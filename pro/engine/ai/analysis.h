#pragma once
// Local analysis that edits: silence, scene cuts, a reframing path. All run
// on this machine from the media itself; no network, no account.

#include <map>
#include <string>
#include <vector>

#include "../model/edit.h"

namespace rhap::ai {

struct Range {
  Tick a = 0, b = 0;  // media time, [a, b)
};

struct SilenceOptions {
  double thresholdDb = -45;  // below this (RMS over a 10 ms window) is silence
  Tick minDur = kFlicks / 2;  // shorter pauses stay
  Tick pad = kFlicks / 10;    // sound kept on each side of a cut
};

/** silent ranges of a media item's sound, sample-accurate at the edges */
std::vector<Range> detectSilence(const std::string& path, const SilenceOptions& o = {}, int sampleRate = 48000);

/**
 * Removes the silences inside a clip (and its linked clips) by extracting
 * them from the timeline, last first. With `frameSnap` the cuts land on frame
 * boundaries (needed when picture is linked). Returns how many were cut.
 */
int removeSilence(Project& p, const std::string& seqId, const std::string& clipId, const std::vector<Range>& silences,
                  bool frameSnap, std::string* err = nullptr);

struct SceneOptions {
  double threshold = 0.3;  // 0..1, the change between frames that counts as a cut
  Tick minGap = kFlicks / 2;
};

/** media times of the first frame of each new shot (not including 0) */
std::vector<Tick> detectScenes(const std::string& path, const SceneOptions& o = {}, bool hw = true);

/** razors the clip at every detected cut inside it ("scene edit detection") */
int splitAtScenes(Project& p, const std::string& seqId, const std::string& clipId, const std::vector<Tick>& cuts);

struct ReframeKey {
  Tick t = 0;     // media time
  double cx = 0.5, cy = 0.5;  // the subject's centre, fractions of the frame
};

/** where the action is, sampled `perSecond` times a second and smoothed */
std::vector<ReframeKey> trackSubject(const std::string& path, double perSecond = 4, bool hw = true);

/**
 * Fits the clip to a canvas of another shape (e.g. 16:9 into 9:16) by scaling
 * it to cover and keyframing its position to follow the subject.
 */
int applyReframe(Project& p, const std::string& seqId, const std::string& clipId, const std::vector<ReframeKey>& keys);

/**
 * A copy of a sequence in another shape (e.g. 1080×1920), every picture clip
 * reframed to follow its subject. `subjects` maps media path → tracked path
 * (from trackSubject; missing media are centred). Returns the new sequence id.
 */
std::string reframedCopy(Project& p, const std::string& seqId, int width, int height,
                         const std::map<std::string, std::vector<ReframeKey>>& subjects);

/**
 * Sync by sound: how far into each file the moment the first file starts
 * happens (positive) or how long before it (negative), from the correlation
 * of their sound — coarse on a 200 Hz onset envelope, then to the sample.
 * offsets[0] is 0. `maxLag` bounds the search.
 */
std::vector<Tick> syncByAudio(const std::vector<std::string>& paths, Tick maxLag = 120 * kFlicks, std::string* err = nullptr);

}  // namespace rhap::ai
