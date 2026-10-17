#include <doctest.h>

#include <algorithm>

#include "fixtures.h"
#include "interchange/interchange.h"
#include "io/project_io.h"

using namespace rhap;
using fx::sec;

namespace {

ImportOptions offline() {
  ImportOptions o;
  o.probeMedia = false;
  return o;
}

/** a timeline using what every format can carry: V1 with a dissolve, linked sound, a PiP, music, a marker */
Project busy() {
  Project p = fx::project(2, 2);
  for (auto& m : p.media) m.rate = Rate{30, 1};
  Editor ed(p, "main");
  auto put = [&](const char* media, TrackRef r, double at, double dur, double in, const std::string& link = "") {
    Clip c = clipOf(p, *p.findMedia(media), sec(at), sec(dur));
    c.in = sec(in);
    c.link = link;
    REQUIRE(ed.overwrite(r, c).empty());
  };
  put("cam", {TrackKind::Video, 0}, 0, 4, 10, "l1");
  put("cam", {TrackKind::Audio, 0}, 0, 4, 10, "l1");
  put("cam", {TrackKind::Video, 0}, 4, 6, 30, "l2");
  put("cam", {TrackKind::Audio, 0}, 4, 6, 30, "l2");
  put("broll", {TrackKind::Video, 1}, 2, 3, 1);
  put("music", {TrackKind::Audio, 1}, 0, 10, 5);
  ed.seq().video[0].transitions.push_back(Transition{"x1", sec(4), sec(1), TransitionKind::Dissolve});
  REQUIRE(ed.addMarker(sec(6), "chorus").empty());
  return p;
}

struct Shape {
  std::vector<std::tuple<int, int, Tick, Tick, Tick, std::string>> clips;  // kind, track, start, dur, in, media name
  std::vector<Tick> cuts, markers;
};

Shape shape(const Project& p, bool videoOnlyV1 = false) {
  Shape s;
  const Sequence& q = *p.findSequence(p.active);
  forEachTrack(q, [&](const Track& t, TrackRef r) {
    if (videoOnlyV1 && r.index > 0) return;
    for (auto& c : t.clips) {
      const Media* m = p.findMedia(c.ref);
      s.clips.push_back({int(r.kind), r.index, c.start, c.dur, c.in, m ? m->name : ""});
    }
    for (auto& x : t.transitions) s.cuts.push_back(x.at);
  });
  for (auto& m : q.markers) s.markers.push_back(m.t);
  std::sort(s.clips.begin(), s.clips.end());
  return s;
}

void roundTrip(const char* fmt, bool v1Only) {
  Project p = busy();
  std::string text;
  REQUIRE(exportText(p, fmt, text).empty());
  Project q;
  std::string e = importText(text, fmt, "", q, offline());
  REQUIRE_MESSAGE(e.empty(), fmt << ": " << e);
  Shape a = shape(p, v1Only), b = shape(q, v1Only);
  CHECK_MESSAGE(a.clips.size() == b.clips.size(), fmt);
  for (size_t i = 0; i < std::min(a.clips.size(), b.clips.size()); ++i)
    CHECK_MESSAGE(a.clips[i] == b.clips[i], fmt << " clip " << i << ": start " << toSeconds(std::get<2>(b.clips[i]))
                                               << " dur " << toSeconds(std::get<3>(b.clips[i])) << " in "
                                               << toSeconds(std::get<4>(b.clips[i])));
  CHECK_MESSAGE(a.cuts == b.cuts, fmt << " transitions");
  CHECK_MESSAGE(a.markers == b.markers, fmt << " markers");
  CHECK(check(q).empty());
}

}  // namespace

TEST_CASE("interchange round trips are frame-exact") {
  roundTrip("otio", false);
  roundTrip("fcpxml", false);
  roundTrip("xml", false);
  roundTrip("edl", true);  // EDL carries one picture track and its sound
}

TEST_CASE("OTIO carries Rhapsode's own settings losslessly") {
  Project p = busy();
  Clip& c = p.sequences[0].video[0].clips[0];
  c.grade.saturation = 0.4;
  c.xf.rotation = 12;
  c.xf.scale.setKey(0, 1, Ease::InOut);
  c.xf.scale.setKey(sec(2), 1.3);
  std::string text;
  REQUIRE(exportText(p, "otio", text).empty());
  Project q;
  REQUIRE(importText(text, "otio", "", q, offline()).empty());
  const Clip& d = q.findSequence(q.active)->video[0].clips[0];
  CHECK(d.grade.saturation == 0.4);
  CHECK(d.xf.rotation.value == 12);
  CHECK(d.xf.scale == c.xf.scale);
}

TEST_CASE("Premiere XML: transitions with -1 ends, shared files, links") {
  const char* xml = R"(<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="4">
 <sequence id="seq-1">
  <name>Interview</name>
  <rate><timebase>24</timebase><ntsc>TRUE</ntsc></rate>
  <media>
   <video>
    <format><samplecharacteristics><width>3840</width><height>2160</height></samplecharacteristics></format>
    <track>
     <clipitem id="clipitem-1">
      <name>A001.mov</name><duration>2400</duration>
      <rate><timebase>24</timebase><ntsc>TRUE</ntsc></rate>
      <start>0</start><end>-1</end><in>100</in><out>220</out>
      <file id="file-1"><name>A001.mov</name><pathurl>file://localhost/Volumes/Media/A001.mov</pathurl>
       <rate><timebase>24</timebase><ntsc>TRUE</ntsc></rate><duration>2400</duration>
       <media><video><samplecharacteristics><width>3840</width><height>2160</height></samplecharacteristics></video><audio><channelcount>2</channelcount></audio></media></file>
      <link><linkclipref>clipitem-1</linkclipref></link><link><linkclipref>clipitem-3</linkclipref></link>
     </clipitem>
     <transitionitem><start>108</start><end>132</end><alignment>center</alignment><effect><name>Cross Dissolve</name></effect></transitionitem>
     <clipitem id="clipitem-2">
      <name>A001.mov</name><duration>2400</duration>
      <rate><timebase>24</timebase><ntsc>TRUE</ntsc></rate>
      <start>-1</start><end>240</end><in>500</in><out>620</out>
      <file id="file-1"/>
     </clipitem>
    </track>
   </video>
   <audio>
    <track>
     <clipitem id="clipitem-3">
      <name>A001.mov</name><start>0</start><end>120</end><in>100</in><out>220</out><file id="file-1"/>
      <link><linkclipref>clipitem-1</linkclipref></link><link><linkclipref>clipitem-3</linkclipref></link>
     </clipitem>
    </track>
   </audio>
  </media>
  <marker><name>Q1</name><comment>first question</comment><in>48</in><out>-1</out></marker>
 </sequence>
</xmeml>)";
  Project p;
  REQUIRE(importText(xml, "xml", "", p, offline()).empty());
  const Sequence& s = *p.findSequence(p.active);
  CHECK(s.rate == kRate23976);
  CHECK(s.width == 3840);
  REQUIRE(s.video[0].clips.size() == 2);
  const Clip& a = s.video[0].clips[0];
  const Clip& b = s.video[0].clips[1];
  CHECK(a.end() == frameStart(120, kRate23976));  // the transition's centre
  CHECK(b.start == frameStart(120, kRate23976));
  CHECK(b.in == frameStart(500, kRate23976));
  CHECK(b.end() == frameStart(240, kRate23976));
  CHECK(a.ref == b.ref);  // one file, referenced twice
  CHECK(p.media.size() == 1);
  CHECK(p.media[0].path == "/Volumes/Media/A001.mov");
  REQUIRE(s.video[0].transitions.size() == 1);
  CHECK(s.video[0].transitions[0].dur == frameStart(24, kRate23976));
  REQUIRE(s.audio[0].clips.size() == 1);
  CHECK(!a.link.empty());
  CHECK(a.link == s.audio[0].clips[0].link);
  REQUIRE(s.markers.size() == 1);
  CHECK(s.markers[0].name == "Q1");
}

TEST_CASE("FCPXML: spine, gaps, connected clips and asset start timecode") {
  const char* xml = R"(<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.10">
 <resources>
  <format id="r1" frameDuration="1001/30000s" width="1920" height="1080"/>
  <asset id="r2" name="Interview" start="3600s" duration="600s" hasVideo="1" hasAudio="1" format="r1">
   <media-rep kind="original-media" src="file:///media/Interview.mov"/>
  </asset>
  <asset id="r3" name="Broll" start="0s" duration="30s" hasVideo="1" hasAudio="0" format="r1">
   <media-rep kind="original-media" src="file:///media/Broll.mov"/>
  </asset>
 </resources>
 <library><event name="E"><project name="Cut">
  <sequence format="r1" duration="20s" tcStart="0s">
   <spine>
    <asset-clip ref="r2" offset="0s" name="Interview" start="3610s" duration="5s">
     <asset-clip ref="r3" lane="1" offset="3612s" name="Broll" start="2s" duration="2s"/>
     <marker start="3611s" duration="1001/30000s" value="hello"/>
    </asset-clip>
    <gap name="Gap" offset="5s" start="3600s" duration="2s"/>
    <asset-clip ref="r2" offset="7s" name="Interview" start="3700s" duration="4s"/>
   </spine>
  </sequence>
 </project></event></library>
</fcpxml>)";
  Project p;
  REQUIRE(importText(xml, "fcpxml", "", p, offline()).empty());
  const Sequence& s = *p.findSequence(p.active);
  CHECK(s.rate == kRate2997);
  REQUIRE(s.video[0].clips.size() == 2);
  CHECK(s.video[0].clips[0].in == sec(10));  // 3610 s − the asset's 3600 s start
  CHECK(s.video[0].clips[1].start == sec(7));
  CHECK(s.video[0].clips[1].in == sec(100));
  REQUIRE(s.video.size() >= 2);
  REQUIRE(s.video[1].clips.size() == 1);
  CHECK(s.video[1].clips[0].start == sec(2));  // 3612 in the parent's time, which starts at 3610 on the timeline at 0
  CHECK(s.audio[0].clips.size() == 2);       // the interview's own sound
  REQUIRE(s.markers.size() == 1);
  CHECK(s.markers[0].t == sec(1));
}

TEST_CASE("EDL: dissolve, clip names, record hour") {
  const char* edl = R"(TITLE: Promo
FCM: NON-DROP FRAME

001  A001     B     C        00:00:10:00 00:00:14:00 01:00:00:00 01:00:04:00
* FROM CLIP NAME: A001.mov

002  A001     B     C        00:00:14:00 00:00:14:00 01:00:04:00 01:00:04:00
002  A002     B     D    030 00:00:29:15 00:00:36:00 01:00:04:00 01:00:10:15
* FROM CLIP NAME: A002.mov
* LOC: 01:00:06:00 RED chorus
)";
  Project p;
  REQUIRE(importText(edl, "edl", "", p, offline()).empty());
  const Sequence& s = *p.findSequence(p.active);
  REQUIRE(s.video[0].clips.size() == 2);
  const Rate r{30, 1};
  CHECK(s.video[0].clips[0].start == 0);
  CHECK(s.video[0].clips[0].end() == frameStart(4 * 30 + 15, r));  // the dissolve's middle
  CHECK(s.video[0].clips[1].in == frameStart(30 * 30, r));
  REQUIRE(s.video[0].transitions.size() == 1);
  CHECK(s.video[0].transitions[0].dur == frameStart(30, r));
  CHECK(s.audio[0].clips.size() == 2);
  REQUIRE(s.markers.size() == 1);
  CHECK(s.markers[0].t == sec(6));
}

TEST_CASE("a web studio sequence opens in Pro") {
  const char* seq = R"({"v":1,"canvas":{"aspect":"9:16","fps":30,"background":"101010"},
    "tracks":[
      {"id":"t1","kind":"visual","clips":[{"id":"c1","source":"aaa","at":0,"duration":5,"in":2,"fit":"cover","opacity":1,"volume":0.5}]},
      {"id":"t2","kind":"audio","clips":[{"id":"c2","source":"bbb","at":1,"in":0,"out":4,"gain":1,"fadeIn":0.5}]},
      {"id":"t3","kind":"text","clips":[{"id":"c3","at":0.5,"duration":2,"text":"hello","sub":"مرحبا","style":"box","size":0.05,"x":0.5,"y":0.8}]}]})";
  Project p;
  ImportOptions o = offline();
  REQUIRE(importText(seq, "json", "", p, o).empty());
  const Sequence& s = *p.findSequence(p.active);
  CHECK(s.width == 1080);
  CHECK(s.height == 1920);
  REQUIRE(s.video.size() == 2);
  CHECK(s.video[0].clips[0].in == sec(2));
  CHECK(s.video[1].clips[0].kind == ClipKind::Title);
  CHECK(s.video[1].clips[0].text == "hello\nمرحبا");
  CHECK(s.video[1].clips[0].xf.y.value == doctest::Approx(0.3 * 1920));
  REQUIRE(s.audio.size() == 2);
  CHECK(s.audio[0].clips[0].gain.value == doctest::Approx(-6.02).epsilon(0.01));  // the clip's own sound at half volume
  CHECK(s.audio[1].clips[0].dur == sec(4));
  CHECK(s.audio[1].clips[0].fadeIn == sec(0.5));
}
