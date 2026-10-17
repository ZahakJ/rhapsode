#include <doctest.h>

#include <cmath>
#include <cstdio>
#include <regex>

#include "audio/mixer.h"
#include "media_fixtures.h"

using namespace rhap;
using namespace rhap::audio;
using fx::sec;

namespace {

std::string makeWav(const std::string& name, const std::string& expr, double seconds) {
  std::string out = fx::mediaDir() + "/" + name;
  if (std::filesystem::exists(out)) return out;
  std::string cmd = "ffmpeg -nostdin -loglevel error -y -f lavfi -i \"aevalsrc='" + expr + "':s=48000:d=" +
                    std::to_string(seconds) + "\" -c:a pcm_f32le '" + out + "'";
  return std::system(cmd.c_str()) == 0 ? out : "";
}

struct Ref {
  double I = 0, LRA = 0, TP = 0;
};

Ref ffmpegLoudness(const std::string& path) {
  std::string cmd = "ffmpeg -nostdin -hide_banner -nostats -i '" + path + "' -af ebur128=peak=true -f null - 2>&1";
  FILE* f = popen(cmd.c_str(), "r");
  std::string text;
  char buf[4096];
  while (size_t n = fread(buf, 1, sizeof buf, f)) text.append(buf, n);
  pclose(f);
  Ref r;
  std::smatch m;
  auto sum = text.substr(text.rfind("Summary:"));
  if (std::regex_search(sum, m, std::regex(R"(I:\s+(-?[0-9.]+) LUFS)"))) r.I = std::stod(m[1]);
  if (std::regex_search(sum, m, std::regex(R"(LRA:\s+(-?[0-9.]+) LU)"))) r.LRA = std::stod(m[1]);
  if (std::regex_search(sum, m, std::regex(R"(Peak:\s+(-?[0-9.]+) dBFS)"))) r.TP = std::stod(m[1]);
  return r;
}

LoudnessMeter meterFile(const std::string& path) {
  AudioDecoder d;
  REQUIRE(d.open(path, 48000, 2).empty());
  LoudnessMeter m(48000, 2);
  std::vector<float> buf(4800 * 2);
  for (int64_t at = 0; at < d.lengthSamples(); at += 4800) {
    int n = int(std::min<int64_t>(4800, d.lengthSamples() - at));
    d.read(at, buf.data(), n);
    m.push(buf.data(), n);
  }
  return m;
}

Media audioMedia(const std::string& id, const std::string& path) {
  Media m;
  m.id = id;
  REQUIRE(probe(path, m).empty());
  return m;
}

}  // namespace

TEST_CASE("loudness: the EBU anchor and agreement with ffmpeg's ebur128") {
  // EBU Tech 3341 case 1: stereo 1 kHz at −23 dBFS reads −23.0 LUFS
  std::string sine = makeWav("sine-23.wav", "0.0707946*sin(2*PI*1000*t)|0.0707946*sin(2*PI*1000*t)", 20);
  REQUIRE(!sine.empty());
  LoudnessMeter m = meterFile(sine);
  CHECK(m.integrated() == doctest::Approx(-23.0).epsilon(0.1 / 23));
  CHECK(m.momentary() == doctest::Approx(-23.0).epsilon(0.1 / 23));
  CHECK(m.shortTerm() == doctest::Approx(-23.0).epsilon(0.1 / 23));
  // programmes with gating at work: loud and quiet stretches, silence, noise, low and high tones
  struct C {
    const char* name;
    const char* expr;
  };
  for (C c : {C{"steps.wav", "if(lt(mod(t,6),2),0.5,if(lt(mod(t,6),4),0.02,0))*sin(2*PI*440*t)|"
                             "if(lt(mod(t,6),2),0.3,0.05)*sin(2*PI*3000*t)"},
              C{"noise.wav", "0.2*(random(0)-0.5)|0.1*(random(1)-0.5)"},
              C{"low.wav", "0.6*sin(2*PI*60*t)*(0.5+0.5*sin(2*PI*0.2*t))|0.4*sin(2*PI*8000*t)"}}) {
    std::string path = makeWav(c.name, c.expr, 30);
    REQUIRE(!path.empty());
    LoudnessMeter mm = meterFile(path);
    Ref r = ffmpegLoudness(path);
    CHECK_MESSAGE(std::fabs(mm.integrated() - r.I) <= 0.1, c.name << ": " << mm.integrated() << " vs ffmpeg " << r.I);
    CHECK_MESSAGE(std::fabs(mm.range() - r.LRA) <= 1.0, c.name << " LRA: " << mm.range() << " vs " << r.LRA);
    CHECK_MESSAGE(std::fabs(mm.truePeak() - r.TP) <= 0.5, std::string(c.name) << " TP: " << mm.truePeak() << " vs " << r.TP);
  }
}

TEST_CASE("mixer: a clip plays its source sample-exactly at its timeline place") {
  std::string path = makeWav("ramp.wav", "0.1*sin(2*PI*233*t)+0.05*sin(2*PI*1999*t)|0.1*sin(2*PI*377*t)", 6);
  Project p = fx::project();
  p.media.push_back(audioMedia("tone", path));
  Editor ed(p, "main");
  Clip c = clipOf(p, *p.findMedia("tone"), sec(1), sec(3));
  c.in = sec(0.5);
  REQUIRE(ed.overwrite({TrackKind::Audio, 0}, c).empty());
  Mixer mix;
  AudioDecoder ref;
  REQUIRE(ref.open(path).empty());
  std::vector<float> out(48000 * 2), want(48000 * 2);
  // a block straddling the clip start: silence, then the source from its in point
  mix.render(p, ed.seq(), 48000 - 1000, 4000, out.data());
  ref.read(24000, want.data(), 3000);
  for (int i = 0; i < 1000; ++i) CHECK(out[size_t(i) * 2] == 0.f);
  int bad = 0;
  for (int i = 0; i < 3000; ++i)
    if (std::fabs(out[size_t(1000 + i) * 2] - want[size_t(i) * 2]) > 1e-6) ++bad;
  CHECK(bad == 0);
  // −6.0206 dB halves it; muting the track silences it
  ed.seq().audio[0].clips[0].gain = Param(-6.0206);
  mix.render(p, ed.seq(), 60000, 1000, out.data());
  ref.read(24000 + 12000, want.data(), 1000);
  for (int i = 0; i < 1000; i += 97) CHECK(out[size_t(i) * 2] == doctest::Approx(want[size_t(i) * 2] / 2).epsilon(1e-4));
  ed.seq().audio[0].mute = true;
  mix.render(p, ed.seq(), 60000, 1000, out.data());
  for (int i = 0; i < 1000; i += 97) CHECK(out[size_t(i) * 2] == 0.f);
}

TEST_CASE("mixer: an equal-power crossfade keeps a steady tone steady") {
  std::string path = makeWav("dc-tone.wav", "0.25*sin(2*PI*500*t)|0.25*sin(2*PI*500*t)", 10);
  Project p = fx::project();
  p.media.push_back(audioMedia("tone", path));
  Editor ed(p, "main");
  Clip a = clipOf(p, *p.findMedia("tone"), 0, sec(4));
  Clip b = clipOf(p, *p.findMedia("tone"), sec(4), sec(4));
  b.in = sec(4);  // continuous source: a perfect crossfade should not dip below an uncorrelated sum
  REQUIRE(ed.overwrite({TrackKind::Audio, 0}, a).empty());
  REQUIRE(ed.overwrite({TrackKind::Audio, 0}, b).empty());
  ed.seq().audio[0].transitions.push_back(Transition{"x", sec(4), sec(1), TransitionKind::Crossfade});
  Mixer mix;
  std::vector<float> out(48000 * 2);
  mix.render(p, ed.seq(), sampleAt(sec(3.5), 48000), 48000, out.data());
  double peak = 0;
  for (float v : out) peak = std::max(peak, double(std::fabs(v)));
  // equal power on correlated signals peaks at √2 × in the middle; never silent, never more than +3 dB
  CHECK(peak <= 0.25 * std::sqrt(2) + 1e-3);
  double minEnv = 1;
  for (int w = 0; w < 48000; w += 480) {
    double pk = 0;
    for (int i = w; i < w + 480; ++i) pk = std::max(pk, double(std::fabs(out[size_t(i) * 2])));
    minEnv = std::min(minEnv, pk);
  }
  CHECK(minEnv > 0.24);
}

TEST_CASE("normalise to a target and duck music under speech") {
  std::string music = makeWav("music.wav", "0.3*sin(2*PI*220*t)|0.3*sin(2*PI*330*t)", 12);
  std::string voice = makeWav("voice.wav", "if(between(mod(t,4),1,2.5),0.4*sin(2*PI*180*t)*sin(2*PI*3*t),0)|"
                                           "if(between(mod(t,4),1,2.5),0.4*sin(2*PI*180*t)*sin(2*PI*3*t),0)", 12);
  Project p = fx::project();
  p.media.push_back(audioMedia("music", music));
  p.media.push_back(audioMedia("voice", voice));
  Editor ed(p, "main");
  REQUIRE(ed.overwrite({TrackKind::Audio, 0}, clipOf(p, *p.findMedia("voice"), 0)).empty());
  REQUIRE(ed.overwrite({TrackKind::Audio, 1}, clipOf(p, *p.findMedia("music"), 0)).empty());
  int dips = autoDuck(p, ed.seq(), {0}, {1}, -12);
  CHECK(dips == 3);
  const Clip& mc = ed.seq().audio[1].clips[0];
  CHECK(mc.gain.at(sec(1.8)) == doctest::Approx(-12));
  CHECK(mc.gain.at(sec(0.3)) == doctest::Approx(0));
  CHECK(mc.gain.at(sec(3.5)) == doctest::Approx(0));
  // normalise the mix to −14 LUFS with one master move
  double before = measureLoudness(p, ed.seq());
  for (auto& t : ed.seq().audio) t.gain = Param(t.gain.value + (-14 - before));
  double after = measureLoudness(p, ed.seq());
  CHECK_MESSAGE(std::fabs(after + 14) <= 0.5, "before " << before << " after " << after);
}
