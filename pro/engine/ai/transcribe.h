#pragma once
// Speech to text on this machine (whisper.cpp), and what an editor does with
// it: captions that follow the words, and editing by deleting words — the
// deleted stretches are ripple-cut from the timeline, picture and all.

#include <functional>
#include <string>
#include <vector>

#include "../model/edit.h"

namespace rhap::ai {

struct TranscribeOptions {
  std::string model;           // a ggml model file; empty = the default under ~/.cache/rhapsode-pro/models
  std::string language = "auto";
  int threads = 0;             // 0 = all cores
  bool gpu = true;             // when whisper.cpp was built with CUDA
  std::function<void(int)> progress;  // percent
};

/** was the engine built with whisper.cpp? */
bool transcriptionAvailable();
std::string defaultModelPath();

/** the words of a media item's sound, in media time */
std::string transcribe(const std::string& mediaPath, const TranscribeOptions& o, Transcript& out);

struct Cue {
  Tick a = 0, b = 0;
  std::string text;
};

struct CaptionOptions {
  int maxChars = 42;  // per line
  int maxLines = 2;
  Tick maxDur = 7 * kFlicks;
  Tick minGap = kFlicks * 6 / 10;  // a pause this long ends a cue
};

/** cues from words: lines filled to maxChars, broken at sentence ends and pauses */
std::vector<Cue> captions(const std::vector<Word>& words, const CaptionOptions& o = {});
std::string toSrt(const std::vector<Cue>& cues);
std::string toVtt(const std::vector<Cue>& cues);
std::vector<Cue> fromSrt(const std::string& text);

/**
 * The words a clip plays, mapped to timeline time (only those inside the
 * clip's window), with their index in the transcript.
 */
struct PlacedWord {
  size_t index;
  Tick a, b;  // timeline
  std::string text;
};
std::vector<PlacedWord> wordsOnTimeline(const Project& p, const Sequence& s, const Clip& c);

/** caption titles for a clip's words on a (new, top) picture track; returns how many */
int addCaptions(Project& p, const std::string& seqId, const std::string& clipId, const CaptionOptions& o = {});

/**
 * Text-based editing: removes the given words (transcript indices) from the
 * clip and everything linked to it, joining runs of neighbouring words into one
 * cut and keeping `keep` of the pause on each side. Cuts snap to frames.
 */
int deleteWords(Project& p, const std::string& seqId, const std::string& clipId, const std::vector<size_t>& words,
                Tick keep = kFlicks / 20, std::string* err = nullptr);

/** a word picked in a track-wide transcript: which clip plays it, and its index in the media's transcript */
struct WordPick {
  std::string clip;
  size_t index;
};

/**
 * Text editing across a whole track (the transcript as one document): every
 * clip's picked words are cut, later clips first so earlier picks keep their place.
 */
int deleteWordsOnTrack(Project& p, const std::string& seqId, const std::vector<WordPick>& picks, Tick keep = kFlicks / 20,
                       std::string* err = nullptr);

/** every filler word on the clips of a track */
std::vector<WordPick> fillerWordsOnTrack(const Project& p, const Sequence& s, TrackRef track);

/** captions for every transcribed clip of a track, on the sequence's one Captions track */
int addCaptionsForTrack(Project& p, const std::string& seqId, TrackRef track, const CaptionOptions& o = {});

/** words that are hesitation, not content ("um", "uh", "erm", "hmm", …), by transcript index, for a clip */
std::vector<size_t> fillerWords(const Project& p, const Sequence& s, const Clip& c);

}  // namespace rhap::ai
