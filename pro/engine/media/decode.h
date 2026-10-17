#pragma once
// Media access: probing, frame-exact video decode, sample-exact audio decode.
//
// Time inside a media item starts at its first frame (the stream's start_time
// is subtracted), in flicks. Frames are found by their real timestamps, so
// variable-frame-rate phone footage plays at the instants it was shot, and a
// seek is exact whatever the GOP structure: seek back to a keyframe, decode
// forward to the frame that covers the asked time.

#include <memory>
#include <string>
#include <vector>

#include "../model/model.h"

struct AVFrame;

namespace rhap {

/** Fills a Media from a file; returns "" or why it could not be read. */
std::string probe(const std::string& path, Media& out);

enum class PixelLayout { NV12, P010, Planar, RGBA8, RGBA16 };

struct VideoFrame {
  std::shared_ptr<AVFrame> av;  // a CPU frame
  Tick pts = 0;                 // media time of this frame
  Tick dur = 0;                 // until the next frame
  int width = 0, height = 0;
  PixelLayout layout = PixelLayout::NV12;
  int chromaShiftX = 1, chromaShiftY = 1;  // planar: log2 subsampling
  int bits = 8;                            // significant bits per sample
  ColorInfo color;
  int rotation = 0;  // degrees clockwise to display upright
  bool hw = false;   // decoded on the GPU (NVDEC)
  bool onGpu = false;  // still on the GPU: not yet copied for display (internal to the decoder)
  const uint8_t* plane(int i) const;
  int stride(int i) const;
};

struct DecodeStats {
  int64_t framesDecoded = 0, seeks = 0;
};

class VideoDecoder {
 public:
  VideoDecoder();
  ~VideoDecoder();
  VideoDecoder(const VideoDecoder&) = delete;
  VideoDecoder& operator=(const VideoDecoder&) = delete;

  /** hw: try NVDEC first, fall back to software silently (hwActive() says which) */
  std::string open(const std::string& path, bool hw = true);
  bool isOpen() const;
  bool hwActive() const;
  std::string codecName() const;

  /** the frame on screen at media time t (the last frame whose pts ≤ t); null on failure */
  const VideoFrame* frameAt(Tick t);
  /** the frame after the current one, decoding it if needed (for playback ahead of the clock) */
  const VideoFrame* next();
  Tick duration() const;
  const DecodeStats& stats() const;

 private:
  struct Impl;
  std::unique_ptr<Impl> d_;
};

/** Decodes a media item's first audio stream to interleaved float at a fixed rate and layout. */
class AudioDecoder {
 public:
  AudioDecoder();
  ~AudioDecoder();
  AudioDecoder(const AudioDecoder&) = delete;
  AudioDecoder& operator=(const AudioDecoder&) = delete;

  std::string open(const std::string& path, int sampleRate = 48000, int channels = 2);
  bool isOpen() const;
  /** fills `frames` sample frames starting at media sample index `at` (silence past either end) */
  void read(int64_t at, float* out, int frames);
  int64_t lengthSamples() const;
  int sampleRate() const;
  int channels() const;

 private:
  struct Impl;
  std::unique_ptr<Impl> d_;
};

/** Is the NVDEC path usable on this machine? Probed once. */
bool nvdecAvailable();

}  // namespace rhap
