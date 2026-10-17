#include "player.h"

#include <SDL3/SDL.h>

#include <vector>

namespace rhap::app {

Player::Player(Session& s) : session_(s) {
  SDL_AudioSpec spec{SDL_AUDIO_F32, 2, 48000};
  stream_ = SDL_OpenAudioDeviceStream(SDL_AUDIO_DEVICE_DEFAULT_PLAYBACK, &spec, &Player::feed, this);
}

Player::~Player() {
  if (stream_) SDL_DestroyAudioStream(stream_);
}

void SDLCALL Player::feed(void* user, SDL_AudioStream* stream, int additional, int) {
  auto* p = static_cast<Player*>(user);
  int frames = additional / 8;
  if (frames <= 0) return;
  std::vector<float> buf(size_t(frames) * 2, 0.f);
  {
    std::lock_guard l(p->mu_);
    if (p->snapshot_) {
      if (const Sequence* s = p->snapshot_->findSequence(p->seqId_)) {
        p->mixer_.render(*p->snapshot_, *s, p->nextSample_, frames, buf.data());
        p->meter_.push(buf.data(), frames);
        p->levels_ = p->mixer_.levels();
      }
    }
    p->nextSample_ += frames;
  }
  SDL_PutAudioStreamData(stream, buf.data(), int(buf.size() * sizeof(float)));
  p->fed_ += frames;
}

void Player::startAudio(Tick from) {
  if (!stream_) return;
  SDL_PauseAudioStreamDevice(stream_);
  SDL_ClearAudioStream(stream_);
  {
    std::lock_guard l(mu_);
    nextSample_ = sampleAt(from, 48000);
    mixer_.reset();
  }
  startSample_ = sampleAt(from, 48000);
  fed_ = 0;
  SDL_ResumeAudioStreamDevice(stream_);
}

void Player::stopAudio() {
  if (!stream_) return;
  SDL_PauseAudioStreamDevice(stream_);
  SDL_ClearAudioStream(stream_);
}

void Player::tick() {
  // a new snapshot after edits
  if (session_.revision != snapRevision_ || session_.project.active != seqId_) {
    auto snap = std::make_shared<const Project>(session_.project);
    std::lock_guard l(mu_);
    snapshot_ = std::move(snap);
    seqId_ = session_.project.active;
    snapRevision_ = session_.revision;
  }
  double sh = session_.shuttle;
  if (sh != lastShuttle_) {
    // a change of speed restarts the clock from where the playhead is
    stopAudio();
    audioClock_ = sh == 1.0 && stream_;
    if (audioClock_) startAudio(session_.playhead);
    wallStart_ = std::chrono::steady_clock::now();
    wallStartTick_ = session_.playhead;
    lastShuttle_ = sh;
  }
  if (sh == 0) return;
  Tick end = session_.seq() ? session_.seq()->duration() : 0;
  Tick t;
  if (audioClock_) {
    // what the device has actually played: fed minus what still sits in the stream
    int64_t queued = SDL_GetAudioStreamQueued(stream_) / 8;
    int64_t played = std::max<int64_t>(0, fed_.load() - queued);
    t = sampleStart(startSample_ + played, 48000);
  } else {
    double el = std::chrono::duration<double>(std::chrono::steady_clock::now() - wallStart_).count();
    t = wallStartTick_ + fromSeconds(el * sh);
  }
  if (t >= end && sh > 0) {
    t = end;
    session_.shuttle = 0;
  }
  if (t <= 0 && sh < 0) {
    t = 0;
    session_.shuttle = 0;
  }
  session_.playhead = t;
}

std::map<std::string, audio::Levels> Player::levels() {
  std::lock_guard l(mu_);
  return levels_;
}

Player::Loudness Player::loudness() {
  std::lock_guard l(mu_);
  return {meter_.momentary(), meter_.shortTerm(), meter_.integrated(), meter_.truePeak()};
}

void Player::resetLoudness() {
  std::lock_guard l(mu_);
  meter_.reset();
}

}  // namespace rhap::app
