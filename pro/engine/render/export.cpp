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
#include <cstring>

#include "../audio/mixer.h"
#include "../gfx/gpu.h"
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

std::string runExport(const ExportJob& jobIn, const std::function<bool(const ExportProgress&)>& progress,
                      ExportProgress* summary) {
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
  int64_t f0 = frameAt(job.in, rate), f1 = frameAt(out + frameTicks(rate) - 1, rate);
  int64_t total = f1 - f0;
  if (total <= 0) return "nothing to export";

  // ——— encoder ———
  Out o;
  if (int e = avformat_alloc_output_context2(&o.oc, nullptr, nullptr, job.path.c_str()); e < 0 || !o.oc)
    return "cannot create " + job.path + ": " + averr(e);
  o.pkt = av_packet_alloc();
  GpuLayout lay{};
  std::string used, lastErr = "no encoder for this preset on this machine";
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
    if (pr.gop > 0) c->gop_size = pr.gop;
    else c->gop_size = int(std::lround(rate.fps() * 2));
    if (pr.bitrate > 0) c->bit_rate = pr.bitrate;
    if (o.oc->oformat->flags & AVFMT_GLOBALHEADER) c->flags |= AV_CODEC_FLAG_GLOBAL_HEADER;
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
      c->max_b_frames = 2;
    } else if (name == "libx264" || name == "libx265") {
      av_dict_set(&opt, "crf", cq.c_str(), 0);
      av_dict_set(&opt, "preset", "medium", 0);
      if (name == "libx265") av_dict_set(&opt, "x265-params", "log-level=none", 0);
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
    o.vc = c;
    used = name;
    break;
  }
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
  DecoderPool pool(job.hwDecode);
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

}  // namespace rhap
