#include <doctest.h>

#include <random>

#include "fixtures.h"
#include "io/project_io.h"

using namespace rhap;
using fx::sec;

namespace {
const TrackRef V1{TrackKind::Video, 0}, V2{TrackKind::Video, 1}, A1{TrackKind::Audio, 0}, A2{TrackKind::Audio, 1};

Clip mk(Project& p, const char* media, double at, double dur, double in = 0) {
  Clip c = clipOf(p, *p.findMedia(media), sec(at), sec(dur));
  c.in = sec(in);
  return c;
}

void ok(const Err& e) { REQUIRE_MESSAGE(e.empty(), e); }

std::vector<std::pair<Tick, Tick>> layout(const Sequence& s, TrackRef r) {
  std::vector<std::pair<Tick, Tick>> v;
  for (auto& c : trackOf(s, r)->clips) v.push_back({c.start, c.end()});
  return v;
}
}  // namespace

TEST_CASE("overwrite cuts through what lies beneath") {
  Project p = fx::project();
  Editor ed(p, "main");
  ok(ed.overwrite(V1, mk(p, "cam", 0, 10)));
  ok(ed.overwrite(V1, mk(p, "broll", 4, 2)));
  auto& t = ed.seq().video[0];
  REQUIRE(t.clips.size() == 3);
  CHECK(t.clips[0].end() == sec(4));
  CHECK(t.clips[1].ref == "broll");
  CHECK(t.clips[2].start == sec(6));
  CHECK(t.clips[2].in == sec(6));  // the right part keeps playing the same source frames
  CHECK(check(p).empty());
}

TEST_CASE("insert ripples the target and every sync-locked track") {
  Project p = fx::project();
  Editor ed(p, "main");
  ok(ed.overwrite(V1, mk(p, "cam", 0, 10)));
  ok(ed.overwrite(A1, mk(p, "music", 0, 10)));
  ed.seq().audio[1].syncLock = false;
  ok(ed.overwrite(A2, mk(p, "music", 0, 10)));
  ok(ed.insert(V1, mk(p, "broll", 5, 3)));
  CHECK(layout(ed.seq(), V1) == std::vector<std::pair<Tick, Tick>>{{0, sec(5)}, {sec(5), sec(8)}, {sec(8), sec(13)}});
  CHECK(layout(ed.seq(), A1) == std::vector<std::pair<Tick, Tick>>{{0, sec(5)}, {sec(8), sec(13)}});
  CHECK(layout(ed.seq(), A2) == std::vector<std::pair<Tick, Tick>>{{0, sec(10)}});  // sync lock off
  CHECK(check(p).empty());
}

TEST_CASE("extract and ripple delete close the gap; lift leaves it") {
  Project p = fx::project();
  Editor ed(p, "main");
  ok(ed.overwrite(V1, mk(p, "cam", 0, 4)));
  Clip mid = mk(p, "cam", 4, 4, 10);
  std::string midId = mid.id;
  ok(ed.overwrite(V1, mid));
  ok(ed.overwrite(V1, mk(p, "cam", 8, 4, 20)));
  Project before = p;
  ok(ed.remove(midId));
  CHECK(layout(ed.seq(), V1).back().first == sec(8));
  p = before;
  ok(ed.rippleDelete(midId));
  CHECK(layout(ed.seq(), V1) == std::vector<std::pair<Tick, Tick>>{{0, sec(4)}, {sec(4), sec(8)}});
  CHECK(ed.seq().video[0].clips[1].in == sec(20));
  CHECK(check(p).empty());
}

TEST_CASE("ripple trim moves what follows; roll keeps the total") {
  Project p = fx::project();
  Editor ed(p, "main");
  Clip a = mk(p, "cam", 0, 5, 10), b = mk(p, "cam", 5, 5, 30);
  std::string aid = a.id, bid = b.id;
  ok(ed.overwrite(V1, a));
  ok(ed.overwrite(V1, b));
  ok(ed.rippleTrim(aid, Edge::Tail, sec(1)));
  CHECK(layout(ed.seq(), V1) == std::vector<std::pair<Tick, Tick>>{{0, sec(6)}, {sec(6), sec(11)}});
  ok(ed.rippleTrim(aid, Edge::Head, sec(2)));  // drops 2 s off the head, start stays at 0
  CHECK(ed.seq().video[0].clips[0].in == sec(12));
  CHECK(layout(ed.seq(), V1) == std::vector<std::pair<Tick, Tick>>{{0, sec(4)}, {sec(4), sec(9)}});
  Tick total = ed.seq().duration();
  ok(ed.rollTrim(aid, sec(1)));
  CHECK(ed.seq().duration() == total);
  CHECK(ed.seq().video[0].clips[1].in == sec(31));
  CHECK_FALSE(ed.rollTrim(aid, sec(100)).empty());  // b would be empty
  CHECK(ed.seq().duration() == total);               // and nothing changed
  // the head of a clip cannot be trimmed before its media starts
  CHECK_FALSE(ed.rippleTrim(aid, Edge::Head, -sec(20)).empty());
  CHECK(check(p).empty());
}

TEST_CASE("slip and slide") {
  Project p = fx::project();
  Editor ed(p, "main");
  Clip a = mk(p, "cam", 0, 5), b = mk(p, "cam", 5, 5, 10), c = mk(p, "cam", 10, 5, 20);
  std::string bid = b.id;
  ok(ed.overwrite(V1, a));
  ok(ed.overwrite(V1, b));
  ok(ed.overwrite(V1, c));
  ok(ed.slip(bid, sec(2)));
  CHECK(clipById(ed.seq(), bid)->in == sec(12));
  CHECK(layout(ed.seq(), V1)[1] == std::pair<Tick, Tick>{sec(5), sec(10)});
  ok(ed.slide(bid, sec(1)));
  CHECK(layout(ed.seq(), V1) == std::vector<std::pair<Tick, Tick>>{{0, sec(6)}, {sec(6), sec(11)}, {sec(11), sec(15)}});
  CHECK(clipById(ed.seq(), bid)->in == sec(12));  // slide keeps the source window
  CHECK(ed.seq().video[0].clips[2].in == sec(21));
  CHECK_FALSE(ed.slip(bid, sec(1000)).empty());
}

TEST_CASE("linked clips move together; razor keeps the link pairs") {
  Project p = fx::project();
  Editor ed(p, "main");
  Clip v = mk(p, "cam", 0, 10), a = mk(p, "cam", 0, 10);
  std::string vid = v.id;
  ok(ed.overwrite(V1, v));
  ok(ed.overwrite(A1, a));
  ok(ed.link({vid, a.id}));
  ok(ed.move(vid, V2, sec(3)));
  CHECK(layout(ed.seq(), V2) == std::vector<std::pair<Tick, Tick>>{{sec(3), sec(13)}});
  CHECK(layout(ed.seq(), A1) == std::vector<std::pair<Tick, Tick>>{{sec(3), sec(13)}});
  ok(ed.razorAll(sec(5)));
  auto& vr = ed.seq().video[1].clips[1];
  auto& ar = ed.seq().audio[0].clips[1];
  CHECK(vr.link == ar.link);
  CHECK(vr.link != ed.seq().video[1].clips[0].link);
}

TEST_CASE("keyframes stay on their frames across a razor") {
  Project p = fx::project();
  Editor ed(p, "main");
  Clip c = mk(p, "cam", 0, 10);
  c.xf.opacity.setKey(0, 0);
  c.xf.opacity.setKey(sec(10), 1);
  ok(ed.overwrite(V1, c));
  double mid = ed.seq().video[0].clips[0].xf.opacity.at(sec(6));
  ok(ed.razor(V1, sec(4)));
  auto& right = ed.seq().video[0].clips[1];
  CHECK(right.xf.opacity.at(sec(2)) == doctest::Approx(mid));
}

TEST_CASE("easing curves") {
  Param p;
  p.setKey(0, 0, Ease::InOut);
  p.setKey(100, 10);
  CHECK(p.at(50) == doctest::Approx(5).epsilon(1e-6));
  CHECK(p.at(10) < 1.0);  // slow in
  Param h;
  h.setKey(0, 3, Ease::Hold);
  h.setKey(100, 9);
  CHECK(h.at(99) == 3);
  CHECK(h.at(100) == 9);
  CHECK(cubicBezier(0.25, 0.1, 0.25, 1, 0.5) == doctest::Approx(0.8024).epsilon(1e-3));  // CSS "ease"
}

TEST_CASE("nest replaces clips with one clip of a new sequence") {
  Project p = fx::project();
  Editor ed(p, "main");
  Clip a = mk(p, "cam", 2, 3), b = mk(p, "broll", 4, 4);
  ok(ed.overwrite(V1, a));
  ok(ed.overwrite(V2, b));
  std::string ns;
  ok(ed.nest({a.id, b.id}, &ns));
  CHECK(ed.seq().video[0].clips.size() == 1);
  CHECK(ed.seq().video[0].clips[0].kind == ClipKind::Nested);
  CHECK(ed.seq().video[0].clips[0].start == sec(2));
  CHECK(ed.seq().video[0].clips[0].dur == sec(6));
  CHECK(ed.seq().video[1].clips.empty());
  const Sequence* n = p.findSequence(ns);
  REQUIRE(n);
  CHECK(n->video[1].clips[0].start == sec(2));
  CHECK(check(p).empty());
}

TEST_CASE("multicam: angles switch at cuts") {
  Project p = fx::project();
  p.media.push_back(fx::media("cam2", MediaKind::Video, 60));
  std::string mc = makeMulticam(p, "Podcast", {"cam", "cam2"}, {sec(1), 0});
  Editor ed(p, "main");
  Clip c;
  c.id = p.makeId("c");
  c.kind = ClipKind::Multicam;
  c.ref = mc;
  c.start = 0;
  c.dur = sec(30);
  ok(ed.overwrite(V1, c));
  ok(ed.switchAngle(c.id, sec(10), 1));
  ok(ed.switchAngle(ed.seq().video[0].clips[1].id, sec(20), 0));
  auto& cl = ed.seq().video[0].clips;
  REQUIRE(cl.size() == 3);
  CHECK(cl[0].angle == 0);
  CHECK(cl[1].angle == 1);
  CHECK(cl[2].angle == 0);
  CHECK(cl[2].in == sec(20));
  CHECK_FALSE(ed.switchAngle(cl[0].id, sec(1), 7).empty());
  CHECK(check(p).empty());
}

TEST_CASE("undo and redo restore exact snapshots") {
  Project p = fx::project();
  History h;
  Editor ed(p, "main");
  Project s0 = p;
  h.push(p, "overwrite");
  ok(ed.overwrite(V1, mk(p, "cam", 0, 10)));
  Project s1 = p;
  h.push(p, "razor");
  ok(ed.razor(V1, sec(3)));
  REQUIRE(h.undo(p));
  CHECK(p == s1);
  REQUIRE(h.undo(p));
  CHECK(p == s0);
  REQUIRE(h.redo(p));
  CHECK(p == s1);
}

TEST_CASE("property: 100 000 random edits never break an invariant") {
  std::mt19937_64 rng(20261016);
  auto pick = [&](int n) { return int(rng() % uint64_t(std::max(1, n))); };
  auto when = [&](double maxS) { return snapFrame(fromSeconds(double(rng() % 100000) / 100000.0 * maxS), Rate{30, 1}); };
  const char* medias[] = {"cam", "music", "still", "broll"};
  Project p = fx::project();
  Editor ed(p, "main");
  int applied = 0, refused = 0;
  for (int i = 0; i < 100000; ++i) {
    if (p.findSequence("main")->duration() > sec(600) || i % 5000 == 0) p = fx::project();  // keep it bounded
    Sequence& s = ed.seq();
    std::vector<std::string> ids;
    forEachTrack(s, [&](const Track& t, TrackRef) {
      for (auto& c : t.clips) ids.push_back(c.id);
    });
    std::string any = ids.empty() ? "nope" : ids[pick(int(ids.size()))];
    TrackRef tr{pick(2) ? TrackKind::Video : TrackKind::Audio, pick(3)};
    const char* m = medias[pick(4)];
    if (tr.kind == TrackKind::Audio && (std::string(m) == "still" || std::string(m) == "broll")) m = "music";
    Tick d = when(8) + frameTicks(Rate{30, 1});
    Project before = p;
    Err e;
    int op = pick(16);
    switch (op) {
      case 0: e = ed.overwrite(tr, mk(p, m, toSeconds(when(60)), toSeconds(d), toSeconds(when(5)))); break;
      case 1: e = ed.insert(tr, mk(p, m, toSeconds(when(60)), toSeconds(d), toSeconds(when(5)))); break;
      case 2: e = ed.razor(tr, when(60)); break;
      case 3: e = ed.lift({tr}, when(30), when(60)); break;
      case 4: e = ed.extract({tr}, when(30), when(60)); break;
      case 5: e = ed.rippleDelete(any); break;
      case 6: e = ed.rippleTrim(any, pick(2) ? Edge::Head : Edge::Tail, when(4) - sec(2)); break;
      case 7: e = ed.rollTrim(any, when(4) - sec(2)); break;
      case 8: e = ed.slip(any, when(4) - sec(2)); break;
      case 9: e = ed.slide(any, when(4) - sec(2)); break;
      case 10: e = ed.move(any, tr, when(60)); break;
      case 11: e = ed.setSpeed(any, pick(2) ? 0.5 : (pick(2) ? 2.0 : -1.0), pick(2)); break;
      case 12: e = ed.trim(any, pick(2) ? Edge::Head : Edge::Tail, when(4) - sec(2)); break;
      case 13: e = ed.closeGap(tr, when(60)); break;
      case 14: e = ids.size() >= 2 ? ed.link({ids[0], ids[1]}) : ed.unlink(any); break;
      case 15: e = ed.razorAll(when(60)); break;
    }
    if (e.empty()) {
      ++applied;
      auto errs = check(p);
      if (!errs.empty()) {
        FAIL_CHECK("op " << op << " broke an invariant at step " << i << ": " << errs[0]);
        break;
      }
    } else {
      ++refused;
      if (!(p == before)) {
        FAIL_CHECK("refused op " << op << " changed the project at step " << i << ": " << e);
        break;
      }
    }
  }
  MESSAGE("applied " << applied << ", refused " << refused);
  CHECK(applied > 30000);
  // and the result survives a save/load round trip byte for byte
  std::string a = serialize(p);
  CHECK(serialize(deserialize(a)) == a);
}

#include "model/templates.h"

TEST_CASE("templates: graphics land above the footage they cover and animate") {
  Project p = fx::project(1, 1);
  Editor ed(p, "main");
  REQUIRE(ed.overwrite(V1, mk(p, "cam", 0, 10)).empty());
  Clip lt = makeTitle(p, p.sequences[0], "Lower third", sec(2));
  REQUIRE(placeGraphic(p, "main", lt).empty());
  REQUIRE(p.sequences[0].video.size() == 2);  // a track was added, nothing was cut
  CHECK(p.sequences[0].video[0].clips.size() == 1);
  const Clip& t = p.sequences[0].video[1].clips[0];
  CHECK(t.xf.x.at(0) < t.xf.x.at(sec(0.5)));       // slides in from the left
  CHECK(t.xf.opacity.at(0) == 0);
  CHECK(t.xf.opacity.at(sec(2)) == 1);
  Clip again = makeTitle(p, p.sequences[0], "Subtitle", sec(3));
  REQUIRE(placeGraphic(p, "main", again).empty());
  CHECK(p.sequences[0].video.size() == 3);  // over the lower third, not on it
  Clip later = makeShape(p, p.sequences[0], ClipKind::Shape, ShapeKind::Ellipse, sec(20));
  REQUIRE(placeGraphic(p, "main", later).empty());
  CHECK(p.sequences[0].video[0].clips.size() == 2);  // nothing under it: the first free track
  CHECK(check(p).empty());
}
