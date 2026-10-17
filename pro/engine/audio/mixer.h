#pragma once
// The mixer: every audible clip of a sequence summed to stereo at the
// sequence's sample rate, sample-exact with the timeline. Playback pulls
// blocks from it on the audio thread's schedule; export pulls the same
// blocks offline, so they sound the same.
//
// Per clip: gain (dB, keyframed), balance, fades (equal power), crossfade
// transitions; per track: gain, balance, mute / solo and an FX chain (eq,
// compressor, limiter, gate); nested sequences mix recursively.

#include <map>
#include <memory>
#include <string>
#include <vector>

#include "../media/decode.h"
#include "../model/model.h"
#include "dsp.h"

namespace rhap::audio {

struct Levels {
  float peakL = 0, peakR = 0;  // linear, the last block
  float rmsL = 0, rmsR = 0;
};

class Mixer {
 public:
  explicit Mixer(int sampleRate = 48000);
  /** mixes [start, start+frames) of the sequence (in its samples) into out (stereo interleaved) */
  void render(const Project& p, const Sequence& s, int64_t start, int frames, float* out);
  /** after a seek: forget filter and envelope state */
  void reset();
  int sampleRate() const { return rate_; }
  /** per track id, and "master" */
  const std::map<std::string, Levels>& levels() const { return levels_; }

 private:
  void mixSequence(const Project& p, const Sequence& s, int64_t start, int frames, float* out,
                   const std::string& prefix, int depth);
  void mixClip(const Project& p, const Clip& c, const Track& t, int64_t start, int frames, float* out,
               const std::string& prefix, int depth, double xfadeIn, double xfadeOut, Tick xfadeInLen, Tick xfadeOutLen);
  AudioDecoder* decoder(const std::string& slot, const Media& m);
  void trackFx(const std::string& key, const Track& t, float* buf, int frames);

  int rate_;
  struct Dec {
    std::unique_ptr<AudioDecoder> d;
    bool failed = false;
  };
  std::map<std::string, Dec> decs_;
  struct FxState {
    std::vector<Biquad> eq;
    std::string eqKey;
    Compressor comp, limit;
    Gate gate;
  };
  std::map<std::string, FxState> fx_;
  std::map<std::string, Levels> levels_;
  std::vector<float> scratch_;
};

/** integrated loudness (LUFS) of the whole sequence mix, offline */
double measureLoudness(const Project& p, const Sequence& s, double* truePeak = nullptr, double* lra = nullptr);

/**
 * Auto-duck: wherever any of `voice` tracks has speech, the `music` tracks'
 * gain dips by `depthDb`, with ramps. Writes keyframes on the music clips;
 * returns how many dips it made.
 */
int autoDuck(const Project& p, Sequence& s, const std::vector<int>& voiceTracks, const std::vector<int>& musicTracks,
             double depthDb = -12, double thresholdDb = -40, Tick attack = kFlicks / 4, Tick release = kFlicks / 2);

}  // namespace rhap::audio
