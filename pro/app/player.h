#pragma once
// Playback: the sound device is the clock at 1× forward; any other shuttle
// speed (J/L doubled, reverse) runs on the wall clock with the sound muted.
// The audio thread mixes from a snapshot of the project that the UI thread
// swaps in after each edit, so editing never blocks the sound.

#include <SDL3/SDL_audio.h>

#include <atomic>
#include <chrono>
#include <memory>
#include <mutex>

#include "engine/audio/mixer.h"
#include "engine/session/session.h"

namespace rhap::app {

class Player {
 public:
  explicit Player(Session& s);
  ~Player();
  /** call once per UI frame: advances the playhead while playing, swaps the snapshot after edits */
  void tick();
  bool playing() const { return session_.shuttle != 0; }
  /** the UI moved the playhead itself: restart the clock from there */
  void seeked() { lastShuttle_ = -1000; }
  /** levels for the meters (copied under a lock) */
  std::map<std::string, audio::Levels> levels();
  struct Loudness {
    double momentary = -200, shortTerm = -200, integrated = -200, truePeak = -200;
  };
  Loudness loudness();
  void resetLoudness();
  bool audioOk() const { return stream_ != nullptr; }

 private:
  static void SDLCALL feed(void* user, SDL_AudioStream* stream, int additional, int total);
  void startAudio(Tick from);
  void stopAudio();

  Session& session_;
  SDL_AudioStream* stream_ = nullptr;
  std::mutex mu_;
  std::shared_ptr<const Project> snapshot_;
  std::string seqId_;
  uint64_t snapRevision_ = ~0ull;
  audio::Mixer mixer_{48000};
  audio::LoudnessMeter meter_{48000, 2};
  std::map<std::string, audio::Levels> levels_;
  int64_t nextSample_ = 0;               // the next sample the mixer will produce
  std::atomic<int64_t> startSample_{0};  // where this playback started
  std::atomic<int64_t> fed_{0};          // samples handed to SDL since the start
  bool audioClock_ = false;
  double lastShuttle_ = 0;
  Tick wallStartTick_ = 0;
  std::chrono::steady_clock::time_point wallStart_;
};

}  // namespace rhap::app
