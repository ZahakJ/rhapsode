#include <doctest.h>

#include <SDL3/SDL.h>

#include <algorithm>
#include <cmath>
#include <cstring>
#include <filesystem>

#include "gfx/color.h"
#include "gfx/gpu.h"
#include "media_fixtures.h"
#include "render/renderer.h"

#define STB_IMAGE_IMPLEMENTATION
#include <stb_image.h>

using namespace rhap;
using fx::sec;

namespace {

gfx::Gpu* gpu() {
  // never destroyed: tearing a Vulkan device down from a static destructor races the driver's own atexit
  static gfx::Gpu* g = new gfx::Gpu;
  static bool tried = false;
  if (!tried) {
    tried = true;
    std::string e = g->init(nullptr);
    if (!e.empty()) MESSAGE("no GPU: " << e);
  }
  return g->ok() ? g : nullptr;
}

Project seqProject(int w, int h) {
  Project p = fx::project(3, 1);
  p.sequences[0].width = w;
  p.sequences[0].height = h;
  return p;
}

struct Image {
  int w = 0, h = 0;
  std::vector<uint8_t> px;
  const uint8_t* at(int x, int y) const { return &px[(size_t(y) * w + x) * 4]; }
};

Image renderRgba(gfx::Gpu& g, FrameSource& src, const Project& p, Tick t) {
  Renderer r(g, src);
  const Sequence& s = p.sequences[0];
  gfx::Texture work, out;
  out = g.make(s.width, s.height, SDL_GPU_TEXTUREFORMAT_R8G8B8A8_UNORM,
               SDL_GPU_TEXTUREUSAGE_COLOR_TARGET | SDL_GPU_TEXTUREUSAGE_SAMPLER);
  SDL_GPUCommandBuffer* cmd = SDL_AcquireGPUCommandBuffer(g.device());
  std::string e = r.render(cmd, p, s, t, work);
  REQUIRE_MESSAGE(e.empty(), e);
  r.output(cmd, work, out, p, s.background);
  SDL_SubmitGPUCommandBuffer(cmd);
  Image img{s.width, s.height, g.download(out)};
  g.release(work);
  g.release(out);
  return img;
}

struct NoFrames : FrameSource {
  const VideoFrame* video(const Media&, const std::string&, Tick) override { return nullptr; }
};

Clip solid(Project& p, double r, double gr, double b, double at = 0, double dur = 10) {
  Clip c;
  c.id = p.makeId("c");
  c.kind = ClipKind::Solid;
  c.start = sec(at);
  c.dur = sec(dur);
  c.fill = {r, gr, b, 1};
  return c;
}

int to8(double v) { return int(std::lround(std::clamp(v, 0.0, 1.0) * 255)); }

}  // namespace

TEST_CASE("gpu: a solid comes out in the output encoding") {
  gfx::Gpu* g = gpu();
  if (!g) return;
  Project p = seqProject(64, 36);
  Editor ed(p, "main");
  REQUIRE(ed.overwrite({TrackKind::Video, 0}, solid(p, 1, 0.5, 0)).empty());
  NoFrames nf;
  Image img = renderRgba(*g, nf, p, sec(1));
  // sRGB 0.5 → linear 0.214 → BT.1886 encoded 0.526
  double want = color::fromLinear(color::Transfer::BT1886, color::toLinear(color::Transfer::sRGB, 0.5));
  const uint8_t* px = img.at(32, 18);
  CHECK(px[0] == 255);
  CHECK(std::abs(px[1] - to8(want)) <= 1);
  CHECK(px[2] == 0);
  // outside the clip's time: the background
  Image empty = renderRgba(*g, nf, p, sec(20));
  CHECK(empty.at(10, 10)[0] == 0);
}

TEST_CASE("gpu: transforms land where the model says (y grows downward)") {
  gfx::Gpu* g = gpu();
  if (!g) return;
  Project p = seqProject(200, 100);
  Editor ed(p, "main");
  Clip c = solid(p, 1, 1, 1);
  c.kind = ClipKind::Shape;
  c.xf.scale = 0.25;      // 50×25
  c.xf.x = 50;            // centre at (150, 50+25=75) in pixels from top-left
  c.xf.y = 25;
  REQUIRE(ed.overwrite({TrackKind::Video, 0}, c).empty());
  NoFrames nf;
  Image img = renderRgba(*g, nf, p, sec(1));
  CHECK(img.at(150, 75)[0] == 255);
  CHECK(img.at(130, 70)[0] == 255);
  CHECK(img.at(50, 25)[0] == 0);   // the mirror position is empty
  CHECK(img.at(150, 25)[0] == 0);  // above it is empty: +y is down
  CHECK(img.at(100, 50)[0] == 0);
}

TEST_CASE("gpu: the primary grade matches the CPU reference") {
  gfx::Gpu* g = gpu();
  if (!g) return;
  NoFrames nf;
  Grade gr;
  gr.lift = {0.05, 0, -0.03};
  gr.gamma = {1.1, 0.9, 1.0};
  gr.gain = {1.1, 1.0, 0.85};
  gr.offset = {0.01, 0.0, 0.02};
  gr.contrast = 1.2;
  gr.pivot = 0.45;
  gr.saturation = 0.8;
  gr.master = {{0, 0.02}, {0.5, 0.55}, {1, 0.98}};
  gr.red = {{0, 0}, {0.6, 0.65}, {1, 1}};
  for (double v : {0.15, 0.45, 0.8}) {
    Project p = seqProject(16, 16);
    Editor ed(p, "main");
    Clip c = solid(p, v, v * 0.7, 1 - v);
    c.grade = gr;
    REQUIRE(ed.overwrite({TrackKind::Video, 0}, c).empty());
    Image img = renderRgba(*g, nf, p, sec(1));
    // the CPU path: sRGB fill → linear → working (BT.1886) → grade → linear → BT.1886 out
    color::Vec3 e;
    for (int k = 0; k < 3; ++k)
      e[size_t(k)] = color::fromLinear(color::Transfer::BT1886, color::toLinear(color::Transfer::sRGB, c.fill[size_t(k)]));
    color::Vec3 want = color::applyGrade(gr, e);
    const uint8_t* px = img.at(8, 8);
    for (int k = 0; k < 3; ++k)
      CHECK_MESSAGE(std::abs(px[k] - to8(want[size_t(k)])) <= 1, "v " << v << " ch " << k << ": " << int(px[k]) << " vs "
                                                                     << to8(want[size_t(k)]));
  }
}

TEST_CASE("gpu: a .cube LUT is applied like the CPU reference") {
  gfx::Gpu* g = gpu();
  if (!g) return;
  // a LUT that swaps red and blue and darkens green
  std::string path = fx::tmpdir("lut") + "/swap.cube";
  {
    std::string s = "LUT_3D_SIZE 5\n";
    for (int b = 0; b < 5; ++b)
      for (int gg = 0; gg < 5; ++gg)
        for (int r = 0; r < 5; ++r) s += std::to_string(b / 4.0) + " " + std::to_string(gg / 8.0) + " " + std::to_string(r / 4.0) + "\n";
    FILE* f = std::fopen(path.c_str(), "w");
    std::fputs(s.c_str(), f);
    std::fclose(f);
  }
  Project p = seqProject(16, 16);
  Editor ed(p, "main");
  Clip c = solid(p, 0.9, 0.6, 0.2);
  c.grade.lut = path;
  REQUIRE(ed.overwrite({TrackKind::Video, 0}, c).empty());
  NoFrames nf;
  Image img = renderRgba(*g, nf, p, sec(1));
  color::Vec3 e;
  for (int k = 0; k < 3; ++k)
    e[size_t(k)] = color::fromLinear(color::Transfer::BT1886, color::toLinear(color::Transfer::sRGB, c.fill[size_t(k)]));
  const uint8_t* px = img.at(8, 8);
  CHECK(std::abs(px[0] - to8(e[2])) <= 1);
  CHECK(std::abs(px[1] - to8(e[1] / 2)) <= 1);
  CHECK(std::abs(px[2] - to8(e[0])) <= 1);
}

TEST_CASE("gpu: decoded video through the whole chain returns its own Y'CbCr") {
  gfx::Gpu* g = gpu();
  if (!g) return;
  // 8-bit NV12 (NVDEC) / planar (software) and 10-bit: render, then convert back to Y'CbCr on the GPU
  struct C {
    const char* file;
    const char* args;
    bool hw;
    int bits;
  };
  for (C cs : {C{"h264.mp4", "-c:v libx264 -preset ultrafast -g 48 -bf 3 -pix_fmt yuv420p -c:a aac", true, 8},
               C{"h264.mp4", "", false, 8},
               C{"hevc10.mp4", "-c:v libx265 -preset ultrafast -x265-params log-level=none -g 48 -pix_fmt yuv420p10le -c:a aac", true, 10},
               C{"prores.mov", "-c:v prores_ks -profile:v 3 -pix_fmt yuv422p10le -c:a pcm_s16le", false, 10}}) {
    std::string path = fx::numbered(cs.file, cs.args);
    REQUIRE(!path.empty());
    Project p = seqProject(320, 240);
    Media m;
    m.id = "clip";
    REQUIRE(probe(path, m).empty());
    p.media.push_back(m);
    Editor ed(p, "main");
    REQUIRE(ed.overwrite({TrackKind::Video, 0}, clipOf(p, m, 0)).empty());
    DecoderPool pool(cs.hw);
    Renderer r(*g, pool);
    gfx::Texture work;
    bool deep = cs.bits > 8;
    auto yf = deep ? SDL_GPU_TEXTUREFORMAT_R16_UNORM : SDL_GPU_TEXTUREFORMAT_R8_UNORM;
    auto uf = deep ? SDL_GPU_TEXTUREFORMAT_R16G16_UNORM : SDL_GPU_TEXTUREFORMAT_R8G8_UNORM;
    auto use = SDL_GPU_TEXTUREUSAGE_COLOR_TARGET | SDL_GPU_TEXTUREUSAGE_SAMPLER;
    gfx::Texture y = g->make(320, 240, yf, use), uv = g->make(160, 120, uf, use);
    for (int frame : {0, 17, 64, 101}) {
      SDL_GPUCommandBuffer* cmd = SDL_AcquireGPUCommandBuffer(g->device());
      REQUIRE(r.render(cmd, p, p.sequences[0], frameStart(frame, Rate{30, 1}), work).empty());
      Renderer::YuvTarget tgt;
      tgt.bits = cs.bits;
      tgt.shift = deep ? 6 : 0;
      r.outputYuv(cmd, work, y, uv, p, {0, 0, 0}, tgt);
      SDL_SubmitGPUCommandBuffer(cmd);
      auto yb = g->download(y), ub = g->download(uv);
      int want = (frame * 7) % 256;
      int gotY = deep ? (reinterpret_cast<uint16_t*>(yb.data())[120 * 320 + 160] >> 6) : yb[120 * 320 + 160];
      int gotCb = deep ? (reinterpret_cast<uint16_t*>(ub.data())[(60 * 160 + 80) * 2] >> 6) : ub[(60 * 160 + 80) * 2];
      // video levels clip below 16 and above 235 on the way through RGB; compare inside the legal range
      int wantY = std::clamp(want, 16, 235) * (deep ? 4 : 1);
      CHECK_MESSAGE(std::abs(gotY - wantY) <= 1, cs.file << (cs.hw ? " hw" : " sw") << " frame " << frame << ": Y "
                                                          << gotY << " want " << wantY);
      CHECK(std::abs(gotCb - 128 * (deep ? 4 : 1)) <= 1);
    }
    g->release(work);
    g->release(y);
    g->release(uv);
  }
}

TEST_CASE("gpu: PQ and HLG survive a round trip within one 10-bit code") {
  gfx::Gpu* g = gpu();
  if (!g) return;
  for (OutputSpace o : {OutputSpace::Rec2020PQ, OutputSpace::Rec2020HLG}) {
    // a solid whose linear value we choose, rendered in a Rec.2020 working space to a 10-bit output
    for (double nits : {5.0, 100.0, 203.0, 600.0, 1000.0}) {
      Project p = seqProject(8, 8);
      p.working = WorkingSpace::Rec2020;
      p.output = o;
      Editor ed(p, "main");
      double lin709 = nits / 203;  // the fill is converted from sRGB/709: pick a grey so the gamut is moot
      double srgb = color::fromLinear(color::Transfer::sRGB, lin709);
      Clip c = solid(p, srgb, srgb, srgb);
      REQUIRE(ed.overwrite({TrackKind::Video, 0}, c).empty());
      NoFrames nf;
      Renderer r(*g, nf);
      gfx::Texture work;
      gfx::Texture out = g->make(8, 8, SDL_GPU_TEXTUREFORMAT_R16G16B16A16_UNORM,
                                 SDL_GPU_TEXTUREUSAGE_COLOR_TARGET | SDL_GPU_TEXTUREUSAGE_SAMPLER);
      SDL_GPUCommandBuffer* cmd = SDL_AcquireGPUCommandBuffer(g->device());
      REQUIRE(r.render(cmd, p, p.sequences[0], sec(1), work).empty());
      r.output(cmd, work, out, p, {0, 0, 0});
      SDL_SubmitGPUCommandBuffer(cmd);
      auto px = g->download(out);
      double got = reinterpret_cast<uint16_t*>(px.data())[(4 * 8 + 4) * 4] / 65535.0;
      color::Transfer tf = o == OutputSpace::Rec2020PQ ? color::Transfer::PQ : color::Transfer::HLG;
      double want = std::min(1.0, color::fromLinear(tf, lin709));
      CHECK_MESSAGE(std::fabs(got - want) * 1023 <= 1.0, (o == OutputSpace::Rec2020PQ ? "PQ " : "HLG ") << nits
                                                                          << " nits: " << got * 1023 << " vs " << want * 1023);
      g->release(work);
      g->release(out);
    }
  }
}

TEST_CASE("gpu: nesting is invisible") {
  gfx::Gpu* g = gpu();
  if (!g) return;
  Project p = seqProject(64, 64);
  Editor ed(p, "main");
  Clip a = solid(p, 0.2, 0.4, 0.6);
  Clip b = solid(p, 1, 1, 1);
  b.kind = ClipKind::Shape;
  b.shape = ShapeKind::Ellipse;
  b.xf.scale = 0.5;
  b.xf.opacity = 0.5;
  REQUIRE(ed.overwrite({TrackKind::Video, 0}, a).empty());
  REQUIRE(ed.overwrite({TrackKind::Video, 1}, b).empty());
  NoFrames nf;
  Image flat = renderRgba(*g, nf, p, sec(1));
  REQUIRE(ed.nest({a.id, b.id}).empty());
  Image nested = renderRgba(*g, nf, p, sec(1));
  int worst = 0;
  for (size_t i = 0; i < flat.px.size(); ++i) worst = std::max(worst, std::abs(int(flat.px[i]) - int(nested.px[i])));
  CHECK(worst <= 1);
}

TEST_CASE("gpu: dissolve mixes the two sides") {
  gfx::Gpu* g = gpu();
  if (!g) return;
  Project p = seqProject(16, 16);
  Editor ed(p, "main");
  REQUIRE(ed.overwrite({TrackKind::Video, 0}, solid(p, 1, 1, 1, 0, 5)).empty());
  REQUIRE(ed.overwrite({TrackKind::Video, 0}, solid(p, 0, 0, 0, 5, 5)).empty());
  ed.seq().video[0].transitions.push_back(Transition{"x", sec(5), sec(2), TransitionKind::Dissolve});
  NoFrames nf;
  auto lin = [&](double t) { return color::toLinear(color::Transfer::BT1886, renderRgba(*g, nf, p, sec(t)).at(8, 8)[0] / 255.0); };
  CHECK(lin(3.9) == doctest::Approx(1).epsilon(0.01));
  CHECK(lin(5.0) == doctest::Approx(0.5).epsilon(0.03));  // halfway: half of each, in linear light
  CHECK(lin(6.1) < 0.01);
}

TEST_CASE("gpu: titles draw, Arabic included") {
  gfx::Gpu* g = gpu();
  if (!g) return;
  for (const char* text : {"RHAPSODE", "ملحمة"}) {
    Project p = seqProject(400, 200);
    Editor ed(p, "main");
    Clip c;
    c.id = p.makeId("c");
    c.kind = ClipKind::Title;
    c.text = text;
    c.style.size = 64;
    c.style.outlineWidth = 3;
    c.start = 0;
    c.dur = sec(5);
    REQUIRE(ed.overwrite({TrackKind::Video, 0}, c).empty());
    NoFrames nf;
    Image img = renderRgba(*g, nf, p, sec(1));
    int lit = 0, dark = 0;
    for (int y = 0; y < img.h; ++y)
      for (int x = 0; x < img.w; ++x) {
        if (img.at(x, y)[0] > 200) ++lit;
        if (img.at(x, y)[0] < 50) ++dark;
      }
    CHECK_MESSAGE(lit > 500, text << " lit " << lit);
    CHECK(dark > 40000);
  }
}

TEST_CASE("gpu: blur spreads an edge") {
  gfx::Gpu* g = gpu();
  if (!g) return;
  Project p = seqProject(100, 20);
  Editor ed(p, "main");
  Clip c = solid(p, 1, 1, 1);
  c.kind = ClipKind::Shape;
  c.xf.cropR = 0.5;  // the left half
  c.fx.push_back(Effect{"blur", true, {{"radius", Param(4)}}});
  REQUIRE(ed.overwrite({TrackKind::Video, 0}, c).empty());
  NoFrames nf;
  Image img = renderRgba(*g, nf, p, sec(1));
  int a = img.at(46, 10)[0], b = img.at(50, 10)[0], d = img.at(54, 10)[0];
  CHECK(a > b);
  CHECK(b > d);
  CHECK(d > 0);
  CHECK(img.at(20, 10)[0] == 255);
}

TEST_CASE("gpu: phone footage tagged as rotated shows upright, as ffmpeg shows it") {
  gfx::Gpu* g = gpu();
  if (!g) return;
  std::string dir = fx::mediaDir();
  std::string flat = dir + "/halves.mp4", rot = dir + "/halves-rot90.mp4", ref = dir + "/halves-rot90.png";
  if (!std::filesystem::exists(rot)) {
    // left half red, right half blue, then tagged with a 90° display matrix (as phones do)
    std::system(("ffmpeg -nostdin -loglevel error -y -f lavfi -i color=red:s=160x240:d=1 -f lavfi -i color=blue:s=160x240:d=1 "
                 "-filter_complex hstack -c:v libx264 -preset ultrafast -pix_fmt yuv420p '" + flat + "'").c_str());
    std::system(("ffmpeg -nostdin -loglevel error -y -display_rotation 90 -i '" + flat + "' -c copy '" + rot + "'").c_str());
    std::system(("ffmpeg -nostdin -loglevel error -y -i '" + rot + "' -frames:v 1 '" + ref + "'").c_str());  // ffmpeg autorotates
  }
  Media m;
  m.id = "rot";
  REQUIRE(probe(rot, m).empty());
  CHECK(m.width == 240);
  CHECK(m.height == 320);
  Project p = seqProject(240, 320);
  p.media.push_back(m);
  Editor ed(p, "main");
  REQUIRE(ed.overwrite({TrackKind::Video, 0}, clipOf(p, m, 0)).empty());
  DecoderPool pool(false);
  Image img = renderRgba(*g, pool, p, sec(0.1));
  int w, h, n;
  unsigned char* r = stbi_load(ref.c_str(), &w, &h, &n, 4);
  REQUIRE(r);
  REQUIRE(w == 240);
  REQUIRE(h == 320);
  for (auto [x, y] : {std::pair{120, 40}, std::pair{120, 280}}) {
    const unsigned char* q = r + (size_t(y) * w + x) * 4;
    const uint8_t* o = img.at(x, y);
    bool refRed = q[0] > q[2], ourRed = o[0] > o[2];
    CHECK_MESSAGE(refRed == ourRed, "at " << x << "," << y << " ffmpeg " << (refRed ? "red" : "blue") << ", ours " << (ourRed ? "red" : "blue"));
  }
  stbi_image_free(r);
}
