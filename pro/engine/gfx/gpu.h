#pragma once
// A thin layer over SDL3 GPU (Vulkan here): textures, staged uploads,
// blocking readback, and the editor's few pipelines. Works without a window
// for export and tests.

#include <SDL3/SDL_gpu.h>

#include <cstdint>
#include <map>
#include <string>
#include <vector>

namespace rhap::gfx {

struct Texture {
  SDL_GPUTexture* tex = nullptr;
  int w = 0, h = 0, d = 1;
  SDL_GPUTextureFormat fmt = SDL_GPU_TEXTUREFORMAT_INVALID;
  explicit operator bool() const { return tex != nullptr; }
};

enum class BlendMode { None, Normal, Add, Multiply, Screen };

/** bytes per texel of a format we use */
int texelBytes(SDL_GPUTextureFormat f);

class Gpu {
 public:
  Gpu() = default;
  ~Gpu();
  Gpu(const Gpu&) = delete;
  Gpu& operator=(const Gpu&) = delete;

  /** headless when window is null; returns "" or the reason */
  std::string init(SDL_Window* window = nullptr, bool debug = false);
  void shutdown();
  SDL_GPUDevice* device() const { return dev_; }
  SDL_Window* window() const { return window_; }
  bool ok() const { return dev_ != nullptr; }

  Texture make(int w, int h, SDL_GPUTextureFormat fmt, SDL_GPUTextureUsageFlags usage, int depth = 1);
  void release(Texture& t);
  /** (re)creates `t` only when its size or format differ */
  void ensure(Texture& t, int w, int h, SDL_GPUTextureFormat fmt, SDL_GPUTextureUsageFlags usage);

  /**
   * Queues an upload of rows of `rowBytes` (source stride `stride`) into t,
   * through a staging buffer that grows as needed. Call between beginUploads
   * and endUploads, which wrap one copy pass on `cmd`.
   */
  void beginUploads(SDL_GPUCommandBuffer* cmd);
  void upload(Texture& t, const void* data, int stride, int rowBytes, int rows, int layers = 1);
  void endUploads();

  /** Blocking: copies a texture back to the CPU, tightly packed. */
  std::vector<uint8_t> download(const Texture& t);
  /** Queues a download into an internal buffer; collect with fetchDownload after the command buffer's fence. */
  void wait();

  SDL_GPUGraphicsPipeline* layerPipeline(BlendMode b, SDL_GPUTextureFormat target);
  SDL_GPUGraphicsPipeline* outputPipeline(SDL_GPUTextureFormat target);
  SDL_GPUGraphicsPipeline* blurPipeline(SDL_GPUTextureFormat target);
  SDL_GPUSampler* linear() const { return linear_; }
  SDL_GPUSampler* nearest() const { return nearest_; }

  /** 1×1 placeholders for unused sampler slots */
  const Texture& dummy2D() const { return dummy2d_; }
  const Texture& dummy3D() const { return dummy3d_; }

 private:
  SDL_GPUGraphicsPipeline* makePipeline(const char* frag, int samplers, BlendMode b, SDL_GPUTextureFormat target);
  SDL_GPUShader* shader(const char* name, SDL_GPUShaderStage stage, int samplers, int uniforms);

  SDL_GPUDevice* dev_ = nullptr;
  SDL_Window* window_ = nullptr;
  SDL_GPUSampler *linear_ = nullptr, *nearest_ = nullptr;
  Texture dummy2d_, dummy3d_;
  std::map<std::string, SDL_GPUShader*> shaders_;
  std::map<std::tuple<std::string, int, int>, SDL_GPUGraphicsPipeline*> pipelines_;

  // staging
  SDL_GPUCommandBuffer* upCmd_ = nullptr;
  SDL_GPUCopyPass* upPass_ = nullptr;
  SDL_GPUTransferBuffer* stage_ = nullptr;
  uint32_t stageSize_ = 0, stageUsed_ = 0;
  uint8_t* stageMap_ = nullptr;
  struct Pending {
    Texture t;
    uint32_t offset;
    int rowBytes, rows, layers;
  };
  std::vector<Pending> pending_;
  void flushPending();
};

}  // namespace rhap::gfx
