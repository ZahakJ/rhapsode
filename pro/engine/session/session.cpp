#include "session.h"

#include <SDL3/SDL_keycode.h>

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <filesystem>

#include "../io/project_io.h"
#include "../media/decode.h"

namespace rhap {

namespace {
Project emptyProject() {
  Project p;
  Sequence s;
  s.id = p.makeId("s");
  s.name = "Sequence 1";
  for (int i = 0; i < 3; ++i) s.video.push_back(Track{.id = p.makeId("t"), .kind = TrackKind::Video, .name = "V" + std::to_string(i + 1)});
  for (int i = 0; i < 3; ++i) s.audio.push_back(Track{.id = p.makeId("t"), .kind = TrackKind::Audio, .name = "A" + std::to_string(i + 1)});
  p.sequences.push_back(s);
  p.active = s.id;
  return p;
}
}  // namespace

Session::Session() : project(emptyProject()) {}
Session::Session(Project p) : project(std::move(p)) {
  if (!project.activeSequence() && !project.sequences.empty()) project.active = project.sequences.front().id;
}

Rate Session::rate() const { return seq() ? seq()->rate : Rate{30, 1}; }

Err Session::apply(const std::string& label, const std::function<Err(Editor&)>& op) {
  Sequence* s = seq();
  if (!s) return status = "no sequence";
  Project before = project;
  Editor ed(project, s->id);
  Err e = op(ed);
  if (!e.empty()) {
    project = std::move(before);
    status = e;
    return e;
  }
  history.push(before, label);
  ++revision;
  status = label;
  // the selection may name clips that no longer exist
  std::erase_if(selection, [&](const std::string& id) { return !clipById(*seq(), id); });
  return {};
}

bool Session::undo() {
  if (!history.undo(project)) return false;
  ++revision;
  status = "undo";
  std::erase_if(selection, [&](const std::string& id) { return !seq() || !clipById(*seq(), id); });
  return true;
}

bool Session::redo() {
  if (!history.redo(project)) return false;
  ++revision;
  status = "redo";
  return true;
}

void Session::seek(Tick t) {
  const Sequence* s = seq();
  Tick end = s ? s->duration() : 0;
  playhead = snapFrame(std::clamp<Tick>(t, 0, std::max<Tick>(end, 0)), rate());
}

void Session::stepFrames(int64_t n) {
  shuttle = 0;
  seek(frameStart(frameAt(playhead + frameTicks(rate()) / 2, rate()) + n, rate()));
}

std::vector<Tick> Session::editPoints() const {
  std::vector<Tick> v{0};
  if (const Sequence* s = seq())
    forEachTrack(*s, [&](const Track& t, TrackRef) {
      for (auto& c : t.clips) v.push_back(c.start), v.push_back(c.end());
    });
  std::sort(v.begin(), v.end());
  v.erase(std::unique(v.begin(), v.end()), v.end());
  return v;
}

void Session::nextEdit(int dir) {
  shuttle = 0;
  auto v = editPoints();
  if (dir > 0) {
    auto it = std::upper_bound(v.begin(), v.end(), playhead);
    if (it != v.end()) playhead = *it;
  } else {
    auto it = std::lower_bound(v.begin(), v.end(), playhead);
    if (it != v.begin()) playhead = *(it - 1);
  }
}

const Clip* Session::clipAt(TrackRef r, Tick at) const {
  const Sequence* s = seq();
  if (!s) return nullptr;
  const Track* t = trackOf(*s, r);
  if (!t) return nullptr;
  for (auto& c : t->clips)
    if (c.start <= at && at < c.end()) return &c;
  return nullptr;
}

void Session::selectAt(TrackRef t, Tick at, bool add) {
  if (!add) selection.clear();
  const Clip* c = clipAt(t, at);
  if (!c) return;
  selection.insert(c->id);
  if (!c->link.empty())
    forEachTrack(*seq(), [&](const Track& tr, TrackRef) {
      for (auto& o : tr.clips)
        if (o.link == c->link) selection.insert(o.id);
    });
}

Err Session::importFiles(const std::vector<std::string>& paths) {
  int n = 0;
  std::string last;
  for (auto& raw : paths) {
    std::string path = std::filesystem::absolute(raw).string();
    bool have = std::any_of(project.media.begin(), project.media.end(), [&](const Media& m) { return m.path == path; });
    if (have) continue;
    Media m;
    m.id = project.makeId("m");
    if (std::string e = probe(path, m); !e.empty()) {
      last = raw + ": " + e;
      continue;
    }
    // the first picture sets an empty sequence's shape and rate
    Sequence* s = seq();
    if (s && s->duration() == 0 && m.hasVideo && m.kind == MediaKind::Video && m.width > 0) {
      s->width = m.width + (m.width & 1);
      s->height = m.height + (m.height & 1);
      s->rate = m.rate;
    }
    project.media.push_back(m);
    ++n;
  }
  if (n) ++revision;
  status = last.empty() ? std::to_string(n) + " imported" : last;
  return last;
}

Err Session::placeMedia(const std::string& mediaId, bool insert, Tick srcIn, Tick srcOut) {
  const Media* m = project.findMedia(mediaId);
  if (!m) return status = "no such media";
  Media copy = *m;
  Err e = apply(insert ? "insert" : "overwrite", [&](Editor& ed) -> Err {
    Clip v = clipOf(project, copy, playhead);
    v.in = std::max<Tick>(0, srcIn);
    if (srcOut > srcIn) v.dur = srcOut - v.in;
    else if (copy.kind != MediaKind::Image) v.dur = copy.duration - v.in;
    Clip a = v;
    a.id = project.makeId("c");
    bool pic = copy.hasVideo || copy.kind == MediaKind::Image, snd = copy.hasAudio;
    if (pic && snd) v.link = a.link = project.makeId("l");
    if (pic) {
      if (Err x = insert ? ed.insert(targetVideo, v) : ed.overwrite(targetVideo, v); !x.empty()) return x;
      if (snd) return ed.overwrite(targetAudio, a);
      return {};
    }
    return insert ? ed.insert(targetAudio, a) : ed.overwrite(targetAudio, a);
  });
  if (e.empty()) {
    const Clip* c = clipAt(copy.hasVideo || copy.kind == MediaKind::Image ? targetVideo : targetAudio, playhead);
    if (c) playhead = c->end();
  }
  return e;
}

Err Session::razorAtPlayhead(bool all) {
  if (all) return apply("razor all", [&](Editor& ed) { return ed.razorAll(playhead); });
  return apply("add edit", [&](Editor& ed) -> Err {
    std::set<std::pair<int, int>> tracks;
    for (auto& id : selection) {
      ClipLoc l = findClip(ed.seq(), id);
      if (l) tracks.insert({int(l.track.kind), l.track.index});
    }
    if (tracks.empty()) {
      tracks.insert({int(targetVideo.kind), targetVideo.index});
      tracks.insert({int(targetAudio.kind), targetAudio.index});
    }
    for (auto [k, i] : tracks)
      if (Err e = ed.razor({TrackKind(k), i}, playhead); !e.empty()) return e;
    return {};
  });
}

Err Session::deleteSelection(bool ripple) {
  if (selection.empty()) return status = "nothing selected";
  std::vector<std::string> ids(selection.begin(), selection.end());
  Err e = apply(ripple ? "ripple delete" : "delete", [&](Editor& ed) -> Err {
    for (auto& id : ids) {
      if (!clipById(ed.seq(), id)) continue;  // went with a linked partner
      if (Err x = ripple ? ed.rippleDelete(id) : ed.remove(id); !x.empty()) return x;
    }
    return {};
  });
  if (e.empty()) selection.clear();
  return e;
}

Err Session::liftOrExtractMarks(bool extract) {
  if (markIn < 0 || markOut <= markIn) return status = "set an in and an out first";
  std::vector<TrackRef> all;
  forEachTrack(*seq(), [&](const Track& t, TrackRef r) {
    if (!t.locked) all.push_back(r);
  });
  Tick a = markIn, b = markOut;
  Err e = apply(extract ? "extract" : "lift", [&](Editor& ed) { return extract ? ed.extract(all, a, b) : ed.lift(all, a, b); });
  if (e.empty()) {
    playhead = a;
    markIn = markOut = -1;
  }
  return e;
}

namespace {
/** the topmost clip under the playhead on the targets, then any track */
const Clip* underPlayhead(const Session& s, TrackRef& where) {
  for (TrackRef r : {s.targetVideo, s.targetAudio})
    if (const Clip* c = s.clipAt(r, s.playhead)) {
      where = r;
      return c;
    }
  const Clip* found = nullptr;
  forEachTrack(*s.seq(), [&](const Track&, TrackRef r) {
    if (found) return;
    if (const Clip* c = s.clipAt(r, s.playhead)) found = c, where = r;
  });
  return found;
}
}  // namespace

Err Session::trimToPlayhead(Edge e) {
  TrackRef r;
  const Clip* c = underPlayhead(*this, r);
  if (!c) return status = "no clip under the playhead";
  std::string id = c->id;
  Tick start = c->start, end = c->end();
  Err x = apply(e == Edge::Head ? "ripple trim head" : "ripple trim tail", [&](Editor& ed) {
    return e == Edge::Head ? ed.rippleTrim(id, Edge::Head, playhead - start) : ed.rippleTrim(id, Edge::Tail, playhead - end);
  });
  if (x.empty() && e == Edge::Head) playhead = start;
  return x;
}

Err Session::extendEditToPlayhead() {
  // the cut on the target picture track nearest the playhead
  const Track* t = trackOf(*seq(), targetVideo);
  if (!t) return status = "no target track";
  const Clip* best = nullptr;
  Tick bestD = 0;
  for (size_t i = 0; i + 1 < t->clips.size(); ++i)
    if (t->clips[i].end() == t->clips[i + 1].start) {
      Tick d = std::llabs(t->clips[i].end() - playhead);
      if (!best || d < bestD) best = &t->clips[i], bestD = d;
    }
  if (!best) return status = "no edit to extend";
  std::string id = best->id;
  Tick delta = playhead - best->end();
  return apply("extend edit", [&](Editor& ed) { return ed.rollTrim(id, delta); });
}

Err Session::closeGapAtPlayhead() {
  for (TrackRef r : {targetVideo, targetAudio})
    if (!clipAt(r, playhead)) {
      Err e = apply("close gap", [&](Editor& ed) { return ed.closeGap(r, playhead); });
      if (e.empty()) return e;
    }
  return status = "no gap under the playhead";
}

Err Session::addMarker() {
  return apply("marker", [&](Editor& ed) { return ed.addMarker(playhead, "Marker " + std::to_string(ed.seq().markers.size() + 1)); });
}

Err Session::nudgeSelection(int64_t frames) {
  if (selection.empty()) return status = "nothing selected";
  std::vector<std::string> ids(selection.begin(), selection.end());
  Tick d = frameStart(frames, rate());
  return apply("nudge", [&](Editor& ed) -> Err {
    std::set<std::string> moved;
    for (auto& id : ids) {
      const Clip* c = clipById(ed.seq(), id);
      if (!c || moved.count(id)) continue;
      ClipLoc l = findClip(ed.seq(), id);
      std::string link = c->link;
      if (Err e = ed.move(id, l.track, c->start + d); !e.empty()) return e;
      moved.insert(id);
      if (!link.empty())
        forEachTrack(ed.seq(), [&](const Track& t, TrackRef) {
          for (auto& o : t.clips)
            if (o.link == link) moved.insert(o.id);
        });
    }
    return {};
  });
}

Err Session::switchAngle(int angle) {
  const Clip* c = clipAt(targetVideo, playhead);
  if (!c || c->kind != ClipKind::Multicam) return status = "no multicam clip under the playhead";
  std::string id = c->id;
  return apply("angle " + std::to_string(angle + 1), [&](Editor& ed) { return ed.switchAngle(id, playhead, angle); });
}

std::string Session::save(const std::string& p) {
  std::string target = p.empty() ? path : p;
  if (target.empty()) return status = "choose where to save";
  if (std::string e = saveProject(project, target); !e.empty()) return status = e;
  path = target;
  savedRevision = revision;
  std::error_code ec;
  std::filesystem::remove(autosavePath(target), ec);  // the autosave is now behind the file
  status = "saved";
  return {};
}

std::string Session::open(const std::string& p) {
  Project q;
  std::string err;
  if (!loadProject(p, q, err)) return status = err;
  project = std::move(q);
  if (!project.activeSequence() && !project.sequences.empty()) project.active = project.sequences.front().id;
  history.clear();
  path = p;
  revision = savedRevision = autosavedRevision = 0;
  playhead = 0;
  selection.clear();
  status = "opened";
  return {};
}

std::string Session::autosave() {
  if (revision == autosavedRevision || !dirty()) return {};
  std::string target = path;
  if (target.empty()) {
    const char* home = std::getenv("HOME");
    std::filesystem::path dir = std::filesystem::path(home ? home : ".") / ".local/share/rhapsode-pro";
    std::error_code ec;
    std::filesystem::create_directories(dir, ec);
    target = (dir / "untitled.rpro").string();
  }
  if (std::string e = saveProject(project, autosavePath(target), {.backups = 0}); !e.empty()) return e;
  autosavedRevision = revision;
  return {};
}

// ——— keymaps ———

const std::vector<std::string>& actionNames() {
  static const std::vector<std::string> v = {
      "play-pause", "shuttle-back", "shuttle-stop", "shuttle-forward", "step-back", "step-forward", "step-back-10",
      "step-forward-10", "prev-edit", "next-edit", "go-start", "go-end", "mark-in", "mark-out", "clear-marks", "go-in",
      "go-out", "insert", "overwrite", "lift", "extract", "add-edit", "razor-all", "delete", "ripple-delete",
      "trim-head-to-playhead", "trim-tail-to-playhead", "extend-edit", "close-gap", "marker", "undo", "redo", "save",
      "tool-select", "tool-razor", "tool-ripple", "tool-roll", "tool-slip", "tool-slide", "tool-hand", "nudge-left",
      "nudge-right", "snap", "angle-1", "angle-2", "angle-3", "angle-4", "angle-5", "angle-6", "angle-7", "angle-8",
      "angle-9"};
  return v;
}

const std::vector<KeyBinding>& premiereKeymap() {
  // Adobe Premiere Pro's default shortcuts (Windows / Linux modifiers)
  static const std::vector<KeyBinding> m = {
      {SDLK_SPACE, 0, "play-pause"},          {SDLK_J, 0, "shuttle-back"},         {SDLK_K, 0, "shuttle-stop"},
      {SDLK_L, 0, "shuttle-forward"},         {SDLK_LEFT, 0, "step-back"},         {SDLK_RIGHT, 0, "step-forward"},
      {SDLK_LEFT, kShift, "step-back-10"},    {SDLK_RIGHT, kShift, "step-forward-10"}, {SDLK_UP, 0, "prev-edit"},
      {SDLK_DOWN, 0, "next-edit"},            {SDLK_HOME, 0, "go-start"},          {SDLK_END, 0, "go-end"},
      {SDLK_I, 0, "mark-in"},                 {SDLK_O, 0, "mark-out"},             {SDLK_X, kCtrl | kShift, "clear-marks"},
      {SDLK_I, kShift, "go-in"},              {SDLK_O, kShift, "go-out"},          {SDLK_COMMA, 0, "insert"},
      {SDLK_PERIOD, 0, "overwrite"},          {SDLK_SEMICOLON, 0, "lift"},         {SDLK_APOSTROPHE, 0, "extract"},
      {SDLK_K, kCtrl, "add-edit"},            {SDLK_K, kCtrl | kShift, "razor-all"}, {SDLK_DELETE, 0, "delete"},
      {SDLK_BACKSPACE, 0, "delete"},          {SDLK_DELETE, kShift, "ripple-delete"}, {SDLK_Q, 0, "trim-head-to-playhead"},
      {SDLK_W, 0, "trim-tail-to-playhead"},   {SDLK_E, 0, "extend-edit"},          {SDLK_M, 0, "marker"},
      {SDLK_Z, kCtrl, "undo"},                {SDLK_Z, kCtrl | kShift, "redo"},    {SDLK_S, kCtrl, "save"},
      {SDLK_V, 0, "tool-select"},             {SDLK_C, 0, "tool-razor"},           {SDLK_B, 0, "tool-ripple"},
      {SDLK_N, 0, "tool-roll"},               {SDLK_Y, 0, "tool-slip"},            {SDLK_U, 0, "tool-slide"},
      {SDLK_H, 0, "tool-hand"},               {SDLK_LEFT, kAlt, "nudge-left"},     {SDLK_RIGHT, kAlt, "nudge-right"},
      {SDLK_S, 0, "snap"},                    {SDLK_1, 0, "angle-1"},              {SDLK_2, 0, "angle-2"},
      {SDLK_3, 0, "angle-3"},                 {SDLK_4, 0, "angle-4"},              {SDLK_5, 0, "angle-5"},
      {SDLK_6, 0, "angle-6"},                 {SDLK_7, 0, "angle-7"},              {SDLK_8, 0, "angle-8"},
      {SDLK_9, 0, "angle-9"},
  };
  return m;
}

const std::vector<KeyBinding>& rhapsodeKeymap() {
  // Premiere's map, changed where a frequent edit hides behind a chord or has no key at all:
  //   X razor every track at the playhead (Premiere: Ctrl+Shift+K)
  //   Backspace ripple delete (Premiere: Shift+Delete; Backspace there only lifts)
  //   G close the gap under the playhead (no Premiere default)
  //   Ctrl+Shift+Z and Ctrl+Y both redo
  static const std::vector<KeyBinding> m = [] {
    std::vector<KeyBinding> v;
    for (auto b : premiereKeymap()) {
      if (b.key == SDLK_BACKSPACE && b.mods == 0) b.action = "ripple-delete";
      v.push_back(b);
    }
    v.push_back({SDLK_X, 0, "razor-all"});
    v.push_back({SDLK_G, 0, "close-gap"});
    v.push_back({SDLK_Y, kCtrl, "redo"});
    return v;
  }();
  return m;
}

std::string actionFor(const std::vector<KeyBinding>& map, int key, int mods) {
  for (auto& b : map)
    if (b.key == key && b.mods == mods) return b.action;
  return "";
}

Err runAction(Session& s, const std::string& a) {
  const Rate r = s.rate();
  auto shuttleStep = [&](double dir) {
    if (s.shuttle * dir < 0 || s.shuttle == 0) s.shuttle = dir;
    else s.shuttle = std::clamp(s.shuttle * 2, -8.0, 8.0);
  };
  if (a == "play-pause") s.shuttle = s.shuttle != 0 ? 0 : 1;
  else if (a == "shuttle-back") shuttleStep(-1);
  else if (a == "shuttle-stop") s.shuttle = 0;
  else if (a == "shuttle-forward") shuttleStep(1);
  else if (a == "step-back") s.stepFrames(-1);
  else if (a == "step-forward") s.stepFrames(1);
  else if (a == "step-back-10") s.stepFrames(-10);
  else if (a == "step-forward-10") s.stepFrames(10);
  else if (a == "prev-edit") s.nextEdit(-1);
  else if (a == "next-edit") s.nextEdit(1);
  else if (a == "go-start") s.seek(0);
  else if (a == "go-end") s.seek(s.seq() ? s.seq()->duration() : 0);
  else if (a == "mark-in") s.markIn = s.playhead;
  else if (a == "mark-out") s.markOut = s.playhead + frameTicks(r);  // the out includes the frame under the playhead
  else if (a == "clear-marks") s.markIn = s.markOut = -1;
  else if (a == "go-in") {
    if (s.markIn >= 0) s.seek(s.markIn);
  } else if (a == "go-out") {
    if (s.markOut >= 0) s.seek(s.markOut - frameTicks(r));
  } else if (a == "insert" || a == "overwrite") {
    return s.status = "choose a clip in the bin";  // the UI calls placeMedia with its source
  } else if (a == "lift") return s.liftOrExtractMarks(false);
  else if (a == "extract") return s.liftOrExtractMarks(true);
  else if (a == "add-edit") return s.razorAtPlayhead(false);
  else if (a == "razor-all") return s.razorAtPlayhead(true);
  else if (a == "delete") return s.deleteSelection(false);
  else if (a == "ripple-delete") return s.deleteSelection(true);
  else if (a == "trim-head-to-playhead") return s.trimToPlayhead(Edge::Head);
  else if (a == "trim-tail-to-playhead") return s.trimToPlayhead(Edge::Tail);
  else if (a == "extend-edit") return s.extendEditToPlayhead();
  else if (a == "close-gap") return s.closeGapAtPlayhead();
  else if (a == "marker") return s.addMarker();
  else if (a == "undo") {
    if (!s.undo()) return s.status = "nothing to undo";
  } else if (a == "redo") {
    if (!s.redo()) return s.status = "nothing to redo";
  } else if (a == "save") return s.save();
  else if (a == "tool-select") s.tool = Tool::Select;
  else if (a == "tool-razor") s.tool = Tool::Razor;
  else if (a == "tool-ripple") s.tool = Tool::Ripple;
  else if (a == "tool-roll") s.tool = Tool::Roll;
  else if (a == "tool-slip") s.tool = Tool::Slip;
  else if (a == "tool-slide") s.tool = Tool::Slide;
  else if (a == "tool-hand") s.tool = Tool::Hand;
  else if (a == "nudge-left") return s.nudgeSelection(-1);
  else if (a == "nudge-right") return s.nudgeSelection(1);
  else if (a == "snap") s.snapping = !s.snapping;
  else if (a.rfind("angle-", 0) == 0) return s.switchAngle(std::stoi(a.substr(6)) - 1);
  else return s.status = "unknown action " + a;
  return {};
}

}  // namespace rhap
