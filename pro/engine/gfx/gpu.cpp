#include "gpu.h"

#include <SDL3/SDL.h>

#include <cstring>
#include <tuple>

#include "rhap_shaders.h"

namespace rhap::gfx {

namespace {
const shaders::Blob* blobOf(const std::string& name) {
  if (name == "quad.vert") return &shaders::quad_vert;
  if (name == "layer.frag") return &shaders::layer_frag;
  if (name == "output.frag") return &shaders::output_frag;
  if (name == "blur.frag") return &shaders::blur_frag;
  return nullptr;
}
}  // namespace

int texelBytes(SDL_GPUTextureFormat f) {
  switch (f) {
    case SDL_GPU_TEXTUREFORMAT_R8_UNORM: return 1;
    case SDL_GPU_TEXTUREFORMAT_R8G8_UNORM:
    case SDL_GPU_TEXTUREFORMAT_R16_UNORM:
    case SDL_GPU_TEXTUREFORMAT_R16_FLOAT: return 2;
    case SDL_GPU_TEXTUREFORMAT_R16G16_UNORM:
    case SDL_GPU_TEXTUREFORMAT_R8G8B8A8_UNORM:
    case SDL_GPU_TEXTUREFORMAT_B8G8R8A8_UNORM:
    case SDL_GPU_TEXTUREFORMAT_R10G10B10A2_UNORM:
    case SDL_GPU_TEXTUREFORMAT_R32_FLOAT:
    case SDL_GPU_TEXTUREFORMAT_R32_UINT: return 4;
    case SDL_GPU_TEXTUREFORMAT_R16G16B16A16_UNORM:
    case SDL_GPU_TEXTUREFORMAT_R16G16B16A16_FLOAT: return 8;
    case SDL_GPU_TEXTUREFORMAT_R32G32B32A32_FLOAT: return 16;
    default: return 4;
  }
}

Gpu::~Gpu() { shutdown(); }

std::string Gpu::init(SDL_Window* window, bool debug) {
  if (!SDL_WasInit(SDL_INIT_VIDEO) && !SDL_InitSubSystem(SDL_INIT_VIDEO)) {
    // no display (a render node, CI): SDL's offscreen driver still opens the GPU
    SDL_SetHint(SDL_HINT_VIDEO_DRIVER, "offscreen");
    if (!SDL_InitSubSystem(SDL_INIT_VIDEO)) return std::string("no video subsystem: ") + SDL_GetError();
  }
  dev_ = SDL_CreateGPUDevice(SDL_GPU_SHADERFORMAT_SPIRV, debug, nullptr);
  if (!dev_) return std::string("no GPU device: ") + SDL_GetError();
  if (window) {
    if (!SDL_ClaimWindowForGPUDevice(dev_, window)) {
      std::string e = SDL_GetError();
      SDL_DestroyGPUDevice(dev_);
      dev_ = nullptr;
      return "cannot use the window: " + e;
    }
    window_ = window;
  }
  SDL_GPUSamplerCreateInfo s{};
  s.min_filter = s.mag_filter = SDL_GPU_FILTER_LINEAR;
  s.mipmap_mode = SDL_GPU_SAMPLERMIPMAPMODE_NEAREST;
  s.address_mode_u = s.address_mode_v = s.address_mode_w = SDL_GPU_SAMPLERADDRESSMODE_CLAMP_TO_EDGE;
  linear_ = SDL_CreateGPUSampler(dev_, &s);
  s.min_filter = s.mag_filter = SDL_GPU_FILTER_NEAREST;
  nearest_ = SDL_CreateGPUSampler(dev_, &s);
  dummy2d_ = make(1, 1, SDL_GPU_TEXTUREFORMAT_R8G8B8A8_UNORM, SDL_GPU_TEXTUREUSAGE_SAMPLER);
  dummy3d_ = make(2, 2, SDL_GPU_TEXTUREFORMAT_R16G16B16A16_FLOAT, SDL_GPU_TEXTUREUSAGE_SAMPLER, 2);
  if (!dummy2d_ || !dummy3d_) return std::string("cannot create textures: ") + SDL_GetError();
  SDL_GPUCommandBuffer* cmd = SDL_AcquireGPUCommandBuffer(dev_);
  beginUploads(cmd);
  uint8_t white[4] = {255, 255, 255, 255};
  upload(dummy2d_, white, 4, 4, 1);
  std::vector<uint16_t> zero(2 * 2 * 2 * 4, 0);
  upload(dummy3d_, zero.data(), 16, 16, 2, 2);
  endUploads();
  SDL_SubmitGPUCommandBuffer(cmd);
  return {};
}

void Gpu::shutdown() {
  if (!dev_) return;
  SDL_WaitForGPUIdle(dev_);
  for (auto& [k, p] : pipelines_) SDL_ReleaseGPUGraphicsPipeline(dev_, p);
  pipelines_.clear();
  for (auto& [k, s] : shaders_) SDL_ReleaseGPUShader(dev_, s);
  shaders_.clear();
  release(dummy2d_);
  release(dummy3d_);
  if (stage_) SDL_ReleaseGPUTransferBuffer(dev_, stage_);
  stage_ = nullptr;
  if (linear_) SDL_ReleaseGPUSampler(dev_, linear_);
  if (nearest_) SDL_ReleaseGPUSampler(dev_, nearest_);
  linear_ = nearest_ = nullptr;
  if (window_) SDL_ReleaseWindowFromGPUDevice(dev_, window_);
  SDL_DestroyGPUDevice(dev_);
  dev_ = nullptr;
  window_ = nullptr;
}

Texture Gpu::make(int w, int h, SDL_GPUTextureFormat fmt, SDL_GPUTextureUsageFlags usage, int depth) {
  SDL_GPUTextureCreateInfo ti{};
  ti.type = depth > 1 ? SDL_GPU_TEXTURETYPE_3D : SDL_GPU_TEXTURETYPE_2D;
  ti.format = fmt;
  ti.usage = usage;
  ti.width = uint32_t(w);
  ti.height = uint32_t(h);
  ti.layer_count_or_depth = uint32_t(depth);
  ti.num_levels = 1;
  ti.sample_count = SDL_GPU_SAMPLECOUNT_1;
  Texture t;
  t.tex = SDL_CreateGPUTexture(dev_, &ti);
  if (!t.tex) return t;
  t.w = w;
  t.h = h;
  t.d = depth;
  t.fmt = fmt;
  return t;
}

void Gpu::release(Texture& t) {
  if (t.tex && dev_) SDL_ReleaseGPUTexture(dev_, t.tex);
  t = {};
}

void Gpu::ensure(Texture& t, int w, int h, SDL_GPUTextureFormat fmt, SDL_GPUTextureUsageFlags usage) {
  if (t.tex && t.w == w && t.h == h && t.fmt == fmt) return;
  release(t);
  t = make(w, h, fmt, usage);
}

void Gpu::beginUploads(SDL_GPUCommandBuffer* cmd) {
  upCmd_ = cmd;
  upPass_ = SDL_BeginGPUCopyPass(cmd);
}

void Gpu::upload(Texture& t, const void* data, int stride, int rowBytes, int rows, int layers) {
  if (!upPass_ || !t.tex) return;
  uint32_t need = uint32_t(rowBytes) * uint32_t(rows) * uint32_t(layers);
  if (need > stageSize_) {
    if (stage_) SDL_ReleaseGPUTransferBuffer(dev_, stage_);
    stageSize_ = need + need / 4;
    SDL_GPUTransferBufferCreateInfo bi{SDL_GPU_TRANSFERBUFFERUSAGE_UPLOAD, stageSize_, 0};
    stage_ = SDL_CreateGPUTransferBuffer(dev_, &bi);
    if (!stage_) {
      stageSize_ = 0;
      return;
    }
  }
  // cycling gives a fresh backing store whenever the last one is still queued
  auto* map = static_cast<uint8_t*>(SDL_MapGPUTransferBuffer(dev_, stage_, true));
  if (!map) return;
  const auto* src = static_cast<const uint8_t*>(data);
  if (stride == rowBytes) {
    std::memcpy(map, src, need);
  } else {
    for (int l = 0; l < layers; ++l)
      for (int y = 0; y < rows; ++y)
        std::memcpy(map + (size_t(l) * rows + y) * rowBytes, src + (size_t(l) * rows + y) * stride, size_t(rowBytes));
  }
  SDL_UnmapGPUTransferBuffer(dev_, stage_);
  SDL_GPUTextureTransferInfo from{stage_, 0, uint32_t(rowBytes / texelBytes(t.fmt)), uint32_t(rows)};
  SDL_GPUTextureRegion to{};
  to.texture = t.tex;
  to.w = uint32_t(rowBytes / texelBytes(t.fmt));
  to.h = uint32_t(rows);
  to.d = uint32_t(layers);
  SDL_UploadToGPUTexture(upPass_, &from, &to, t.d == 1);
}

void Gpu::endUploads() {
  if (upPass_) SDL_EndGPUCopyPass(upPass_);
  upPass_ = nullptr;
  upCmd_ = nullptr;
}

void Gpu::flushPending() { pending_.clear(); }

std::vector<uint8_t> Gpu::download(const Texture& t) {
  std::vector<uint8_t> out;
  if (!t.tex) return out;
  uint32_t size = uint32_t(t.w) * uint32_t(t.h) * uint32_t(texelBytes(t.fmt));
  SDL_GPUTransferBufferCreateInfo bi{SDL_GPU_TRANSFERBUFFERUSAGE_DOWNLOAD, size, 0};
  SDL_GPUTransferBuffer* tb = SDL_CreateGPUTransferBuffer(dev_, &bi);
  if (!tb) return out;
  SDL_GPUCommandBuffer* cmd = SDL_AcquireGPUCommandBuffer(dev_);
  SDL_GPUCopyPass* cp = SDL_BeginGPUCopyPass(cmd);
  SDL_GPUTextureRegion src{};
  src.texture = t.tex;
  src.w = uint32_t(t.w);
  src.h = uint32_t(t.h);
  src.d = 1;
  SDL_GPUTextureTransferInfo dst{tb, 0, uint32_t(t.w), uint32_t(t.h)};
  SDL_DownloadFromGPUTexture(cp, &src, &dst);
  SDL_EndGPUCopyPass(cp);
  SDL_GPUFence* fence = SDL_SubmitGPUCommandBufferAndAcquireFence(cmd);
  if (fence) {
    SDL_WaitForGPUFences(dev_, true, &fence, 1);
    SDL_ReleaseGPUFence(dev_, fence);
  }
  const auto* map = static_cast<const uint8_t*>(SDL_MapGPUTransferBuffer(dev_, tb, false));
  if (map) out.assign(map, map + size);
  SDL_UnmapGPUTransferBuffer(dev_, tb);
  SDL_ReleaseGPUTransferBuffer(dev_, tb);
  return out;
}

void Gpu::wait() {
  if (dev_) SDL_WaitForGPUIdle(dev_);
}

SDL_GPUShader* Gpu::shader(const char* name, SDL_GPUShaderStage stage, int samplers, int uniforms) {
  auto it = shaders_.find(name);
  if (it != shaders_.end()) return it->second;
  const shaders::Blob* b = blobOf(name);
  if (!b) return nullptr;
  SDL_GPUShaderCreateInfo si{};
  si.code = b->data;
  si.code_size = b->size;
  si.entrypoint = "main";
  si.format = SDL_GPU_SHADERFORMAT_SPIRV;
  si.stage = stage;
  si.num_samplers = uint32_t(samplers);
  si.num_uniform_buffers = uint32_t(uniforms);
  SDL_GPUShader* s = SDL_CreateGPUShader(dev_, &si);
  if (s) shaders_[name] = s;
  return s;
}

SDL_GPUGraphicsPipeline* Gpu::makePipeline(const char* frag, int samplers, BlendMode b, SDL_GPUTextureFormat target) {
  auto key = std::make_tuple(std::string(frag), int(b), int(target));
  auto it = pipelines_.find(key);
  if (it != pipelines_.end()) return it->second;
  SDL_GPUShader* vs = shader("quad.vert", SDL_GPU_SHADERSTAGE_VERTEX, 0, 1);
  SDL_GPUShader* fs = shader(frag, SDL_GPU_SHADERSTAGE_FRAGMENT, samplers, 1);
  if (!vs || !fs) return nullptr;
  SDL_GPUColorTargetDescription ct{};
  ct.format = target;
  SDL_GPUColorTargetBlendState& bs = ct.blend_state;
  bs.enable_blend = b != BlendMode::None;
  bs.color_blend_op = bs.alpha_blend_op = SDL_GPU_BLENDOP_ADD;
  bs.src_alpha_blendfactor = SDL_GPU_BLENDFACTOR_ONE;
  bs.dst_alpha_blendfactor = SDL_GPU_BLENDFACTOR_ONE_MINUS_SRC_ALPHA;
  switch (b) {
    case BlendMode::None:
    case BlendMode::Normal:
      bs.src_color_blendfactor = SDL_GPU_BLENDFACTOR_ONE;
      bs.dst_color_blendfactor = SDL_GPU_BLENDFACTOR_ONE_MINUS_SRC_ALPHA;
      break;
    case BlendMode::Add:
      bs.src_color_blendfactor = SDL_GPU_BLENDFACTOR_ONE;
      bs.dst_color_blendfactor = SDL_GPU_BLENDFACTOR_ONE;
      break;
    case BlendMode::Multiply:
      bs.src_color_blendfactor = SDL_GPU_BLENDFACTOR_DST_COLOR;
      bs.dst_color_blendfactor = SDL_GPU_BLENDFACTOR_ONE_MINUS_SRC_ALPHA;
      break;
    case BlendMode::Screen:
      bs.src_color_blendfactor = SDL_GPU_BLENDFACTOR_ONE;
      bs.dst_color_blendfactor = SDL_GPU_BLENDFACTOR_ONE_MINUS_SRC_COLOR;
      break;
  }
  SDL_GPUGraphicsPipelineCreateInfo pi{};
  pi.vertex_shader = vs;
  pi.fragment_shader = fs;
  pi.primitive_type = SDL_GPU_PRIMITIVETYPE_TRIANGLESTRIP;
  pi.rasterizer_state.fill_mode = SDL_GPU_FILLMODE_FILL;
  pi.rasterizer_state.cull_mode = SDL_GPU_CULLMODE_NONE;
  pi.target_info.color_target_descriptions = &ct;
  pi.target_info.num_color_targets = 1;
  SDL_GPUGraphicsPipeline* p = SDL_CreateGPUGraphicsPipeline(dev_, &pi);
  if (p) pipelines_[key] = p;
  return p;
}

SDL_GPUGraphicsPipeline* Gpu::layerPipeline(BlendMode b, SDL_GPUTextureFormat target) {
  return makePipeline("layer.frag", 6, b, target);
}
SDL_GPUGraphicsPipeline* Gpu::outputPipeline(SDL_GPUTextureFormat target) {
  return makePipeline("output.frag", 2, BlendMode::None, target);
}
SDL_GPUGraphicsPipeline* Gpu::blurPipeline(SDL_GPUTextureFormat target) {
  return makePipeline("blur.frag", 1, BlendMode::None, target);
}

}  // namespace rhap::gfx
