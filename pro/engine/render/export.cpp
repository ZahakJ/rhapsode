#include "export.h"

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/audio_fifo.h>
#include <libavutil/opt.h>
#include <libswresample/swresample.h>
}

#include <SDL3/SDL.h>

#include <chrono>
#include <thread>
#include <cstring>

#include "../audio/mixer.h"
#include "../io/project_io.h"
#include <filesystem>
#include <nlohmann/json.hpp>
#include <sys/stat.h>
#include "../gfx/gpu.h"
#include "../media/prefetch.h"
#include "renderer.h"

namespace rhap {

const std::vector<Preset>& presets() {
  static const std::vector<Preset> P = {
      {"youtube-1080p", "YouTube 1080p (H.264)", "mp4", {"h264_nvenc", "libx264"}, PixFmt::NV12, 19, 0, "high", "aac", 320000, 1920, 1080},
      {"youtube-4k", "YouTube 4K (HEVC 10-bit)", "mp4", {"hevc_nvenc", "libx265"}, PixFmt::P010, 21, 0, "main10", "aac", 384000, 3840, 2160},
      {"vertical-1080x1920", "Social vertical 1080×1920 (H.264)", "mp4", {"h264_nvenc", "libx264"}, PixFmt::NV12, 20, 0, "high", "aac", 256000, 1080, 1920},
      {"square-1080", "Social square 1080 (H.264)", "mp4", {"h264_nvenc", "libx264"}, PixFmt::NV12, 20, 0, "high", "aac", 256000, 1080, 1080},
      {"av1-1080p", "AV1 1080p (10-bit)", "mp4", {"av1_nvenc", "libsvtav1"}, PixFmt::P010, 28, 0, "", "aac", 256000, 1920, 1080},
      {"hdr10-4k", "HDR10 4K (HEVC 10-bit, PQ)", "mp4", {"hevc_nvenc", "libx265"}, PixFmt::P010, 20, 0, "main10", "aac", 384000, 3840, 2160, true},
      {"prores-hq", "ProRes 422 HQ master", "mov", {"prores_ks"}, PixFmt::YUV422P10, 0, 0, "3", "pcm_s24le", 0, 0, 0, false, 1},
      {"prores-proxy", "ProRes 422 Proxy", "mov", {"prores_ks"}, PixFmt::YUV422P10, 0, 0, "0", "pcm_s24le", 0, 0, 0, false, 1},
      {"dnxhr-hqx", "DNxHR HQX (10-bit)", "mov", {"dnxhd"}, PixFmt::YUV422P10, 0, 0, "dnxhr_hqx", "pcm_s24le", 0, 0, 0, false, 1},
      {"dnxhr-hq", "DNxHR HQ (8-bit)", "mov", {"dnxhd"}, PixFmt::YUV422P, 0, 0, "dnxhr_hq", "pcm_s24le", 0, 0, 0, false, 1},
      {"master-source", "H.264 at sequence size", "mp4", {"h264_nvenc", "libx264"}, PixFmt::NV12, 17, 0, "high", "aac", 320000, 0, 0},
  };
  return P;
}

const Preset* findPreset(const std::string& id) {
  for (auto& p : presets())
    if (p.id == id) return &p;
  return nullptr;
}

namespace {

std::string averr(int e) {
  char b[AV_ERROR_MAX_STRING_SIZE];
  av_strerror(e, b, sizeof b);
  return b;
}

struct GpuLayout {
  AVPixelFormat fmt;
  bool deep;         // 16-bit texels
  int bits, shift;   // code bits, MSB shift within the texel
  int csx, csy;      // chroma subsampling shifts
  bool interleaved;  // the encoder takes CbCr interleaved (NV12 / P010)
};

std::vector<GpuLayout> candidates(PixFmt p) {
  switch (p) {
    case PixFmt::NV12:
    case PixFmt::YUV420P:
      return {{AV_PIX_FMT_NV12, false, 8, 0, 1, 1, true}, {AV_PIX_FMT_YUV420P, false, 8, 0, 1, 1, false}};
    case PixFmt::P010:
      return {{AV_PIX_FMT_P010LE, true, 10, 6, 1, 1, true}, {AV_PIX_FMT_YUV420P10LE, true, 10, 0, 1, 1, false}};
    case PixFmt::YUV422P: return {{AV_PIX_FMT_YUV422P, false, 8, 0, 1, 0, false}};
    case PixFmt::YUV422P10: return {{AV_PIX_FMT_YUV422P10LE, true, 10, 0, 1, 0, false}};
  }
  return {};
}

bool supports(const AVCodec* c, AVPixelFormat f) {
  const void* cfg = nullptr;
  int n = 0;
  if (avcodec_get_supported_config(nullptr, c, AV_CODEC_CONFIG_PIX_FORMAT, 0, &cfg, &n) < 0 || !cfg) return true;
  auto* list = static_cast<const AVPixelFormat*>(cfg);
  for (int i = 0; i < n; ++i)
    if (list[i] == f) return true;
  return false;
}

AVSampleFormat audioFormat(const AVCodec* c) {
  const void* cfg = nullptr;
  int n = 0;
  if (avcodec_get_supported_config(nullptr, c, AV_CODEC_CONFIG_SAMPLE_FORMAT, 0, &cfg, &n) < 0 || !cfg || n == 0)
    return AV_SAMPLE_FMT_FLTP;
  return static_cast<const AVSampleFormat*>(cfg)[0];
}

/** opens the first of the preset's encoders that takes one of its layouts; null + err when none does */
AVCodecContext* openVideoEncoder(const Preset& pr, int W, int H, Rate rate, bool globalHeader, int gop, bool noBFrames,
                                 GpuLayout& lay, std::string& used, std::string& lastErr) {
  lastErr = "no encoder for this preset on this machine";
  for (const std::string& name : pr.encoders) {
    const AVCodec* codec = avcodec_find_encoder_by_name(name.c_str());
    if (!codec) continue;
    bool picked = false;
    for (const GpuLayout& l : candidates(pr.pix))
      if (supports(codec, l.fmt)) {
        lay = l;
        picked = true;
        break;
      }
    if (!picked) continue;
    AVCodecContext* c = avcodec_alloc_context3(codec);
    c->width = W;
    c->height = H;
    c->pix_fmt = lay.fmt;
    c->time_base = AVRational{int(rate.den), int(rate.num)};
    c->framerate = AVRational{int(rate.num), int(rate.den)};
    c->sample_aspect_ratio = {1, 1};
    c->color_range = AVCOL_RANGE_MPEG;
    c->color_primaries = pr.hdr ? AVCOL_PRI_BT2020 : AVCOL_PRI_BT709;
    c->color_trc = pr.hdr ? AVCOL_TRC_SMPTE2084 : AVCOL_TRC_BT709;
    c->colorspace = pr.hdr ? AVCOL_SPC_BT2020_NCL : AVCOL_SPC_BT709;
    c->gop_size = gop > 0 ? gop : pr.gop > 0 ? pr.gop : int(std::lround(rate.fps() * 2));
    if (pr.bitrate > 0) c->bit_rate = pr.bitrate;
    if (globalHeader) c->flags |= AV_CODEC_FLAG_GLOBAL_HEADER;
    if (name.find("nvenc") == std::string::npos) {
      c->thread_count = 0;  // software encoders (ProRes, DNxHR, x264/x265): every core
      c->thread_type = FF_THREAD_SLICE | FF_THREAD_FRAME;
    }
    AVDictionary* opt = nullptr;
    std::string cq = std::to_string(pr.cq);
    if (name.find("nvenc") != std::string::npos) {
      av_dict_set(&opt, "preset", "p5", 0);
      av_dict_set(&opt, "tune", "hq", 0);
      av_dict_set(&opt, "rc", "vbr", 0);
      if (pr.cq > 0) {
        av_dict_set(&opt, "cq", cq.c_str(), 0);
        c->bit_rate = 0;
      }
      if (!pr.profile.empty() && name != "av1_nvenc") av_dict_set(&opt, "profile", pr.profile.c_str(), 0);
      c->max_b_frames = noBFrames ? 0 : 2;
      if (noBFrames) av_dict_set(&opt, "strict_gop", "1", 0);
    } else if (name == "libx264" || name == "libx265") {
      av_dict_set(&opt, "crf", cq.c_str(), 0);
      av_dict_set(&opt, "preset", "medium", 0);
      if (noBFrames) c->max_b_frames = 0;
      if (name == "libx265") av_dict_set(&opt, "x265-params", noBFrames ? "log-level=none:bframes=0" : "log-level=none", 0);
    } else if (name == "libsvtav1") {
      av_dict_set(&opt, "crf", cq.c_str(), 0);
      av_dict_set(&opt, "preset", "8", 0);
    } else if (name == "prores_ks") {
      av_dict_set(&opt, "profile", pr.profile.empty() ? "3" : pr.profile.c_str(), 0);
      av_dict_set(&opt, "vendor", "apl0", 0);
    } else if (name == "dnxhd") {
      av_dict_set(&opt, "profile", pr.profile.c_str(), 0);
    }
    int e = avcodec_open2(c, codec, &opt);
    av_dict_free(&opt);
    if (e < 0) {
      lastErr = name + ": " + averr(e);
      avcodec_free_context(&c);
      continue;
    }
    used = name;
    return c;
  }
  return nullptr;
}

struct Out {
  AVFormatContext* oc = nullptr;
  AVCodecContext *vc = nullptr, *ac = nullptr;
  AVStream *vs = nullptr, *as = nullptr;
  SwrContext* swr = nullptr;
  AVAudioFifo* fifo = nullptr;
  AVPacket* pkt = nullptr;
  int64_t audioPts = 0;
  ~Out() {
    av_audio_fifo_free(fifo);
    swr_free(&swr);
    avcodec_free_context(&vc);
    avcodec_free_context(&ac);
    av_packet_free(&pkt);
    if (oc) {
      if (!(oc->oformat->flags & AVFMT_NOFILE) && oc->pb) avio_closep(&oc->pb);
      avformat_free_context(oc);
    }
  }
  std::string drain(AVCodecContext* c, AVStream* s) {
    for (;;) {
      int r = avcodec_receive_packet(c, pkt);
      if (r == AVERROR(EAGAIN) || r == AVERROR_EOF) return {};
      if (r < 0) return "encoder failed: " + averr(r);
      av_packet_rescale_ts(pkt, c->time_base, s->time_base);
      pkt->stream_index = s->index;
      if (int e = av_interleaved_write_frame(oc, pkt); e < 0) return "write failed: " + averr(e);
    }
  }
};

}  // namespace

std::string runSmartExport(const ExportJob& job, const std::function<bool(const ExportProgress&)>& progress,
                           ExportProgress* summary);

std::string runExport(const ExportJob& jobIn, const std::function<bool(const ExportProgress&)>& progress,
                      ExportProgress* summary) {
  if (jobIn.smart) {
    std::string e = runSmartExport(jobIn, progress, summary);
    if (e.rfind("smart:", 0) != 0) return e;  // a real failure; "smart:" means fall back to a full render
  }
  ExportJob job = jobIn;
  job.smart = false;
  Project& p = job.project;
  if (job.preset.hdr) p.output = OutputSpace::Rec2020PQ;
  const Sequence* sp = p.findSequence(job.sequence.empty() ? p.active : job.sequence);
  if (!sp) return "no such sequence";
  const Sequence& s = *sp;
  const Preset& pr = job.preset;
  const int W = pr.width > 0 ? pr.width : s.width, H = pr.height > 0 ? pr.height : s.height;
  if (W % 2 || H % 2) return "the output size must be even";
  const Rate rate = s.rate;
  Tick out = job.out < 0 ? s.duration() : std::min(job.out, s.duration());
  int64_t f0 = frameAt(job.in, rate), f1 = frameAt(out + frameTicks(rate) - 1, rate);
  int64_t total = f1 - f0;
  if (total <= 0) return "nothing to export";

  // ——— encoder ———
  Out o;
  if (int e = avformat_alloc_output_context2(&o.oc, nullptr, nullptr, job.path.c_str()); e < 0 || !o.oc)
    return "cannot create " + job.path + ": " + averr(e);
  o.pkt = av_packet_alloc();
  GpuLayout lay{};
  std::string used, lastErr;
  o.vc = openVideoEncoder(pr, W, H, rate, o.oc->oformat->flags & AVFMT_GLOBALHEADER, 0, false, lay, used, lastErr);
  if (!o.vc) return lastErr;
  o.vs = avformat_new_stream(o.oc, nullptr);
  avcodec_parameters_from_context(o.vs->codecpar, o.vc);
  o.vs->time_base = o.vc->time_base;
  o.vs->avg_frame_rate = o.vc->framerate;

  const AVCodec* acodec = avcodec_find_encoder_by_name(pr.acodec.c_str());
  if (acodec) {
    AVCodecContext* c = avcodec_alloc_context3(acodec);
    c->sample_rate = s.sampleRate;
    av_channel_layout_default(&c->ch_layout, 2);
    c->sample_fmt = audioFormat(acodec);
    c->time_base = {1, s.sampleRate};
    if (pr.abitrate > 0) c->bit_rate = pr.abitrate;
    if (o.oc->oformat->flags & AVFMT_GLOBALHEADER) c->flags |= AV_CODEC_FLAG_GLOBAL_HEADER;
    if (avcodec_open2(c, acodec, nullptr) >= 0) {
      o.ac = c;
      o.as = avformat_new_stream(o.oc, nullptr);
      avcodec_parameters_from_context(o.as->codecpar, c);
      o.as->time_base = c->time_base;
      AVChannelLayout st;
      av_channel_layout_default(&st, 2);
      swr_alloc_set_opts2(&o.swr, &c->ch_layout, c->sample_fmt, c->sample_rate, &st, AV_SAMPLE_FMT_FLT, s.sampleRate, 0,
                          nullptr);
      swr_init(o.swr);
      o.fifo = av_audio_fifo_alloc(c->sample_fmt, 2, 4096);
    } else {
      avcodec_free_context(&c);
    }
  }
  AVDictionary* mux = nullptr;
  if (pr.ext == "mp4" || pr.ext == "mov") av_dict_set(&mux, "movflags", "+faststart", 0);
  if (!(o.oc->oformat->flags & AVFMT_NOFILE))
    if (int e = avio_open(&o.oc->pb, job.path.c_str(), AVIO_FLAG_WRITE); e < 0) return "cannot write " + job.path;
  if (int e = avformat_write_header(o.oc, &mux); e < 0) {
    av_dict_free(&mux);
    return "cannot start the file: " + averr(e);
  }
  av_dict_free(&mux);

  // ——— GPU ———
  gfx::Gpu gpu;
  if (std::string e = gpu.init(nullptr); !e.empty()) return e;
  PrefetchPool pool(job.hwDecode, 8);  // every layer decodes ahead on its own thread
  Renderer ren(gpu, pool);
  audio::Mixer mixer(s.sampleRate);
  Renderer::YuvTarget tgt;
  tgt.matrix = pr.hdr ? 9 : 1;
  tgt.bits = lay.bits;
  tgt.shift = lay.shift;
  tgt.chromaShiftX = lay.csx;
  tgt.chromaShiftY = lay.csy;
  const int cw = W >> lay.csx, ch = H >> lay.csy;
  auto use = SDL_GPU_TEXTUREUSAGE_COLOR_TARGET | SDL_GPU_TEXTUREUSAGE_SAMPLER;
  const int bpp = lay.deep ? 2 : 1;
  const uint32_t ySize = uint32_t(W) * H * bpp, uvSize = uint32_t(cw) * ch * bpp * 2;
  struct Slot {
    gfx::Texture y, uv;
    SDL_GPUTransferBuffer* tb = nullptr;
    SDL_GPUFence* fence = nullptr;
    int64_t frame = -1;
  };
  constexpr int K = 3;
  Slot slots[K];
  for (Slot& sl : slots) {
    sl.y = gpu.make(W, H, lay.deep ? SDL_GPU_TEXTUREFORMAT_R16_UNORM : SDL_GPU_TEXTUREFORMAT_R8_UNORM, use);
    sl.uv = gpu.make(cw, ch, lay.deep ? SDL_GPU_TEXTUREFORMAT_R16G16_UNORM : SDL_GPU_TEXTUREFORMAT_R8G8_UNORM, use);
    SDL_GPUTransferBufferCreateInfo bi{SDL_GPU_TRANSFERBUFFERUSAGE_DOWNLOAD, ySize + uvSize, 0};
    sl.tb = SDL_CreateGPUTransferBuffer(gpu.device(), &bi);
    if (!sl.y || !sl.uv || !sl.tb) return "cannot allocate export buffers";
  }
  gfx::Texture work;
  AVFrame* vf = av_frame_alloc();
  vf->format = lay.fmt;
  vf->width = W;
  vf->height = H;
  vf->color_range = AVCOL_RANGE_MPEG;
  vf->color_primaries = o.vc->color_primaries;
  vf->color_trc = o.vc->color_trc;
  vf->colorspace = o.vc->colorspace;
  if (av_frame_get_buffer(vf, 64) < 0) return "out of memory";
  std::vector<float> mixBuf;
  std::string err;

  auto encodeAudio = [&](bool flush) -> std::string {
    if (!o.ac) return {};
    int fs = o.ac->frame_size > 0 ? o.ac->frame_size : 1024;
    while (av_audio_fifo_size(o.fifo) >= fs || (flush && av_audio_fifo_size(o.fifo) > 0)) {
      int n = std::min(fs, av_audio_fifo_size(o.fifo));
      AVFrame* af = av_frame_alloc();
      af->format = o.ac->sample_fmt;
      af->sample_rate = o.ac->sample_rate;
      av_channel_layout_copy(&af->ch_layout, &o.ac->ch_layout);
      af->nb_samples = o.ac->frame_size > 0 && !(o.ac->codec->capabilities & AV_CODEC_CAP_VARIABLE_FRAME_SIZE) ? fs : n;
      av_frame_get_buffer(af, 0);
      av_samples_set_silence(af->data, 0, af->nb_samples, 2, o.ac->sample_fmt);
      av_audio_fifo_read(o.fifo, reinterpret_cast<void**>(af->data), n);
      af->pts = o.audioPts;
      o.audioPts += af->nb_samples;
      int e = avcodec_send_frame(o.ac, af);
      av_frame_free(&af);
      if (e < 0) return "audio encoder: " + averr(e);
      if (std::string d = o.drain(o.ac, o.as); !d.empty()) return d;
    }
    if (flush) {
      avcodec_send_frame(o.ac, nullptr);
      return o.drain(o.ac, o.as);
    }
    return {};
  };

  auto finish = [&](Slot& sl) -> std::string {
    if (sl.frame < 0) return {};
    SDL_WaitForGPUFences(gpu.device(), true, &sl.fence, 1);
    SDL_ReleaseGPUFence(gpu.device(), sl.fence);
    sl.fence = nullptr;
    const auto* map = static_cast<const uint8_t*>(SDL_MapGPUTransferBuffer(gpu.device(), sl.tb, false));
    if (!map) return "readback failed";
    if (av_frame_make_writable(vf) < 0) {
      SDL_UnmapGPUTransferBuffer(gpu.device(), sl.tb);
      return "out of memory";
    }
    const int yRow = W * bpp;
    for (int y = 0; y < H; ++y) std::memcpy(vf->data[0] + size_t(y) * vf->linesize[0], map + size_t(y) * yRow, size_t(yRow));
    const uint8_t* uv = map + ySize;
    const int uvRow = cw * bpp * 2;
    if (lay.interleaved) {
      for (int y = 0; y < ch; ++y) std::memcpy(vf->data[1] + size_t(y) * vf->linesize[1], uv + size_t(y) * uvRow, size_t(uvRow));
    } else if (bpp == 1) {
      for (int y = 0; y < ch; ++y) {
        const uint8_t* src = uv + size_t(y) * uvRow;
        uint8_t* u = vf->data[1] + size_t(y) * vf->linesize[1];
        uint8_t* v = vf->data[2] + size_t(y) * vf->linesize[2];
        for (int x = 0; x < cw; ++x) u[x] = src[x * 2], v[x] = src[x * 2 + 1];
      }
    } else {
      for (int y = 0; y < ch; ++y) {
        const auto* src = reinterpret_cast<const uint16_t*>(uv + size_t(y) * uvRow);
        auto* u = reinterpret_cast<uint16_t*>(vf->data[1] + size_t(y) * vf->linesize[1]);
        auto* v = reinterpret_cast<uint16_t*>(vf->data[2] + size_t(y) * vf->linesize[2]);
        for (int x = 0; x < cw; ++x) u[x] = src[x * 2], v[x] = src[x * 2 + 1];
      }
    }
    SDL_UnmapGPUTransferBuffer(gpu.device(), sl.tb);
    vf->pts = sl.frame - f0;
    if (int e = avcodec_send_frame(o.vc, vf); e < 0) return "video encoder: " + averr(e);
    if (std::string d = o.drain(o.vc, o.vs); !d.empty()) return d;
    // the sound under this frame
    if (o.ac) {
      int64_t a = sampleAt(frameStart(sl.frame, rate), s.sampleRate), b = sampleAt(frameStart(sl.frame + 1, rate), s.sampleRate);
      int n = int(b - a);
      mixBuf.resize(size_t(n) * 2);
      mixer.render(p, s, a, n, mixBuf.data());
      uint8_t** conv = nullptr;
      av_samples_alloc_array_and_samples(&conv, nullptr, 2, n + 32, o.ac->sample_fmt, 0);
      const uint8_t* in[1] = {reinterpret_cast<const uint8_t*>(mixBuf.data())};
      int got = swr_convert(o.swr, conv, n + 32, in, n);
      if (got > 0) av_audio_fifo_write(o.fifo, reinterpret_cast<void**>(conv), got);
      av_freep(&conv[0]);
      av_freep(&conv);
      if (std::string d = encodeAudio(false); !d.empty()) return d;
    }
    sl.frame = -1;
    return {};
  };

  auto t0 = std::chrono::steady_clock::now();
  ExportProgress prog;
  prog.total = total;
  prog.encoder = used;
  for (int64_t f = f0; f < f1 && err.empty(); ++f) {
    Slot& sl = slots[f % K];
    if (!(err = finish(sl)).empty()) break;
    SDL_GPUCommandBuffer* cmd = SDL_AcquireGPUCommandBuffer(gpu.device());
    if (std::string e = ren.render(cmd, p, s, frameStart(f, rate), work); !e.empty()) {
      SDL_CancelGPUCommandBuffer(cmd);
      err = e;
      break;
    }
    ren.outputYuv(cmd, work, sl.y, sl.uv, p, s.background, tgt);
    SDL_GPUCopyPass* cp = SDL_BeginGPUCopyPass(cmd);
    SDL_GPUTextureRegion ry{};
    ry.texture = sl.y.tex;
    ry.w = uint32_t(W);
    ry.h = uint32_t(H);
    ry.d = 1;
    SDL_GPUTextureTransferInfo dy{sl.tb, 0, uint32_t(W), uint32_t(H)};
    SDL_DownloadFromGPUTexture(cp, &ry, &dy);
    SDL_GPUTextureRegion ru{};
    ru.texture = sl.uv.tex;
    ru.w = uint32_t(cw);
    ru.h = uint32_t(ch);
    ru.d = 1;
    SDL_GPUTextureTransferInfo du{sl.tb, ySize, uint32_t(cw), uint32_t(ch)};
    SDL_DownloadFromGPUTexture(cp, &ru, &du);
    SDL_EndGPUCopyPass(cp);
    sl.fence = SDL_SubmitGPUCommandBufferAndAcquireFence(cmd);
    sl.frame = f;
    prog.frame = f - f0 + 1;
    double el = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
    prog.fps = el > 0 ? double(prog.frame) / el : 0;
    if (progress && !progress(prog)) err = "cancelled";
  }
  // drain the frames still in flight, oldest first
  for (int64_t f = std::max(f0, f1 - K); f < f1 && err.empty(); ++f) err = finish(slots[f % K]);
  for (Slot& sl : slots) {
    if (sl.fence) SDL_ReleaseGPUFence(gpu.device(), sl.fence);
    SDL_ReleaseGPUTransferBuffer(gpu.device(), sl.tb);
    gpu.release(sl.y);
    gpu.release(sl.uv);
  }
  gpu.release(work);
  av_frame_free(&vf);
  if (!err.empty()) return err;
  avcodec_send_frame(o.vc, nullptr);
  if (std::string d = o.drain(o.vc, o.vs); !d.empty()) return d;
  if (std::string d = encodeAudio(true); !d.empty()) return d;
  if (int e = av_write_trailer(o.oc); e < 0) return "cannot finish the file: " + averr(e);
  double el = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
  prog.fps = el > 0 ? double(total) / el : 0;
  if (summary) *summary = prog;
  return {};
}


// ——— smart render ———

namespace {

/** what a stretch of the picture depends on, as text: hashed to name its cached segment */
std::string segmentKey(const Project& p, const Sequence& s, Tick t0, Tick t1, const std::string& presetKey) {
  nlohmann::json j = toJson(p);
  std::string key = presetKey + "|" + std::to_string(int(p.working)) + "|" + std::to_string(int(p.output)) + "|" +
                    std::to_string(s.background[0]) + "," + std::to_string(s.background[1]) + "," + std::to_string(s.background[2]);
  // transitions reach half their length past a cut: widen the window by the longest one
  Tick margin = 0;
  for (auto& t : s.video)
    for (auto& x : t.transitions) margin = std::max(margin, x.dur);
  for (size_t ti = 0; ti < s.video.size(); ++ti) {
    const Track& t = s.video[ti];
    key += "|V" + std::to_string(ti) + (t.hidden ? "h" : "");
    for (auto& c : t.clips) {
      if (c.end() + margin <= t0 || c.start - margin >= t1) continue;
      key += clipJson(c).dump();
      if (const Media* m = c.kind == ClipKind::Media ? p.findMedia(c.ref) : nullptr) {
        struct stat st{};
        stat(m->path.c_str(), &st);
        key += m->path + ":" + std::to_string(st.st_size) + ":" + std::to_string(st.st_mtim.tv_sec) + "." + std::to_string(st.st_mtim.tv_nsec);
      }
      if (c.kind == ClipKind::Nested || c.kind == ClipKind::Multicam)
        for (auto& sj : j["sequences"])
          if (sj.value("id", "") == c.ref) key += sj.dump();  // a nested change rebuilds every segment it shows in
    }
    for (auto& x : t.transitions)
      if (x.at + x.dur > t0 && x.at - x.dur < t1) key += "x" + std::to_string(x.at) + ":" + std::to_string(x.dur) + ":" + std::to_string(int(x.kind));
  }
  return key;
}

std::string hex64(uint64_t v) {
  char b[17];
  std::snprintf(b, sizeof b, "%016llx", (unsigned long long)v);
  return b;
}

}  // namespace

std::string runSmartExport(const ExportJob& jobIn, const std::function<bool(const ExportProgress&)>& progress,
                           ExportProgress* summary) {
  namespace fs = std::filesystem;
  ExportJob job = jobIn;
  Project& p = job.project;
  if (job.preset.hdr) p.output = OutputSpace::Rec2020PQ;
  const Sequence* sp = p.findSequence(job.sequence.empty() ? p.active : job.sequence);
  if (!sp) return "no such sequence";
  const Sequence& s = *sp;
  const Preset& pr = job.preset;
  const int W = pr.width > 0 ? pr.width : s.width, H = pr.height > 0 ? pr.height : s.height;
  if (W % 2 || H % 2) return "the output size must be even";
  const Rate rate = s.rate;
  Tick out = job.out < 0 ? s.duration() : std::min(job.out, s.duration());
  const int64_t f0 = frameAt(job.in, rate), f1 = frameAt(out + frameTicks(rate) - 1, rate);
  if (f1 <= f0) return "nothing to export";
  const int L = pr.gop == 1 ? 30 : int(std::lround(rate.fps() * 2));
  std::string cache = job.cacheDir;
  if (cache.empty()) {
    const char* home = std::getenv("HOME");
    cache = (fs::path(home ? home : ".") / ".cache" / "rhapsode-pro" / "smart").string();
  }
  std::error_code ec;
  fs::create_directories(cache, ec);

  // which encoder, which layout: learnt by opening one
  GpuLayout lay{};
  std::string used, err;
  {
    AVCodecContext* probe = openVideoEncoder(pr, W, H, rate, true, L, true, lay, used, err);
    if (!probe) return err;
    avcodec_free_context(&probe);
  }
  const std::string presetKey = pr.id + ":" + used + ":" + std::to_string(W) + "x" + std::to_string(H) + ":" +
                                std::to_string(rate.num) + "/" + std::to_string(rate.den) + ":" + std::to_string(pr.cq) + ":" +
                                std::to_string(pr.bitrate) + ":" + pr.profile + ":" + std::to_string(L) + ":v1";
  struct Seg {
    int64_t a, b;
    std::string file;
    bool cached;
  };
  std::vector<Seg> segs;
  for (int64_t a = f0; a < f1; a += L) {
    int64_t b = std::min(f1, a + L);
    std::string k = segmentKey(p, s, frameStart(a, rate), frameStart(b, rate), presetKey + ":" + std::to_string(a - f0) + ":" + std::to_string(b - a));
    std::string file = cache + "/" + hex64(fnv1a(k)) + ".mkv";
    segs.push_back({a, b, file, fs::exists(file, ec)});
  }

  // ——— render the segments that changed ———
  gfx::Gpu gpu;
  if (std::string e = gpu.init(nullptr); !e.empty()) return e;
  PrefetchPool pool(job.hwDecode, 8);  // every layer decodes ahead on its own thread
  Renderer ren(gpu, pool);
  Renderer::YuvTarget tgt;
  tgt.matrix = pr.hdr ? 9 : 1;
  tgt.bits = lay.bits;
  tgt.shift = lay.shift;
  tgt.chromaShiftX = lay.csx;
  tgt.chromaShiftY = lay.csy;
  const int cw = W >> lay.csx, ch = H >> lay.csy, bpp = lay.deep ? 2 : 1;
  const uint32_t ySize = uint32_t(W) * H * bpp, uvSize = uint32_t(cw) * ch * bpp * 2;
  auto use = SDL_GPU_TEXTUREUSAGE_COLOR_TARGET | SDL_GPU_TEXTUREUSAGE_SAMPLER;
  gfx::Texture yT = gpu.make(W, H, lay.deep ? SDL_GPU_TEXTUREFORMAT_R16_UNORM : SDL_GPU_TEXTUREFORMAT_R8_UNORM, use);
  gfx::Texture uvT = gpu.make(cw, ch, lay.deep ? SDL_GPU_TEXTUREFORMAT_R16G16_UNORM : SDL_GPU_TEXTUREFORMAT_R8G8_UNORM, use);
  SDL_GPUTransferBufferCreateInfo bi{SDL_GPU_TRANSFERBUFFERUSAGE_DOWNLOAD, ySize + uvSize, 0};
  SDL_GPUTransferBuffer* tb = SDL_CreateGPUTransferBuffer(gpu.device(), &bi);
  gfx::Texture work;
  ExportProgress prog;
  prog.total = f1 - f0;
  prog.encoder = used;
  auto t0 = std::chrono::steady_clock::now();
  std::vector<uint8_t> firstExtra;
  int64_t done = 0;
  for (Seg& sg : segs) {
    if (sg.cached) {
      prog.reused += sg.b - sg.a;
      done += sg.b - sg.a;
      continue;
    }
    std::string tmp = sg.file + ".part.mkv";
    AVFormatContext* oc = nullptr;
    avformat_alloc_output_context2(&oc, nullptr, "matroska", tmp.c_str());
    GpuLayout l2{};
    std::string u2, e2;
    AVCodecContext* vc = nullptr;
    // NVENC can refuse a context while another process holds the GPU; segments must share one encoder, so wait for it
    for (int attempt = 0; attempt < 5; ++attempt) {
      vc = openVideoEncoder(pr, W, H, rate, true, L, true, l2, u2, e2);
      if (vc && u2 == used) break;
      avcodec_free_context(&vc);
      std::this_thread::sleep_for(std::chrono::milliseconds(300 * (attempt + 1)));
    }
    if (!oc || !vc || u2 != used) {
      avcodec_free_context(&vc);
      if (oc) avformat_free_context(oc);
      return "cannot start a segment encoder: " + e2;
    }
    AVStream* vs = avformat_new_stream(oc, nullptr);
    avcodec_parameters_from_context(vs->codecpar, vc);
    vs->time_base = vc->time_base;
    avio_open(&oc->pb, tmp.c_str(), AVIO_FLAG_WRITE);
    std::string werr;
    if (avformat_write_header(oc, nullptr) < 0) werr = "cannot write a segment";
    AVPacket* pkt = av_packet_alloc();
    AVFrame* vf = av_frame_alloc();
    vf->format = lay.fmt;
    vf->width = W;
    vf->height = H;
    av_frame_get_buffer(vf, 64);
    auto drain = [&]() {
      while (avcodec_receive_packet(vc, pkt) == 0) {
        av_packet_rescale_ts(pkt, vc->time_base, vs->time_base);
        pkt->stream_index = 0;
        av_interleaved_write_frame(oc, pkt);
      }
    };
    for (int64_t f = sg.a; f < sg.b && werr.empty(); ++f) {
      SDL_GPUCommandBuffer* cmd = SDL_AcquireGPUCommandBuffer(gpu.device());
      if (std::string e = ren.render(cmd, p, s, frameStart(f, rate), work); !e.empty()) {
        SDL_CancelGPUCommandBuffer(cmd);
        werr = e;
        break;
      }
      ren.outputYuv(cmd, work, yT, uvT, p, s.background, tgt);
      SDL_GPUCopyPass* cp = SDL_BeginGPUCopyPass(cmd);
      SDL_GPUTextureRegion ry{};
      ry.texture = yT.tex;
      ry.w = uint32_t(W);
      ry.h = uint32_t(H);
      ry.d = 1;
      SDL_GPUTextureTransferInfo dy{tb, 0, uint32_t(W), uint32_t(H)};
      SDL_DownloadFromGPUTexture(cp, &ry, &dy);
      SDL_GPUTextureRegion ru{};
      ru.texture = uvT.tex;
      ru.w = uint32_t(cw);
      ru.h = uint32_t(ch);
      ru.d = 1;
      SDL_GPUTextureTransferInfo du{tb, ySize, uint32_t(cw), uint32_t(ch)};
      SDL_DownloadFromGPUTexture(cp, &ru, &du);
      SDL_EndGPUCopyPass(cp);
      SDL_GPUFence* fence = SDL_SubmitGPUCommandBufferAndAcquireFence(cmd);
      SDL_WaitForGPUFences(gpu.device(), true, &fence, 1);
      SDL_ReleaseGPUFence(gpu.device(), fence);
      const auto* map = static_cast<const uint8_t*>(SDL_MapGPUTransferBuffer(gpu.device(), tb, false));
      av_frame_make_writable(vf);
      for (int y = 0; y < H; ++y) std::memcpy(vf->data[0] + size_t(y) * vf->linesize[0], map + size_t(y) * W * bpp, size_t(W) * bpp);
      const uint8_t* uv = map + ySize;
      const int uvRow = cw * bpp * 2;
      for (int y = 0; y < ch; ++y) {
        if (lay.interleaved) {
          std::memcpy(vf->data[1] + size_t(y) * vf->linesize[1], uv + size_t(y) * uvRow, size_t(uvRow));
        } else if (bpp == 1) {
          for (int x = 0; x < cw; ++x)
            vf->data[1][size_t(y) * vf->linesize[1] + x] = uv[size_t(y) * uvRow + x * 2],
            vf->data[2][size_t(y) * vf->linesize[2] + x] = uv[size_t(y) * uvRow + x * 2 + 1];
        } else {
          auto* src = reinterpret_cast<const uint16_t*>(uv + size_t(y) * uvRow);
          auto* U = reinterpret_cast<uint16_t*>(vf->data[1] + size_t(y) * vf->linesize[1]);
          auto* V = reinterpret_cast<uint16_t*>(vf->data[2] + size_t(y) * vf->linesize[2]);
          for (int x = 0; x < cw; ++x) U[x] = src[x * 2], V[x] = src[x * 2 + 1];
        }
      }
      SDL_UnmapGPUTransferBuffer(gpu.device(), tb);
      vf->pts = f - sg.a;
      avcodec_send_frame(vc, vf);
      drain();
      ++done;
      prog.frame = done;
      double el = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
      prog.fps = el > 0 ? double(done - prog.reused) / el : 0;
      if (progress && !progress(prog)) werr = "cancelled";
    }
    avcodec_send_frame(vc, nullptr);
    drain();
    av_write_trailer(oc);
    avio_closep(&oc->pb);
    avformat_free_context(oc);
    avcodec_free_context(&vc);
    av_frame_free(&vf);
    av_packet_free(&pkt);
    if (!werr.empty()) {
      fs::remove(tmp, ec);
      return werr;
    }
    fs::rename(tmp, sg.file, ec);
  }
  SDL_ReleaseGPUTransferBuffer(gpu.device(), tb);
  gpu.release(yT);
  gpu.release(uvT);
  gpu.release(work);

  // ——— join: video packets from the segments, sound encoded once alongside ———
  Out o;
  if (avformat_alloc_output_context2(&o.oc, nullptr, nullptr, job.path.c_str()) < 0 || !o.oc) return "cannot create " + job.path;
  o.pkt = av_packet_alloc();
  AVFormatContext* first = nullptr;
  if (avformat_open_input(&first, segs[0].file.c_str(), nullptr, nullptr) < 0 || avformat_find_stream_info(first, nullptr) < 0)
    return "smart: a cached segment is unreadable";
  o.vs = avformat_new_stream(o.oc, nullptr);
  avcodec_parameters_copy(o.vs->codecpar, first->streams[0]->codecpar);
  o.vs->codecpar->codec_tag = 0;
  const AVRational vtb{int(rate.den), int(rate.num)};
  o.vs->time_base = vtb;
  o.vs->avg_frame_rate = AVRational{int(rate.num), int(rate.den)};
  std::vector<uint8_t> extra(first->streams[0]->codecpar->extradata,
                             first->streams[0]->codecpar->extradata + first->streams[0]->codecpar->extradata_size);
  avformat_close_input(&first);
  const AVCodec* acodec = avcodec_find_encoder_by_name(pr.acodec.c_str());
  if (acodec) {
    AVCodecContext* c = avcodec_alloc_context3(acodec);
    c->sample_rate = s.sampleRate;
    av_channel_layout_default(&c->ch_layout, 2);
    c->sample_fmt = audioFormat(acodec);
    c->time_base = {1, s.sampleRate};
    if (pr.abitrate > 0) c->bit_rate = pr.abitrate;
    if (o.oc->oformat->flags & AVFMT_GLOBALHEADER) c->flags |= AV_CODEC_FLAG_GLOBAL_HEADER;
    if (avcodec_open2(c, acodec, nullptr) >= 0) {
      o.ac = c;
      o.as = avformat_new_stream(o.oc, nullptr);
      avcodec_parameters_from_context(o.as->codecpar, c);
      o.as->time_base = c->time_base;
      AVChannelLayout st;
      av_channel_layout_default(&st, 2);
      swr_alloc_set_opts2(&o.swr, &c->ch_layout, c->sample_fmt, c->sample_rate, &st, AV_SAMPLE_FMT_FLT, s.sampleRate, 0, nullptr);
      swr_init(o.swr);
    } else {
      avcodec_free_context(&c);
    }
  }
  AVDictionary* mux = nullptr;
  if (pr.ext == "mp4" || pr.ext == "mov") av_dict_set(&mux, "movflags", "+faststart", 0);
  if (!(o.oc->oformat->flags & AVFMT_NOFILE) && avio_open(&o.oc->pb, job.path.c_str(), AVIO_FLAG_WRITE) < 0) return "cannot write " + job.path;
  if (avformat_write_header(o.oc, &mux) < 0) {
    av_dict_free(&mux);
    return "cannot start the file";
  }
  av_dict_free(&mux);
  audio::Mixer mixer(s.sampleRate);
  const int64_t aStart = sampleAt(frameStart(f0, rate), s.sampleRate), aEnd = sampleAt(frameStart(f1, rate), s.sampleRate);
  int64_t aAt = aStart;
  std::vector<float> mixBuf;
  // sound up to a time, so the muxer interleaves without holding the whole film
  auto soundUntil = [&](double seconds) -> std::string {
    if (!o.ac) return {};
    const int fs_ = o.ac->frame_size > 0 ? o.ac->frame_size : 1024;
    while (aAt < aEnd && double(aAt - aStart) / s.sampleRate < seconds) {
      int n = int(std::min<int64_t>(fs_, aEnd - aAt));
      mixBuf.resize(size_t(n) * 2);
      mixer.render(p, s, aAt, n, mixBuf.data());
      AVFrame* af = av_frame_alloc();
      af->format = o.ac->sample_fmt;
      af->sample_rate = o.ac->sample_rate;
      av_channel_layout_copy(&af->ch_layout, &o.ac->ch_layout);
      af->nb_samples = o.ac->frame_size > 0 && !(o.ac->codec->capabilities & AV_CODEC_CAP_VARIABLE_FRAME_SIZE) ? fs_ : n;
      av_frame_get_buffer(af, 0);
      av_samples_set_silence(af->data, 0, af->nb_samples, 2, o.ac->sample_fmt);
      const uint8_t* in[1] = {reinterpret_cast<const uint8_t*>(mixBuf.data())};
      swr_convert(o.swr, af->data, af->nb_samples, in, n);
      af->pts = aAt - aStart;
      aAt += n;
      int e = avcodec_send_frame(o.ac, af);
      av_frame_free(&af);
      if (e < 0) return "audio encoder: " + averr(e);
      if (std::string d = o.drain(o.ac, o.as); !d.empty()) return d;
    }
    return {};
  };
  for (const Seg& sg : segs) {
    AVFormatContext* in = nullptr;
    if (avformat_open_input(&in, sg.file.c_str(), nullptr, nullptr) < 0 || avformat_find_stream_info(in, nullptr) < 0) {
      fs::remove(sg.file, ec);
      return "smart: a cached segment is unreadable";
    }
    const AVCodecParameters* cp = in->streams[0]->codecpar;
    if (cp->extradata_size != int(extra.size()) || std::memcmp(cp->extradata, extra.data(), extra.size()) != 0) {
      avformat_close_input(&in);
      fs::remove(sg.file, ec);  // made with other parameter sets: it cannot join; render it again next time
      return "smart: segments differ";
    }
    const AVRational stb = in->streams[0]->time_base;
    const int64_t offset = sg.a - f0;  // frames
    AVPacket* pk = av_packet_alloc();
    while (av_read_frame(in, pk) >= 0) {
      av_packet_rescale_ts(pk, stb, vtb);
      pk->pts += offset;
      pk->dts += offset;
      pk->stream_index = o.vs->index;
      pk->pos = -1;
      if (std::string e = soundUntil(double(pk->dts) * av_q2d(vtb) + 0.5); !e.empty()) return e;
      av_packet_rescale_ts(pk, vtb, o.vs->time_base);
      if (int e = av_interleaved_write_frame(o.oc, pk); e < 0) {
        av_packet_free(&pk);
        avformat_close_input(&in);
        return "write failed: " + averr(e);
      }
    }
    av_packet_free(&pk);
    avformat_close_input(&in);
  }
  if (std::string e = soundUntil(1e18); !e.empty()) return e;
  if (o.ac) {
    avcodec_send_frame(o.ac, nullptr);
    if (std::string d = o.drain(o.ac, o.as); !d.empty()) return d;
  }
  if (av_write_trailer(o.oc) < 0) return "cannot finish the file";
  double el = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
  prog.frame = prog.total;
  prog.fps = el > 0 ? double(prog.total) / el : 0;
  if (summary) *summary = prog;
  return {};
}

}  // namespace rhap
