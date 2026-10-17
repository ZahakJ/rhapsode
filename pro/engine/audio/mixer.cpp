#include "mixer.h"

#include <algorithm>
#include <cmath>
#include <cstring>

namespace rhap::audio {

namespace {

const Effect* fxOf(const std::vector<Effect>& v, const char* type) {
  for (auto& e : v)
    if (e.enabled && e.type == type) return &e;
  return nullptr;
}

double par(const Effect* e, const char* name, double fallback) {
  if (!e) return fallback;
  auto it = e->params.find(name);
  return it == e->params.end() ? fallback : it->second.value;
}

/** equal-power ramp, 0 → 1 */
double rampUp(double u) { return u <= 0 ? 0 : u >= 1 ? 1 : std::sin(u * M_PI / 2); }

void balance(double pan, double& l, double& r) {
  pan = std::clamp(pan, -1.0, 1.0);
  l = pan > 0 ? 1 - pan : 1;
  r = pan < 0 ? 1 + pan : 1;
}

}  // namespace

Mixer::Mixer(int rate) : rate_(rate) {}

void Mixer::reset() {
  for (auto& [k, f] : fx_) {
    for (auto& b : f.eq) b.reset();
    f.comp.reset();
    f.limit.reset();
    f.gate.g = 1;
  }
}

AudioDecoder* Mixer::decoder(const std::string& slot, const Media& m) {
  Dec& d = decs_[slot + "|" + m.path];
  if (d.failed) return nullptr;
  if (!d.d) {
    d.d = std::make_unique<AudioDecoder>();
    if (!d.d->open(m.path, rate_, 2).empty()) {
      d.d.reset();
      d.failed = true;
      return nullptr;
    }
    if (decs_.size() > 64) {
      // drop decoders of slots not heard for a while (simple: the first other one)
      for (auto it = decs_.begin(); it != decs_.end(); ++it)
        if (it->second.d.get() != d.d.get()) {
          decs_.erase(it);
          break;
        }
    }
  }
  return d.d.get();
}

void Mixer::render(const Project& p, const Sequence& s, int64_t start, int frames, float* out) {
  std::fill(out, out + size_t(frames) * 2, 0.f);
  mixSequence(p, s, start, frames, out, "", 0);
  Levels& m = levels_["master"];
  m = {};
  double sl = 0, sr = 0;
  for (int i = 0; i < frames; ++i) {
    m.peakL = std::max(m.peakL, std::fabs(out[i * 2]));
    m.peakR = std::max(m.peakR, std::fabs(out[i * 2 + 1]));
    sl += double(out[i * 2]) * out[i * 2];
    sr += double(out[i * 2 + 1]) * out[i * 2 + 1];
  }
  if (frames > 0) {
    m.rmsL = float(std::sqrt(sl / frames));
    m.rmsR = float(std::sqrt(sr / frames));
  }
}

void Mixer::mixSequence(const Project& p, const Sequence& s, int64_t start, int frames, float* out,
                        const std::string& prefix, int depth) {
  if (depth > 8) return;
  bool anySolo = std::any_of(s.audio.begin(), s.audio.end(), [](const Track& t) { return t.solo; });
  std::vector<float> buf(size_t(frames) * 2);
  const Tick t0 = sampleStart(start, rate_), t1 = sampleStart(start + frames, rate_);
  for (const Track& tr : s.audio) {
    if (tr.mute || (anySolo && !tr.solo)) continue;
    std::fill(buf.begin(), buf.end(), 0.f);
    bool any = false;
    for (size_t i = 0; i < tr.clips.size(); ++i) {
      const Clip& c = tr.clips[i];
      // crossfades widen both sides of a cut into their handles
      Tick xin = 0, xout = 0;
      for (auto& x : tr.transitions) {
        if (x.at == c.start && i > 0 && tr.clips[i - 1].end() == x.at) xin = x.dur;
        if (x.at == c.end() && i + 1 < tr.clips.size() && tr.clips[i + 1].start == x.at) xout = x.dur;
      }
      if (c.end() + xout / 2 <= t0 || c.start - xin / 2 >= t1) continue;
      mixClip(p, c, tr, start, frames, buf.data(), prefix, depth, 0, 0, xin, xout);
      any = true;
    }
    if (!any) {
      levels_[prefix + tr.id] = {};
      continue;
    }
    trackFx(prefix + tr.id, tr, buf.data(), frames);
    // track gain and balance, keyed on sequence time
    for (int b = 0; b < frames; b += 64) {
      int n = std::min(64, frames - b);
      Tick at = sampleStart(start + b, rate_);
      double g = fromDb(tr.gain.at(at)), l, r;
      balance(tr.pan.at(at), l, r);
      for (int i = b; i < b + n; ++i) {
        out[i * 2] += float(buf[size_t(i) * 2] * g * l);
        out[i * 2 + 1] += float(buf[size_t(i) * 2 + 1] * g * r);
      }
    }
    if (depth == 0) {
      Levels& lv = levels_[tr.id];
      lv = {};
      for (int i = 0; i < frames; ++i) {
        lv.peakL = std::max(lv.peakL, std::fabs(buf[size_t(i) * 2]));
        lv.peakR = std::max(lv.peakR, std::fabs(buf[size_t(i) * 2 + 1]));
      }
    }
  }
}

void Mixer::mixClip(const Project& p, const Clip& c, const Track&, int64_t start, int frames, float* out,
                    const std::string& prefix, int depth, double, double, Tick xin, Tick xout) {
  if (!c.enabled) return;
  const int64_t cs = sampleAt(c.start, rate_);
  const int64_t a = std::max(start, sampleAt(c.start - xin / 2, rate_));
  const int64_t b = std::min(start + frames, sampleAt(c.end() + xout / 2, rate_));
  if (a >= b) return;
  const int n = int(b - a);
  // the source samples this stretch needs, then resampled by speed
  const double sp = c.speed;
  const double inS = double(c.in) * rate_ / double(kFlicks);
  const double spanS = double(c.sourceSpan()) * rate_ / double(kFlicks);
  auto srcPos = [&](int64_t sample) {
    double off = double(sample - cs);
    return sp >= 0 ? inS + off * sp : inS + spanS + off * sp;
  };
  double p0 = srcPos(a), p1 = srcPos(b - 1);
  int64_t lo = int64_t(std::floor(std::min(p0, p1))) - 1, hi = int64_t(std::ceil(std::max(p0, p1))) + 2;
  int len = int(hi - lo);
  scratch_.resize(size_t(len) * 2);
  std::vector<float> src(size_t(len) * 2, 0.f);
  if (c.kind == ClipKind::Media) {
    const Media* m = p.findMedia(c.ref);
    if (!m || !m->hasAudio) return;
    AudioDecoder* d = decoder(prefix + c.id, *m);
    if (!d) return;
    d->read(lo, src.data(), len);
  } else if (c.kind == ClipKind::Nested) {
    const Sequence* ns = p.findSequence(c.ref);
    if (!ns) return;
    mixSequence(p, *ns, lo, len, src.data(), prefix + c.id + "/", depth + 1);
  } else {
    return;
  }
  const bool unit = sp == 1.0 && std::floor(inS) == inS;
  for (int k0 = 0; k0 < n; k0 += 32) {
    int kn = std::min(32, n - k0);
    Tick at = sampleStart(a + k0, rate_);
    Tick local = at - c.start;
    double g = fromDb(c.gain.at(local)), l, r;
    balance(c.pan.at(local), l, r);
    for (int k = k0; k < k0 + kn; ++k) {
      int64_t sample = a + k;
      Tick t = sampleStart(sample, rate_);
      double f = 1;
      if (c.fadeIn > 0 && t < c.start + c.fadeIn) f *= rampUp(double(t - c.start) / double(c.fadeIn));
      if (c.fadeOut > 0 && t > c.end() - c.fadeOut) f *= rampUp(double(c.end() - t) / double(c.fadeOut));
      if (xin > 0 && t < c.start + xin / 2) f *= rampUp(double(t - (c.start - xin / 2)) / double(xin));
      if (xout > 0 && t > c.end() - xout / 2) f *= rampUp(double(c.end() + xout / 2 - t) / double(xout));
      float L, R;
      if (unit) {
        size_t i = size_t(int64_t(inS) + (sample - cs) - lo);
        L = src[i * 2];
        R = src[i * 2 + 1];
      } else {
        double pos = srcPos(sample) - double(lo);
        int i = std::clamp(int(pos), 0, len - 2);
        double fr = pos - i;
        L = float(src[size_t(i) * 2] * (1 - fr) + src[size_t(i + 1) * 2] * fr);
        R = float(src[size_t(i) * 2 + 1] * (1 - fr) + src[size_t(i + 1) * 2 + 1] * fr);
      }
      out[size_t(sample - start) * 2] += float(L * g * l * f);
      out[size_t(sample - start) * 2 + 1] += float(R * g * r * f);
    }
  }
}

void Mixer::trackFx(const std::string& key, const Track& t, float* buf, int frames) {
  if (t.fx.empty()) return;
  FxState& st = fx_[key];
  if (const Effect* gate = fxOf(t.fx, "gate")) {
    st.gate.rate = rate_;
    st.gate.thresholdDb = par(gate, "threshold", -50);
    st.gate.rangeDb = par(gate, "range", -40);
    st.gate.process(buf, frames, 2);
  }
  if (const Effect* eq = fxOf(t.fx, "eq")) {
    double low = par(eq, "low", 0), mid = par(eq, "mid", 0), high = par(eq, "high", 0), midF = par(eq, "midFreq", 1000),
           hp = par(eq, "highpass", 0);
    std::string k = std::to_string(low) + "," + std::to_string(mid) + "," + std::to_string(high) + "," +
                    std::to_string(midF) + "," + std::to_string(hp);
    if (k != st.eqKey) {
      st.eqKey = k;
      st.eq.clear();
      if (hp > 0) st.eq.push_back(Biquad::highPass(rate_, hp));
      if (low != 0) st.eq.push_back(Biquad::lowShelf(rate_, 120, low));
      if (mid != 0) st.eq.push_back(Biquad::peaking(rate_, midF, mid, 0.9));
      if (high != 0) st.eq.push_back(Biquad::highShelf(rate_, 8000, high));
    }
    for (auto& q : st.eq)
      for (int i = 0; i < frames; ++i)
        for (int c = 0; c < 2; ++c) buf[i * 2 + c] = float(q.run(c, buf[i * 2 + c]));
  }
  if (const Effect* comp = fxOf(t.fx, "compressor")) {
    Compressor& k = st.comp;
    k.rate = rate_;
    k.thresholdDb = par(comp, "threshold", -18);
    k.ratio = par(comp, "ratio", 3);
    k.attackMs = par(comp, "attack", 10);
    k.releaseMs = par(comp, "release", 120);
    k.makeupDb = par(comp, "makeup", 0);
    k.process(buf, frames, 2);
  }
  if (const Effect* lim = fxOf(t.fx, "limiter")) {
    Compressor& k = st.limit;
    k.rate = rate_;
    k.thresholdDb = par(lim, "ceiling", -1);
    k.ratio = 1000;
    k.kneeDb = 0.5;
    k.attackMs = 0.5;
    k.releaseMs = 60;
    k.process(buf, frames, 2);
  }
}

double measureLoudness(const Project& p, const Sequence& s, double* tp, double* lra) {
  Mixer m(s.sampleRate);
  LoudnessMeter meter(s.sampleRate, 2);
  int64_t total = sampleAt(s.duration(), s.sampleRate);
  std::vector<float> buf(4800 * 2);
  for (int64_t at = 0; at < total; at += 4800) {
    int n = int(std::min<int64_t>(4800, total - at));
    m.render(p, s, at, n, buf.data());
    meter.push(buf.data(), n);
  }
  if (tp) *tp = meter.truePeak();
  if (lra) *lra = meter.range();
  return meter.integrated();
}

int autoDuck(const Project& p, Sequence& s, const std::vector<int>& voice, const std::vector<int>& music, double depthDb,
             double thresholdDb, Tick attack, Tick release) {
  // the voice tracks alone
  Sequence v = s;
  for (size_t i = 0; i < v.audio.size(); ++i) {
    bool isVoice = std::find(voice.begin(), voice.end(), int(i)) != voice.end();
    v.audio[i].mute = !isVoice;
    v.audio[i].solo = false;
  }
  Mixer m(s.sampleRate);
  const int win = s.sampleRate / 10;
  int64_t total = sampleAt(s.duration(), s.sampleRate);
  std::vector<float> buf(size_t(win) * 2);
  std::vector<std::pair<Tick, Tick>> speech;
  for (int64_t at = 0; at < total; at += win) {
    int n = int(std::min<int64_t>(win, total - at));
    m.render(p, v, at, n, buf.data());
    double e = 0;
    for (int i = 0; i < n * 2; ++i) e += double(buf[size_t(i)]) * buf[size_t(i)];
    bool on = n > 0 && toDb(std::sqrt(e / (n * 2))) > thresholdDb;
    if (!on) continue;
    Tick a = sampleStart(at, s.sampleRate), b = sampleStart(at + n, s.sampleRate);
    // bridge pauses shorter than 400 ms
    if (!speech.empty() && a - speech.back().second < kFlicks * 2 / 5) speech.back().second = b;
    else speech.push_back({a, b});
  }
  int dips = 0;
  for (int mi : music) {
    if (mi < 0 || size_t(mi) >= s.audio.size()) continue;
    for (Clip& c : s.audio[size_t(mi)].clips) {
      double base = c.gain.value;
      Param g(base);
      for (auto [a, b] : speech) {
        if (b <= c.start || a >= c.end()) continue;
        Tick la = std::max<Tick>(0, a - c.start), lb = std::min(c.dur, b - c.start);
        g.setKey(std::max<Tick>(0, la - attack), base);
        g.setKey(la, base + depthDb);
        g.setKey(lb, base + depthDb);
        g.setKey(std::min(c.dur, lb + release), base);
        ++dips;
      }
      if (!g.keys.empty()) c.gain = g;
    }
  }
  return dips;
}

}  // namespace rhap::audio
