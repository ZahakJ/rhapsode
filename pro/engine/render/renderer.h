#pragma once
// Turns a sequence at a time into pixels on the GPU. One renderer serves the
// viewer and the exporter, so what plays is what exports.
//
//   evaluate → per layer: frame from the FrameSource, planes uploaded →
//   layer.frag (decode to linear, grade) blended into an RGBA16F working
//   image → output.frag (to the display / file encoding, or to Y'CbCr planes)

#include <array>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

#include "../gfx/color.h"
#include "../gfx/gpu.h"
#include "../media/decode.h"
#include "evaluate.h"

namespace rhap {

/** Where the renderer gets decoded pictures. */
class FrameSource {
 public:
  virtual ~FrameSource() = default;
  /** the frame of media `m` showing at media time t, for the decoder identity `slot` */
  virtual const VideoFrame* video(const Media& m, const std::string& slot, Tick t) = 0;
};

/** A decoder per slot (clip), opened on demand, least recently used closed first. */
class DecoderPool : public FrameSource {
 public:
  explicit DecoderPool(bool hw = true, size_t capacity = 32) : hw_(hw), cap_(capacity) {}
  const VideoFrame* video(const Media& m, const std::string& slot, Tick t) override;
  void setProxies(bool on) { proxies_ = on; }
  bool proxies() const { return proxies_; }
  void clear();
  int64_t framesDecoded() const;

 private:
  struct Entry {
    std::unique_ptr<VideoDecoder> dec;
    uint64_t used = 0;
    std::string error;
  };
  std::map<std::string, Entry> decs_;
  bool hw_, proxies_ = false;
  size_t cap_;
  uint64_t clock_ = 0;
};

struct RenderStats {
  int layers = 0;
  int uploads = 0;
  double uploadMB = 0;
};

class Renderer {
 public:
  Renderer(gfx::Gpu& gpu, FrameSource& frames);
  ~Renderer();

  /** composites `s` at t into `target` (created/resized to the sequence size, RGBA16F) */
  std::string render(SDL_GPUCommandBuffer* cmd, const Project& p, const Sequence& s, Tick t, gfx::Texture& target);

  /** working-linear `src` → `dst` encoded for output `o` (RGB), background flattened when flatten */
  void output(SDL_GPUCommandBuffer* cmd, const gfx::Texture& src, gfx::Texture& dst, const Project& p,
              std::array<double, 3> background, bool flatten = true);

  struct YuvTarget {
    int matrix = 1;        // AVColorSpace
    bool fullRange = false;
    int bits = 8;          // code bits
    int shift = 0;         // MSB alignment within the texel (P010: 6)
    int chromaShiftX = 1, chromaShiftY = 1;
  };
  /** Y plane into y (R8/R16, full size) and CbCr into uv (RG8/RG16, chroma size) */
  void outputYuv(SDL_GPUCommandBuffer* cmd, const gfx::Texture& src, gfx::Texture& y, gfx::Texture& uv,
                 const Project& p, std::array<double, 3> background, const YuvTarget& fmt);

  const RenderStats& stats() const { return stats_; }

 private:
  struct Prep;
  struct SlotTex;
  std::string renderInto(SDL_GPUCommandBuffer* cmd, const Project& p, const Sequence& s, Tick t, gfx::Texture& target,
                         int depth, int onlyTrack);
  bool prepareMedia(const Project& p, const LayerDraw& l, const Sequence& s, Prep& out);
  void prepareGrade(const Project& p, const Clip& c, Prep& out);
  gfx::Texture& scratch(int depth, int index, int w, int h);
  void drawQuad(SDL_GPURenderPass* pass, SDL_GPUCommandBuffer* cmd, const Prep& pr, SDL_GPUTextureFormat fmt);
  void pass(SDL_GPUCommandBuffer* cmd, const gfx::Texture& src, gfx::Texture& dst, const void* uniforms, size_t size,
            SDL_GPUGraphicsPipeline* pipe, const gfx::Texture* second = nullptr);
  /** an OCIO transform baked to a 3D LUT texture, cached; null when OCIO is absent or the names are wrong */
  const gfx::Texture* ocioLut(SDL_GPUCommandBuffer* cmd, const std::string& key, bool output, const std::string& config, const std::string& a,
                              const std::string& b);

  gfx::Gpu& gpu_;
  FrameSource& frames_;
  std::map<std::string, std::unique_ptr<SlotTex>> slots_;
  std::map<std::string, gfx::Texture> titles_, curves_, luts_, ocioLuts_;
  std::map<std::string, color::Lut3D> lutData_;
  std::map<std::pair<int, int>, gfx::Texture> scratch_;  // map: references stay valid as it grows
  RenderStats stats_;
  // uploads gathered while preparing, flushed in one copy pass
  struct Upload {
    gfx::Texture* tex;
    const uint8_t* data;
    int stride, rowBytes, rows, layers;
    std::shared_ptr<void> keep;  // keeps the bytes alive until the pass
  };
  std::vector<Upload> uploads_;
};

}  // namespace rhap
