#include <doctest.h>

#include <algorithm>
#include <cmath>

#include "media/decode.h"
#include "media_fixtures.h"
#include "render/export.h"

using namespace rhap;
using fx::sec;

namespace {
int centreLuma(const VideoFrame& f) {
  const uint8_t* p = f.plane(0) + size_t(f.height / 2) * f.stride(0);
  int x = f.width / 2;
  switch (f.layout) {
    case PixelLayout::NV12: return p[x];
    case PixelLayout::P010: return reinterpret_cast<const uint16_t*>(p)[x] >> 8;
    case PixelLayout::Planar: return f.bits > 8 ? reinterpret_cast<const uint16_t*>(p)[x] >> (f.bits - 8) : p[x];
    default: return -1;
  }
}
}  // namespace

TEST_CASE("export: every preset is frame-exact across cuts, with sound") {
  std::string src = fx::numbered("h264.mp4", "-c:v libx264 -preset ultrafast -g 48 -bf 3 -pix_fmt yuv420p -c:a aac");
  REQUIRE(!src.empty());
  Project p = fx::project(2, 2);
  p.sequences[0].width = 320;
  p.sequences[0].height = 240;
  Media m;
  m.id = "src";
  REQUIRE(probe(src, m).empty());
  p.media.push_back(m);
  Editor ed(p, "main");
  // A: source frames 0..29 at 0 s; B: source frames 60..89 at 1 s (a cut mid-GOP)
  Clip a = clipOf(p, m, 0, sec(1)), b = clipOf(p, m, sec(1), sec(1));
  b.in = sec(2);
  Clip aa = a, ab = b;
  aa.id = p.makeId("c");
  ab.id = p.makeId("c");
  REQUIRE(ed.overwrite({TrackKind::Video, 0}, a).empty());
  REQUIRE(ed.overwrite({TrackKind::Video, 0}, b).empty());
  REQUIRE(ed.overwrite({TrackKind::Audio, 0}, aa).empty());
  REQUIRE(ed.overwrite({TrackKind::Audio, 0}, ab).empty());
  std::string dir = fx::tmpdir("export");
  for (const char* id : {"youtube-1080p", "youtube-4k", "av1-1080p", "prores-hq", "dnxhr-hq", "dnxhr-hqx"}) {
    SUBCASE(id) {
      ExportJob job;
      job.project = p;
      job.preset = *findPreset(id);
      job.preset.width = job.preset.height = 0;  // the sequence's 320×240
      job.path = dir + "/" + id + "." + job.preset.ext;
      ExportProgress sum;
      std::string e = runExport(job, {}, &sum);
      REQUIRE_MESSAGE(e.empty(), std::string(id) << ": " << e);
      MESSAGE(std::string(id) << " via " << sum.encoder << " at " << sum.fps << " fps");
      Media out;
      REQUIRE(probe(job.path, out).empty());
      CHECK(out.width == 320);
      CHECK(out.rate == Rate{30, 1});
      CHECK(out.hasAudio);
      VideoDecoder d;
      REQUIRE(d.open(job.path, false).empty());
      int n = 0;
      for (const VideoFrame* f = d.frameAt(0); f; f = d.next(), ++n) {
        int want = n < 30 ? n : 60 + (n - 30);
        // video levels: luma outside 16..235 is clipped by any limited-range path, so compare clamped values
        int wantY = std::clamp((want * 7) % 256, 16, 235), gotY = centreLuma(*f);
        CHECK_MESSAGE(std::abs(gotY - wantY) <= 2, std::string(id) << " output frame " << n << ": luma " << gotY << " want " << wantY);
        CHECK(std::llabs(f->pts - frameStart(n, Rate{30, 1})) < kFlicks / 1000);
        if (n > 100) break;
      }
      CHECK(n == 60);
      AudioDecoder ad;
      REQUIRE(ad.open(job.path).empty());
      // AAC pads to whole 1024-sample frames; PCM is exact
      CHECK(std::llabs(ad.lengthSamples() - 96000) <= 2048);
    }
  }
}
