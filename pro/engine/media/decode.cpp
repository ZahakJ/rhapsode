#include "decode.h"

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/display.h>
#include <libavutil/hwcontext.h>
#include <libavutil/imgutils.h>
#include <libavutil/opt.h>
#include <libavutil/pixdesc.h>
#include <libswresample/swresample.h>
#include <libswscale/swscale.h>
}

#include <algorithm>
#include <cmath>
#include <cstring>
#include <mutex>

namespace rhap {

namespace {

const AVRational kFlickTb{1, int(kFlicks)};

std::string averr(int e) {
  char b[AV_ERROR_MAX_STRING_SIZE];
  av_strerror(e, b, sizeof b);
  return b;
}

struct FrameDel {
  void operator()(AVFrame* f) const { av_frame_free(&f); }
};

std::shared_ptr<AVFrame> newFrame() { return std::shared_ptr<AVFrame>(av_frame_alloc(), FrameDel{}); }

int rotationOf(const AVStream* st) {
  const AVPacketSideData* sd =
      av_packet_side_data_get(st->codecpar->coded_side_data, st->codecpar->nb_coded_side_data, AV_PKT_DATA_DISPLAYMATRIX);
  if (!sd || sd->size < 9 * 4) return 0;
  double r = -av_display_rotation_get(reinterpret_cast<const int32_t*>(sd->data));
  int deg = int(std::lround(r)) % 360;
  if (deg < 0) deg += 360;
  return (deg + 45) / 90 * 90 % 360;
}

ColorInfo colorOf(const AVCodecParameters* cp) {
  ColorInfo c;
  c.primaries = cp->color_primaries == AVCOL_PRI_UNSPECIFIED ? 1 : int(cp->color_primaries);
  c.transfer = cp->color_trc == AVCOL_TRC_UNSPECIFIED ? 1 : int(cp->color_trc);
  c.matrix = cp->color_space == AVCOL_SPC_UNSPECIFIED ? (cp->height > 576 || cp->height == 0 ? 1 : 6) : int(cp->color_space);
  c.range = cp->color_range == AVCOL_RANGE_JPEG ? 2 : 1;
  const AVPixFmtDescriptor* d = av_pix_fmt_desc_get(AVPixelFormat(cp->format));
  c.bitDepth = d ? d->comp[0].depth : 8;
  return c;
}

bool isStill(const AVFormatContext* fc, const AVStream* st) {
  if (st->disposition & AV_DISPOSITION_ATTACHED_PIC) return true;
  std::string fmt = fc->iformat->name;
  return fmt.find("image2") != std::string::npos || fmt.find("_pipe") != std::string::npos ||
         st->codecpar->codec_id == AV_CODEC_ID_PNG || st->codecpar->codec_id == AV_CODEC_ID_WEBP ||
         (st->codecpar->codec_id == AV_CODEC_ID_MJPEG && st->nb_frames <= 1 && fc->duration <= AV_TIME_BASE / 10);
}

int bestVideo(AVFormatContext* fc) {
  for (unsigned i = 0; i < fc->nb_streams; ++i) {
    AVStream* st = fc->streams[i];
    if (st->codecpar->codec_type == AVMEDIA_TYPE_VIDEO && !(st->disposition & AV_DISPOSITION_ATTACHED_PIC)) {
      int b = av_find_best_stream(fc, AVMEDIA_TYPE_VIDEO, -1, -1, nullptr, 0);
      return b >= 0 ? b : int(i);
    }
  }
  return av_find_best_stream(fc, AVMEDIA_TYPE_VIDEO, -1, -1, nullptr, 0);
}

Tick streamStart(const AVStream* st) { return st->start_time == AV_NOPTS_VALUE ? 0 : st->start_time; }

std::once_flag gHwOnce;
AVBufferRef* gHwDevice = nullptr;

AVBufferRef* hwDevice() {
  std::call_once(gHwOnce, [] {
    if (av_hwdevice_ctx_create(&gHwDevice, AV_HWDEVICE_TYPE_CUDA, nullptr, nullptr, 0) < 0) gHwDevice = nullptr;
  });
  return gHwDevice;
}

AVPixelFormat pickHw(AVCodecContext*, const AVPixelFormat* fmts) {
  for (const AVPixelFormat* p = fmts; *p != AV_PIX_FMT_NONE; ++p)
    if (*p == AV_PIX_FMT_CUDA) return *p;
  return fmts[0];
}

}  // namespace

bool nvdecAvailable() { return hwDevice() != nullptr; }

const uint8_t* VideoFrame::plane(int i) const { return av ? av->data[i] : nullptr; }
int VideoFrame::stride(int i) const { return av ? av->linesize[i] : 0; }

// ——— probe ———

std::string probe(const std::string& path, Media& m) {
  AVFormatContext* fc = nullptr;
  if (int e = avformat_open_input(&fc, path.c_str(), nullptr, nullptr); e < 0) return "cannot open: " + averr(e);
  struct Closer {
    AVFormatContext** f;
    ~Closer() { avformat_close_input(f); }
  } closer{&fc};
  if (int e = avformat_find_stream_info(fc, nullptr); e < 0) return "cannot read streams: " + averr(e);
  m.path = path;
  if (m.name.empty()) {
    auto slash = path.find_last_of('/');
    m.name = slash == std::string::npos ? path : path.substr(slash + 1);
  }
  int vi = bestVideo(fc);
  int ai = av_find_best_stream(fc, AVMEDIA_TYPE_AUDIO, -1, -1, nullptr, 0);
  m.hasVideo = vi >= 0;
  m.hasAudio = ai >= 0;
  if (!m.hasVideo && !m.hasAudio) return "no picture or sound in the file";
  Tick dur = 0;
  if (vi >= 0) {
    AVStream* st = fc->streams[vi];
    const AVCodecParameters* cp = st->codecpar;
    int rot = rotationOf(st);
    m.width = rot % 180 ? cp->height : cp->width;
    m.height = rot % 180 ? cp->width : cp->height;
    // honour the sample aspect ratio: display width
    if (cp->sample_aspect_ratio.num > 0 && cp->sample_aspect_ratio.den > 0 &&
        cp->sample_aspect_ratio.num != cp->sample_aspect_ratio.den && rot % 180 == 0)
      m.width = int(std::lround(double(m.width) * cp->sample_aspect_ratio.num / cp->sample_aspect_ratio.den));
    m.videoCodec = avcodec_get_name(cp->codec_id);
    m.color = colorOf(cp);
    AVRational fr = st->avg_frame_rate.num > 0 ? st->avg_frame_rate : st->r_frame_rate;
    if (fr.num <= 0 || fr.den <= 0) fr = {30, 1};
    // snap near-standard rates (e.g. 29.97002997) to their exact fractions
    double f = av_q2d(fr);
    m.rate = Rate{fr.num, fr.den};
    for (Rate r : {Rate{24, 1}, Rate{25, 1}, Rate{30, 1}, Rate{48, 1}, Rate{50, 1}, Rate{60, 1}, Rate{120, 1}, kRate23976,
                   kRate2997, kRate5994})
      if (std::fabs(r.fps() - f) < 0.005) m.rate = r;
    if (isStill(fc, st)) {
      m.kind = MediaKind::Image;
      m.hasAudio = false;
      m.duration = 0;
      m.color.range = 2;
      return {};
    }
    m.kind = MediaKind::Video;
    if (st->duration != AV_NOPTS_VALUE && st->duration > 0) dur = av_rescale_q(st->duration, st->time_base, kFlickTb);
    // VFR: look at the timestamps of the first packets
    std::vector<int64_t> pts;
    AVPacket* pkt = av_packet_alloc();
    while (pts.size() < 240 && av_read_frame(fc, pkt) >= 0) {
      if (pkt->stream_index == vi && pkt->pts != AV_NOPTS_VALUE) pts.push_back(pkt->pts);
      av_packet_unref(pkt);
    }
    av_packet_free(&pkt);
    std::sort(pts.begin(), pts.end());
    if (pts.size() > 3) {
      std::vector<int64_t> d;
      for (size_t i = 1; i < pts.size(); ++i)
        if (pts[i] > pts[i - 1]) d.push_back(pts[i] - pts[i - 1]);  // duplicates are muxer noise
      if (!d.empty()) {
        auto [lo, hi] = std::minmax_element(d.begin(), d.end());
        m.vfr = double(*hi) / double(*lo) > 1.5;
      }
    }
    AVDictionaryEntry* tc = av_dict_get(st->metadata, "timecode", nullptr, 0);
    if (!tc) tc = av_dict_get(fc->metadata, "timecode", nullptr, 0);
    if (tc) parseTimecode(tc->value, m.rate, m.startTimecode);
  } else {
    m.kind = MediaKind::Audio;
  }
  if (ai >= 0) {
    AVStream* st = fc->streams[ai];
    m.channels = st->codecpar->ch_layout.nb_channels;
    m.sampleRate = st->codecpar->sample_rate;
    m.audioCodec = avcodec_get_name(st->codecpar->codec_id);
    if (st->duration != AV_NOPTS_VALUE && st->duration > 0)
      dur = std::max(dur, av_rescale_q(st->duration, st->time_base, kFlickTb));
  }
  if (dur <= 0 && fc->duration > 0) dur = av_rescale_q(fc->duration, AVRational{1, AV_TIME_BASE}, kFlickTb);
  m.duration = dur;
  if (m.duration <= 0) return "the file has no duration";
  return {};
}

// ——— video ———

struct VideoDecoder::Impl {
  AVFormatContext* fc = nullptr;
  AVCodecContext* cc = nullptr;
  AVStream* st = nullptr;
  int si = -1;
  bool hw = false;
  bool eof = false;  // demuxer and decoder fully drained
  bool flushing = false;
  AVPacket* pkt = nullptr;
  SwsContext* sws = nullptr;
  int rotation = 0;
  ColorInfo color;
  Tick dur = 0;
  Rate rate;
  Tick slop = 0;
  std::unique_ptr<VideoFrame> cur, pending;
  DecodeStats stats;

  ~Impl() {
    sws_freeContext(sws);
    av_packet_free(&pkt);
    avcodec_free_context(&cc);
    avformat_close_input(&fc);
  }

  std::string openCodec(bool wantHw) {
    const AVCodecParameters* cp = st->codecpar;
    const AVCodec* codec = avcodec_find_decoder(cp->codec_id);
    bool hwOk = false;
    if (wantHw && hwDevice()) {
      // the first registered decoder may be a software one (libdav1d for AV1); find one NVDEC can drive
      void* it = nullptr;
      while (const AVCodec* c = av_codec_iterate(&it)) {
        if (!av_codec_is_decoder(c) || c->id != cp->codec_id || (c->capabilities & AV_CODEC_CAP_EXPERIMENTAL)) continue;
        for (int i = 0;; ++i) {
          const AVCodecHWConfig* h = avcodec_get_hw_config(c, i);
          if (!h) break;
          if (h->device_type == AV_HWDEVICE_TYPE_CUDA && (h->methods & AV_CODEC_HW_CONFIG_METHOD_HW_DEVICE_CTX)) hwOk = true;
        }
        if (hwOk) {
          codec = c;
          break;
        }
      }
    }
    if (!hwOk && cp->codec_id == AV_CODEC_ID_AV1) {
      // the native AV1 decoder is hardware-only; dav1d is the software path
      if (const AVCodec* d = avcodec_find_decoder_by_name("libdav1d")) codec = d;
    }
    if (!codec) return "no decoder for " + std::string(avcodec_get_name(cp->codec_id));
    cc = avcodec_alloc_context3(codec);
    avcodec_parameters_to_context(cc, cp);
    cc->pkt_timebase = st->time_base;
    if (hwOk) {
      cc->hw_device_ctx = av_buffer_ref(hwDevice());
      cc->get_format = pickHw;
      // more decode surfaces than the default: we hold frames while compositing
      cc->extra_hw_frames = 4;
    } else {
      cc->thread_count = 0;  // auto
      cc->thread_type = FF_THREAD_FRAME | FF_THREAD_SLICE;
    }
    if (int e = avcodec_open2(cc, codec, nullptr); e < 0) {
      avcodec_free_context(&cc);
      if (hwOk) return openCodec(false);
      return "cannot open the decoder: " + averr(e);
    }
    hw = hwOk;
    return {};
  }

  /** wraps a decoded frame (moving it to the CPU if it came from NVDEC) */
  std::unique_ptr<VideoFrame> wrap(AVFrame* raw) {
    auto out = std::make_unique<VideoFrame>();
    std::shared_ptr<AVFrame> f = newFrame();
    if (raw->format == AV_PIX_FMT_CUDA) {
      if (av_hwframe_transfer_data(f.get(), raw, 0) < 0) return nullptr;
      av_frame_copy_props(f.get(), raw);
      out->hw = true;
    } else {
      av_frame_ref(f.get(), raw);
    }
    const AVPixFmtDescriptor* d = av_pix_fmt_desc_get(AVPixelFormat(f->format));
    out->width = f->width;
    out->height = f->height;
    out->color = color;
    if (f->color_range == AVCOL_RANGE_JPEG) out->color.range = 2;
    if (f->colorspace != AVCOL_SPC_UNSPECIFIED) out->color.matrix = int(f->colorspace);
    if (f->color_trc != AVCOL_TRC_UNSPECIFIED) out->color.transfer = int(f->color_trc);
    out->rotation = rotation;
    bool be = d && (d->flags & AV_PIX_FMT_FLAG_BE);
    bool planarYuv = d && !(d->flags & AV_PIX_FMT_FLAG_RGB) && (d->flags & AV_PIX_FMT_FLAG_PLANAR) &&
                     d->nb_components >= 3 && !(d->flags & AV_PIX_FMT_FLAG_FLOAT) && d->comp[0].depth <= 16 && !be &&
                     d->comp[1].plane == 1 && d->comp[2].plane == 2;
    if (f->format == AV_PIX_FMT_NV12) {
      out->layout = PixelLayout::NV12;
      out->bits = 8;
    } else if (f->format == AV_PIX_FMT_P010LE || f->format == AV_PIX_FMT_P016LE || f->format == AV_PIX_FMT_P012LE) {
      out->layout = PixelLayout::P010;  // MSB-aligned 16-bit samples
      out->bits = 16;
    } else if (planarYuv) {
      out->layout = PixelLayout::Planar;
      out->bits = d->comp[0].depth;
      out->chromaShiftX = d->log2_chroma_w;
      out->chromaShiftY = d->log2_chroma_h;
    } else {
      // RGB, palettes, gray, packed YUV: convert to RGBA once here
      bool deep = d && d->comp[0].depth > 8;
      AVPixelFormat dst = deep ? AV_PIX_FMT_RGBA64LE : AV_PIX_FMT_RGBA;
      sws = sws_getCachedContext(sws, f->width, f->height, AVPixelFormat(f->format), f->width, f->height, dst,
                                 SWS_BICUBIC, nullptr, nullptr, nullptr);
      std::shared_ptr<AVFrame> rgb = newFrame();
      rgb->format = dst;
      rgb->width = f->width;
      rgb->height = f->height;
      if (!sws || av_frame_get_buffer(rgb.get(), 64) < 0) return nullptr;
      sws_scale(sws, f->data, f->linesize, 0, f->height, rgb->data, rgb->linesize);
      av_frame_copy_props(rgb.get(), f.get());
      f = rgb;
      out->layout = deep ? PixelLayout::RGBA16 : PixelLayout::RGBA8;
      out->bits = deep ? 16 : 8;
      out->color.matrix = 0;  // RGB
      out->color.range = 2;
      if (!(d && (d->flags & AV_PIX_FMT_FLAG_RGB))) out->color.matrix = color.matrix;
    }
    int64_t ts = raw->best_effort_timestamp != AV_NOPTS_VALUE ? raw->best_effort_timestamp : raw->pts;
    out->pts = ts == AV_NOPTS_VALUE ? 0 : av_rescale_q(ts - streamStart(st), st->time_base, kFlickTb);
    out->dur = raw->duration > 0 ? av_rescale_q(raw->duration, st->time_base, kFlickTb) : frameTicks(rate);
    out->av = std::move(f);
    return out;
  }

  /** the next decoded frame in stream order, or null at the end */
  std::unique_ptr<VideoFrame> decodeOne() {
    if (eof) return nullptr;
    AVFrame* raw = av_frame_alloc();
    for (;;) {
      int r = avcodec_receive_frame(cc, raw);
      if (r == 0) {
        ++stats.framesDecoded;
        auto f = wrap(raw);
        av_frame_free(&raw);
        if (f) return f;
        raw = av_frame_alloc();
        continue;
      }
      if (r == AVERROR_EOF) {
        eof = true;
        av_frame_free(&raw);
        return nullptr;
      }
      if (r != AVERROR(EAGAIN)) {
        av_frame_free(&raw);
        eof = true;
        return nullptr;
      }
      if (flushing) {
        av_frame_free(&raw);
        eof = true;
        return nullptr;
      }
      int e = av_read_frame(fc, pkt);
      if (e < 0) {
        avcodec_send_packet(cc, nullptr);
        flushing = true;
        continue;
      }
      if (pkt->stream_index == si) avcodec_send_packet(cc, pkt);
      av_packet_unref(pkt);
    }
  }

  void seekTo(Tick t) {
    ++stats.seeks;
    int64_t ts = av_rescale_q(std::max<Tick>(0, t), kFlickTb, st->time_base) + streamStart(st);
    av_seek_frame(fc, si, ts, AVSEEK_FLAG_BACKWARD);
    avcodec_flush_buffers(cc);
    eof = flushing = false;
    cur.reset();
    pending.reset();
  }

  /** the next frame after cur, kept in `pending` */
  VideoFrame* peek() {
    if (!pending) pending = decodeOne();
    // the decoder emits in presentation order, but guard against stray older frames
    while (pending && cur && pending->pts <= cur->pts) pending = decodeOne();
    return pending.get();
  }

  const VideoFrame* get(Tick t) {
    // containers round timestamps to their time base (mkv: 1 ms), so a frame
    // may be stamped up to one unit after its true instant
    t += slop;
    if (cur && t >= cur->pts) {
      VideoFrame* n = peek();
      if (!n) return cur.get();  // past the last frame: it holds
      if (t < n->pts) return cur.get();
      if (n->pts - t < 0 && t - cur->pts > 2 * kFlicks) {
        // far ahead: a seek is cheaper than decoding through
      } else {
        while ((n = peek()) && n->pts <= t) cur = std::move(pending);
        return cur.get();
      }
    }
    // seek, then decode forward; step back further if the demuxer lands late
    Tick back = 0;
    for (int attempt = 0; attempt < 4; ++attempt) {
      seekTo(t - back);
      cur = decodeOne();
      if (!cur) return nullptr;
      if (cur->pts <= t || back > 8 * kFlicks) break;
      back = back ? back * 4 : kFlicks / 2;
    }
    VideoFrame* n;
    while ((n = peek()) && n->pts <= t) cur = std::move(pending);
    return cur.get();
  }
};

VideoDecoder::VideoDecoder() : d_(std::make_unique<Impl>()) {}
VideoDecoder::~VideoDecoder() = default;

std::string VideoDecoder::open(const std::string& path, bool hw) {
  d_ = std::make_unique<Impl>();
  Impl& d = *d_;
  if (int e = avformat_open_input(&d.fc, path.c_str(), nullptr, nullptr); e < 0) return "cannot open: " + averr(e);
  if (int e = avformat_find_stream_info(d.fc, nullptr); e < 0) return "cannot read streams: " + averr(e);
  d.si = bestVideo(d.fc);
  if (d.si < 0) return "no picture in the file";
  d.st = d.fc->streams[d.si];
  for (unsigned i = 0; i < d.fc->nb_streams; ++i)
    if (int(i) != d.si) d.fc->streams[i]->discard = AVDISCARD_ALL;
  d.rotation = rotationOf(d.st);
  d.color = colorOf(d.st->codecpar);
  AVRational fr = d.st->avg_frame_rate.num > 0 ? d.st->avg_frame_rate : d.st->r_frame_rate;
  d.rate = fr.num > 0 && fr.den > 0 ? Rate{fr.num, fr.den} : Rate{30, 1};
  if (d.st->duration != AV_NOPTS_VALUE) d.dur = av_rescale_q(d.st->duration, d.st->time_base, kFlickTb);
  d.slop = std::min<Tick>(av_rescale_q(1, d.st->time_base, kFlickTb), frameTicks(d.rate) / 4);
  d.pkt = av_packet_alloc();
  return d.openCodec(hw);
}

bool VideoDecoder::isOpen() const { return d_->cc != nullptr; }
bool VideoDecoder::hwActive() const { return d_->hw; }
std::string VideoDecoder::codecName() const { return d_->cc ? d_->cc->codec->name : ""; }
const VideoFrame* VideoDecoder::frameAt(Tick t) { return d_->cc ? d_->get(t) : nullptr; }
Tick VideoDecoder::duration() const { return d_->dur; }
const DecodeStats& VideoDecoder::stats() const { return d_->stats; }

const VideoFrame* VideoDecoder::next() {
  if (!d_->cc) return nullptr;
  if (!d_->cur) return d_->get(0);
  if (!d_->peek()) return nullptr;
  d_->cur = std::move(d_->pending);
  return d_->cur.get();
}

// ——— audio ———

struct AudioDecoder::Impl {
  AVFormatContext* fc = nullptr;
  AVCodecContext* cc = nullptr;
  AVStream* st = nullptr;
  SwrContext* swr = nullptr;
  AVPacket* pkt = nullptr;
  AVFrame* frame = nullptr;
  int rate = 48000, ch = 2;
  int64_t length = 0;
  // decoded, resampled output starting at sample index `bufStart`
  std::vector<float> buf;
  int64_t bufStart = 0;
  int64_t nextOut = -1;  // output sample index of the next converted sample; -1 = unknown (after seek)
  bool eof = false;

  ~Impl() {
    av_frame_free(&frame);
    av_packet_free(&pkt);
    swr_free(&swr);
    avcodec_free_context(&cc);
    avformat_close_input(&fc);
  }

  void seek(int64_t sample) {
    // land a little early so the decoder's preroll and the resampler settle before `sample`
    int64_t s = std::max<int64_t>(0, sample - rate / 10);
    int64_t ts = av_rescale_q(s, AVRational{1, rate}, st->time_base) + streamStart(st);
    av_seek_frame(fc, st->index, ts, AVSEEK_FLAG_BACKWARD);
    avcodec_flush_buffers(cc);
    swr_init(swr);
    buf.clear();
    bufStart = 0;
    nextOut = -1;
    eof = false;
  }

  /** decodes one more chunk into buf; false at the end */
  bool pump() {
    if (eof) return false;
    for (;;) {
      int r = avcodec_receive_frame(cc, frame);
      if (r == 0) {
        if (nextOut < 0) {
          int64_t ts = frame->best_effort_timestamp != AV_NOPTS_VALUE ? frame->best_effort_timestamp : frame->pts;
          nextOut = ts == AV_NOPTS_VALUE ? 0 : av_rescale_q(ts - streamStart(st), st->time_base, AVRational{1, rate});
          bufStart = nextOut;
        }
        int maxOut = swr_get_out_samples(swr, frame->nb_samples);
        std::vector<float> tmp(size_t(std::max(0, maxOut)) * ch);
        uint8_t* outp = reinterpret_cast<uint8_t*>(tmp.data());
        int n = swr_convert(swr, &outp, maxOut, const_cast<const uint8_t**>(frame->extended_data), frame->nb_samples);
        av_frame_unref(frame);
        if (n > 0) {
          buf.insert(buf.end(), tmp.begin(), tmp.begin() + size_t(n) * ch);
          nextOut += n;
          return true;
        }
        continue;
      }
      if (r == AVERROR_EOF) {
        eof = true;
        return false;
      }
      if (r != AVERROR(EAGAIN)) {
        eof = true;
        return false;
      }
      int e = av_read_frame(fc, pkt);
      if (e < 0) {
        avcodec_send_packet(cc, nullptr);
        continue;
      }
      if (pkt->stream_index == st->index) avcodec_send_packet(cc, pkt);
      av_packet_unref(pkt);
    }
  }
};

AudioDecoder::AudioDecoder() : d_(std::make_unique<Impl>()) {}
AudioDecoder::~AudioDecoder() = default;

std::string AudioDecoder::open(const std::string& path, int sampleRate, int channels) {
  d_ = std::make_unique<Impl>();
  Impl& d = *d_;
  d.rate = sampleRate;
  d.ch = channels;
  if (int e = avformat_open_input(&d.fc, path.c_str(), nullptr, nullptr); e < 0) return "cannot open: " + averr(e);
  if (int e = avformat_find_stream_info(d.fc, nullptr); e < 0) return "cannot read streams: " + averr(e);
  int ai = av_find_best_stream(d.fc, AVMEDIA_TYPE_AUDIO, -1, -1, nullptr, 0);
  if (ai < 0) return "no sound in the file";
  d.st = d.fc->streams[ai];
  for (unsigned i = 0; i < d.fc->nb_streams; ++i)
    if (int(i) != ai) d.fc->streams[i]->discard = AVDISCARD_ALL;
  const AVCodec* codec = avcodec_find_decoder(d.st->codecpar->codec_id);
  if (!codec) return "no decoder for the sound";
  d.cc = avcodec_alloc_context3(codec);
  avcodec_parameters_to_context(d.cc, d.st->codecpar);
  d.cc->pkt_timebase = d.st->time_base;
  if (int e = avcodec_open2(d.cc, codec, nullptr); e < 0) return "cannot open the sound decoder: " + averr(e);
  AVChannelLayout out;
  av_channel_layout_default(&out, channels);
  AVChannelLayout in = d.cc->ch_layout;
  if (in.order == AV_CHANNEL_ORDER_UNSPEC) av_channel_layout_default(&in, in.nb_channels);
  if (swr_alloc_set_opts2(&d.swr, &out, AV_SAMPLE_FMT_FLT, sampleRate, &in, d.cc->sample_fmt, d.cc->sample_rate, 0,
                          nullptr) < 0)
    return "cannot set up resampling";
  // a mono source plays at full level on both sides, as every NLE does (swr's default is −3 dB)
  if (in.nb_channels == 1) {
    std::vector<double> ones(size_t(channels), 1.0);
    swr_set_matrix(d.swr, ones.data(), 1);
  }
  if (swr_init(d.swr) < 0)
    return "cannot set up resampling";
  d.pkt = av_packet_alloc();
  d.frame = av_frame_alloc();
  Tick dur = d.st->duration != AV_NOPTS_VALUE ? av_rescale_q(d.st->duration, d.st->time_base, kFlickTb)
                                              : av_rescale_q(d.fc->duration, AVRational{1, AV_TIME_BASE}, kFlickTb);
  d.length = sampleAt(dur, sampleRate);
  return {};
}

bool AudioDecoder::isOpen() const { return d_->cc != nullptr; }
int64_t AudioDecoder::lengthSamples() const { return d_->length; }
int AudioDecoder::sampleRate() const { return d_->rate; }
int AudioDecoder::channels() const { return d_->ch; }

void AudioDecoder::read(int64_t at, float* out, int frames) {
  Impl& d = *d_;
  const int ch = d.ch;
  std::fill(out, out + size_t(frames) * ch, 0.f);
  if (!d.cc || frames <= 0) return;
  int64_t end = at + frames;
  if (end <= 0) return;
  // reuse what is buffered when the read continues from it; otherwise seek
  int64_t bufEnd = d.bufStart + int64_t(d.buf.size()) / ch;
  bool inBuf = d.nextOut >= 0 && at >= d.bufStart && at <= bufEnd + d.rate / 4;
  if (!inBuf) d.seek(std::max<int64_t>(0, at));
  // drop what is before `at` to keep the buffer small
  for (;;) {
    bufEnd = d.bufStart + int64_t(d.buf.size()) / ch;
    if (bufEnd >= end) break;
    if (!d.pump()) break;
    if (d.bufStart < at && d.nextOut >= 0) {
      int64_t drop = std::min<int64_t>(at - d.bufStart, int64_t(d.buf.size()) / ch);
      d.buf.erase(d.buf.begin(), d.buf.begin() + size_t(drop) * ch);
      d.bufStart += drop;
    }
  }
  bufEnd = d.bufStart + int64_t(d.buf.size()) / ch;
  int64_t from = std::max(at, d.bufStart), to = std::min(end, bufEnd);
  for (int64_t s = from; s < to; ++s)
    for (int c = 0; c < ch; ++c) out[size_t(s - at) * ch + c] = d.buf[size_t(s - d.bufStart) * ch + c];
}

}  // namespace rhap
