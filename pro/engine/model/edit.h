#pragma once
// Edit operations. Each one either succeeds or leaves the sequence exactly as
// it was and returns the reason; none can leave a track overlapping, a clip
// empty or a source window outside its media. `check` states those
// invariants, and the property test hammers every op against it.
//
// Sync lock follows Premiere: an insert, extract or ripple on one track also
// shifts every other unlocked track whose syncLock is on, cutting through
// what lies across the edit so the tracks stay in step.

#include <functional>
#include <string>
#include <vector>

#include "model.h"

namespace rhap {

enum class Edge { Head, Tail };

/** Result of an edit: empty when it succeeded. */
using Err = std::string;

class Editor {
 public:
  Editor(Project& p, std::string seqId) : p_(p), id_(std::move(seqId)) {}
  Editor(Project& p, const Sequence& s) : p_(p), id_(s.id) {}
  Sequence& seq() { return *p_.findSequence(id_); }
  const Sequence& seq() const { return *p_.findSequence(id_); }

  // placing
  Err overwrite(TrackRef t, Clip c);  // c.start is where it lands
  Err insert(TrackRef t, Clip c);     // pushes everything at c.start right by c.dur
  Err razor(TrackRef t, Tick at);
  Err razorAll(Tick at);

  // removing
  Err lift(const std::vector<TrackRef>& ts, Tick a, Tick b);     // leaves a gap
  Err extract(const std::vector<TrackRef>& ts, Tick a, Tick b);  // closes it
  Err remove(const std::string& clipId);                         // lift one clip (+ linked)
  Err rippleDelete(const std::string& clipId);                   // extract one clip (+ linked)
  Err closeGap(TrackRef t, Tick at);                             // ripple out the gap containing at

  // trimming
  Err rippleTrim(const std::string& clipId, Edge e, Tick delta);  // + delta = later
  Err rollTrim(const std::string& clipId, Tick delta);            // the cut after clipId moves by delta
  Err trim(const std::string& clipId, Edge e, Tick delta);        // plain trim: no ripple, gaps open/close
  Err slip(const std::string& clipId, Tick delta);
  Err slide(const std::string& clipId, Tick delta);

  // moving and shaping
  Err move(const std::string& clipId, TrackRef dst, Tick start);  // overwrite at the destination
  Err setSpeed(const std::string& clipId, double speed, bool ripple);
  Err link(const std::vector<std::string>& clipIds);
  Err unlink(const std::string& clipId);
  /** replaces the clips with one nested clip; returns the new sequence id in `out` */
  Err nest(const std::vector<std::string>& clipIds, std::string* out = nullptr);
  /** a multicam clip shows `angle` from `at` onwards (razors at `at`) */
  Err switchAngle(const std::string& clipId, Tick at, int angle);

  // tracks and markers
  Err addTrack(TrackKind k, int index = -1);
  Err removeTrack(TrackRef t);
  Err addMarker(Tick t, const std::string& name, Tick dur = 0);
  Err removeMarker(const std::string& id);

  /** source length a clip may consume; huge for stills, titles and solids */
  Tick sourceLimit(const Clip& c) const;

 private:
  template <class F>
  Err atomic(F&& f);
  Err placeOn(Track& t, Clip c);
  void clearRange(Track& t, Tick a, Tick b);
  void splitAt(Track& t, Tick at);
  void shiftFrom(Track& t, Tick at, Tick delta);
  std::vector<TrackRef> syncTracks(const std::vector<TrackRef>& targets) const;
  std::vector<std::string> linked(const std::string& clipId) const;
  Err checkClip(const Clip& c) const;

  void rippleOthers(const std::vector<TrackRef>& except, Tick at, Tick delta);
  bool reshape(Clip& c, Edge e, Tick delta) const;

  Project& p_;
  std::string id_;  // the sequence; resolved per call because nest() grows p_.sequences
};

/** Every invariant of a sequence, as messages; empty when sound. */
std::vector<std::string> check(const Project& p, const Sequence& s);
std::vector<std::string> check(const Project& p);

/** Builds a multicam source sequence: one video track per angle, aligned by offset (ticks into each angle). */
std::string makeMulticam(Project& p, const std::string& name, const std::vector<std::string>& mediaIds,
                         const std::vector<Tick>& offsets);

/** A clip of a media item over its whole length (or `dur` for stills). */
Clip clipOf(Project& p, const Media& m, Tick start, Tick dur = 0);

/** Snapshot undo. Every edit pushes the project as it was. */
class History {
 public:
  explicit History(size_t cap = 1000) : cap_(cap) {}
  void push(const Project& before, std::string label);
  bool undo(Project& p);
  bool redo(Project& p);
  bool canUndo() const { return !undo_.empty(); }
  bool canRedo() const { return !redo_.empty(); }
  const std::string& undoLabel() const;
  void clear();

 private:
  struct Entry {
    Project p;
    std::string label;
  };
  std::vector<Entry> undo_, redo_;
  size_t cap_;
};

}  // namespace rhap
