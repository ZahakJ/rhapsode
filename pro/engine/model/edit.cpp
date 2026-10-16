#include "edit.h"

#include <algorithm>
#include <cmath>
#include <set>
#include <unordered_set>

namespace rhap {

namespace {

constexpr Tick kUnbounded = Tick(1) << 60;

template <class F>
void forEachParam(Clip& c, F&& f) {
  Transform& x = c.xf;
  for (Param* p : {&x.x, &x.y, &x.scale, &x.scaleY, &x.rotation, &x.anchorX, &x.anchorY, &x.opacity, &x.cropL,
                   &x.cropR, &x.cropT, &x.cropB, &c.gain, &c.pan})
    f(*p);
  for (auto& e : c.fx)
    for (auto& [k, p] : e.params) f(p);
  for (auto& e : c.afx)
    for (auto& [k, p] : e.params) f(p);
}

void shiftKeys(Clip& c, Tick delta) {
  forEachParam(c, [&](Param& p) {
    for (auto& k : p.keys) k.t += delta;
  });
}

bool sameRef(const TrackRef& a, const TrackRef& b) { return a.kind == b.kind && a.index == b.index; }
bool contains(const std::vector<TrackRef>& v, TrackRef r) {
  return std::any_of(v.begin(), v.end(), [&](const TrackRef& x) { return sameRef(x, r); });
}

void sortTrack(Track& t) {
  std::stable_sort(t.clips.begin(), t.clips.end(), [](const Clip& a, const Clip& b) { return a.start < b.start; });
}

Tick span(Tick dur, double speed) { return Tick(std::llround(double(dur) * std::fabs(speed))); }

}  // namespace

// ——— helpers ———

template <class F>
Err Editor::atomic(F&& f) {
  if (!p_.findSequence(id_)) return "no such sequence";
  Project backup = p_;
  Err e = f();
  if (!e.empty()) p_ = std::move(backup);
  return e;
}

Tick Editor::sourceLimit(const Clip& c) const {
  switch (c.kind) {
    case ClipKind::Media: {
      const Media* m = p_.findMedia(c.ref);
      if (!m) return 0;
      return m->kind == MediaKind::Image ? kUnbounded : m->duration;
    }
    case ClipKind::Nested:
    case ClipKind::Multicam: {
      const Sequence* s = p_.findSequence(c.ref);
      return s ? s->duration() : 0;
    }
    default: return kUnbounded;
  }
}

Err Editor::checkClip(const Clip& c) const {
  if (c.dur <= 0) return "a clip needs a duration";
  if (c.speed == 0 || !std::isfinite(c.speed)) return "speed cannot be zero";
  if (c.in < 0) return "the source in point is before the start of the media";
  if (c.in + c.sourceSpan() > sourceLimit(c)) return "the clip runs past the end of its media";
  return {};
}

void Editor::splitAt(Track& t, Tick at) {
  for (size_t i = 0; i < t.clips.size(); ++i) {
    Clip& c = t.clips[i];
    if (!(c.start < at && at < c.end())) continue;
    Clip right = c;
    Tick leftDur = at - c.start;
    right.id = p_.makeId("c");
    right.start = at;
    right.dur = c.end() - at;
    if (c.speed >= 0) {
      right.in = c.in + span(leftDur, c.speed);
    } else {
      // reversed: the left part plays the top of the source window
      right.in = c.in;
      c.in = c.in + span(right.dur, c.speed);
    }
    if (!c.link.empty()) right.link = c.link + "/" + std::to_string(at);
    c.dur = leftDur;
    c.fadeOut = 0;
    right.fadeIn = 0;
    shiftKeys(right, -leftDur);
    t.clips.insert(t.clips.begin() + i + 1, std::move(right));
    return;
  }
}

void Editor::clearRange(Track& t, Tick a, Tick b) {
  if (a >= b) return;
  splitAt(t, a);
  splitAt(t, b);
  std::erase_if(t.clips, [&](const Clip& c) { return c.start >= a && c.end() <= b; });
  std::erase_if(t.transitions, [&](const Transition& x) { return x.at >= a && x.at <= b; });
}

void Editor::shiftFrom(Track& t, Tick at, Tick delta) {
  for (auto& c : t.clips)
    if (c.start >= at) c.start += delta;
  for (auto& x : t.transitions)
    if (x.at >= at) x.at += delta;
}

std::vector<TrackRef> Editor::syncTracks(const std::vector<TrackRef>& targets) const {
  std::vector<TrackRef> out = targets;
  forEachTrack(seq(), [&](const Track& t, TrackRef r) {
    if (!t.locked && t.syncLock && !contains(out, r)) out.push_back(r);
  });
  return out;
}

void Editor::rippleOthers(const std::vector<TrackRef>& except, Tick at, Tick delta) {
  Sequence& s = seq();
  for (TrackRef r : syncTracks({})) {
    if (contains(except, r)) continue;
    Track& t = *trackOf(s, r);
    if (delta > 0) {
      splitAt(t, at);
    } else if (delta < 0) {
      clearRange(t, at + delta, at);
    }
    shiftFrom(t, at, delta);
  }
}

std::vector<std::string> Editor::linked(const std::string& clipId) const {
  const Clip* c = clipById(seq(), clipId);
  if (!c) return {};
  std::vector<std::string> out{clipId};
  if (c->link.empty()) return out;
  forEachTrack(seq(), [&](const Track& t, TrackRef) {
    for (auto& o : t.clips)
      if (o.link == c->link && o.id != clipId) out.push_back(o.id);
  });
  return out;
}

Err Editor::placeOn(Track& t, Clip c) {
  if (t.locked) return "the track is locked";
  for (auto& o : t.clips)
    if (o.start < c.end() && c.start < o.end()) return "the clip would overlap " + (o.name.empty() ? o.id : o.name);
  if (t.kind == TrackKind::Audio && (c.kind != ClipKind::Media && c.kind != ClipKind::Nested))
    return "only sound goes on an audio track";
  t.clips.push_back(std::move(c));
  sortTrack(t);
  return {};
}

bool Editor::reshape(Clip& c, Edge e, Tick delta) const {
  Tick dur = e == Edge::Head ? c.dur - delta : c.dur + delta;
  if (dur <= 0) return false;
  if (e == Edge::Head && c.start + delta < 0) return false;
  Tick in = c.in;
  if (c.speed >= 0) {
    if (e == Edge::Head) in += Tick(std::llround(double(delta) * c.speed));
  } else {
    if (e == Edge::Tail) in -= Tick(std::llround(double(delta) * -c.speed));
  }
  if (in < 0 || in + span(dur, c.speed) > sourceLimit(c)) return false;
  if (e == Edge::Head) {
    c.start += delta;
    shiftKeys(c, -delta);
  }
  c.in = in;
  c.dur = dur;
  return true;
}

// ——— placing ———

Err Editor::overwrite(TrackRef r, Clip c) {
  return atomic([&]() -> Err {
    if (Err e = checkClip(c); !e.empty()) return e;
    Track* t = trackOf(seq(), r);
    if (!t) return "no such track";
    if (t->locked) return "the track is locked";
    if (c.id.empty()) c.id = p_.makeId("c");
    clearRange(*t, c.start, c.end());
    return placeOn(*t, std::move(c));
  });
}

Err Editor::insert(TrackRef r, Clip c) {
  return atomic([&]() -> Err {
    if (Err e = checkClip(c); !e.empty()) return e;
    Track* t = trackOf(seq(), r);
    if (!t) return "no such track";
    if (t->locked) return "the track is locked";
    if (c.id.empty()) c.id = p_.makeId("c");
    splitAt(*t, c.start);
    shiftFrom(*t, c.start, c.dur);
    rippleOthers({r}, c.start, c.dur);
    return placeOn(*trackOf(seq(), r), std::move(c));
  });
}

Err Editor::razor(TrackRef r, Tick at) {
  return atomic([&]() -> Err {
    Track* t = trackOf(seq(), r);
    if (!t) return "no such track";
    if (t->locked) return "the track is locked";
    splitAt(*t, at);
    return {};
  });
}

Err Editor::razorAll(Tick at) {
  return atomic([&]() -> Err {
    forEachTrack(seq(), [&](Track& t, TrackRef) {
      if (!t.locked) splitAt(t, at);
    });
    return {};
  });
}

// ——— removing ———

Err Editor::lift(const std::vector<TrackRef>& ts, Tick a, Tick b) {
  return atomic([&]() -> Err {
    if (a >= b) return "an empty range";
    for (TrackRef r : ts) {
      Track* t = trackOf(seq(), r);
      if (!t) return "no such track";
      if (t->locked) return "the track is locked";
      clearRange(*t, a, b);
    }
    return {};
  });
}

Err Editor::extract(const std::vector<TrackRef>& ts, Tick a, Tick b) {
  return atomic([&]() -> Err {
    if (a >= b) return "an empty range";
    for (TrackRef r : ts) {
      Track* t = trackOf(seq(), r);
      if (!t) return "no such track";
      if (t->locked) return "the track is locked";
    }
    for (TrackRef r : syncTracks(ts)) {
      Track& t = *trackOf(seq(), r);
      clearRange(t, a, b);
      shiftFrom(t, b, a - b);
    }
    return {};
  });
}

Err Editor::remove(const std::string& clipId) {
  return atomic([&]() -> Err {
    if (!clipById(seq(), clipId)) return "no such clip";
    for (auto& id : linked(clipId)) {
      ClipLoc l = findClip(seq(), id);
      Track& t = *trackOf(seq(), l.track);
      if (t.locked) return "the track is locked";
      t.clips.erase(t.clips.begin() + l.index);
    }
    return {};
  });
}

Err Editor::rippleDelete(const std::string& clipId) {
  const Clip* c = clipById(seq(), clipId);
  if (!c) return "no such clip";
  Tick a = c->start, b = c->end();
  std::vector<TrackRef> ts;
  for (auto& id : linked(clipId)) ts.push_back(findClip(seq(), id).track);
  return extract(ts, a, b);
}

Err Editor::closeGap(TrackRef r, Tick at) {
  return atomic([&]() -> Err {
    Track* t = trackOf(seq(), r);
    if (!t) return "no such track";
    Tick a = 0, b = -1;
    for (auto& c : t->clips) {
      if (c.start <= at && at < c.end()) return "that is not a gap";
      if (c.end() <= at) a = std::max(a, c.end());
      if (c.start > at && (b < 0 || c.start < b)) b = c.start;
    }
    if (b < 0) return "nothing after the gap to pull in";
    for (TrackRef o : syncTracks({r})) {
      if (sameRef(o, r)) continue;
      for (auto& c : trackOf(seq(), o)->clips)
        if (c.start < b && a < c.end()) return "another track has material in the gap";
    }
    for (TrackRef o : syncTracks({r})) shiftFrom(*trackOf(seq(), o), b, a - b);
    return {};
  });
}

// ——— trimming ———

Err Editor::trim(const std::string& clipId, Edge e, Tick delta) {
  return atomic([&]() -> Err {
    if (!clipById(seq(), clipId)) return "no such clip";
    for (auto& id : linked(clipId)) {
      ClipLoc l = findClip(seq(), id);
      Track& t = *trackOf(seq(), l.track);
      if (t.locked) return "the track is locked";
      Clip& c = t.clips[l.index];
      if (!reshape(c, e, delta)) return "the trim runs out of media or makes the clip empty";
      if (l.index > 0 && t.clips[l.index - 1].end() > c.start) return "the trim runs into the clip before";
      if (size_t(l.index) + 1 < t.clips.size() && t.clips[l.index + 1].start < c.end())
        return "the trim runs into the clip after";
    }
    return {};
  });
}

Err Editor::rippleTrim(const std::string& clipId, Edge e, Tick delta) {
  return atomic([&]() -> Err {
    const Clip* c0 = clipById(seq(), clipId);
    if (!c0) return "no such clip";
    const Tick start = c0->start, end = c0->end();
    std::vector<TrackRef> mine;
    for (auto& id : linked(clipId)) {
      ClipLoc l = findClip(seq(), id);
      Track& t = *trackOf(seq(), l.track);
      if (t.locked) return "the track is locked";
      Clip& c = t.clips[l.index];
      if ((e == Edge::Head ? c.start : c.end()) != (e == Edge::Head ? start : end)) continue;
      if (!reshape(c, e, delta)) return "the trim runs out of media or makes the clip empty";
      if (e == Edge::Head) {
        c.start = start;  // ripple: the head stays put and everything after moves
        for (auto& o : t.clips)
          if (o.start >= end) o.start -= delta;
        for (auto& x : t.transitions)
          if (x.at >= end) x.at -= delta;
      } else {
        for (auto& o : t.clips)
          if (o.id != c.id && o.start >= end) o.start += delta;
        for (auto& x : t.transitions)
          if (x.at >= end) x.at += delta;
      }
      mine.push_back(l.track);
    }
    if (e == Edge::Head)
      rippleOthers(mine, delta > 0 ? start + delta : start, -delta);
    else
      rippleOthers(mine, end, delta);
    return {};
  });
}

Err Editor::rollTrim(const std::string& clipId, Tick delta) {
  return atomic([&]() -> Err {
    if (!clipById(seq(), clipId)) return "no such clip";
    for (auto& id : linked(clipId)) {
      ClipLoc l = findClip(seq(), id);
      Track& t = *trackOf(seq(), l.track);
      if (t.locked) return "the track is locked";
      if (size_t(l.index) + 1 >= t.clips.size() || t.clips[l.index + 1].start != t.clips[l.index].end()) {
        if (id == clipId) return "no clip right after to roll against";
        continue;
      }
      if (!reshape(t.clips[l.index], Edge::Tail, delta) || !reshape(t.clips[l.index + 1], Edge::Head, delta))
        return "the roll runs out of media on one side";
    }
    return {};
  });
}

Err Editor::slip(const std::string& clipId, Tick delta) {
  return atomic([&]() -> Err {
    if (!clipById(seq(), clipId)) return "no such clip";
    for (auto& id : linked(clipId)) {
      Clip* c = clipById(seq(), id);
      if (trackOf(seq(), findClip(seq(), id).track)->locked) return "the track is locked";
      c->in += delta;
      if (c->in < 0 || c->in + c->sourceSpan() > sourceLimit(*c)) return "the slip runs out of media";
    }
    return {};
  });
}

Err Editor::slide(const std::string& clipId, Tick delta) {
  return atomic([&]() -> Err {
    if (!clipById(seq(), clipId)) return "no such clip";
    for (auto& id : linked(clipId)) {
      ClipLoc l = findClip(seq(), id);
      Track& t = *trackOf(seq(), l.track);
      if (t.locked) return "the track is locked";
      Clip& c = t.clips[l.index];
      Clip* prev = l.index > 0 ? &t.clips[l.index - 1] : nullptr;
      Clip* next = size_t(l.index) + 1 < t.clips.size() ? &t.clips[l.index + 1] : nullptr;
      bool prevTouch = prev && prev->end() == c.start;
      bool nextTouch = next && next->start == c.end();
      if (prevTouch) {
        if (!reshape(*prev, Edge::Tail, delta)) return "the clip before runs out of media";
      } else if (c.start + delta < (prev ? prev->end() : 0)) {
        return "the slide runs into the clip before";
      }
      if (nextTouch) {
        if (!reshape(*next, Edge::Head, delta)) return "the clip after runs out of media";
      } else if (next && c.end() + delta > next->start) {
        return "the slide runs into the clip after";
      }
      c.start += delta;
    }
    return {};
  });
}

// ——— moving and shaping ———

Err Editor::move(const std::string& clipId, TrackRef dst, Tick start) {
  return atomic([&]() -> Err {
    ClipLoc l0 = findClip(seq(), clipId);
    if (!l0) return "no such clip";
    if (dst.kind != l0.track.kind) return "a clip stays on its kind of track";
    if (start < 0) return "before the start of the sequence";
    const Tick dt = start - trackOf(seq(), l0.track)->clips[l0.index].start;
    const int di = dst.index - l0.track.index;
    struct Move {
      Clip c;
      TrackRef to;
    };
    std::vector<Move> moves;
    for (auto& id : linked(clipId)) {
      ClipLoc l = findClip(seq(), id);
      Track& t = *trackOf(seq(), l.track);
      if (t.locked) return "the track is locked";
      Move m{t.clips[l.index], l.track};
      if (l.track.kind == dst.kind) m.to.index += di;
      m.c.start += dt;
      if (m.c.start < 0) return "a linked clip would start before the sequence";
      if (!trackOf(seq(), m.to)) return "no such track";
      t.clips.erase(t.clips.begin() + l.index);
      moves.push_back(std::move(m));
    }
    for (auto& m : moves) {
      Track& t = *trackOf(seq(), m.to);
      if (t.locked) return "the track is locked";
      clearRange(t, m.c.start, m.c.end());
      if (Err e = placeOn(t, std::move(m.c)); !e.empty()) return e;
    }
    return {};
  });
}

Err Editor::setSpeed(const std::string& clipId, double speed, bool ripple) {
  return atomic([&]() -> Err {
    if (!clipById(seq(), clipId)) return "no such clip";
    if (speed == 0 || !std::isfinite(speed) || std::fabs(speed) > 100 || std::fabs(speed) < 0.01)
      return "speed must be between 1% and 10000%";
    std::vector<TrackRef> mine;
    Tick end = -1, delta = 0;
    for (auto& id : linked(clipId)) {
      ClipLoc l = findClip(seq(), id);
      Track& t = *trackOf(seq(), l.track);
      if (t.locked) return "the track is locked";
      Clip& c = t.clips[l.index];
      if (end >= 0 && c.end() != end) continue;  // a linked clip of another length keeps its speed
      const Tick oldEnd = c.end(), oldDur = c.dur;
      Tick src = c.sourceSpan();
      c.speed = speed;
      c.dur = std::max<Tick>(1, Tick(std::llround(double(src) / std::fabs(speed))));
      while (c.dur > 1 && c.in + c.sourceSpan() > sourceLimit(c)) --c.dur;
      if (end < 0) {
        end = oldEnd;
        delta = c.dur - oldDur;
      } else if (c.dur - oldDur != delta) {
        return "linked clips would end up different lengths";
      }
      if (ripple) {
        for (auto& o : t.clips)
          if (o.id != c.id && o.start >= end) o.start += delta;
      } else if (size_t(l.index) + 1 < t.clips.size() && t.clips[l.index + 1].start < c.end()) {
        return "the slower clip runs into the next one (use ripple)";
      }
      mine.push_back(l.track);
    }
    if (ripple) rippleOthers(mine, end, delta);
    return {};
  });
}

Err Editor::link(const std::vector<std::string>& ids) {
  return atomic([&]() -> Err {
    if (ids.size() < 2) return "link needs two clips";
    std::string g = p_.makeId("l");
    for (auto& id : ids) {
      Clip* c = clipById(seq(), id);
      if (!c) return "no such clip";
      c->link = g;
    }
    return {};
  });
}

Err Editor::unlink(const std::string& clipId) {
  return atomic([&]() -> Err {
    if (!clipById(seq(), clipId)) return "no such clip";
    for (auto& id : linked(clipId)) clipById(seq(), id)->link.clear();
    return {};
  });
}

Err Editor::nest(const std::vector<std::string>& ids, std::string* out) {
  return atomic([&]() -> Err {
    if (ids.empty()) return "nothing to nest";
    Sequence& s = seq();
    Tick a = kUnbounded, b = 0;
    int lowestVideo = 1 << 30, lowestAudio = 1 << 30;
    for (auto& id : ids) {
      ClipLoc l = findClip(s, id);
      if (!l) return "no such clip";
      if (trackOf(s, l.track)->locked) return "the track is locked";
      const Clip& c = trackOf(s, l.track)->clips[l.index];
      a = std::min(a, c.start);
      b = std::max(b, c.end());
      (l.track.kind == TrackKind::Video ? lowestVideo : lowestAudio) =
          std::min(l.track.kind == TrackKind::Video ? lowestVideo : lowestAudio, l.track.index);
    }
    Sequence ns;
    ns.id = p_.makeId("s");
    ns.name = "Nest " + ns.id;
    ns.width = s.width;
    ns.height = s.height;
    ns.rate = s.rate;
    ns.sampleRate = s.sampleRate;
    for (auto& t : s.video) ns.video.push_back(Track{.id = p_.makeId("t"), .kind = TrackKind::Video, .name = t.name});
    for (auto& t : s.audio) ns.audio.push_back(Track{.id = p_.makeId("t"), .kind = TrackKind::Audio, .name = t.name});
    for (auto& id : ids) {
      ClipLoc l = findClip(s, id);
      Track& t = *trackOf(s, l.track);
      Clip c = t.clips[l.index];
      t.clips.erase(t.clips.begin() + l.index);
      c.start -= a;
      trackOf(ns, l.track)->clips.push_back(std::move(c));
    }
    for (auto& t : ns.video) sortTrack(t);
    for (auto& t : ns.audio) sortTrack(t);
    Clip n;
    n.id = p_.makeId("c");
    n.kind = ClipKind::Nested;
    n.ref = ns.id;
    n.name = ns.name;
    n.start = a;
    n.dur = b - a;
    TrackRef dst = lowestVideo < (1 << 30) ? TrackRef{TrackKind::Video, lowestVideo}
                                             : TrackRef{TrackKind::Audio, lowestAudio};
    if (out) *out = ns.id;
    p_.sequences.push_back(std::move(ns));  // invalidates `s`
    return placeOn(*trackOf(seq(), dst), std::move(n));
  });
}

Err Editor::switchAngle(const std::string& clipId, Tick at, int angle) {
  return atomic([&]() -> Err {
    ClipLoc l = findClip(seq(), clipId);
    if (!l) return "no such clip";
    Track& t = *trackOf(seq(), l.track);
    if (t.locked) return "the track is locked";
    Clip& c = t.clips[l.index];
    if (c.kind != ClipKind::Multicam) return "not a multicam clip";
    const Sequence* mc = p_.findSequence(c.ref);
    if (!mc || angle < 0 || size_t(angle) >= mc->video.size()) return "no such angle";
    if (at < c.start || at >= c.end()) return "outside the clip";
    splitAt(t, at);
    for (auto& o : t.clips)
      if (o.start == at && o.kind == ClipKind::Multicam) o.angle = angle;
    return {};
  });
}

// ——— tracks and markers ———

Err Editor::addTrack(TrackKind k, int index) {
  return atomic([&]() -> Err {
    auto& v = k == TrackKind::Video ? seq().video : seq().audio;
    if (index < 0 || size_t(index) > v.size()) index = int(v.size());
    Track t;
    t.id = p_.makeId("t");
    t.kind = k;
    t.name = (k == TrackKind::Video ? "V" : "A") + std::to_string(v.size() + 1);
    v.insert(v.begin() + index, std::move(t));
    return {};
  });
}

Err Editor::removeTrack(TrackRef r) {
  return atomic([&]() -> Err {
    auto& v = r.kind == TrackKind::Video ? seq().video : seq().audio;
    if (r.index < 0 || size_t(r.index) >= v.size()) return "no such track";
    if (v[r.index].locked) return "the track is locked";
    v.erase(v.begin() + r.index);
    return {};
  });
}

Err Editor::addMarker(Tick t, const std::string& name, Tick dur) {
  return atomic([&]() -> Err {
    if (t < 0 || dur < 0) return "a marker sits inside the sequence";
    Marker m;
    m.id = p_.makeId("m");
    m.t = t;
    m.dur = dur;
    m.name = name;
    auto& ms = seq().markers;
    ms.insert(std::upper_bound(ms.begin(), ms.end(), t, [](Tick a, const Marker& x) { return a < x.t; }), m);
    return {};
  });
}

Err Editor::removeMarker(const std::string& id) {
  return atomic([&]() -> Err {
    auto& ms = seq().markers;
    auto n = std::erase_if(ms, [&](const Marker& m) { return m.id == id; });
    return n ? Err{} : Err{"no such marker"};
  });
}

// ——— invariants ———

namespace {
bool nests(const Project& p, const std::string& from, const std::string& target, std::set<std::string>& seen) {
  if (from == target) return true;
  if (!seen.insert(from).second) return false;
  const Sequence* s = p.findSequence(from);
  if (!s) return false;
  bool hit = false;
  forEachTrack(*s, [&](const Track& t, TrackRef) {
    for (auto& c : t.clips)
      if (!hit && (c.kind == ClipKind::Nested || c.kind == ClipKind::Multicam) && nests(p, c.ref, target, seen))
        hit = true;
  });
  return hit;
}
}  // namespace

std::vector<std::string> check(const Project& p, const Sequence& s) {
  std::vector<std::string> out;
  std::unordered_set<std::string> ids;
  Editor ed(const_cast<Project&>(p), s);
  forEachTrack(s, [&](const Track& t, TrackRef r) {
    const std::string where = s.id + "/" + (r.kind == TrackKind::Video ? "V" : "A") + std::to_string(r.index + 1);
    for (size_t i = 0; i < t.clips.size(); ++i) {
      const Clip& c = t.clips[i];
      if (!ids.insert(c.id).second) out.push_back(where + ": duplicate clip id " + c.id);
      if (c.dur <= 0) out.push_back(where + ": empty clip " + c.id);
      if (c.start < 0) out.push_back(where + ": clip before zero " + c.id);
      if (c.speed == 0) out.push_back(where + ": zero speed " + c.id);
      if (c.in < 0) out.push_back(where + ": negative in " + c.id);
      if (c.in + c.sourceSpan() > ed.sourceLimit(c)) out.push_back(where + ": past the media end " + c.id);
      if (i > 0 && t.clips[i - 1].end() > c.start) out.push_back(where + ": overlap at " + c.id);
      if (c.kind == ClipKind::Media && !p.findMedia(c.ref)) out.push_back(where + ": missing media " + c.ref);
      if ((c.kind == ClipKind::Nested || c.kind == ClipKind::Multicam)) {
        std::set<std::string> seen;
        if (!p.findSequence(c.ref)) out.push_back(where + ": missing sequence " + c.ref);
        else if (nests(p, c.ref, s.id, seen)) out.push_back(where + ": a sequence contains itself via " + c.id);
      }
      if (t.kind == TrackKind::Audio && c.kind != ClipKind::Media && c.kind != ClipKind::Nested)
        out.push_back(where + ": picture on an audio track " + c.id);
    }
  });
  for (size_t i = 1; i < s.markers.size(); ++i)
    if (s.markers[i - 1].t > s.markers[i].t) out.push_back(s.id + ": markers out of order");
  return out;
}

std::vector<std::string> check(const Project& p) {
  std::vector<std::string> out;
  std::unordered_set<std::string> ids;
  for (auto& m : p.media)
    if (!ids.insert(m.id).second) out.push_back("duplicate media id " + m.id);
  for (auto& s : p.sequences) {
    if (!ids.insert(s.id).second) out.push_back("duplicate sequence id " + s.id);
    auto e = check(p, s);
    out.insert(out.end(), e.begin(), e.end());
  }
  return out;
}

// ——— builders ———

Clip clipOf(Project& p, const Media& m, Tick start, Tick dur) {
  Clip c;
  c.id = p.makeId("c");
  c.kind = ClipKind::Media;
  c.ref = m.id;
  c.name = m.name;
  c.start = start;
  c.dur = m.kind == MediaKind::Image ? (dur > 0 ? dur : 5 * kFlicks) : (dur > 0 ? std::min(dur, m.duration) : m.duration);
  return c;
}

std::string makeMulticam(Project& p, const std::string& name, const std::vector<std::string>& mediaIds,
                         const std::vector<Tick>& offsets) {
  Sequence s;
  s.id = p.makeId("s");
  s.name = name;
  s.multicam = true;
  Tick lead = 0;
  for (size_t i = 0; i < mediaIds.size(); ++i) lead = std::max(lead, i < offsets.size() ? offsets[i] : 0);
  for (size_t i = 0; i < mediaIds.size(); ++i) {
    const Media* m = p.findMedia(mediaIds[i]);
    if (!m) continue;
    if (i == 0) {
      s.width = m->width ? m->width : s.width;
      s.height = m->height ? m->height : s.height;
      s.rate = m->rate;
    }
    Tick at = lead - (i < offsets.size() ? offsets[i] : 0);
    Track v{.id = p.makeId("t"), .kind = TrackKind::Video, .name = m->name};
    std::string g = p.makeId("l");
    if (m->hasVideo) {
      Clip c = clipOf(p, *m, at);
      c.link = g;
      v.clips.push_back(c);
    }
    s.video.push_back(std::move(v));
    if (m->hasAudio) {
      Track a{.id = p.makeId("t"), .kind = TrackKind::Audio, .name = m->name};
      Clip c = clipOf(p, *m, at);
      c.link = g;
      a.clips.push_back(c);
      s.audio.push_back(std::move(a));
    }
  }
  std::string id = s.id;
  p.sequences.push_back(std::move(s));
  return id;
}

// ——— history ———

void History::push(const Project& before, std::string label) {
  undo_.push_back({before, std::move(label)});
  if (undo_.size() > cap_) undo_.erase(undo_.begin());
  redo_.clear();
}

bool History::undo(Project& p) {
  if (undo_.empty()) return false;
  redo_.push_back({p, undo_.back().label});
  p = std::move(undo_.back().p);
  undo_.pop_back();
  return true;
}

bool History::redo(Project& p) {
  if (redo_.empty()) return false;
  undo_.push_back({p, redo_.back().label});
  p = std::move(redo_.back().p);
  redo_.pop_back();
  return true;
}

const std::string& History::undoLabel() const {
  static const std::string none;
  return undo_.empty() ? none : undo_.back().label;
}

void History::clear() {
  undo_.clear();
  redo_.clear();
}

}  // namespace rhap
