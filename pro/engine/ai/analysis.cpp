#include "analysis.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <numeric>

#include "../media/decode.h"

namespace rhap::ai {

// ——— silence ———

std::vector<Range> detectSilence(const std::string& path, const SilenceOptions& o, int rate) {
  std::vector<Range> out;
  AudioDecoder d;
  if (!d.open(path, rate, 2).empty()) return out;
  const int win = rate / 100;  // 10 ms
  const int64_t total = d.lengthSamples();
  const double thr = std::pow(10.0, o.thresholdDb / 20);
  const float eps = 1e-4f;  // −80 dBFS: the edge of a silence, sample by sample
  std::vector<float> buf(size_t(win) * 2);
  std::vector<uint8_t> silent;
  for (int64_t at = 0; at < total; at += win) {
    int n = int(std::min<int64_t>(win, total - at));
    d.read(at, buf.data(), n);
    double el = 0, er = 0;
    for (int i = 0; i < n; ++i) el += double(buf[size_t(i) * 2]) * buf[size_t(i) * 2], er += double(buf[size_t(i) * 2 + 1]) * buf[size_t(i) * 2 + 1];
    double rms = std::sqrt(std::max(el, er) / std::max(1, n));
    silent.push_back(rms < thr);
  }
  // refine a window boundary to the exact sample where the sound stops (dir +1) or starts (dir −1)
  auto refine = [&](int64_t boundary, bool soundBefore) {
    int64_t lo = std::max<int64_t>(0, boundary - win), hi = std::min<int64_t>(total, boundary + win);
    std::vector<float> b(size_t(hi - lo) * 2);
    d.read(lo, b.data(), int(hi - lo));
    if (soundBefore) {
      // the first silent sample after the last loud one
      for (int64_t s = hi - 1; s >= lo; --s)
        if (std::fabs(b[size_t(s - lo) * 2]) > eps || std::fabs(b[size_t(s - lo) * 2 + 1]) > eps) return s + 1;
      return lo;
    }
    for (int64_t s = lo; s < hi; ++s)
      if (std::fabs(b[size_t(s - lo) * 2]) > eps || std::fabs(b[size_t(s - lo) * 2 + 1]) > eps) return s;
    return hi;
  };
  const int64_t minS = sampleAt(o.minDur, rate), padS = sampleAt(o.pad, rate);
  for (size_t i = 0; i < silent.size();) {
    if (!silent[i]) {
      ++i;
      continue;
    }
    size_t j = i;
    while (j < silent.size() && silent[j]) ++j;
    int64_t a = int64_t(i) * win, b = std::min<int64_t>(total, int64_t(j) * win);
    if (i > 0) a = refine(a, true);
    if (j < silent.size()) b = refine(b, false);
    a += i > 0 ? padS : 0;
    b -= j < silent.size() ? padS : 0;
    if (b - a >= minS) out.push_back({sampleStart(a, rate), sampleStart(b, rate)});
    i = j;
  }
  return out;
}

int removeSilence(Project& p, const std::string& seqId, const std::string& clipId, const std::vector<Range>& sil,
                  bool frameSnap, std::string* err) {
  Sequence* s = p.findSequence(seqId);
  if (!s) return 0;
  const Clip* c = clipById(*s, clipId);
  if (!c) return 0;
  if (c->speed != 1) {
    if (err) *err = "silence removal needs the clip at 100% speed";
    return 0;
  }
  const Rate r = s->rate;
  std::vector<TrackRef> tracks;
  ClipLoc loc = findClip(*s, clipId);
  tracks.push_back(loc.track);
  if (!c->link.empty())
    forEachTrack(*s, [&](const Track& t, TrackRef ref) {
      for (auto& o : t.clips)
        if (o.link == c->link && o.id != clipId && !(ref == loc.track)) tracks.push_back(ref);
    });
  std::vector<std::pair<Tick, Tick>> cuts;
  for (auto& x : sil) {
    Tick a = std::max(x.a, c->in), b = std::min(x.b, c->in + c->sourceSpan());
    if (b <= a) continue;
    Tick ta = c->start + (a - c->in), tb = c->start + (b - c->in);
    if (frameSnap) {
      ta = frameStart(frameAt(ta + frameTicks(r) - 1, r), r);  // round in: keep every frame with sound
      tb = frameStart(frameAt(tb, r), r);
    }
    if (tb > ta) cuts.push_back({ta, tb});
  }
  Editor ed(p, seqId);
  int n = 0;
  for (auto it = cuts.rbegin(); it != cuts.rend(); ++it) {
    Err e = ed.extract(tracks, it->first, it->second);
    if (!e.empty()) {
      if (err) *err = e;
      break;
    }
    ++n;
  }
  return n;
}

// ——— pictures at thumbnail size ———

namespace {

constexpr int kW = 64, kH = 36;

/** a frame's luma box-filtered to 64×36, 0..255 */
std::vector<float> tiny(const VideoFrame& f) {
  std::vector<float> out(kW * kH, 0.f);
  std::vector<int> cnt(kW * kH, 0);
  int step = std::max(1, std::min(f.width / kW, f.height / kH) / 4);
  for (int y = 0; y < f.height; y += step) {
    const uint8_t* row = f.plane(0) + size_t(y) * f.stride(0);
    int ty = y * kH / f.height;
    for (int x = 0; x < f.width; x += step) {
      double v;
      switch (f.layout) {
        case PixelLayout::NV12: v = row[x]; break;
        case PixelLayout::P010: v = reinterpret_cast<const uint16_t*>(row)[x] / 256.0; break;
        case PixelLayout::Planar: v = f.bits > 8 ? reinterpret_cast<const uint16_t*>(row)[x] / double(1 << (f.bits - 8)) : row[x]; break;
        case PixelLayout::RGBA8: v = 0.2126 * row[x * 4] + 0.7152 * row[x * 4 + 1] + 0.0722 * row[x * 4 + 2]; break;
        case PixelLayout::RGBA16: {
          auto* q = reinterpret_cast<const uint16_t*>(row);
          v = (0.2126 * q[x * 4] + 0.7152 * q[x * 4 + 1] + 0.0722 * q[x * 4 + 2]) / 256.0;
          break;
        }
        default: v = 0;
      }
      int tx = x * kW / f.width;
      out[size_t(ty) * kW + tx] += float(v);
      cnt[size_t(ty) * kW + tx]++;
    }
  }
  for (int i = 0; i < kW * kH; ++i) out[size_t(i)] = cnt[size_t(i)] ? out[size_t(i)] / float(cnt[size_t(i)]) : 0;
  return out;
}

}  // namespace

// ——— scenes ———

std::vector<Tick> detectScenes(const std::string& path, const SceneOptions& o, bool hw) {
  std::vector<Tick> cuts;
  VideoDecoder d;
  if (!d.open(path, hw).empty()) return cuts;
  std::vector<float> prev;
  std::array<double, 32> prevHist{};
  std::vector<double> recent;
  Tick lastCut = 0;
  for (const VideoFrame* f = d.frameAt(0); f; f = d.next()) {
    auto cur = tiny(*f);
    std::array<double, 32> hist{};
    for (float v : cur) hist[size_t(std::clamp(int(v / 8), 0, 31))] += 1.0 / (kW * kH);
    if (!prev.empty()) {
      double mad = 0;
      for (size_t i = 0; i < cur.size(); ++i) mad += std::fabs(cur[i] - prev[i]);
      mad /= double(cur.size()) * 255;
      double inter = 0;
      for (size_t i = 0; i < 32; ++i) inter += std::min(hist[i], prevHist[i]);
      double score = std::max(std::min(1.0, mad * 3), 1 - inter);
      double mean = recent.empty() ? 0 : std::accumulate(recent.begin(), recent.end(), 0.0) / double(recent.size());
      // a cut is a spike: well above the threshold and well above the recent motion
      if (score > o.threshold && score > 3 * mean && f->pts - lastCut >= o.minGap) {
        cuts.push_back(f->pts);
        lastCut = f->pts;
      }
      recent.push_back(score);
      if (recent.size() > 8) recent.erase(recent.begin());
    }
    prev = std::move(cur);
    prevHist = hist;
  }
  return cuts;
}

int splitAtScenes(Project& p, const std::string& seqId, const std::string& clipId, const std::vector<Tick>& cuts) {
  Sequence* s = p.findSequence(seqId);
  if (!s) return 0;
  const Clip* c = clipById(*s, clipId);
  if (!c || c->speed <= 0) return 0;
  ClipLoc l = findClip(*s, clipId);
  std::vector<Tick> at;
  for (Tick m : cuts) {
    Tick t = c->start + Tick(std::llround(double(m - c->in) / c->speed));
    if (t > c->start && t < c->end()) at.push_back(t);
  }
  std::string link = c->link;
  std::vector<TrackRef> tracks{l.track};
  if (!link.empty())
    forEachTrack(*s, [&](const Track& t, TrackRef r) {
      for (auto& o : t.clips)
        if (o.link == link && !(r == l.track)) tracks.push_back(r);
    });
  Editor ed(p, seqId);
  int n = 0;
  for (Tick t : at) {
    bool ok = true;
    for (TrackRef r : tracks) ok = ed.razor(r, t).empty() && ok;
    n += ok;
  }
  return n;
}

// ——— reframing ———

std::vector<ReframeKey> trackSubject(const std::string& path, double perSecond, bool hw) {
  std::vector<ReframeKey> keys;
  Media m;
  if (!probe(path, m).empty() || m.kind != MediaKind::Video) return keys;
  VideoDecoder d;
  if (!d.open(path, hw).empty()) return keys;
  Tick step = Tick(double(kFlicks) / perSecond);
  std::vector<float> prev;
  for (Tick t = 0; t < m.duration; t += step) {
    const VideoFrame* f = d.frameAt(t);
    if (!f) break;
    auto cur = tiny(*f);
    double mean = std::accumulate(cur.begin(), cur.end(), 0.0) / double(cur.size());
    double sx = 0, sy = 0, sw = 0;
    for (int y = 0; y < kH; ++y)
      for (int x = 0; x < kW; ++x) {
        double v = cur[size_t(y) * kW + x];
        double sal = std::fabs(v - mean);
        if (!prev.empty()) sal += 2 * std::fabs(v - prev[size_t(y) * kW + x]);
        double w = sal * sal;
        sx += w * (x + 0.5) / kW;
        sy += w * (y + 0.5) / kH;
        sw += w;
      }
    ReframeKey k;
    k.t = t;
    if (sw > 0) k.cx = sx / sw, k.cy = sy / sw;
    keys.push_back(k);
    prev = std::move(cur);
  }
  // zero-phase smoothing: forward then backward, so the frame leads nothing and lags nothing
  const double a = 0.45;
  for (int pass = 0; pass < 2; ++pass) {
    for (size_t i = 1; i < keys.size(); ++i) {
      keys[i].cx = keys[i - 1].cx + a * (keys[i].cx - keys[i - 1].cx);
      keys[i].cy = keys[i - 1].cy + a * (keys[i].cy - keys[i - 1].cy);
    }
    std::reverse(keys.begin(), keys.end());
  }
  return keys;
}

int applyReframe(Project& p, const std::string& seqId, const std::string& clipId, const std::vector<ReframeKey>& keys) {
  Sequence* s = p.findSequence(seqId);
  if (!s) return 0;
  Clip* c = clipById(*s, clipId);
  if (!c || c->kind != ClipKind::Media) return 0;
  const Media* m = p.findMedia(c->ref);
  if (!m || m->width <= 0) return 0;
  double w = m->width, h = m->height, W = s->width, H = s->height;
  double fit = std::min(W / w, H / h), cover = std::max(W / w, H / h);
  c->xf.scale = Param(cover / fit);
  c->xf.x = Param(0);
  c->xf.y = Param(0);
  double maxX = (w * cover - W) / 2, maxY = (h * cover - H) / 2;
  int n = 0;
  for (auto& k : keys) {
    if (k.t < c->in || k.t > c->in + c->sourceSpan()) continue;
    Tick local = Tick(std::llround(double(k.t - c->in) / std::fabs(c->speed)));
    double x = std::clamp(-(k.cx - 0.5) * w * cover, -maxX, maxX), y = std::clamp(-(k.cy - 0.5) * h * cover, -maxY, maxY);
    if (maxX > 0.5) c->xf.x.setKey(local, x, Ease::InOut);
    if (maxY > 0.5) c->xf.y.setKey(local, y, Ease::InOut);
    ++n;
  }
  return n;
}

}  // namespace rhap::ai
