#include "evaluate.h"

#include <algorithm>
#include <cmath>

namespace rhap {

namespace {

const Clip* clipAt(const Track& t, Tick at) {
  auto it = std::upper_bound(t.clips.begin(), t.clips.end(), at, [](Tick a, const Clip& c) { return a < c.start; });
  if (it == t.clips.begin()) return nullptr;
  const Clip& c = *(it - 1);
  return at < c.end() ? &c : nullptr;
}

const Clip* clipEndingAt(const Track& t, Tick at) {
  for (auto& c : t.clips)
    if (c.end() == at) return &c;
  return nullptr;
}

const Clip* clipStartingAt(const Track& t, Tick at) {
  for (auto& c : t.clips)
    if (c.start == at) return &c;
  return nullptr;
}

LayerDraw resolve(const Project& p, const Clip& c, Tick t) {
  LayerDraw l;
  l.clip = &c;
  l.local = t - c.start;
  l.source = c.sourceAt(t);
  l.slot = c.id;
  const Transform& x = c.xf;
  l.x = x.x.at(l.local);
  l.y = x.y.at(l.local);
  l.scale = x.scale.at(l.local);
  l.scaleY = x.scaleY.at(l.local);
  l.rotation = x.rotation.at(l.local);
  l.anchorX = x.anchorX.at(l.local);
  l.anchorY = x.anchorY.at(l.local);
  l.opacity = std::clamp(x.opacity.at(l.local), 0.0, 1.0);
  l.cropL = std::clamp(x.cropL.at(l.local), 0.0, 1.0);
  l.cropR = std::clamp(x.cropR.at(l.local), 0.0, 1.0);
  l.cropT = std::clamp(x.cropT.at(l.local), 0.0, 1.0);
  l.cropB = std::clamp(x.cropB.at(l.local), 0.0, 1.0);
  if (c.kind == ClipKind::Media) l.media = p.findMedia(c.ref);
  if (c.kind == ClipKind::Nested || c.kind == ClipKind::Multicam) {
    l.nested = p.findSequence(c.ref);
    if (c.kind == ClipKind::Multicam) l.angle = c.angle;
  }
  return l;
}

bool drawable(const Project& p, const LayerDraw& l) {
  const Clip& c = *l.clip;
  if (!c.enabled || l.opacity <= 0) return false;
  if (c.kind == ClipKind::Media) return l.media && l.media->hasVideo;
  if (c.kind == ClipKind::Nested || c.kind == ClipKind::Multicam) return l.nested != nullptr;
  (void)p;
  return true;
}

}  // namespace

std::vector<LayerDraw> evaluate(const Project& p, const Sequence& s, Tick t) {
  std::vector<LayerDraw> out;
  for (const Track& tr : s.video) {
    if (tr.hidden) continue;
    // a transition straddling t draws both sides
    const Transition* tx = nullptr;
    for (auto& x : tr.transitions)
      if (t >= x.at - x.dur / 2 && t < x.at + x.dur - x.dur / 2) tx = &x;
    if (tx) {
      const Clip* a = clipEndingAt(tr, tx->at);
      const Clip* b = clipStartingAt(tr, tx->at);
      double u = double(t - (tx->at - tx->dur / 2)) / double(std::max<Tick>(1, tx->dur));
      if (a && b) {
        LayerDraw lb = resolve(p, *b, t), la = resolve(p, *a, t);
        if (tx->kind == TransitionKind::DipToBlack) {
          if (u < 0.5) {
            la.opacity *= 1 - 2 * u;
            if (drawable(p, la)) out.push_back(la);
          } else {
            lb.opacity *= 2 * u - 1;
            if (drawable(p, lb)) out.push_back(lb);
          }
        } else {
          // B underneath at full strength, A on top fading out: A(1−u) + B·u for opaque pictures
          if (drawable(p, lb)) out.push_back(lb);
          la.opacity *= 1 - u;
          if (drawable(p, la)) out.push_back(la);
        }
        continue;
      }
    }
    const Clip* c = clipAt(tr, t);
    if (!c) continue;
    LayerDraw l = resolve(p, *c, t);
    if (drawable(p, l)) out.push_back(l);
  }
  return out;
}

Quad place(const LayerDraw& l, double w, double h, int W, int H, bool fit, int rotation) {
  double base = fit && w > 0 && h > 0 ? std::min(double(W) / w, double(H) / h) : 1.0;
  double sx = base * l.scale, sy = base * l.scale * l.scaleY;
  if (l.clip && l.clip->xf.flipH) sx = -sx;
  if (l.clip && l.clip->xf.flipV) sy = -sy;
  double x0 = -w / 2 + l.cropL * w, x1 = w / 2 - l.cropR * w;
  double y0 = -h / 2 + l.cropT * h, y1 = h / 2 - l.cropB * h;
  double u0 = l.cropL, u1 = 1 - l.cropR, v0 = l.cropT, v1 = 1 - l.cropB;
  double th = l.rotation * M_PI / 180, cs = std::cos(th), sn = std::sin(th);
  Quad q;
  const double px[4] = {x0, x1, x0, x1}, py[4] = {y0, y0, y1, y1};
  double us[4] = {u0, u1, u0, u1}, vs[4] = {v0, v0, v1, v1};
  // a frame stored sideways (phone footage): rotate which texel lands on each display corner
  if (rotation == 90 || rotation == 180 || rotation == 270) {
    for (int i = 0; i < 4; ++i) {
      double u = us[i], v = vs[i];
      if (rotation == 90) us[i] = v, vs[i] = 1 - u;
      if (rotation == 180) us[i] = 1 - u, vs[i] = 1 - v;
      if (rotation == 270) us[i] = 1 - v, vs[i] = u;
    }
  }
  for (int i = 0; i < 4; ++i) {
    double ax = (px[i] - l.anchorX) * sx, ay = (py[i] - l.anchorY) * sy;
    double rx = ax * cs - ay * sn, ry = ax * sn + ay * cs;
    double X = rx + l.x, Y = ry + l.y;
    q.ndc[size_t(i * 2)] = X / (W / 2.0);
    q.ndc[size_t(i * 2 + 1)] = -Y / (H / 2.0);
    q.uv[size_t(i * 2)] = us[i];
    q.uv[size_t(i * 2 + 1)] = vs[i];
  }
  return q;
}

}  // namespace rhap
