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
