#pragma once
// An editing session: the project plus what the editor is pointing at —
// playhead, marks, selection, targets, tool — and every keyboard action as a
// named function. The UI only draws this and forwards keys; tests drive the
// same actions without a window.

#include <functional>
#include <set>
#include <string>
#include <vector>

#include "../model/edit.h"

namespace rhap {

enum class Tool { Select, Razor, Ripple, Roll, Slip, Slide, Hand };

struct Session {
  Project project;
  History history;
  std::string path;      // where it saves; empty = untitled
  uint64_t revision = 0;  // bumps on every change (autosave, viewer cache)
  uint64_t savedRevision = 0;

  Tick playhead = 0;
  Tick markIn = -1, markOut = -1;
  std::set<std::string> selection;
  TrackRef targetVideo{TrackKind::Video, 0}, targetAudio{TrackKind::Audio, 0};
  Tool tool = Tool::Select;
  double shuttle = 0;  // J/K/L: −8..8, 0 = stopped
  bool snapping = true;
  std::string status;  // the last action's message for the status bar

  Session();
  explicit Session(Project p);

  Sequence* seq() { return project.activeSequence(); }
  const Sequence* seq() const { return project.findSequence(project.active); }
  Rate rate() const;
  bool dirty() const { return revision != savedRevision; }

  /** runs an edit with undo; on refusal sets status and leaves everything as it was */
  Err apply(const std::string& label, const std::function<Err(Editor&)>& op);
  bool undo();
  bool redo();

  // ——— navigation ———
  void seek(Tick t);
  void stepFrames(int64_t n);
  void nextEdit(int dir);  // dir +1 / −1
  std::vector<Tick> editPoints() const;
  /** the clip under the playhead on a track, or null */
  const Clip* clipAt(TrackRef t, Tick at) const;

  // ——— actions ———
  Err importFiles(const std::vector<std::string>& paths);
  /** media into the timeline at the playhead on the targets (video + linked sound), source in/out = marks on the media */
  Err placeMedia(const std::string& mediaId, bool insert, Tick srcIn = 0, Tick srcOut = -1);
  Err razorAtPlayhead(bool allTracks);
  Err deleteSelection(bool ripple);
  Err liftOrExtractMarks(bool extract);
  Err trimToPlayhead(Edge e);  // Q / W: ripple the nearest clip's head or tail to the playhead
  Err extendEditToPlayhead();  // E: roll the nearest edit to the playhead
  Err closeGapAtPlayhead();
  Err addMarker();
  Err nudgeSelection(int64_t frames);
  Err switchAngle(int angle);  // multicam cut at the playhead
  void selectAt(TrackRef t, Tick at, bool add);

  // ——— files ———
  std::string save(const std::string& path = "");
  std::string open(const std::string& path);
  /** writes the autosave if dirty since the last one; returns "" or the error */
  std::string autosave();
  uint64_t autosavedRevision = 0;
};

/** a key combination: SDL keycode + modifier bits (1 ctrl, 2 shift, 4 alt) */
struct KeyBinding {
  int key = 0;
  int mods = 0;
  std::string action;
};
enum KeyMods { kCtrl = 1, kShift = 2, kAlt = 4 };

const std::vector<KeyBinding>& premiereKeymap();
/** Rhapsode's default: Premiere's map, with single keys for the edits people make most */
const std::vector<KeyBinding>& rhapsodeKeymap();
/** every action name a keymap may use */
const std::vector<std::string>& actionNames();
/** runs a named action; "" when it worked, otherwise why not (unknown action included) */
Err runAction(Session& s, const std::string& action);
/** the action bound to a key in a map, or "" */
std::string actionFor(const std::vector<KeyBinding>& map, int key, int mods);

}  // namespace rhap
