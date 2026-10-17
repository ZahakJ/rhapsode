#include <doctest.h>

#include <cmath>
#include <random>

#include "media/decode.h"
#include "media_fixtures.h"

using namespace rhap;

namespace {

int centreLuma(const VideoFrame& f) {
  int x = f.width / 2, y = f.height / 2;
  const uint8_t* p = f.plane(0) + size_t(y) * f.stride(0);
  switch (f.layout) {
    case PixelLayout::NV12: return p[x];
    case PixelLayout::P010: return reinterpret_cast<const uint16_t*>(p)[x] >> 8;
    case PixelLayout::Planar:
      return f.bits > 8 ? reinterpret_cast<const uint16_t*>(p)[x] >> (f.bits - 8) : p[x];
    default: return -1;
  }
}

struct Case {
  const char* name;
  const char* file;
  const char* args;
};

const Case kCases[] = {
    {"h264", "h264.mp4", "-c:v libx264 -preset ultrafast -g 48 -bf 3 -pix_fmt yuv420p -c:a aac"},
    {"hevc 10-bit", "hevc10.mp4", "-c:v libx265 -preset ultrafast -x265-params log-level=none -g 48 -pix_fmt yuv420p10le -c:a aac"},
    {"av1", "av1.mkv", "-c:v libsvtav1 -preset 12 -g 48 -pix_fmt yuv420p -svtav1-params lp=2 -c:a libopus"},
    {"prores 422 hq", "prores.mov", "-c:v prores_ks -profile:v 3 -pix_fmt yuv422p10le -c:a pcm_s16le"},
    {"dnxhr hq", "dnxhr.mov", "-c:v dnxhd -profile:v dnxhr_hq -pix_fmt yuv422p -c:a pcm_s16le"},
};

void checkSeeks(const std::string& path, bool hw, int frames, Rate rate) {
  VideoDecoder d;
  REQUIRE_MESSAGE(d.open(path, hw).empty(), path);
  std::mt19937 rng(7);
  std::vector<int> order;
  for (int i = 0; i < 60; ++i) order.push_back(int(rng() % uint32_t(frames)));
  // forward runs, back jumps, repeats and a mid-frame time
  order.insert(order.end(), {0, 1, 2, 3, frames - 1, frames - 2, 0, 47, 48, 49, 96, 5});
  for (int f : order) {
    Tick t = frameStart(f, rate) + (f % 2 ? frameTicks(rate) / 2 : 0);
    const VideoFrame* fr = d.frameAt(t);
    REQUIRE(fr);
    int got = fx::lumaToFrame(centreLuma(*fr), f);
    CHECK_MESSAGE(got == f, path << (hw ? " hw" : " sw") << ": asked frame " << f << " got " << got << " (luma "
                                 << centreLuma(*fr) << ", pts " << toSeconds(fr->pts) << ")");
  }
}

}  // namespace

TEST_CASE("frame-exact seeks in every pro codec") {
  for (const Case& c : kCases) {
    SUBCASE(c.name) {
      std::string path = fx::numbered(c.file, c.args);
      REQUIRE_MESSAGE(!path.empty(), "ffmpeg could not make the fixture");
      Media m;
      REQUIRE(probe(path, m).empty());
      CHECK(m.kind == MediaKind::Video);
      CHECK(m.rate == Rate{30, 1});
      CHECK(m.hasAudio);
      CHECK_FALSE(m.vfr);
      CHECK(std::fabs(toSeconds(m.duration) - 4) < 0.1);
      checkSeeks(path, false, 120, m.rate);
      if (nvdecAvailable()) checkSeeks(path, true, 120, m.rate);
    }
  }
}

TEST_CASE("NVDEC decodes h264, HEVC 10-bit and AV1 on the GPU when present") {
  if (!nvdecAvailable()) {
    MESSAGE("no CUDA device; skipped");
    return;
  }
  for (const char* f : {"h264.mp4", "hevc10.mp4", "av1.mkv"}) {
    VideoDecoder d;
    std::string path = fx::mediaDir() + "/" + f;
    if (!std::filesystem::exists(path)) continue;
    REQUIRE(d.open(path, true).empty());
    CHECK_MESSAGE(d.hwActive(), std::string(f));
    const VideoFrame* fr = d.frameAt(0);
    REQUIRE(fr);
    CHECK(fr->hw);
    if (std::string(f) == "hevc10.mp4") CHECK(fr->layout == PixelLayout::P010);
  }
}

TEST_CASE("variable frame rate is decoded by timestamp") {
  // 30 fps for a second, then 60 fps: frame n sits at n/30 s for n < 30, then 1 + (n−30)/60 s
  std::string path = fx::numbered("vfr.mkv", "-c:v libx264 -preset ultrafast -pix_fmt yuv420p -fps_mode passthrough -c:a aac", 3, 60,
                                  "setpts='if(lt(N\\,30)\\,N/30\\,1+(N-30)/60)/TB'", "320x240");
  REQUIRE(!path.empty());
  Media m;
  REQUIRE(probe(path, m).empty());
  CHECK_MESSAGE(m.vfr, "rate " << m.rate.num << "/" << m.rate.den << " dur " << toSeconds(m.duration));
  VideoDecoder d;
  REQUIRE(d.open(path, false).empty());
  for (int n : {0, 10, 29, 30, 31, 45, 60, 89, 3, 50}) {
    double t = n < 30 ? n / 30.0 : 1 + (n - 30) / 60.0;
    const VideoFrame* fr = d.frameAt(fromSeconds(t));
    REQUIRE(fr);
    CHECK_MESSAGE(fx::lumaToFrame(centreLuma(*fr), n) == n, "frame " << n);
    CHECK(std::fabs(toSeconds(fr->pts) - t) < 0.002);
  }
}

TEST_CASE("audio reads are sample-exact wherever they start") {
  std::string path = fx::numbered("tone.mov", "-c:v prores_ks -profile:v 0 -c:a pcm_s24le", 3);
  REQUIRE(!path.empty());
  AudioDecoder a;
  REQUIRE(a.open(path, 48000, 2).empty());
  CHECK(std::llabs(a.lengthSamples() - 144000) < 2000);
  // a 440 Hz sine at amplitude 1/8 (lavfi's default); phase 0 at sample 0
  std::mt19937 rng(3);
  for (int i = 0; i < 30; ++i) {
    int64_t at = int64_t(rng() % 140000);
    float buf[2 * 256];
    a.read(at, buf, 256);
    double maxErr = 0;
    for (int s = 0; s < 256; ++s) {
      double want = 0.125 * std::sin(2 * M_PI * 440 * double(at + s) / 48000);
      maxErr = std::max(maxErr, std::fabs(buf[s * 2] - want));
    }
    CHECK_MESSAGE(maxErr < 2e-3, "at " << at << " err " << maxErr);
  }
  // past the end is silence
  float tail[2 * 64];
  a.read(a.lengthSamples() + 1000, tail, 64);
  for (float v : tail) CHECK(v == 0.f);
}

TEST_CASE("probe: stills and sound-only files") {
  std::string png = fx::mediaDir() + "/still.png";
  if (!std::filesystem::exists(png))
    std::system(("ffmpeg -nostdin -loglevel error -y -f lavfi -i testsrc2=s=640x360:d=1 -frames:v 1 '" + png + "'").c_str());
  Media m;
  REQUIRE(probe(png, m).empty());
  CHECK(m.kind == MediaKind::Image);
  CHECK(m.width == 640);
  VideoDecoder d;
  REQUIRE(d.open(png, true).empty());
  const VideoFrame* f = d.frameAt(fromSeconds(3));
  REQUIRE(f);
  CHECK(f->layout == PixelLayout::RGBA8);

  std::string wav = fx::mediaDir() + "/voice.wav";
  if (!std::filesystem::exists(wav))
    std::system(("ffmpeg -nostdin -loglevel error -y -f lavfi -i sine=d=2 '" + wav + "'").c_str());
  Media w;
  REQUIRE(probe(wav, w).empty());
  CHECK(w.kind == MediaKind::Audio);
  CHECK_FALSE(w.hasVideo);
}
