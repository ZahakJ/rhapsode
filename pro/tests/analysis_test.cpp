#include <doctest.h>

#include <cmath>

#include "ai/analysis.h"
#include "media/decode.h"
#include "media_fixtures.h"

using namespace rhap;
using fx::sec;

namespace {
std::string make(const std::string& name, const std::string& args) {
  std::string out = fx::mediaDir() + "/" + name;
  if (std::filesystem::exists(out)) return out;
  std::string cmd = "ffmpeg -nostdin -loglevel error -y -threads 2 " + args + " '" + out + "'";
  return std::system(cmd.c_str()) == 0 ? out : "";
}
}  // namespace

TEST_CASE("silence: found to the sample, removed with a ripple") {
  // tone 0–1 s, digital silence 1–2.5 s, tone 2.5–4 s, a 0.2 s pause (kept), tone to 5 s
  std::string path = make("talk.wav",
                          "-f lavfi -i \"aevalsrc='if(between(t,1,2.5)+between(t,4,4.2),0,0.3*cos(2*PI*300*t))':s=48000:d=5\" -c:a pcm_f32le");
  REQUIRE(!path.empty());
  ai::SilenceOptions o;
  o.pad = 0;
  auto sil = ai::detectSilence(path, o);
  REQUIRE(sil.size() == 1);
  CHECK(sampleAt(sil[0].a, 48000) == 48000);
  CHECK(sampleAt(sil[0].b, 48000) == 120001);  // between() is inclusive: sample 120000 (t = 2.5) is still silent
  Project p = fx::project();
  Media m;
  m.id = "talk";
  REQUIRE(probe(path, m).empty());
  p.media.push_back(m);
  Editor ed(p, "main");
  Clip c = clipOf(p, m, sec(2));
  REQUIRE(ed.overwrite({TrackKind::Audio, 0}, c).empty());
  std::string err;
  CHECK(ai::removeSilence(p, "main", c.id, sil, false, &err) == 1);
  const Track& t = p.sequences[0].audio[0];
  REQUIRE(t.clips.size() == 2);
  CHECK(t.clips[0].end() == sec(3));
  CHECK(t.clips[1].start == sec(3));
  CHECK(t.clips[1].in == sampleStart(120001, 48000));  // the sound resumes on its first sample
  CHECK(p.sequences[0].duration() == sec(7) - sampleStart(72001, 48000));
  CHECK(check(p).empty());
}

TEST_CASE("scene cuts land on the first frame of each shot") {
  std::string path = make("shots.mp4",
                          "-f lavfi -i testsrc2=s=320x240:r=30:d=1 -f lavfi -i smptehdbars=s=320x240:r=30:d=1 "
                          "-f lavfi -i rgbtestsrc=s=320x240:r=30:d=1 -filter_complex \"[0][1][2]concat=n=3:v=1:a=0\" "
                          "-c:v libx264 -preset ultrafast -pix_fmt yuv420p");
  REQUIRE(!path.empty());
  auto cuts = ai::detectScenes(path, {}, false);
  REQUIRE(cuts.size() == 2);
  CHECK(frameAt(cuts[0] + kFlicks / 1000, Rate{30, 1}) == 30);
  CHECK(frameAt(cuts[1] + kFlicks / 1000, Rate{30, 1}) == 60);
  Project p = fx::project();
  Media m;
  m.id = "shots";
  REQUIRE(probe(path, m).empty());
  p.media.push_back(m);
  Editor ed(p, "main");
  Clip c = clipOf(p, m, 0);
  REQUIRE(ed.overwrite({TrackKind::Video, 0}, c).empty());
  CHECK(ai::splitAtScenes(p, "main", c.id, cuts) == 2);
  CHECK(p.sequences[0].video[0].clips.size() == 3);
}

TEST_CASE("auto-reframe follows a moving subject into a vertical frame") {
  // a white square crossing a black 16:9 frame left to right in 1.5 s
  std::string path = make("subject.mp4",
                          "-f lavfi -i color=black:s=640x360:r=30:d=2 -f lavfi -i color=white:s=60x60:r=30:d=2 "
                          "-filter_complex \"[0][1]overlay=x='20+t*360':y=150\" "
                          "-c:v libx264 -preset ultrafast -pix_fmt yuv420p");
  REQUIRE(!path.empty());
  auto keys = ai::trackSubject(path, 6, false);
  REQUIRE(keys.size() >= 10);
  for (auto& k : keys) {
    double t = toSeconds(k.t);
    if (t < 0.3 || t > 1.4) continue;  // ends of a smoothed path ease in and out
    double want = (20 + t * 360 + 30) / 640;
    CHECK_MESSAGE(std::fabs(k.cx - want) < 0.07, "t " << t << " cx " << k.cx << " want " << want);
  }
  // in a 9:16 sequence the clip covers the frame and its position tracks the square
  Project p = fx::project();
  p.sequences[0].width = 1080;
  p.sequences[0].height = 1920;
  Media m;
  m.id = "subject";
  REQUIRE(probe(path, m).empty());
  p.media.push_back(m);
  Editor ed(p, "main");
  Clip c = clipOf(p, m, 0);
  REQUIRE(ed.overwrite({TrackKind::Video, 0}, c).empty());
  CHECK(ai::applyReframe(p, "main", c.id, keys) > 5);
  const Clip& r = p.sequences[0].video[0].clips[0];
  CHECK(r.xf.scale.value == doctest::Approx((1920.0 / 360) / (1080.0 / 640)));
  CHECK(r.xf.x.at(sec(0.4)) > r.xf.x.at(sec(1.2)));  // the subject moves right, so the picture slides left
}

TEST_CASE("multicam: angles synced by their sound, to the sample") {
  // one room, three recorders started at different moments, at different levels, each with its own hiss
  std::string room = make("room.wav", "-f lavfi -i \"aevalsrc='0.3*sin(2*PI*(200+150*sin(2*PI*0.7*t))*t)*(0.5+0.5*sin(2*PI*1.3*t))*gt(sin(2*PI*0.9*t),-0.3)':s=48000:d=30\" -c:a pcm_f32le");
  REQUIRE(!room.empty());
  // B starts 1.234 s into the room, C 2.5 s before A (it has 2.5 s A never heard)
  std::string b = make("angleB.wav", "-i '" + room + "' -af \"atrim=start=1.234,asetpts=PTS-STARTPTS,volume=0.4,aeval='val(0)+0.01*(random(0)-0.5)'\" -c:a pcm_f32le");
  std::string c = make("angleC.wav", "-f lavfi -i anoisesrc=d=2.5:a=0.02:r=48000 -i '" + room + "' -filter_complex \"[0][1]concat=n=2:v=0:a=1,volume=1.5\" -c:a pcm_f32le");
  REQUIRE(!b.empty());
  REQUIRE(!c.empty());
  std::string err;
  auto off = ai::syncByAudio({room, b, c}, 10 * kFlicks, &err);
  REQUIRE_MESSAGE(err.empty(), err);
  CHECK_MESSAGE(std::llabs(sampleAt(off[1], 48000) - sampleAt(-fromSeconds(1.234), 48000)) <= 1, "B " << toSeconds(off[1]));
  CHECK_MESSAGE(std::llabs(sampleAt(off[2], 48000) - sampleAt(fromSeconds(2.5), 48000)) <= 1, "C " << toSeconds(off[2]));
}
