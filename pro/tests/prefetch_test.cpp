#include <doctest.h>

#include <random>

#include "media/prefetch.h"
#include "media_fixtures.h"

using namespace rhap;

namespace {
int luma(const VideoFrame& f) {
  const uint8_t* p = f.plane(0) + size_t(f.height / 2) * f.stride(0);
  return f.layout == PixelLayout::P010 ? reinterpret_cast<const uint16_t*>(p)[f.width / 2] >> 8 : p[f.width / 2];
}
}  // namespace

TEST_CASE("prefetch: playback, scrubbing and the end all return the right frame") {
  std::string path = fx::numbered("h264.mp4", "-c:v libx264 -preset ultrafast -g 48 -bf 3 -pix_fmt yuv420p -c:a aac");
  Media m;
  REQUIRE(probe(path, m).empty());
  for (bool hw : {false, true}) {
    PrefetchPool pool(hw, 6);
    const Rate r{30, 1};
    for (int f = 0; f < 120; ++f) {
      const VideoFrame* v = pool.video(m, "a", frameStart(f, r));
      REQUIRE(v);
      CHECK_MESSAGE(fx::lumaToFrame(luma(*v), f) == f, (hw ? "hw" : "sw") << " playback frame " << f);
    }
    // the last frame holds past the end
    const VideoFrame* end = pool.video(m, "a", frameStart(500, r));
    REQUIRE(end);
    CHECK(fx::lumaToFrame(luma(*end), 119) == 119);
    std::mt19937 rng(11);
    for (int i = 0; i < 40; ++i) {
      int f = int(rng() % 120);
      const VideoFrame* v = pool.video(m, "a", frameStart(f, r));
      REQUIRE(v);
      CHECK_MESSAGE(fx::lumaToFrame(luma(*v), f) == f, (hw ? "hw" : "sw") << " scrub to " << f);
    }
    auto st = pool.stats();
    MESSAGE((hw ? "hw" : "sw") << ": hits " << st.hits << " waits " << st.waits << " seeks " << st.seeks);
  }
}

TEST_CASE("prefetch: many clips share one memory budget, idle ones are let go") {
  std::string path = fx::numbered("h264.mp4", "-c:v libx264 -preset ultrafast -g 48 -bf 3 -pix_fmt yuv420p -c:a aac");
  Media m;
  REQUIRE(probe(path, m).empty());
  // a budget that fits about 16 of these 320×240 frames
  size_t frame = 320 * 240 * 3 / 2;
  PrefetchPool pool(false, 8, 24, frame * 16);
  const Rate r{30, 1};
  for (int f = 0; f < 60; ++f)
    for (int c = 0; c < 6; ++c) REQUIRE(pool.video(m, "clip" + std::to_string(c), frameStart(f, r)));
  // six clips of up to 8 ahead would hold 48+ frames; the budget keeps it near 16 (+ one held per clip, + slack)
  CHECK(pool.heldBytes() <= frame * 34);
  // only clip 0 keeps playing: after a couple of sweeps the others are gone
  for (int f = 60; f < 119; ++f) REQUIRE(pool.video(m, "clip0", frameStart(f, r)));
  for (int k = 0; k < 600; ++k) pool.video(m, "clip0", frameStart(119, r));
  CHECK(pool.heldBytes() <= frame * 12);
}
