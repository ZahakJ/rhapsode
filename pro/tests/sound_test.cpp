#include <doctest.h>

#include <cmath>
#include <cstdlib>

#include "ai/sound.h"
#include "media/decode.h"
#include "media_fixtures.h"

using namespace rhap;

namespace {
double rmsDb(AudioDecoder& d, double a, double b) {
  int64_t s0 = int64_t(a * 48000), n = int64_t((b - a) * 48000);
  std::vector<float> buf(size_t(n) * 2);
  d.read(s0, buf.data(), int(n));
  double e = 0;
  for (float v : buf) e += double(v) * v;
  return 10 * std::log10(e / double(buf.size()) + 1e-20);
}
}  // namespace

TEST_CASE("noise reduction lowers the floor, keeps the voice and every sample's place") {
  std::string src = fx::mediaDir() + "/noisy.wav";
  if (!std::filesystem::exists(src))
    std::system(("ffmpeg -nostdin -loglevel error -y -f lavfi -i \"aevalsrc='0.02*(random(0)-0.5)+if(gte(t,1),0.3*sin(2*PI*220*t)*(0.6+0.4*sin(2*PI*3*t)),0)':s=48000:d=3\" -c:a pcm_f32le '" + src + "'").c_str());
  std::string out = fx::tmpdir("denoise") + "/clean.flac";
  REQUIRE(ai::denoise(src, out).empty());
  AudioDecoder a, b;
  REQUIRE(a.open(src).empty());
  REQUIRE(b.open(out).empty());
  CHECK(std::llabs(a.lengthSamples() - b.lengthSamples()) <= 1);
  double floorBefore = rmsDb(a, 0.2, 0.8), floorAfter = rmsDb(b, 0.2, 0.8);
  double voiceBefore = rmsDb(a, 1.5, 2.5), voiceAfter = rmsDb(b, 1.5, 2.5);
  MESSAGE("floor " << floorBefore << " → " << floorAfter << " dB, voice " << voiceBefore << " → " << voiceAfter << " dB");
  CHECK(floorBefore - floorAfter >= 10);
  CHECK(std::fabs(voiceBefore - voiceAfter) <= 1.5);
  // alignment: a click in noise comes out on the same sample
  std::string click = fx::mediaDir() + "/click.wav";
  if (!std::filesystem::exists(click))
    std::system(("ffmpeg -nostdin -loglevel error -y -f lavfi -i \"aevalsrc='0.02*(random(0)-0.5)+if(eq(n,72000),0.9,0)':s=48000:d=3\" -c:a pcm_f32le '" + click + "'").c_str());
  std::string cleanClick = fx::tmpdir("denoise-click") + "/click.flac";
  REQUIRE(ai::denoise(click, cleanClick).empty());
  AudioDecoder c;
  REQUIRE(c.open(cleanClick).empty());
  std::vector<float> v(48000 * 2);
  c.read(48000, v.data(), 48000);
  int peak = 0;
  for (int i = 0; i < 48000; ++i)
    if (std::fabs(v[size_t(i) * 2]) > std::fabs(v[size_t(peak) * 2])) peak = i;
  CHECK(48000 + peak == 72000);
}

TEST_CASE("voice isolation (Demucs, when RHAP_TEST_DEMUCS=1)") {
  if (!std::getenv("RHAP_TEST_DEMUCS")) return;
  std::string src = fx::mediaDir() + "/noisy.wav";
  std::string out = fx::tmpdir("voice") + "/voice.flac";
  REQUIRE(ai::isolateVoice(src, out).empty());
  Media m;
  REQUIRE(probe(out, m).empty());
  CHECK(std::fabs(toSeconds(m.duration) - 3) < 0.05);
}
