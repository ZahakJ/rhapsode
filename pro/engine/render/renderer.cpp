#include "renderer.h"

extern "C" {
#include <libavutil/frame.h>
}

#include <algorithm>
#include <cmath>
#include <cstring>
#include <sstream>

#include "../gfx/text.h"

namespace rhap {

using gfx::Texture;

// ——— decoder pool ———

const VideoFrame* DecoderPool::video(const Media& m, const std::string& slot, Tick t) {
  const std::string& path = proxies_ && !m.proxy.empty() ? m.proxy : m.path;
  std::string key = slot + "|" + path;
  Entry& e = decs_[key];
  e.used = ++clock_;
  if (!e.dec) {
    if (!e.error.empty()) return nullptr;
    e.dec = std::make_unique<VideoDecoder>();
    e.error = e.dec->open(path, hw_);
    if (!e.error.empty()) {
      e.dec.reset();
      return nullptr;
    }
    while (decs_.size() > cap_) {
      auto old = std::min_element(decs_.begin(), decs_.end(), [](auto& a, auto& b) { return a.second.used < b.second.used; });
      if (old->first == key) break;
      decs_.erase(old);
    }
  }
  return e.dec->frameAt(m.kind == MediaKind::Image ? 0 : t);
}

void DecoderPool::clear() { decs_.clear(); }

int64_t DecoderPool::framesDecoded() const {
  int64_t n = 0;
  for (auto& [k, e] : decs_)
    if (e.dec) n += e.dec->stats().framesDecoded;
  return n;
}

// ——— uniforms (std140 mirrors of the shaders) ———

namespace {

struct QuadU {
  float c[4][4];
};

struct LayerU {
  float yuvR[4], yuvG[4], yuvB[4];
  float gamR[4], gamG[4], gamB[4];
  float p0[4], p1[4];
  float lift[4], gammaInv[4], gain[4], offset[4];
  float p2[4], wb[4], lutDom[4], lutInv[4];
  float fill[4], shape[4];
};

struct OutputU {
  float gamR[4], gamG[4], gamB[4];
  float yuvY[4], yuvU[4], yuvV[4];
  float bg[4], p0[4];
};

struct BlurU {
  float p[4];
};

void row3(float* dst, const color::Mat3& m, int r) {
  dst[0] = float(m[size_t(r * 3)]);
  dst[1] = float(m[size_t(r * 3 + 1)]);
  dst[2] = float(m[size_t(r * 3 + 2)]);
  dst[3] = 0;
}

void row4(float* dst, const std::array<double, 16>& m, int r) {
  for (int k = 0; k < 4; ++k) dst[k] = float(m[size_t(r * 4 + k)]);
}

QuadU quadOf(const Quad& q) {
  QuadU u{};
  for (int i = 0; i < 4; ++i) {
    u.c[i][0] = float(q.ndc[size_t(i * 2)]);
    u.c[i][1] = float(q.ndc[size_t(i * 2 + 1)]);
    u.c[i][2] = float(q.uv[size_t(i * 2)]);
    u.c[i][3] = float(q.uv[size_t(i * 2 + 1)]);
  }
  return u;
}

QuadU fullQuad() {
  Quad q{{-1, 1, 1, 1, -1, -1, 1, -1}, {0, 0, 1, 0, 0, 1, 1, 1}};
  return quadOf(q);
}

gfx::BlendMode blendOf(Blend b) {
  switch (b) {
    case Blend::Add: return gfx::BlendMode::Add;
    case Blend::Multiply: return gfx::BlendMode::Multiply;
    case Blend::Screen: return gfx::BlendMode::Screen;
    default: return gfx::BlendMode::Normal;
  }
}

const Effect* effect(const Clip& c, const char* type) {
  for (auto& e : c.fx)
    if (e.enabled && e.type == type) return &e;
  return nullptr;
}

double param(const Effect* e, const char* name, Tick local, double fallback) {
  if (!e) return fallback;
  auto it = e->params.find(name);
  return it == e->params.end() ? fallback : it->second.at(local);
}

constexpr SDL_GPUTextureFormat kWork = SDL_GPU_TEXTUREFORMAT_R16G16B16A16_FLOAT;
constexpr SDL_GPUTextureUsageFlags kTargetUsage = SDL_GPU_TEXTUREUSAGE_COLOR_TARGET | SDL_GPU_TEXTUREUSAGE_SAMPLER;

}  // namespace

struct Renderer::SlotTex {
  Texture planes[3];
  const void* lastData = nullptr;
  Tick lastPts = -1;
};

struct Renderer::Prep {
  LayerU u{};
  QuadU q{};
  gfx::BlendMode blend = gfx::BlendMode::Normal;
  const Texture* planes[3] = {nullptr, nullptr, nullptr};
  const Texture* curves = nullptr;
  const Texture* lut = nullptr;
  bool blur = false;
  double blurSigma = 0;
};

Renderer::Renderer(gfx::Gpu& gpu, FrameSource& frames) : gpu_(gpu), frames_(frames) {}

Renderer::~Renderer() {
  for (auto& [k, s] : slots_)
    for (auto& t : s->planes) gpu_.release(t);
  for (auto* m : {&titles_, &curves_, &luts_})
    for (auto& [k, t] : *m) gpu_.release(t);
  for (auto& [k, t] : scratch_) gpu_.release(t);
}

Texture& Renderer::scratch(int depth, int index, int w, int h) {
  Texture& t = scratch_[{depth, index}];
  gpu_.ensure(t, w, h, kWork, kTargetUsage);
  return t;
}

void Renderer::prepareGrade(const Project& p, const Clip& c, Prep& pr) {
  const Grade& g = c.grade;
  LayerU& u = pr.u;
  u.p1[0] = float(int(color::workingEncoding(p.working)));
  u.p2[0] = float(g.contrast);
  u.p2[1] = float(g.pivot);
  u.p2[2] = float(g.saturation);
  u.p2[3] = float(std::exp2(g.exposure));
  auto wb = color::whiteBalance(g.temperature, g.tint);
  for (int k = 0; k < 3; ++k) {
    u.lift[k] = float(g.lift[size_t(k)]);
    u.gammaInv[k] = float(1 / std::max(g.gamma[size_t(k)], 1e-3));
    u.gain[k] = float(g.gain[size_t(k)]);
    u.offset[k] = float(g.offset[size_t(k)]);
    u.wb[k] = float(wb[size_t(k)]);
  }
  const Effect* vig = effect(c, "vignette");
  u.wb[3] = float(std::clamp(param(vig, "amount", 0, vig ? 0.5 : 0), 0.0, 1.0));
  u.p1[1] = g.neutral() ? 0.f : 1.f;
  if (!g.enabled) return;
  // curves: one RGBA32F row, each channel's curve composed after the master
  if (!g.master.empty() || !g.red.empty() || !g.green.empty() || !g.blue.empty()) {
    std::ostringstream key;
    for (auto* v : {&g.master, &g.red, &g.green, &g.blue}) {
      for (auto& pt : *v) key << pt.x << ',' << pt.y << ';';
      key << '|';
    }
    Texture& t = curves_[key.str()];
    const int n = 1024;
    if (!t) {
      t = gpu_.make(n, 1, SDL_GPU_TEXTUREFORMAT_R32G32B32A32_FLOAT, SDL_GPU_TEXTUREUSAGE_SAMPLER);
      auto master = color::curveTable(g.master, n);
      auto r = color::curveTable(g.red, n), gg = color::curveTable(g.green, n), b = color::curveTable(g.blue, n);
      auto bytes = std::make_shared<std::vector<float>>(size_t(n) * 4);
      auto at = [&](const std::vector<float>& tb, double x) {
        if (x <= 0) return double(tb[0]) + x;
        if (x >= 1) return double(tb[size_t(n - 1)]) + (x - 1);
        double q = x * (n - 1);
        int i = std::min(int(q), n - 2);
        double f = q - i;
        return tb[size_t(i)] * (1 - f) + tb[size_t(i + 1)] * f;
      };
      for (int i = 0; i < n; ++i) {
        double m = master[size_t(i)];
        (*bytes)[size_t(i) * 4 + 0] = float(at(r, m));
        (*bytes)[size_t(i) * 4 + 1] = float(at(gg, m));
        (*bytes)[size_t(i) * 4 + 2] = float(at(b, m));
        (*bytes)[size_t(i) * 4 + 3] = 1;
      }
      uploads_.push_back({&t, reinterpret_cast<const uint8_t*>(bytes->data()), n * 16, n * 16, 1, 1, bytes});
    }
    pr.curves = &t;
    u.p1[3] = 1;
    u.lutInv[3] = float(n);
  }
  if (!g.lut.empty() && g.lutMix > 0) {
    auto it = lutData_.find(g.lut);
    if (it == lutData_.end()) {
      color::Lut3D l;
      if (color::loadCube(g.lut, l).empty()) it = lutData_.emplace(g.lut, std::move(l)).first;
    }
    if (it != lutData_.end()) {
      const color::Lut3D& l = it->second;
      Texture& t = luts_[g.lut];
      if (!t) {
        t = gpu_.make(l.size, l.size, SDL_GPU_TEXTUREFORMAT_R32G32B32A32_FLOAT, SDL_GPU_TEXTUREUSAGE_SAMPLER, l.size);
        auto bytes = std::make_shared<std::vector<float>>(size_t(l.size) * l.size * l.size * 4);
        for (size_t i = 0; i < size_t(l.size) * l.size * l.size; ++i) {
          (*bytes)[i * 4 + 0] = l.rgb[i * 3 + 0];
          (*bytes)[i * 4 + 1] = l.rgb[i * 3 + 1];
          (*bytes)[i * 4 + 2] = l.rgb[i * 3 + 2];
          (*bytes)[i * 4 + 3] = 1;
        }
        uploads_.push_back({&t, reinterpret_cast<const uint8_t*>(bytes->data()), l.size * 16, l.size * 16,
                            l.size, l.size, bytes});
      }
      pr.lut = &t;
      u.p1[2] = float(std::clamp(g.lutMix, 0.0, 1.0));
      for (int k = 0; k < 3; ++k) {
        u.lutDom[k] = float(l.domainMin[size_t(k)]);
        u.lutInv[k] = float(1 / (l.domainMax[size_t(k)] - l.domainMin[size_t(k)]));
      }
      u.lutDom[3] = float(l.size);
    }
  }
}

bool Renderer::prepareMedia(const Project& p, const LayerDraw& l, const Sequence& s, Prep& pr) {
  const Media& m = *l.media;
  const VideoFrame* f = frames_.video(m, l.slot, l.source);
  if (!f || !f->av) return false;
  auto& slot = slots_[l.slot];
  if (!slot) slot = std::make_unique<SlotTex>();
  LayerU& u = pr.u;
  int texBits = 8;
  struct PlaneSpec {
    int w, h;
    SDL_GPUTextureFormat fmt;
  } spec[3]{};
  int nplanes = 0;
  int cw = (f->width + (1 << f->chromaShiftX) - 1) >> f->chromaShiftX;
  int ch = (f->height + (1 << f->chromaShiftY) - 1) >> f->chromaShiftY;
  switch (f->layout) {
    case PixelLayout::NV12:
      u.p0[0] = 0;
      spec[0] = {f->width, f->height, SDL_GPU_TEXTUREFORMAT_R8_UNORM};
      spec[1] = {(f->width + 1) / 2, (f->height + 1) / 2, SDL_GPU_TEXTUREFORMAT_R8G8_UNORM};
      nplanes = 2;
      u.p0[2] = 255.f / 256.f;
      break;
    case PixelLayout::P010:
      u.p0[0] = 0;
      spec[0] = {f->width, f->height, SDL_GPU_TEXTUREFORMAT_R16_UNORM};
      spec[1] = {(f->width + 1) / 2, (f->height + 1) / 2, SDL_GPU_TEXTUREFORMAT_R16G16_UNORM};
      nplanes = 2;
      texBits = 16;
      u.p0[2] = 65535.f / 65536.f;
      break;
    case PixelLayout::Planar: {
      u.p0[0] = 1;
      SDL_GPUTextureFormat pf = f->bits > 8 ? SDL_GPU_TEXTUREFORMAT_R16_UNORM : SDL_GPU_TEXTUREFORMAT_R8_UNORM;
      texBits = f->bits > 8 ? 16 : 8;
      spec[0] = {f->width, f->height, pf};
      spec[1] = spec[2] = {cw, ch, pf};
      nplanes = 3;
      u.p0[2] = float((std::exp2(texBits) - 1) / std::exp2(f->bits));
      break;
    }
    case PixelLayout::RGBA8:
    case PixelLayout::RGBA16:
      u.p0[0] = 2;
      spec[0] = {f->width, f->height,
                 f->layout == PixelLayout::RGBA8 ? SDL_GPU_TEXTUREFORMAT_R8G8B8A8_UNORM : SDL_GPU_TEXTUREFORMAT_R16G16B16A16_UNORM};
      nplanes = 1;
      u.p0[2] = 1;
      break;
  }
  bool fresh = slot->lastData != f->plane(0) || slot->lastPts != f->pts;
  for (int i = 0; i < nplanes; ++i) {
    Texture& t = slot->planes[i];
    if (!t || t.w != spec[i].w || t.h != spec[i].h || t.fmt != spec[i].fmt) {
      gpu_.ensure(t, spec[i].w, spec[i].h, spec[i].fmt, SDL_GPU_TEXTUREUSAGE_SAMPLER);
      fresh = true;
    }
  }
  if (fresh) {
    for (int i = 0; i < nplanes; ++i) {
      Texture& t = slot->planes[i];
      int rowBytes = t.w * gfx::texelBytes(t.fmt);
      // keep the AVFrame alive until the copy pass has read it
      uploads_.push_back({&t, f->plane(i), f->stride(i), rowBytes, t.h, 1, f->av});
      stats_.uploadMB += double(rowBytes) * t.h / 1e6;
    }
    ++stats_.uploads;
    slot->lastData = f->plane(0);
    slot->lastPts = f->pts;
  }
  for (int i = 0; i < 3; ++i) pr.planes[i] = i < nplanes ? &slot->planes[i] : &gpu_.dummy2D();

  bool full = f->color.range == 2;
  bool rgb = f->layout == PixelLayout::RGBA8 || f->layout == PixelLayout::RGBA16;
  auto yuv = color::yuvToRgb(rgb ? 0 : f->color.matrix, full, f->layout == PixelLayout::P010 ? 16 : f->bits);
  row4(u.yuvR, yuv, 0);
  row4(u.yuvG, yuv, 1);
  row4(u.yuvB, yuv, 2);
  color::Transfer tr = m.kind == MediaKind::Image ? color::Transfer::sRGB : color::transferOf(f->color.transfer);
  u.p0[1] = float(int(tr));
  auto gam = color::gamut(color::primariesOf(m.color.primaries), color::workingPrimaries(p.working));
  row3(u.gamR, gam, 0);
  row3(u.gamG, gam, 1);
  row3(u.gamB, gam, 2);
  bool sideways = f->rotation == 90 || f->rotation == 270;
  double dw = sideways ? f->height : f->width, dh = sideways ? f->width : f->height;
  // non-square pixels: the media's display width wins
  if (!sideways && m.width > 0 && m.height == f->height) dw = m.width;
  pr.q = quadOf(place(l, dw, dh, s.width, s.height, true, f->rotation));
  (void)texBits;
  return true;
}

void Renderer::drawQuad(SDL_GPURenderPass* pass, SDL_GPUCommandBuffer* cmd, const Prep& pr, SDL_GPUTextureFormat fmt) {
  SDL_GPUGraphicsPipeline* pipe = gpu_.layerPipeline(pr.blend, fmt);
  if (!pipe) return;
  SDL_BindGPUGraphicsPipeline(pass, pipe);
  SDL_PushGPUVertexUniformData(cmd, 0, &pr.q, sizeof pr.q);
  SDL_PushGPUFragmentUniformData(cmd, 0, &pr.u, sizeof pr.u);
  SDL_GPUTextureSamplerBinding b[5];
  for (int i = 0; i < 3; ++i) b[i] = {pr.planes[i] ? pr.planes[i]->tex : gpu_.dummy2D().tex, gpu_.linear()};
  b[3] = {pr.curves ? pr.curves->tex : gpu_.dummy2D().tex, gpu_.linear()};
  b[4] = {pr.lut ? pr.lut->tex : gpu_.dummy3D().tex, gpu_.linear()};
  SDL_BindGPUFragmentSamplers(pass, 0, b, 5);
  SDL_DrawGPUPrimitives(pass, 4, 1, 0, 0);
}

void Renderer::pass(SDL_GPUCommandBuffer* cmd, const Texture& src, Texture& dst, const void* uniforms, size_t size,
                    SDL_GPUGraphicsPipeline* pipe) {
  if (!pipe) return;
  SDL_GPUColorTargetInfo ct{};
  ct.texture = dst.tex;
  ct.load_op = SDL_GPU_LOADOP_DONT_CARE;
  ct.store_op = SDL_GPU_STOREOP_STORE;
  SDL_GPURenderPass* rp = SDL_BeginGPURenderPass(cmd, &ct, 1, nullptr);
  SDL_BindGPUGraphicsPipeline(rp, pipe);
  QuadU q = fullQuad();
  SDL_PushGPUVertexUniformData(cmd, 0, &q, sizeof q);
  SDL_PushGPUFragmentUniformData(cmd, 0, uniforms, uint32_t(size));
  SDL_GPUTextureSamplerBinding b{src.tex, gpu_.linear()};
  SDL_BindGPUFragmentSamplers(rp, 0, &b, 1);
  SDL_DrawGPUPrimitives(rp, 4, 1, 0, 0);
  SDL_EndGPURenderPass(rp);
}

std::string Renderer::render(SDL_GPUCommandBuffer* cmd, const Project& p, const Sequence& s, Tick t, Texture& target) {
  stats_ = {};
  gpu_.ensure(target, s.width, s.height, kWork, kTargetUsage);
  if (!target) return "cannot allocate the frame";
  return renderInto(cmd, p, s, t, target, 0, -1);
}

std::string Renderer::renderInto(SDL_GPUCommandBuffer* cmd, const Project& p, const Sequence& s, Tick t, Texture& target,
                                 int depth, int onlyTrack) {
  if (depth > 8) return "sequences nested too deep";
  std::vector<LayerDraw> layers;
  if (onlyTrack >= 0) {
    // a multicam angle: the one track
    Sequence one;
    one.width = s.width;
    one.height = s.height;
    if (size_t(onlyTrack) < s.video.size()) one.video.push_back(s.video[size_t(onlyTrack)]);
    layers = evaluate(p, one, t);
    for (auto& l : layers) {
      // re-point at the real clip (the copy dies with `one`)
      for (auto& c : s.video[size_t(onlyTrack)].clips)
        if (c.id == l.clip->id) l.clip = &c;
    }
  } else {
    layers = evaluate(p, s, t);
  }
  stats_.layers += int(layers.size());

  std::vector<Prep> preps;
  int scratchIndex = 0;
  for (const LayerDraw& l : layers) {
    const Clip& c = *l.clip;
    Prep pr;
    pr.blend = blendOf(c.blend);
    pr.u.p0[3] = float(l.opacity);
    prepareGrade(p, c, pr);
    bool ok = false;
    switch (c.kind) {
      case ClipKind::Media: ok = prepareMedia(p, l, s, pr); break;
      case ClipKind::Nested:
      case ClipKind::Multicam: {
        const Sequence& n = *l.nested;
        Texture& sub = scratch(depth + 1, scratchIndex++, n.width, n.height);
        // nested renders run their own passes before this level's
        if (!renderInto(cmd, p, n, l.source, sub, depth + 1, c.kind == ClipKind::Multicam ? l.angle : -1).empty()) break;
        pr.u.p0[0] = 3;
        pr.planes[0] = &sub;
        pr.q = quadOf(place(l, n.width, n.height, s.width, s.height, true));
        ok = true;
        break;
      }
      case ClipKind::Title: {
        std::ostringstream key;
        const TextStyle& st = c.style;
        key << c.text << '\x1f' << st.font << '|' << st.size << '|' << st.outlineWidth << '|' << st.align << '|'
            << st.lineSpacing;
        for (auto* a : {&st.color, &st.outline, &st.box})
          for (double v : *a) key << ',' << v;
        Texture& tex = titles_[key.str()];
        if (!tex) {
          gfx::TextImage img;
          if (!gfx::rasterize(c.text, st, img).empty()) break;
          tex = gpu_.make(img.width, img.height, SDL_GPU_TEXTUREFORMAT_R8G8B8A8_UNORM, SDL_GPU_TEXTUREUSAGE_SAMPLER);
          auto bytes = std::make_shared<std::vector<uint8_t>>(std::move(img.rgba));
          uploads_.push_back({&tex, bytes->data(), tex.w * 4, tex.w * 4, tex.h, 1, bytes});
        }
        pr.u.p0[0] = 2;
        pr.u.p0[1] = float(int(color::Transfer::sRGB));
        pr.u.p0[2] = 1;
        auto id = color::yuvToRgb(0, true, 8);
        row4(pr.u.yuvR, id, 0);
        row4(pr.u.yuvG, id, 1);
        row4(pr.u.yuvB, id, 2);
        auto gam = color::gamut(color::Primaries::BT709, color::workingPrimaries(p.working));
        row3(pr.u.gamR, gam, 0);
        row3(pr.u.gamG, gam, 1);
        row3(pr.u.gamB, gam, 2);
        pr.planes[0] = &tex;
        pr.q = quadOf(place(l, tex.w, tex.h, s.width, s.height, false));
        ok = true;
        break;
      }
      case ClipKind::Solid:
      case ClipKind::Shape: {
        pr.u.p0[0] = 4;
        auto gam = color::gamut(color::Primaries::BT709, color::workingPrimaries(p.working));
        color::Vec3 lin{color::toLinear(color::Transfer::sRGB, c.fill[0]), color::toLinear(color::Transfer::sRGB, c.fill[1]),
                        color::toLinear(color::Transfer::sRGB, c.fill[2])};
        lin = color::mul(gam, lin);
        for (int k = 0; k < 3; ++k) pr.u.fill[k] = float(lin[size_t(k)]);
        pr.u.fill[3] = float(c.fill[3]);
        if (c.kind == ClipKind::Shape) {
          pr.u.shape[0] = c.shape == ShapeKind::Ellipse ? 2.f : 1.f;
          pr.u.shape[1] = 0.01f;
        }
        pr.q = quadOf(place(l, s.width, s.height, s.width, s.height, false));
        ok = true;
        break;
      }
      case ClipKind::Adjustment: break;  // not drawn yet
    }
    if (!ok) continue;
    const Effect* blur = effect(c, "blur");
    double sigma = param(blur, "radius", l.local, 0);
    if (sigma > 0.25) {
      pr.blur = true;
      pr.blurSigma = sigma;
    }
    preps.push_back(pr);
  }

  // one copy pass for every upload this level gathered
  if (!uploads_.empty()) {
    gpu_.beginUploads(cmd);
    for (auto& u : uploads_) gpu_.upload(*u.tex, u.data, u.stride, u.rowBytes, u.rows, u.layers);
    gpu_.endUploads();
    uploads_.clear();
  }

  // layers with a blur are drawn alone first, blurred, then composited as one picture
  for (Prep& pr : preps) {
    if (!pr.blur) continue;
    Texture& a = scratch(depth, 100 + scratchIndex, s.width, s.height);
    Texture& b = scratch(depth, 101 + scratchIndex, s.width, s.height);
    scratchIndex += 2;
    SDL_GPUColorTargetInfo ct{};
    ct.texture = a.tex;
    ct.load_op = SDL_GPU_LOADOP_CLEAR;
    ct.store_op = SDL_GPU_STOREOP_STORE;
    SDL_GPURenderPass* rp = SDL_BeginGPURenderPass(cmd, &ct, 1, nullptr);
    Prep solo = pr;
    solo.blend = gfx::BlendMode::Normal;
    drawQuad(rp, cmd, solo, kWork);
    SDL_EndGPURenderPass(rp);
    BlurU bu{{1.f / float(s.width), 0, float(pr.blurSigma), 0}};
    pass(cmd, a, b, &bu, sizeof bu, gpu_.blurPipeline(kWork));
    bu = {{0, 1.f / float(s.height), float(pr.blurSigma), 0}};
    pass(cmd, b, a, &bu, sizeof bu, gpu_.blurPipeline(kWork));
    Prep comp;
    comp.blend = pr.blend;
    comp.u.p0[0] = 3;
    comp.u.p0[3] = 1;
    comp.planes[0] = &a;
    comp.q = fullQuad();
    pr = comp;
  }

  SDL_GPUColorTargetInfo ct{};
  ct.texture = target.tex;
  ct.load_op = SDL_GPU_LOADOP_CLEAR;
  ct.clear_color = {0, 0, 0, 0};
  ct.store_op = SDL_GPU_STOREOP_STORE;
  SDL_GPURenderPass* rp = SDL_BeginGPURenderPass(cmd, &ct, 1, nullptr);
  for (const Prep& pr : preps) drawQuad(rp, cmd, pr, target.fmt);
  SDL_EndGPURenderPass(rp);
  return {};
}

void Renderer::output(SDL_GPUCommandBuffer* cmd, const Texture& src, Texture& dst, const Project& p,
                      std::array<double, 3> bg, bool flatten) {
  OutputU u{};
  auto gam = color::gamut(color::workingPrimaries(p.working), color::outputPrimaries(p.output));
  row3(u.gamR, gam, 0);
  row3(u.gamG, gam, 1);
  row3(u.gamB, gam, 2);
  auto bgGam = color::gamut(color::Primaries::BT709, color::outputPrimaries(p.output));
  color::Vec3 b = color::mul(bgGam, color::Vec3{color::toLinear(color::Transfer::BT1886, bg[0]),
                                     color::toLinear(color::Transfer::BT1886, bg[1]),
                                     color::toLinear(color::Transfer::BT1886, bg[2])});
  for (int k = 0; k < 3; ++k) u.bg[k] = float(b[size_t(k)]);
  u.bg[3] = flatten ? 1.f : 0.f;
  u.p0[0] = float(int(color::outputTransfer(p.output)));
  u.p0[1] = 0;
  pass(cmd, src, dst, &u, sizeof u, gpu_.outputPipeline(dst.fmt));
}

void Renderer::outputYuv(SDL_GPUCommandBuffer* cmd, const Texture& src, Texture& y, Texture& uv, const Project& p,
                         std::array<double, 3> bg, const YuvTarget& f) {
  OutputU u{};
  auto gam = color::gamut(color::workingPrimaries(p.working), color::outputPrimaries(p.output));
  row3(u.gamR, gam, 0);
  row3(u.gamG, gam, 1);
  row3(u.gamB, gam, 2);
  auto bgGam = color::gamut(color::Primaries::BT709, color::outputPrimaries(p.output));
  color::Vec3 b = color::mul(bgGam, color::Vec3{color::toLinear(color::Transfer::BT1886, bg[0]),
                                     color::toLinear(color::Transfer::BT1886, bg[1]),
                                     color::toLinear(color::Transfer::BT1886, bg[2])});
  for (int k = 0; k < 3; ++k) u.bg[k] = float(b[size_t(k)]);
  u.bg[3] = 1;
  u.p0[0] = float(int(color::outputTransfer(p.output)));
  auto m = color::rgbToYuv(f.matrix, f.fullRange, f.bits);
  row4(u.yuvY, m, 0);
  row4(u.yuvU, m, 1);
  row4(u.yuvV, m, 2);
  int texBits = gfx::texelBytes(y.fmt) == 1 ? 8 : 16;
  u.p0[2] = float(std::exp2(f.bits + f.shift) / (std::exp2(texBits) - 1));
  u.p0[1] = 1;
  pass(cmd, src, y, &u, sizeof u, gpu_.outputPipeline(y.fmt));
  u.p0[1] = 2;
  pass(cmd, src, uv, &u, sizeof u, gpu_.outputPipeline(uv.fmt));
}

}  // namespace rhap
