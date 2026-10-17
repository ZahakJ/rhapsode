#include "dsp.h"

#include <algorithm>
#include <cmath>
#include <numeric>

namespace rhap::audio {

double toDb(double lin) { return lin > 0 ? 20 * std::log10(lin) : -200; }
double fromDb(double db) { return db <= -199 ? 0 : std::pow(10.0, db / 20); }

namespace {
// RBJ cookbook
Biquad norm(double b0, double b1, double b2, double a0, double a1, double a2) {
  Biquad q;
  q.b0 = b0 / a0;
  q.b1 = b1 / a0;
  q.b2 = b2 / a0;
  q.a1 = a1 / a0;
  q.a2 = a2 / a0;
  return q;
}
}  // namespace

Biquad Biquad::lowShelf(double fs, double f0, double g, double q) {
  double A = std::pow(10, g / 40), w = 2 * M_PI * f0 / fs, c = std::cos(w), s = std::sin(w), al = s / (2 * q);
  double sa = 2 * std::sqrt(A) * al;
  return norm(A * ((A + 1) - (A - 1) * c + sa), 2 * A * ((A - 1) - (A + 1) * c), A * ((A + 1) - (A - 1) * c - sa),
              (A + 1) + (A - 1) * c + sa, -2 * ((A - 1) + (A + 1) * c), (A + 1) + (A - 1) * c - sa);
}
Biquad Biquad::highShelf(double fs, double f0, double g, double q) {
  double A = std::pow(10, g / 40), w = 2 * M_PI * f0 / fs, c = std::cos(w), s = std::sin(w), al = s / (2 * q);
  double sa = 2 * std::sqrt(A) * al;
  return norm(A * ((A + 1) + (A - 1) * c + sa), -2 * A * ((A - 1) + (A + 1) * c), A * ((A + 1) + (A - 1) * c - sa),
              (A + 1) - (A - 1) * c + sa, 2 * ((A - 1) - (A + 1) * c), (A + 1) - (A - 1) * c - sa);
}
Biquad Biquad::peaking(double fs, double f0, double g, double q) {
  double A = std::pow(10, g / 40), w = 2 * M_PI * f0 / fs, c = std::cos(w), al = std::sin(w) / (2 * q);
  return norm(1 + al * A, -2 * c, 1 - al * A, 1 + al / A, -2 * c, 1 - al / A);
}
Biquad Biquad::highPass(double fs, double f0, double q) {
  double w = 2 * M_PI * f0 / fs, c = std::cos(w), al = std::sin(w) / (2 * q);
  return norm((1 + c) / 2, -(1 + c), (1 + c) / 2, 1 + al, -2 * c, 1 - al);
}
Biquad Biquad::lowPass(double fs, double f0, double q) {
  double w = 2 * M_PI * f0 / fs, c = std::cos(w), al = std::sin(w) / (2 * q);
  return norm((1 - c) / 2, 1 - c, (1 - c) / 2, 1 + al, -2 * c, 1 - al);
}

void Compressor::process(float* x, int frames, int ch) {
  double att = std::exp(-1.0 / (attackMs * 1e-3 * rate)), rel = std::exp(-1.0 / (releaseMs * 1e-3 * rate));
  double makeup = fromDb(makeupDb);
  for (int i = 0; i < frames; ++i) {
    double peak = 0;
    for (int c = 0; c < ch; ++c) peak = std::max(peak, double(std::fabs(x[i * ch + c])));
    double lvl = toDb(peak), over = lvl - thresholdDb, red;
    // soft knee
    if (2 * over < -kneeDb) red = 0;
    else if (2 * std::fabs(over) <= kneeDb) red = (1 / ratio - 1) * (over + kneeDb / 2) * (over + kneeDb / 2) / (2 * kneeDb);
    else red = (1 / ratio - 1) * over;
    double coef = red < env ? att : rel;  // reduction is negative: more negative = attacking
    env = coef * env + (1 - coef) * red;
    double g = fromDb(env) * makeup;
    for (int c = 0; c < ch; ++c) x[i * ch + c] = float(x[i * ch + c] * g);
  }
}

void Gate::process(float* x, int frames, int ch) {
  double att = std::exp(-1.0 / (attackMs * 1e-3 * rate)), rel = std::exp(-1.0 / (releaseMs * 1e-3 * rate));
  double floor = fromDb(rangeDb);
  for (int i = 0; i < frames; ++i) {
    double peak = 0;
    for (int c = 0; c < ch; ++c) peak = std::max(peak, double(std::fabs(x[i * ch + c])));
    double target = toDb(peak) >= thresholdDb ? 1 : floor;
    double coef = target > g ? att : rel;
    g = coef * g + (1 - coef) * target;
    for (int c = 0; c < ch; ++c) x[i * ch + c] = float(x[i * ch + c] * g);
  }
}

// ——— BS.1770-4 ———

LoudnessMeter::LoudnessMeter(int rate, int channels) : rate_(rate), ch_(std::min(channels, 8)) {
  // K-weighting from its analogue prototype, so any sample rate gets the standard response
  double fs = rate;
  {
    double f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
    double K = std::tan(M_PI * f0 / fs), Vh = std::pow(10, G / 20), Vb = std::pow(Vh, 0.4996667741545416);
    double a0 = 1 + K / Q + K * K;
    shelf_.b0 = (Vh + Vb * K / Q + K * K) / a0;
    shelf_.b1 = 2 * (K * K - Vh) / a0;
    shelf_.b2 = (Vh - Vb * K / Q + K * K) / a0;
    shelf_.a1 = 2 * (K * K - 1) / a0;
    shelf_.a2 = (1 - K / Q + K * K) / a0;
  }
  {
    double f0 = 38.13547087602444, Q = 0.5003270373238773;
    double K = std::tan(M_PI * f0 / fs), a0 = 1 + K / Q + K * K;
    hpf_.b0 = 1;
    hpf_.b1 = -2;
    hpf_.b2 = 1;
    hpf_.a1 = 2 * (K * K - 1) / a0;
    hpf_.a2 = (1 - K / Q + K * K) / a0;
  }
  subLen_ = rate / 10;
  hist_.assign(size_t(ch_) * 32, 0.f);
}

void LoudnessMeter::reset() { *this = LoudnessMeter(rate_, ch_); }

namespace {
// 4× oversampling: windowed-sinc interpolation, kTaps per phase
constexpr int kTaps = 32;
struct Oversampler {
  double taps[4][kTaps];
  Oversampler() {
    for (int ph = 0; ph < 4; ++ph) {
      double sum = 0;
      for (int k = 0; k < kTaps; ++k) {
        double x = (k - (kTaps / 2 - 1)) - ph / 4.0;
        double s = std::fabs(x) < 1e-12 ? 1 : std::sin(M_PI * x) / (M_PI * x);
        double w = 0.5 * (1 + std::cos(M_PI * x / (kTaps / 2 + 0.5)));
        taps[ph][k] = s * w;
        sum += taps[ph][k];
      }
      for (int k = 0; k < kTaps; ++k) taps[ph][k] /= sum;
    }
  }
};
const Oversampler kOver;
double loudnessOf(double energy) { return energy > 0 ? -0.691 + 10 * std::log10(energy) : -200; }
}  // namespace

void LoudnessMeter::push(const float* x, int frames) {
  for (int i = 0; i < frames; ++i) {
    for (int c = 0; c < ch_; ++c) {
      double s = x[i * ch_ + c];
      peak_ = std::max(peak_, std::fabs(s));
      // true peak: shift the history, interpolate 4 phases
      float* h = &hist_[size_t(c) * kTaps];
      std::move(h + 1, h + kTaps, h);
      h[kTaps - 1] = float(s);
      for (int ph = 0; ph < 4; ++ph) {
        double v = 0;
        for (int k = 0; k < kTaps; ++k) v += kOver.taps[ph][k] * h[k];
        truePeak_ = std::max(truePeak_, std::fabs(v));
      }
      double k = hpf_.run(c, shelf_.run(c, s));
      subSum_[c] += k * k;
    }
    if (++subFill_ == subLen_) {
      double e = 0;
      for (int c = 0; c < ch_; ++c) {
        e += subSum_[c] / subLen_;  // channel weight 1 for L, R, C
        subSum_[c] = 0;
      }
      subFill_ = 0;
      subs_.push_back(e);
      if (subs_.size() > 30) subs_.pop_front();
      if (subs_.size() >= 4) {
        double b = (subs_[subs_.size() - 1] + subs_[subs_.size() - 2] + subs_[subs_.size() - 3] + subs_[subs_.size() - 4]) / 4;
        blocks_.push_back(b);
      }
      if (subs_.size() == 30) shorts_.push_back(std::accumulate(subs_.begin(), subs_.end(), 0.0) / 30);
    }
  }
}

double LoudnessMeter::momentary() const {
  if (subs_.size() < 4) return -200;
  double e = 0;
  for (size_t i = subs_.size() - 4; i < subs_.size(); ++i) e += subs_[i];
  return loudnessOf(e / 4);
}

double LoudnessMeter::shortTerm() const {
  if (subs_.size() < 30) return -200;
  return loudnessOf(std::accumulate(subs_.begin(), subs_.end(), 0.0) / 30);
}

double LoudnessMeter::integrated() const {
  double sum = 0;
  int n = 0;
  for (double b : blocks_)
    if (loudnessOf(b) > -70) sum += b, ++n;
  if (!n) return -200;
  double rel = loudnessOf(sum / n) - 10;
  sum = 0;
  n = 0;
  for (double b : blocks_)
    if (loudnessOf(b) > -70 && loudnessOf(b) > rel) sum += b, ++n;
  return n ? loudnessOf(sum / n) : -200;
}

double LoudnessMeter::range() const {
  std::vector<double> v;
  double sum = 0;
  int n = 0;
  for (double s : shorts_)
    if (loudnessOf(s) > -70) sum += s, ++n;
  if (n < 2) return 0;
  double rel = loudnessOf(sum / n) - 20;
  for (double s : shorts_)
    if (loudnessOf(s) > -70 && loudnessOf(s) > rel) v.push_back(loudnessOf(s));
  if (v.size() < 2) return 0;
  std::sort(v.begin(), v.end());
  auto pct = [&](double p) { return v[size_t(std::lround(p * double(v.size() - 1)))]; };
  return pct(0.95) - pct(0.10);
}

double LoudnessMeter::truePeak() const { return toDb(std::max(truePeak_, peak_)); }
double LoudnessMeter::samplePeak() const { return toDb(peak_); }

}  // namespace rhap::audio
