#include "model.h"

#include <algorithm>
#include <cmath>

namespace rhap {

double cubicBezier(double x1, double y1, double x2, double y2, double x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  auto bx = [&](double t) { return 3 * (1 - t) * (1 - t) * t * x1 + 3 * (1 - t) * t * t * x2 + t * t * t; };
  auto by = [&](double t) { return 3 * (1 - t) * (1 - t) * t * y1 + 3 * (1 - t) * t * t * y2 + t * t * t; };
  auto dx = [&](double t) {
    return 3 * (1 - t) * (1 - t) * x1 + 6 * (1 - t) * t * (x2 - x1) + 3 * t * t * (1 - x2);
  };
  // Newton, then bisection when the slope is flat
  double t = x;
  for (int i = 0; i < 8; ++i) {
    double e = bx(t) - x, d = dx(t);
    if (std::fabs(e) < 1e-9) return by(t);
    if (std::fabs(d) < 1e-6) break;
    t -= e / d;
  }
  double lo = 0, hi = 1;
  t = x;
  for (int i = 0; i < 60; ++i) {
    double v = bx(t);
    if (std::fabs(v - x) < 1e-10) break;
    (v < x ? lo : hi) = t;
    t = (lo + hi) / 2;
  }
  return by(t);
}

double easeValue(Ease e, double u, const Keyframe& k) {
  switch (e) {
    case Ease::Linear: return u;
    case Ease::Hold: return 0;
    case Ease::In: return cubicBezier(0.42, 0, 1, 1, u);
    case Ease::Out: return cubicBezier(0, 0, 0.58, 1, u);
    case Ease::InOut: return cubicBezier(0.42, 0, 0.58, 1, u);
    case Ease::Bezier: return cubicBezier(k.x1, k.y1, k.x2, k.y2, u);
  }
  return u;
}

double Param::at(Tick t) const {
  if (keys.empty()) return value;
  if (t <= keys.front().t) return keys.front().v;
  if (t >= keys.back().t) return keys.back().v;
  auto it = std::upper_bound(keys.begin(), keys.end(), t, [](Tick a, const Keyframe& k) { return a < k.t; });
  const Keyframe& b = *it;
  const Keyframe& a = *(it - 1);
  double u = double(t - a.t) / double(b.t - a.t);
  return a.v + (b.v - a.v) * easeValue(a.ease, u, a);
}

void Param::setKey(Tick t, double v, Ease e) {
  auto it = std::lower_bound(keys.begin(), keys.end(), t, [](const Keyframe& k, Tick a) { return k.t < a; });
  if (it != keys.end() && it->t == t) {
    it->v = v;
    it->ease = e;
    return;
  }
  Keyframe k;
  k.t = t;
  k.v = v;
  k.ease = e;
  keys.insert(it, k);
}

bool Grade::neutral() const {
  return !enabled || (lift == std::array<double, 3>{0, 0, 0} && gamma == std::array<double, 3>{1, 1, 1} &&
                      gain == std::array<double, 3>{1, 1, 1} && offset == std::array<double, 3>{0, 0, 0} &&
                      exposure == 0 && contrast == 1 && saturation == 1 && temperature == 0 && tint == 0 &&
                      master.empty() && red.empty() && green.empty() && blue.empty() && lut.empty());
}

Tick Clip::sourceAt(Tick t) const {
  double off = double(t - start) * speed;
  if (speed < 0) return in + sourceSpan() + Tick(std::llround(off));
  return in + Tick(std::llround(off));
}

Tick Clip::sourceSpan() const { return Tick(std::llround(double(dur) * std::fabs(speed))); }

Tick Sequence::duration() const {
  Tick d = 0;
  forEachTrack(*this, [&](const Track& t, TrackRef) {
    if (!t.clips.empty()) d = std::max(d, t.clips.back().end());
  });
  return d;
}

const Media* Project::findMedia(const std::string& id) const {
  for (auto& m : media)
    if (m.id == id) return &m;
  return nullptr;
}

Sequence* Project::findSequence(const std::string& id) {
  for (auto& s : sequences)
    if (s.id == id) return &s;
  return nullptr;
}

const Sequence* Project::findSequence(const std::string& id) const {
  for (auto& s : sequences)
    if (s.id == id) return &s;
  return nullptr;
}

std::string Project::makeId(const char* prefix) { return std::string(prefix) + std::to_string(nextId++); }

Track* trackOf(Sequence& s, TrackRef r) {
  auto& v = r.kind == TrackKind::Video ? s.video : s.audio;
  return r.index >= 0 && size_t(r.index) < v.size() ? &v[r.index] : nullptr;
}

const Track* trackOf(const Sequence& s, TrackRef r) { return trackOf(const_cast<Sequence&>(s), r); }

ClipLoc findClip(const Sequence& s, const std::string& id) {
  ClipLoc loc;
  forEachTrack(s, [&](const Track& t, TrackRef r) {
    if (loc) return;
    for (size_t i = 0; i < t.clips.size(); ++i)
      if (t.clips[i].id == id) {
        loc.track = r;
        loc.index = int(i);
        return;
      }
  });
  return loc;
}

Clip* clipById(Sequence& s, const std::string& id) {
  ClipLoc l = findClip(s, id);
  return l ? &trackOf(s, l.track)->clips[l.index] : nullptr;
}

const Clip* clipById(const Sequence& s, const std::string& id) { return clipById(const_cast<Sequence&>(s), id); }

}  // namespace rhap
