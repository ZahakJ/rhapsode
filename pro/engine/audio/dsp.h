#pragma once
// Sound processing pieces: biquads, dynamics, and an ITU-R BS.1770-4 /
// EBU R128 loudness meter (momentary, short-term, integrated, LRA, true peak).

#include <cstdint>
#include <deque>
#include <vector>

namespace rhap::audio {

struct Biquad {
  double b0 = 1, b1 = 0, b2 = 0, a1 = 0, a2 = 0;
  double z1[8] = {}, z2[8] = {};  // per channel
  double run(int ch, double x) {
    double y = b0 * x + z1[ch];
    z1[ch] = b1 * x - a1 * y + z2[ch];
    z2[ch] = b2 * x - a2 * y;
    return y;
  }
  void reset() {
    for (int i = 0; i < 8; ++i) z1[i] = z2[i] = 0;
  }
  static Biquad lowShelf(double fs, double f0, double gainDb, double q = 0.707);
  static Biquad highShelf(double fs, double f0, double gainDb, double q = 0.707);
  static Biquad peaking(double fs, double f0, double gainDb, double q);
  static Biquad highPass(double fs, double f0, double q = 0.707);
  static Biquad lowPass(double fs, double f0, double q = 0.707);
};

/** Feed-forward compressor with soft knee; also a limiter (ratio ∞, fast attack) and a gate (ratio < 1). */
struct Compressor {
  double thresholdDb = -18, ratio = 3, attackMs = 10, releaseMs = 120, kneeDb = 6, makeupDb = 0;
  double env = 0;  // dB of gain reduction state
  int rate = 48000;
  void process(float* interleaved, int frames, int channels);
  void reset() { env = 0; }
  double reductionDb() const { return env; }
};

/** Noise gate with hysteresis: closes below the threshold by `rangeDb`. */
struct Gate {
  double thresholdDb = -50, rangeDb = -40, attackMs = 2, releaseMs = 150;
  double g = 1;
  int rate = 48000;
  void process(float* interleaved, int frames, int channels);
};

class LoudnessMeter {
 public:
  explicit LoudnessMeter(int rate = 48000, int channels = 2);
  void push(const float* interleaved, int frames);
  void reset();
  /** LUFS; −inf (as −200) before there is enough sound */
  double momentary() const;
  double shortTerm() const;
  double integrated() const;
  /** loudness range, LU (EBU Tech 3342) */
  double range() const;
  /** dBTP, 4× oversampled */
  double truePeak() const;
  double samplePeak() const;

 private:
  int rate_, ch_;
  Biquad shelf_, hpf_;
  int subLen_;            // samples per 100 ms
  int subFill_ = 0;
  double subSum_[8] = {};  // per channel, current 100 ms
  std::deque<double> subs_;     // last 30 sub-block energies (weighted sum over channels)
  std::vector<double> blocks_;  // every 400 ms block (75% overlap), for the integrated gate
  std::vector<double> shorts_;  // every short-term value (3 s window, 100 ms step), for LRA
  double peak_ = 0, truePeak_ = 0;
  std::vector<float> hist_;  // last few samples per channel for the oversampler
};

double toDb(double lin);
double fromDb(double db);

}  // namespace rhap::audio
