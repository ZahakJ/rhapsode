#include "app.h"

#include <imgui_internal.h>
#include <misc/cpp/imgui_stdlib.h>

#include <algorithm>
#include <cmath>
#include <filesystem>

#include "engine/ai/analysis.h"
#include "engine/ai/sound.h"
#include "engine/ai/transcribe.h"
#include "engine/audio/mixer.h"
#include "engine/interchange/interchange.h"
#include "engine/io/project_io.h"
#include "engine/net/web.h"
#include <fstream>
#include <nlohmann/json.hpp>
#include <sys/stat.h>
#include "engine/render/export.h"

namespace rhap::app {

namespace fs = std::filesystem;

namespace {

const ImU32 kAccent = IM_COL32(255, 122, 89, 255);
const ImU32 kAccentDim = IM_COL32(255, 122, 89, 90);

ImU32 clipColour(const Clip& c, TrackKind k) {
  switch (c.kind) {
    case ClipKind::Title: return IM_COL32(150, 110, 210, 255);
    case ClipKind::Nested:
    case ClipKind::Multicam: return IM_COL32(220, 150, 70, 255);
    case ClipKind::Solid:
    case ClipKind::Shape: return IM_COL32(120, 120, 130, 255);
    default: return k == TrackKind::Video ? IM_COL32(70, 120, 190, 255) : IM_COL32(60, 150, 110, 255);
  }
}

std::string tc(const Session& s, Tick t) { return timecode(t, s.rate(), s.rate().den == 1001); }

int modsOf(SDL_Keymod m) {
  int r = 0;
  if (m & SDL_KMOD_CTRL) r |= kCtrl;
  if (m & SDL_KMOD_SHIFT) r |= kShift;
  if (m & SDL_KMOD_ALT) r |= kAlt;
  return r;
}

}  // namespace

App::App(SDL_Window* w, gfx::Gpu& gpu)
    : window_(w), gpu_(gpu), frames_(true, 8), renderer_(gpu, frames_), player_(s_) {
  loadWebSettings();
  auto use = SDL_GPU_TEXTUREUSAGE_COLOR_TARGET | SDL_GPU_TEXTUREUSAGE_SAMPLER;
  scopeSrc_ = gpu_.make(480, 270, SDL_GPU_TEXTUREFORMAT_R8G8B8A8_UNORM, use);
  waveTex_ = gpu_.make(480, 256, SDL_GPU_TEXTUREFORMAT_R8G8B8A8_UNORM, SDL_GPU_TEXTUREUSAGE_SAMPLER);
  paradeTex_ = gpu_.make(480 * 3, 256, SDL_GPU_TEXTUREFORMAT_R8G8B8A8_UNORM, SDL_GPU_TEXTUREUSAGE_SAMPLER);
  vecTex_ = gpu_.make(256, 256, SDL_GPU_TEXTUREFORMAT_R8G8B8A8_UNORM, SDL_GPU_TEXTUREUSAGE_SAMPLER);
  waveBind_ = {waveTex_.tex, gpu_.linear()};
  paradeBind_ = {paradeTex_.tex, gpu_.linear()};
  vecBind_ = {vecTex_.tex, gpu_.linear()};
}

App::~App() {
  for (auto* t : {&work_, &view_, &scopeSrc_, &waveTex_, &vecTex_, &paradeTex_}) gpu_.release(*t);
}

void App::requestQuit() {
  s_.autosave();
  quit_ = true;
}

void App::openPath(const std::string& path) {
  std::string ext = fs::path(path).extension().string();
  if (ext == ".rpro") {
    if (hasRecovery(path)) {
      recoveryFor_ = path;
      showRecovery_ = true;
    }
    s_.open(path);
  } else if (ext == ".otio" || ext == ".fcpxml" || ext == ".edl" || ext == ".xml") {
    Project p;
    std::string e = importProject(path, p);
    if (e.empty()) {
      s_ = Session(std::move(p));
      s_.status = "imported " + fs::path(path).filename().string();
    } else {
      s_.status = e;
    }
  } else {
    s_.importFiles({path});
    if (!s_.project.media.empty()) selectedMedia_ = s_.project.media.back().id;
  }
}

void SDLCALL App::onDialog(void* user, const char* const* files, int) {
  auto* a = static_cast<App*>(user);
  if (!files || !*files) return;
  DialogResult r;
  {
    std::lock_guard l(a->dialogMu_);
    r.tag = a->dialogTag_;
  }
  for (auto f = files; *f; ++f) r.files.push_back(*f);
  std::lock_guard l(a->dialogMu_);
  a->dialogResults_.push_back(std::move(r));
}

void App::pollDialogs() {
  std::vector<DialogResult> v;
  {
    std::lock_guard l(dialogMu_);
    v.swap(dialogResults_);
  }
  for (auto& r : v) {
    if (r.tag == "import") {
      s_.importFiles(r.files);
      if (!s_.project.media.empty()) selectedMedia_ = s_.project.media.back().id;
    } else if (r.tag == "open") {
      openPath(r.files[0]);
    } else if (r.tag == "save") {
      std::string p = r.files[0];
      if (fs::path(p).extension() != ".rpro") p += ".rpro";
      s_.save(p);
    } else if (r.tag == "export-timeline") {
      std::string e = exportProject(s_.project, r.files[0]);
      s_.status = e.empty() ? "wrote " + r.files[0] : e;
    } else if (r.tag == "lut") {
      std::string f = r.files[0];
      editClip("LUT", [&](Clip& c) { c.grade.lut = f; });
    } else if (r.tag == "export-path") {
      exportPath_ = r.files[0];
    }
  }
}

// ——— keys ———

void App::key(const SDL_KeyboardEvent& e) {
  if (ImGui::GetIO().WantTextInput) return;
  if (transcriptFocused_ && (e.key == SDLK_DELETE || e.key == SDLK_BACKSPACE)) return;
  int mods = modsOf(e.mod);
  const auto& map = premiereKeys_ ? premiereKeymap() : rhapsodeKeymap();
  std::string a = actionFor(map, int(e.key), mods);
  if (a.empty()) {
    if (e.key == SDLK_EQUALS || e.key == SDLK_KP_PLUS) pxPerSec_ = std::min(4000.0, pxPerSec_ * 1.25);
    if (e.key == SDLK_MINUS || e.key == SDLK_KP_MINUS) pxPerSec_ = std::max(2.0, pxPerSec_ / 1.25);
    if (e.key == SDLK_BACKSLASH && s_.seq()) {
      double w = std::max(200.0, ImGui::GetMainViewport()->Size.x - 300.0);
      pxPerSec_ = std::clamp(w / std::max(1.0, toSeconds(s_.seq()->duration())), 2.0, 4000.0);
      scroll_ = 0;
    }
    return;
  }
  if (a == "insert" || a == "overwrite") {
    if (selectedMedia_.empty()) {
      s_.status = "choose a clip in the bin";
      return;
    }
    s_.placeMedia(selectedMedia_, a == "insert");
    return;
  }
  if (a == "save" && s_.path.empty()) {
    dialogTag_ = "save";
    SDL_ShowSaveFileDialog(&App::onDialog, this, window_, nullptr, 0, nullptr);
    return;
  }
  Tick before = s_.playhead;
  runAction(s_, a);
  if (s_.playhead != before && a != "play-pause") player_.seeked();
}

// ——— frame ———

void App::frame(SDL_GPUCommandBuffer* cmd) {
  pollDialogs();
  for (auto& [mid, path] : jobs_.takeProxies())
    for (auto& m : s_.project.media)
      if (m.id == mid) {
        m.proxy = path;
        ++s_.revision;
      }
  for (auto& f : jobs_.takeApplies()) f();
  player_.tick();
  // autosave two seconds after the last change
  static auto lastChange = SDL_GetTicks();
  static uint64_t seenRev = 0;
  if (s_.revision != seenRev) {
    seenRev = s_.revision;
    lastChange = SDL_GetTicks();
  }
  if (s_.dirty() && SDL_GetTicks() - lastChange > 2000 && lastAutosave_ != s_.revision) {
    s_.autosave();
    lastAutosave_ = s_.revision;
  }

  ImGui::DockSpaceOverViewport(kDockId, ImGui::GetMainViewport());
  menu();
  viewer(cmd);
  timeline();
  bin();
  inspector();
  scopesPanel(cmd);
  mixerPanel();
  exportPanel();
  transcriptPanel();
  statusBar();
  if (showShortcuts_) shortcutsWindow();
  if (showRecovery_) recoveryModal();
  if (showWeb_) webModal();

  std::string title = "Rhapsode Pro — " + (s_.path.empty() ? std::string("untitled") : fs::path(s_.path).filename().string()) +
                      (s_.dirty() ? " •" : "");
  SDL_SetWindowTitle(window_, title.c_str());
}

void App::menu() {
  if (!ImGui::BeginMainMenuBar()) return;
  if (ImGui::BeginMenu("File")) {
    if (ImGui::MenuItem("New project")) s_ = Session();
    if (ImGui::MenuItem("Open…")) {
      dialogTag_ = "open";
      static const SDL_DialogFileFilter f[] = {{"Projects", "rpro;otio;fcpxml;edl;xml"}};
      SDL_ShowOpenFileDialog(&App::onDialog, this, window_, f, 1, nullptr, false);
    }
    if (ImGui::MenuItem("Save", "Ctrl+S")) {
      if (s_.path.empty()) {
        dialogTag_ = "save";
        SDL_ShowSaveFileDialog(&App::onDialog, this, window_, nullptr, 0, nullptr);
      } else {
        s_.save();
      }
    }
    if (ImGui::MenuItem("Save as…")) {
      dialogTag_ = "save";
      SDL_ShowSaveFileDialog(&App::onDialog, this, window_, nullptr, 0, nullptr);
    }
    if (ImGui::MenuItem("Open a quick-mode render…")) showWeb_ = true;
    ImGui::Separator();
    if (ImGui::MenuItem("Import media…", "Ctrl+I")) {
      dialogTag_ = "import";
      SDL_ShowOpenFileDialog(&App::onDialog, this, window_, nullptr, 0, nullptr, true);
    }
    if (ImGui::MenuItem("Export timeline (OTIO / FCPXML / EDL / XML)…")) {
      dialogTag_ = "export-timeline";
      static const SDL_DialogFileFilter f[] = {{"OpenTimelineIO", "otio"}, {"Final Cut Pro XML", "fcpxml"}, {"CMX 3600 EDL", "edl"}, {"Premiere / FCP7 XML", "xml"}};
      SDL_ShowSaveFileDialog(&App::onDialog, this, window_, f, 4, nullptr);
    }
    ImGui::Separator();
    if (ImGui::MenuItem("Quit", "Ctrl+Q")) requestQuit();
    ImGui::EndMenu();
  }
  if (ImGui::BeginMenu("Edit")) {
    if (ImGui::MenuItem("Undo", "Ctrl+Z", false, s_.history.canUndo())) s_.undo();
    if (ImGui::MenuItem("Redo", "Ctrl+Shift+Z", false, s_.history.canRedo())) s_.redo();
    ImGui::Separator();
    if (ImGui::MenuItem("Razor all tracks at playhead", premiereKeys_ ? "Ctrl+Shift+K" : "X")) s_.razorAtPlayhead(true);
    if (ImGui::MenuItem("Ripple delete", premiereKeys_ ? "Shift+Del" : "Backspace")) s_.deleteSelection(true);
    if (ImGui::MenuItem("Nest selection") && !s_.selection.empty()) {
      std::vector<std::string> ids(s_.selection.begin(), s_.selection.end());
      s_.apply("nest", [&](Editor& ed) { return ed.nest(ids); });
    }
    if (ImGui::MenuItem("Link selection") && s_.selection.size() > 1) {
      std::vector<std::string> ids(s_.selection.begin(), s_.selection.end());
      s_.apply("link", [&](Editor& ed) { return ed.link(ids); });
    }
    if (ImGui::MenuItem("Unlink") && !s_.selection.empty()) {
      std::string id = *s_.selection.begin();
      s_.apply("unlink", [&](Editor& ed) { return ed.unlink(id); });
    }
    if (ImGui::MenuItem("Add dissolve at nearest cut (V1)")) {
      s_.apply("dissolve", [&](Editor& ed) -> Err {
        Track& t = ed.seq().video[0];
        Tick best = -1, bd = 0;
        for (size_t i = 0; i + 1 < t.clips.size(); ++i)
          if (t.clips[i].end() == t.clips[i + 1].start) {
            Tick d = std::llabs(t.clips[i].end() - s_.playhead);
            if (best < 0 || d < bd) best = t.clips[i].end(), bd = d;
          }
        if (best < 0) return "no cut on V1";
        t.transitions.push_back(Transition{s_.project.makeId("x"), best, frameStart(30, s_.rate()), TransitionKind::Dissolve});
        return {};
      });
    }
    ImGui::EndMenu();
  }
  if (ImGui::BeginMenu("Sequence")) {
    if (ImGui::MenuItem("Add video track")) s_.apply("add track", [](Editor& ed) { return ed.addTrack(TrackKind::Video); });
    if (ImGui::MenuItem("Add audio track")) s_.apply("add track", [](Editor& ed) { return ed.addTrack(TrackKind::Audio); });
    if (ImGui::MenuItem("Add title at playhead")) {
      s_.apply("title", [&](Editor& ed) -> Err {
        Clip c;
        c.id = s_.project.makeId("c");
        c.kind = ClipKind::Title;
        c.name = "Title";
        c.text = "Title";
        c.start = s_.playhead;
        c.dur = 5 * kFlicks;
        c.style.size = ed.seq().height * 0.08;
        c.style.outlineWidth = c.style.size * 0.06;
        int top = int(ed.seq().video.size()) - 1;
        return ed.overwrite({TrackKind::Video, top}, c);
      });
    }
    if (ImGui::MenuItem("Normalise loudness to −14 LUFS")) {
      double now = audio::measureLoudness(s_.project, *s_.seq());
      if (now > -100)
        s_.apply("normalise", [&](Editor& ed) -> Err {
          for (auto& t : ed.seq().audio) t.gain = Param(t.gain.value + (-14 - now));
          return {};
        });
    }
    if (ImGui::MenuItem("Duck music (A2+) under dialogue (A1)")) {
      std::vector<int> music;
      for (int i = 1; i < int(s_.seq()->audio.size()); ++i) music.push_back(i);
      s_.apply("auto duck", [&](Editor& ed) -> Err {
        return audio::autoDuck(s_.project, ed.seq(), {0}, music) > 0 ? Err{} : Err{"no speech found on A1"};
      });
    }
    ImGui::EndMenu();
  }
  clipMenu();
  if (ImGui::BeginMenu("View")) {
    ImGui::MenuItem("Premiere keymap", nullptr, &premiereKeys_);
    if (ImGui::MenuItem("Use proxies", nullptr, &proxies_)) frames_.setProxies(proxies_);
    ImGui::MenuItem("Keyboard shortcuts", "?", &showShortcuts_);
    ImGui::EndMenu();
  }
  ImGui::EndMainMenuBar();
}

void App::statusBar() {
  ImGuiViewport* vp = ImGui::GetMainViewport();
  ImGui::SetNextWindowPos(ImVec2(vp->Pos.x, vp->Pos.y + vp->Size.y - 24));
  ImGui::SetNextWindowSize(ImVec2(vp->Size.x, 24));
  ImGui::Begin("##status", nullptr,
               ImGuiWindowFlags_NoDecoration | ImGuiWindowFlags_NoDocking | ImGuiWindowFlags_NoSavedSettings |
                   ImGuiWindowFlags_NoFocusOnAppearing | ImGuiWindowFlags_NoNav);
  const char* tools[] = {"Select", "Razor", "Ripple", "Roll", "Slip", "Slide", "Hand"};
  ImGui::Text("%s  ·  %s  ·  %s keys  ·  %s  ·  render %.1f ms  ·  %s", tools[int(s_.tool)], s_.snapping ? "snap" : "no snap",
              premiereKeys_ ? "Premiere" : "Rhapsode", nvdecAvailable() ? "NVDEC" : "software decode", renderMs_,
              s_.status.c_str());
  ImGui::End();
}

// ——— viewer ———

void App::viewer(SDL_GPUCommandBuffer* cmd) {
  ImGui::Begin("Program");
  const Sequence* s = s_.seq();
  if (s) {
    ImVec2 avail = ImGui::GetContentRegionAvail();
    avail.y -= 34;
    double aspect = double(s->width) / s->height;
    float w = avail.x, h = float(avail.x / aspect);
    if (h > avail.y) h = avail.y, w = float(avail.y * aspect);
    w = std::max(w, 16.f);
    h = std::max(h, 9.f);
    // the viewer renders at the panel's pixel size (never above the sequence's)
    float dpi = ImGui::GetIO().DisplayFramebufferScale.x;
    int vw = std::min(s->width, std::max(16, int(w * dpi))) & ~1, vh = std::min(s->height, std::max(16, int(h * dpi))) & ~1;
    if (!view_ || view_.w != vw || view_.h != vh) {
      gpu_.ensure(view_, vw, vh, SDL_GPU_TEXTUREFORMAT_R8G8B8A8_UNORM, SDL_GPU_TEXTUREUSAGE_COLOR_TARGET | SDL_GPU_TEXTUREUSAGE_SAMPLER);
      renderedAt_ = -1;
    }
    Tick at = frameStart(frameAt(s_.playhead, s->rate), s->rate);
    if (at != renderedAt_ || s_.revision != renderedRev_ || proxies_ != renderedProxies_) {
      Uint64 t0 = SDL_GetPerformanceCounter();
      renderer_.render(cmd, s_.project, *s, at, work_);
      renderer_.output(cmd, work_, view_, s_.project, s->background);
      renderMs_ = double(SDL_GetPerformanceCounter() - t0) * 1000.0 / double(SDL_GetPerformanceFrequency());
      renderedAt_ = at;
      renderedRev_ = s_.revision;
      renderedProxies_ = proxies_;
      if (scopeCountdown_ <= 0) scopeCountdown_ = 1;  // measure the new frame
    }
    viewBind_ = {view_.tex, gpu_.linear()};
    ImVec2 cur = ImGui::GetCursorPos();
    ImGui::SetCursorPos(ImVec2(cur.x + (avail.x - w) / 2, cur.y + (avail.y - h) / 2));
    ImGui::Image(ImTextureID(&viewBind_), ImVec2(w, h));
    ImGui::SetCursorPos(ImVec2(cur.x, cur.y + avail.y + 4));
    ImGui::Text("%s", tc(s_, s_.playhead).c_str());
    ImGui::SameLine();
    ImGui::TextDisabled("/ %s", tc(s_, s->duration()).c_str());
    ImGui::SameLine(0, 24);
    if (ImGui::Button("|<")) runAction(s_, "go-start"), player_.seeked();
    ImGui::SameLine();
    if (ImGui::Button("<|")) runAction(s_, "step-back");
    ImGui::SameLine();
    if (ImGui::Button(s_.shuttle != 0 ? "Pause" : "Play")) runAction(s_, "play-pause");
    ImGui::SameLine();
    if (ImGui::Button("|>")) runAction(s_, "step-forward");
    ImGui::SameLine();
    if (ImGui::Button(">|")) runAction(s_, "go-end"), player_.seeked();
    ImGui::SameLine(0, 24);
    if (s_.shuttle != 0 && s_.shuttle != 1) ImGui::TextColored(ImVec4(1, 0.48f, 0.35f, 1), "%+.0f×", s_.shuttle);
    ImGui::SameLine();
    if (s_.markIn >= 0 || s_.markOut >= 0)
      ImGui::TextDisabled("in %s  out %s", s_.markIn >= 0 ? tc(s_, s_.markIn).c_str() : "--",
                          s_.markOut >= 0 ? tc(s_, s_.markOut).c_str() : "--");
  }
  ImGui::End();
}

// ——— timeline ———

void App::timeline() {
  ImGui::Begin("Timeline", nullptr, ImGuiWindowFlags_NoScrollbar | ImGuiWindowFlags_NoScrollWithMouse);
  Sequence* s = s_.seq();
  if (!s) {
    ImGui::End();
    return;
  }
  ImDrawList* dl = ImGui::GetWindowDrawList();
  ImVec2 origin = ImGui::GetCursorScreenPos();
  ImVec2 size = ImGui::GetContentRegionAvail();
  const float header = 120, ruler = 26, vh = 50, ah = 40;
  const float x0 = origin.x + header;
  auto xOf = [&](Tick t) { return float(x0 + (toSeconds(t) - scroll_) * pxPerSec_); };
  auto tOf = [&](float x) { return fromSeconds(scroll_ + (x - x0) / pxPerSec_); };
  // rows: video top (highest first), then audio
  struct Row {
    TrackRef ref;
    float y, h;
  };
  std::vector<Row> rows;
  float y = origin.y + ruler;
  for (int i = int(s->video.size()) - 1; i >= 0; --i) rows.push_back({{TrackKind::Video, i}, y, vh}), y += vh + 2;
  y += 6;
  for (int i = 0; i < int(s->audio.size()); ++i) rows.push_back({{TrackKind::Audio, i}, y, ah}), y += ah + 2;
  auto rowAt = [&](float my) -> const Row* {
    for (auto& r : rows)
      if (my >= r.y && my < r.y + r.h) return &r;
    return nullptr;
  };

  ImGui::InvisibleButton("##timeline", ImVec2(std::max(size.x, 10.f), std::max(size.y, 10.f)),
                         ImGuiButtonFlags_MouseButtonLeft | ImGuiButtonFlags_MouseButtonRight);
  bool hovered = ImGui::IsItemHovered();
  ImVec2 mouse = ImGui::GetIO().MousePos;
  // wheel: zoom with ctrl, scroll otherwise
  if (hovered) {
    float wh = ImGui::GetIO().MouseWheel, whx = ImGui::GetIO().MouseWheelH;
    if (ImGui::GetIO().KeyCtrl && wh != 0) {
      double at = scroll_ + (mouse.x - x0) / pxPerSec_;
      pxPerSec_ = std::clamp(pxPerSec_ * (wh > 0 ? 1.2 : 1 / 1.2), 2.0, 4000.0);
      scroll_ = std::max(0.0, at - (mouse.x - x0) / pxPerSec_);
    } else if (wh != 0 || whx != 0) {
      scroll_ = std::max(0.0, scroll_ - (whx != 0 ? whx : wh) * 80 / pxPerSec_);
    }
  }
  // keep the playhead in view while playing
  if (s_.shuttle != 0) {
    float px = xOf(s_.playhead);
    if (px > origin.x + size.x - 40 || px < x0) scroll_ = std::max(0.0, toSeconds(s_.playhead) - 0.1 * (size.x - header) / pxPerSec_);
  }

  // snapping targets
  std::vector<Tick> snaps = s_.editPoints();
  snaps.push_back(s_.playhead);
  for (auto& m : s->markers) snaps.push_back(m.t);
  auto snap = [&](Tick t, const std::string& ignore) {
    if (!s_.snapping) return t;
    float best = 8;
    Tick out = t;
    for (Tick c : snaps) {
      (void)ignore;
      float d = std::fabs(xOf(c) - xOf(t));
      if (d < best) best = d, out = c;
    }
    return out;
  };

  dl->PushClipRect(origin, ImVec2(origin.x + size.x, origin.y + size.y), true);
  dl->AddRectFilled(origin, ImVec2(origin.x + size.x, origin.y + size.y), IM_COL32(18, 18, 22, 255));
  // ruler
  dl->AddRectFilled(ImVec2(x0, origin.y), ImVec2(origin.x + size.x, origin.y + ruler), IM_COL32(28, 28, 34, 255));
  double step = 1;
  for (double cand : {1.0 / s->rate.fps(), 0.1, 0.5, 1.0, 2.0, 5.0, 10.0, 30.0, 60.0, 300.0, 600.0})
    if (cand * pxPerSec_ >= 70) {
      step = cand;
      break;
    }
  for (double t = std::floor(scroll_ / step) * step; xOf(fromSeconds(t)) < origin.x + size.x; t += step) {
    float x = xOf(fromSeconds(t));
    if (x < x0) continue;
    dl->AddLine(ImVec2(x, origin.y + ruler - 8), ImVec2(x, origin.y + ruler), IM_COL32(120, 120, 130, 255));
    dl->AddText(ImVec2(x + 3, origin.y + 2), IM_COL32(150, 150, 160, 255), tc(s_, fromSeconds(t)).c_str());
  }
  if (s_.markIn >= 0 && s_.markOut > s_.markIn)
    dl->AddRectFilled(ImVec2(xOf(s_.markIn), origin.y), ImVec2(xOf(s_.markOut), origin.y + ruler), kAccentDim);
  for (auto& m : s->markers) {
    float x = xOf(m.t);
    dl->AddTriangleFilled(ImVec2(x - 5, origin.y + ruler - 10), ImVec2(x + 5, origin.y + ruler - 10), ImVec2(x, origin.y + ruler - 2),
                          IM_COL32(240, 200, 80, 255));
  }

  // tracks
  for (auto& r : rows) {
    Track& t = *trackOf(*s, r.ref);
    bool target = r.ref == s_.targetVideo || r.ref == s_.targetAudio;
    dl->AddRectFilled(ImVec2(origin.x, r.y), ImVec2(origin.x + header - 4, r.y + r.h),
                      target ? IM_COL32(60, 40, 36, 255) : IM_COL32(30, 30, 36, 255));
    dl->AddRectFilled(ImVec2(x0, r.y), ImVec2(origin.x + size.x, r.y + r.h), IM_COL32(24, 24, 29, 255));
    std::string label = t.name + (t.locked ? "  L" : "") + (t.mute ? "  M" : "") + (t.solo ? "  S" : "") + (t.hidden ? "  H" : "");
    dl->AddText(ImVec2(origin.x + 8, r.y + 6), target ? kAccent : IM_COL32(200, 200, 205, 255), label.c_str());
    for (size_t ci = 0; ci < t.clips.size(); ++ci) {
      const Clip& c = t.clips[ci];
      Tick start = c.start;
      int rowShift = 0;
      if (drag_.kind == Drag::Move && drag_.moved) {
        // the dragged clip and its links follow the mouse
        const Clip* dc = clipById(*s, drag_.clip);
        bool group = c.id == drag_.clip || (dc && !dc->link.empty() && dc->link == c.link);
        if (group) start += drag_.delta, rowShift = c.id == drag_.clip || r.ref.kind == drag_.track.kind ? drag_.trackDelta : 0;
      }
      float cx0 = xOf(start), cx1 = xOf(start + c.dur);
      if (drag_.moved && c.id == drag_.clip && drag_.kind == Drag::TrimHead) cx0 = xOf(c.start + drag_.delta);
      if (drag_.moved && c.id == drag_.clip && drag_.kind == Drag::TrimTail) cx1 = xOf(c.end() + drag_.delta);
      if (cx1 < x0 || cx0 > origin.x + size.x) continue;
      float ry = r.y;
      if (rowShift != 0) {
        TrackRef nr = r.ref;
        nr.index += rowShift;
        for (auto& o : rows)
          if (o.ref == nr) ry = o.y;
      }
      ImU32 col = clipColour(c, r.ref.kind);
      if (!c.enabled) col = IM_COL32(70, 70, 75, 255);
      dl->AddRectFilled(ImVec2(std::max(cx0, x0), ry + 2), ImVec2(cx1, ry + r.h - 2), col, 3);
      if (s_.selection.count(c.id)) dl->AddRect(ImVec2(std::max(cx0, x0), ry + 2), ImVec2(cx1, ry + r.h - 2), kAccent, 3, 0, 2);
      std::string name = c.kind == ClipKind::Title ? "T  " + c.text.substr(0, c.text.find('\n')) : c.name;
      if (c.speed != 1) name += "  " + std::to_string(int(std::lround(c.speed * 100))) + "%";
      dl->PushClipRect(ImVec2(std::max(cx0, x0), ry), ImVec2(cx1, ry + r.h), true);
      dl->AddText(ImVec2(std::max(cx0, x0) + 4, ry + 5), IM_COL32(240, 240, 245, 255), name.c_str());
      // gain line on sound clips
      if (r.ref.kind == TrackKind::Audio && c.gain.animated()) {
        for (float px = std::max(cx0, x0); px < cx1; px += 3) {
          double g = c.gain.at(tOf(px) - c.start);
          float gy = ry + r.h - 4 - float(std::clamp((g + 30) / 42, 0.0, 1.0)) * (r.h - 8);
          dl->AddRectFilled(ImVec2(px, gy), ImVec2(px + 2, gy + 2), IM_COL32(255, 230, 120, 220));
        }
      }
      dl->PopClipRect();
    }
    for (auto& x : t.transitions) {
      float a = xOf(x.at - x.dur / 2), b = xOf(x.at + x.dur - x.dur / 2);
      dl->AddRectFilled(ImVec2(a, r.y + r.h - 12), ImVec2(b, r.y + r.h - 2), IM_COL32(255, 255, 255, 60));
      dl->AddLine(ImVec2(a, r.y + r.h - 2), ImVec2(b, r.y + r.h - 12), IM_COL32(255, 255, 255, 160));
    }
  }
  // playhead
  float px = xOf(s_.playhead);
  dl->AddLine(ImVec2(px, origin.y), ImVec2(px, origin.y + size.y), kAccent, 2);
  dl->AddTriangleFilled(ImVec2(px - 6, origin.y), ImVec2(px + 6, origin.y), ImVec2(px, origin.y + 9), kAccent);
  if (drag_.moved && (drag_.kind == Drag::Move || drag_.kind == Drag::TrimHead || drag_.kind == Drag::TrimTail)) {
    std::string d = (drag_.delta >= 0 ? "+" : "-") + tc(s_, std::llabs(drag_.delta));
    dl->AddText(ImVec2(mouse.x + 12, mouse.y - 18), kAccent, d.c_str());
  }
  dl->PopClipRect();

  // ——— interaction ———
  const Row* row = rowAt(mouse.y);
  Tick mt = std::max<Tick>(0, tOf(mouse.x));
  if (hovered && ImGui::IsMouseClicked(ImGuiMouseButton_Left)) {
    drag_ = {};
    drag_.grabX = mouse.x;
    drag_.grabY = mouse.y;
    if (mouse.y < origin.y + ruler || s_.tool == Tool::Hand) {
      drag_.kind = Drag::Scrub;
      s_.seek(mt);
      player_.seeked();
    } else if (mouse.x < x0 && row) {
      // header: click targets, ctrl mutes / hides, shift solos, alt locks
      Track& t = *trackOf(*s, row->ref);
      auto& io = ImGui::GetIO();
      if (io.KeyCtrl) (row->ref.kind == TrackKind::Audio ? t.mute : t.hidden) ^= true, ++s_.revision;
      else if (io.KeyShift && row->ref.kind == TrackKind::Audio) t.solo ^= true, ++s_.revision;
      else if (io.KeyAlt) t.locked ^= true, ++s_.revision;
      else (row->ref.kind == TrackKind::Video ? s_.targetVideo : s_.targetAudio) = row->ref;
    } else if (row) {
      const Clip* c = s_.clipAt(row->ref, mt);
      if (s_.tool == Tool::Razor) {
        TrackRef r = row->ref;
        Tick at = snap(mt, "");
        if (ImGui::GetIO().KeyShift) s_.apply("razor all", [&](Editor& ed) { return ed.razorAll(at); });
        else s_.apply("razor", [&](Editor& ed) { return ed.razor(r, at); });
      } else if (c) {
        if (!s_.selection.count(c->id)) s_.selectAt(row->ref, mt, ImGui::GetIO().KeyShift);
        drag_.clip = c->id;
        drag_.track = row->ref;
        drag_.origStart = c->start;
        float edgeL = std::fabs(mouse.x - xOf(c->start)), edgeR = std::fabs(mouse.x - xOf(c->end()));
        if (s_.tool == Tool::Slip) drag_.kind = Drag::Slip;
        else if (s_.tool == Tool::Slide) drag_.kind = Drag::Slide;
        else if (edgeL < 7) drag_.kind = Drag::TrimHead;
        else if (edgeR < 7) drag_.kind = Drag::TrimTail;
        else drag_.kind = Drag::Move;
      } else {
        s_.selection.clear();
        drag_.kind = Drag::Scrub;
        s_.seek(mt);
        player_.seeked();
      }
    }
  }
  if (drag_.kind != Drag::None && ImGui::IsMouseDown(ImGuiMouseButton_Left)) {
    if (std::fabs(mouse.x - drag_.grabX) > 3 || std::fabs(mouse.y - drag_.grabY) > 3) drag_.moved = true;
    Tick raw = fromSeconds((mouse.x - drag_.grabX) / pxPerSec_);
    if (drag_.kind == Drag::Scrub) {
      s_.seek(mt);
      player_.seeked();
    } else if (const Clip* c = clipById(*s, drag_.clip)) {
      Tick edge = drag_.kind == Drag::TrimTail ? c->end() : c->start;
      Tick moved = snap(edge + raw, drag_.clip);
      if (drag_.kind == Drag::Move && s_.snapping) {
        // the tail may snap too
        Tick tail = snap(c->end() + raw, drag_.clip);
        if (tail != c->end() + raw && moved == edge + raw) moved = tail - c->dur;
      }
      drag_.delta = snapFrame(moved - edge, s->rate);
      if (drag_.kind == Drag::Move && row) drag_.trackDelta = row->ref.kind == drag_.track.kind ? row->ref.index - drag_.track.index : 0;
    }
  }
  if (drag_.kind != Drag::None && ImGui::IsMouseReleased(ImGuiMouseButton_Left)) {
    Drag d = drag_;
    drag_ = {};
    if (d.moved && !d.clip.empty() && (d.delta != 0 || d.trackDelta != 0)) {
      bool ripple = s_.tool == Tool::Ripple, roll = s_.tool == Tool::Roll;
      switch (d.kind) {
        case Drag::Move: {
          TrackRef dst = d.track;
          dst.index += d.trackDelta;
          s_.apply("move", [&](Editor& ed) { return ed.move(d.clip, dst, std::max<Tick>(0, d.origStart + d.delta)); });
          break;
        }
        case Drag::TrimHead:
          if (roll) {
            // the cut before this clip: roll the previous clip's tail
            ClipLoc l = findClip(*s, d.clip);
            const Track& t = *trackOf(*s, l.track);
            if (l.index > 0) {
              std::string prev = t.clips[size_t(l.index - 1)].id;
              s_.apply("roll", [&](Editor& ed) { return ed.rollTrim(prev, d.delta); });
            }
          } else {
            s_.apply(ripple ? "ripple trim" : "trim", [&](Editor& ed) {
              return ripple ? ed.rippleTrim(d.clip, Edge::Head, d.delta) : ed.trim(d.clip, Edge::Head, d.delta);
            });
          }
          break;
        case Drag::TrimTail:
          s_.apply(roll ? "roll" : ripple ? "ripple trim" : "trim", [&](Editor& ed) {
            return roll ? ed.rollTrim(d.clip, d.delta) : ripple ? ed.rippleTrim(d.clip, Edge::Tail, d.delta) : ed.trim(d.clip, Edge::Tail, d.delta);
          });
          break;
        case Drag::Slip: s_.apply("slip", [&](Editor& ed) { return ed.slip(d.clip, -d.delta); }); break;
        case Drag::Slide: s_.apply("slide", [&](Editor& ed) { return ed.slide(d.clip, d.delta); }); break;
        default: break;
      }
    }
  }
  // drop from the bin: overwrite (ctrl: insert) where it lands
  if (ImGui::BeginDragDropTarget()) {
    if (const ImGuiPayload* pl = ImGui::AcceptDragDropPayload("RHAP_MEDIA")) {
      std::string id(static_cast<const char*>(pl->Data), size_t(pl->DataSize));
      if (row) {
        (row->ref.kind == TrackKind::Video ? s_.targetVideo : s_.targetAudio) = row->ref;
        s_.playhead = snap(mt, "");
      }
      s_.placeMedia(id, ImGui::GetIO().KeyCtrl);
    }
    ImGui::EndDragDropTarget();
  }
  // right click: the clip menu
  if (hovered && ImGui::IsMouseClicked(ImGuiMouseButton_Right) && row) {
    if (const Clip* c = s_.clipAt(row->ref, mt)) {
      if (!s_.selection.count(c->id)) s_.selectAt(row->ref, mt, false);
      ImGui::OpenPopup("clipmenu");
    }
  }
  if (ImGui::BeginPopup("clipmenu")) {
    std::string id = s_.selection.empty() ? "" : *s_.selection.begin();
    if (ImGui::MenuItem("Ripple delete")) s_.deleteSelection(true);
    if (ImGui::MenuItem("Delete")) s_.deleteSelection(false);
    if (ImGui::MenuItem("Enable / disable"))
      editClip("enable", [](Clip& c) { c.enabled = !c.enabled; });
    if (ImGui::BeginMenu("Speed")) {
      for (double sp : {0.25, 0.5, 1.0, 1.5, 2.0, 4.0, -1.0})
        if (ImGui::MenuItem((sp < 0 ? std::string("Reverse") : std::to_string(int(sp * 100)) + "%").c_str()))
          s_.apply("speed", [&](Editor& ed) { return ed.setSpeed(id, sp, true); });
      ImGui::EndMenu();
    }
    if (ImGui::MenuItem("Nest")) {
      std::vector<std::string> ids(s_.selection.begin(), s_.selection.end());
      s_.apply("nest", [&](Editor& ed) { return ed.nest(ids); });
    }
    if (ImGui::MenuItem("Unlink")) s_.apply("unlink", [&](Editor& ed) { return ed.unlink(id); });
    ImGui::EndPopup();
  }
  ImGui::End();
}

// ——— bin ———

void App::bin() {
  ImGui::Begin("Media");
  if (ImGui::Button("Import…")) {
    dialogTag_ = "import";
    SDL_ShowOpenFileDialog(&App::onDialog, this, window_, nullptr, 0, nullptr, true);
  }
  ImGui::SameLine();
  if (ImGui::Button("Make proxies")) makeProxies();
  ImGui::SameLine();
  ImGui::BeginDisabled(selectedMedia_.empty());
  if (ImGui::Button("Insert ,")) s_.placeMedia(selectedMedia_, true);
  ImGui::SameLine();
  if (ImGui::Button("Overwrite .")) s_.placeMedia(selectedMedia_, false);
  ImGui::EndDisabled();
  if (ImGui::BeginTable("bin", 5, ImGuiTableFlags_RowBg | ImGuiTableFlags_Resizable | ImGuiTableFlags_ScrollY)) {
    ImGui::TableSetupColumn("Name");
    ImGui::TableSetupColumn("Length");
    ImGui::TableSetupColumn("Format");
    ImGui::TableSetupColumn("Rate");
    ImGui::TableSetupColumn("Proxy");
    ImGui::TableHeadersRow();
    for (auto& m : s_.project.media) {
      ImGui::TableNextRow();
      ImGui::TableNextColumn();
      bool sel = selectedMedia_ == m.id;
      if (ImGui::Selectable(m.name.c_str(), sel, ImGuiSelectableFlags_SpanAllColumns)) selectedMedia_ = m.id;
      if (ImGui::BeginDragDropSource()) {
        ImGui::SetDragDropPayload("RHAP_MEDIA", m.id.data(), m.id.size());
        ImGui::Text("%s", m.name.c_str());
        ImGui::EndDragDropSource();
      }
      ImGui::TableNextColumn();
      ImGui::TextUnformatted(m.kind == MediaKind::Image ? "still" : tc(s_, m.duration).c_str());
      ImGui::TableNextColumn();
      if (m.hasVideo)
        ImGui::Text("%dx%d %s%s", m.width, m.height, m.videoCodec.c_str(), m.color.bitDepth > 8 ? " 10-bit" : "");
      else
        ImGui::Text("%s %d ch", m.audioCodec.c_str(), m.channels);
      ImGui::TableNextColumn();
      if (m.hasVideo && m.kind == MediaKind::Video) ImGui::Text("%.3g%s", m.rate.fps(), m.vfr ? " VFR" : "");
      ImGui::TableNextColumn();
      ImGui::TextUnformatted(m.proxy.empty() ? "" : "yes");
    }
    ImGui::EndTable();
  }
  ImGui::End();
}

void App::makeProxies() {
  std::string dir = s_.path.empty() ? (fs::temp_directory_path() / "rhapsode-proxies").string()
                                    : (fs::path(s_.path).parent_path() / "Proxies").string();
  std::error_code ec;
  fs::create_directories(dir, ec);
  int n = 0;
  for (auto& m : s_.project.media) {
    if (m.kind != MediaKind::Video || !m.hasVideo || !m.proxy.empty()) continue;
    std::string out = dir + "/" + fs::path(m.path).stem().string() + "-" + m.id + "-proxy.mp4";
    // a half-size, all-intra H.264 proxy: every frame is a keyframe, so scrubbing never decodes a GOP
    int w = std::max(2, (m.width / 2) & ~1);
    Job j;
    j.kind = Job::Kind::Proxy;
    j.title = "proxy · " + m.name;
    j.output = out;
    j.mediaId = m.id;
    j.argv = {"ffmpeg", "-nostdin", "-y", "-loglevel", "error", "-progress", "pipe:1", "-i", m.path, "-map", "0:v:0", "-map", "0:a?",
              "-vf", "scale=" + std::to_string(w) + ":-2", "-c:v", "h264_nvenc", "-g", "1", "-preset", "p4", "-cq", "23",
              "-c:a", "aac", "-b:a", "128k", out};
    j.duration = toSeconds(m.duration);
    jobs_.add(j);
    ++n;
  }
  s_.status = std::to_string(n) + " proxies queued";
}

// ——— inspector ———

void App::editClip(const char* label, const std::function<void(Clip&)>& f) {
  if (s_.selection.empty() || !s_.seq()) return;
  Clip* c = clipById(*s_.seq(), *s_.selection.begin());
  if (!c) return;
  if (!editing_) s_.history.push(s_.project, label);
  f(*c);
  ++s_.revision;
}

bool App::paramRow(const char* label, Param& p, Tick local, float speed, float lo, float hi, const char* fmt) {
  ImGui::PushID(label);
  bool keyed = p.animated();
  bool onKey = false;
  for (auto& k : p.keys)
    if (std::llabs(k.t - local) < frameTicks(s_.rate()) / 2) onKey = true;
  ImGui::PushStyleColor(ImGuiCol_Text, keyed ? ImVec4(1, 0.48f, 0.35f, 1) : ImVec4(0.6f, 0.6f, 0.65f, 1));
  bool toggled = ImGui::SmallButton(onKey ? "◆" : "◇");
  ImGui::PopStyleColor();
  if (ImGui::IsItemHovered()) ImGui::SetTooltip("Add or remove a keyframe at the playhead");
  ImGui::SameLine();
  float v = float(p.at(local));
  ImGui::SetNextItemWidth(-90);
  bool changed = ImGui::DragFloat(label, &v, speed, lo, hi, fmt);
  bool active = ImGui::IsItemActive();
  ImGui::PopID();
  if (toggled) {
    editClip("keyframe", [&](Clip&) {
      if (onKey) std::erase_if(p.keys, [&](const Keyframe& k) { return std::llabs(k.t - local) < frameTicks(s_.rate()) / 2; });
      else p.setKey(local, p.at(local), Ease::InOut);
    });
  }
  if (changed) {
    editClip(label, [&](Clip&) {
      if (p.animated()) p.setKey(local, v, Ease::InOut);
      else p.value = v;
    });
    editing_ = active;
  }
  if (!active && editing_ && ImGui::IsItemDeactivated()) editing_ = false;
  return changed;
}

void App::inspector() {
  ImGui::Begin("Inspector");
  Sequence* s = s_.seq();
  Clip* c = s && !s_.selection.empty() ? clipById(*s, *s_.selection.begin()) : nullptr;
  if (!c) {
    if (s) {
      ImGui::TextDisabled("Sequence");
      ImGui::Text("%s  %dx%d  %.3g fps  %d Hz", s->name.c_str(), s->width, s->height, s->rate.fps(), s->sampleRate);
      const char* ws[] = {"Rec.709", "ACEScct", "Rec.2020"};
      const char* os[] = {"Rec.709", "sRGB", "Rec.2020 PQ", "Rec.2020 HLG"};
      int w = int(s_.project.working), o = int(s_.project.output);
      if (ImGui::Combo("Working space", &w, ws, 3)) s_.project.working = WorkingSpace(w), ++s_.revision;
      if (ImGui::Combo("Output", &o, os, 4)) s_.project.output = OutputSpace(o), ++s_.revision;
      ImGui::TextDisabled("Select a clip to edit it.");
    }
    ImGui::End();
    return;
  }
  // keyframes are clip-local
  Tick local = std::clamp<Tick>(s_.playhead - c->start, 0, c->dur);
  if (!ImGui::IsAnyItemActive()) editing_ = false;
  ImGui::Text("%s", c->name.c_str());
  ImGui::TextDisabled("%s → %s   in %s", tc(s_, c->start).c_str(), tc(s_, c->end()).c_str(), tc(s_, c->in).c_str());
  bool isPicture = c->kind != ClipKind::Media || (s_.project.findMedia(c->ref) && s_.project.findMedia(c->ref)->hasVideo);
  ClipLoc loc = findClip(*s, c->id);
  bool onVideo = loc.track.kind == TrackKind::Video;
  if (c->kind == ClipKind::Title && ImGui::CollapsingHeader("Text", ImGuiTreeNodeFlags_DefaultOpen)) {
    std::string text = c->text;
    if (ImGui::InputTextMultiline("##text", &text, ImVec2(-1, 70))) editClip("text", [&](Clip& k) { k.text = text; });
    float size = float(c->style.size), ow = float(c->style.outlineWidth);
    if (ImGui::DragFloat("Size", &size, 0.5f, 6, 600)) editClip("text size", [&](Clip& k) { k.style.size = size; });
    if (ImGui::DragFloat("Outline", &ow, 0.1f, 0, 40)) editClip("outline", [&](Clip& k) { k.style.outlineWidth = ow; });
    float col[4] = {float(c->style.color[0]), float(c->style.color[1]), float(c->style.color[2]), float(c->style.color[3])};
    if (ImGui::ColorEdit4("Colour", col)) editClip("colour", [&](Clip& k) { k.style.color = {col[0], col[1], col[2], col[3]}; });
    float box[4] = {float(c->style.box[0]), float(c->style.box[1]), float(c->style.box[2]), float(c->style.box[3])};
    if (ImGui::ColorEdit4("Box", box)) editClip("box", [&](Clip& k) { k.style.box = {box[0], box[1], box[2], box[3]}; });
    const char* fonts[] = {"Anton", "Plex"};
    int f = c->style.font == "Anton" ? 0 : 1;
    if (ImGui::Combo("Face", &f, fonts, 2)) editClip("face", [&](Clip& k) { k.style.font = fonts[f]; });
  }
  if (onVideo && isPicture && ImGui::CollapsingHeader("Motion", ImGuiTreeNodeFlags_DefaultOpen)) {
    paramRow("Position X", c->xf.x, local, 1, -10000, 10000, "%.1f px");
    paramRow("Position Y", c->xf.y, local, 1, -10000, 10000, "%.1f px");
    paramRow("Scale", c->xf.scale, local, 0.005f, 0.01f, 20, "%.3f");
    paramRow("Rotation", c->xf.rotation, local, 0.2f, -3600, 3600, "%.1f°");
    paramRow("Opacity", c->xf.opacity, local, 0.005f, 0, 1, "%.2f");
    paramRow("Crop left", c->xf.cropL, local, 0.002f, 0, 1, "%.3f");
    paramRow("Crop right", c->xf.cropR, local, 0.002f, 0, 1, "%.3f");
    paramRow("Crop top", c->xf.cropT, local, 0.002f, 0, 1, "%.3f");
    paramRow("Crop bottom", c->xf.cropB, local, 0.002f, 0, 1, "%.3f");
    const char* blends[] = {"Normal", "Add", "Multiply", "Screen"};
    int b = std::min(int(c->blend), 3);
    if (ImGui::Combo("Blend", &b, blends, 4)) editClip("blend", [&](Clip& k) { k.blend = Blend(b); });
  }
  if (onVideo && isPicture && ImGui::CollapsingHeader("Colour", ImGuiTreeNodeFlags_DefaultOpen)) {
    Grade g = c->grade;
    bool ch = false;
    auto trio = [&](const char* name, std::array<double, 3>& v, float sp, float lo, float hi) {
      float f[3] = {float(v[0]), float(v[1]), float(v[2])};
      if (ImGui::DragFloat3(name, f, sp, lo, hi, "%.3f")) {
        v = {f[0], f[1], f[2]};
        ch = true;
      }
      if (ImGui::IsItemActive()) editing_ = true;
    };
    trio("Lift", g.lift, 0.002f, -1, 1);
    trio("Gamma", g.gamma, 0.002f, 0.1f, 4);
    trio("Gain", g.gain, 0.002f, 0, 4);
    trio("Offset", g.offset, 0.001f, -1, 1);
    auto one = [&](const char* name, double& v, float sp, float lo, float hi) {
      float f = float(v);
      if (ImGui::DragFloat(name, &f, sp, lo, hi, "%.3f")) v = f, ch = true;
      if (ImGui::IsItemActive()) editing_ = true;
    };
    one("Exposure", g.exposure, 0.01f, -6, 6);
    one("Contrast", g.contrast, 0.005f, 0, 3);
    one("Pivot", g.pivot, 0.002f, 0, 1);
    one("Saturation", g.saturation, 0.005f, 0, 3);
    one("Temperature", g.temperature, 0.005f, -1, 1);
    one("Tint", g.tint, 0.005f, -1, 1);
    // the master curve: drag the points, double-click to add, right-click to remove
    ImGui::TextDisabled("Master curve");
    ImVec2 p0 = ImGui::GetCursorScreenPos();
    float side = std::min(220.f, ImGui::GetContentRegionAvail().x);
    ImGui::InvisibleButton("curve", ImVec2(side, side));
    ImDrawList* dl = ImGui::GetWindowDrawList();
    dl->AddRectFilled(p0, ImVec2(p0.x + side, p0.y + side), IM_COL32(20, 20, 24, 255));
    for (int i = 1; i < 4; ++i) {
      dl->AddLine(ImVec2(p0.x + side * i / 4, p0.y), ImVec2(p0.x + side * i / 4, p0.y + side), IM_COL32(50, 50, 56, 255));
      dl->AddLine(ImVec2(p0.x, p0.y + side * i / 4), ImVec2(p0.x + side, p0.y + side * i / 4), IM_COL32(50, 50, 56, 255));
    }
    std::vector<CurvePoint> pts = g.master.empty() ? std::vector<CurvePoint>{{0, 0}, {1, 1}} : g.master;
    auto table = color::curveTable(pts, 128);
    for (int i = 1; i < 128; ++i)
      dl->AddLine(ImVec2(p0.x + side * (i - 1) / 127.f, p0.y + side * (1 - table[size_t(i - 1)])),
                  ImVec2(p0.x + side * i / 127.f, p0.y + side * (1 - table[size_t(i)])), IM_COL32(230, 230, 235, 255), 1.5f);
    ImVec2 m = ImGui::GetIO().MousePos;
    float mx = std::clamp((m.x - p0.x) / side, 0.f, 1.f), my = std::clamp(1 - (m.y - p0.y) / side, 0.f, 1.f);
    static int dragPt = -1;
    if (ImGui::IsItemHovered() && ImGui::IsMouseDoubleClicked(ImGuiMouseButton_Left)) {
      pts.push_back({mx, my});
      std::sort(pts.begin(), pts.end(), [](auto& a, auto& b) { return a.x < b.x; });
      g.master = pts;
      ch = true;
    } else if (ImGui::IsItemClicked(ImGuiMouseButton_Left)) {
      dragPt = -1;
      for (size_t i = 0; i < pts.size(); ++i)
        if (std::fabs(pts[i].x - mx) < 0.04 && std::fabs(pts[i].y - my) < 0.06) dragPt = int(i);
    }
    if (dragPt >= 0 && ImGui::IsItemActive() && ImGui::IsMouseDragging(ImGuiMouseButton_Left) && size_t(dragPt) < pts.size()) {
      pts[size_t(dragPt)] = {mx, my};
      g.master = pts;
      ch = true;
      editing_ = true;
    }
    if (ImGui::IsItemHovered() && ImGui::IsMouseClicked(ImGuiMouseButton_Right))
      for (size_t i = 1; i + 1 < pts.size(); ++i)
        if (std::fabs(pts[i].x - mx) < 0.04) {
          pts.erase(pts.begin() + long(i));
          g.master = pts;
          ch = true;
          break;
        }
    for (auto& pt : pts) dl->AddCircleFilled(ImVec2(p0.x + side * float(pt.x), p0.y + side * (1 - float(pt.y))), 4, kAccent);
    std::string lut = g.lut.empty() ? "none" : fs::path(g.lut).filename().string();
    ImGui::Text("LUT: %s", lut.c_str());
    ImGui::SameLine();
    if (ImGui::SmallButton("Choose…")) {
      dialogTag_ = "lut";
      static const SDL_DialogFileFilter f[] = {{"3D LUT", "cube"}};
      SDL_ShowOpenFileDialog(&App::onDialog, this, window_, f, 1, nullptr, false);
    }
    if (!g.lut.empty()) {
      ImGui::SameLine();
      if (ImGui::SmallButton("Clear")) g.lut.clear(), ch = true;
      one("LUT mix", g.lutMix, 0.005f, 0, 1);
    }
    if (ImGui::Button("Reset grade")) g = Grade{}, ch = true;
    if (ch) editClip("grade", [&](Clip& k) { k.grade = g; });
  }
  if (onVideo && isPicture && ImGui::CollapsingHeader("Effects")) {
    auto fxValue = [&](const char* type, const char* param, float lo, float hi, float def) {
      float v = 0;
      for (auto& e : c->fx)
        if (e.type == type && e.params.count(param)) v = float(e.params.at(param).value);
      if (ImGui::SliderFloat(type, &v, lo, hi)) {
        editClip(type, [&](Clip& k) {
          auto it = std::find_if(k.fx.begin(), k.fx.end(), [&](const Effect& e) { return e.type == type; });
          if (v <= 0) {
            if (it != k.fx.end()) k.fx.erase(it);
            return;
          }
          if (it == k.fx.end()) k.fx.push_back(Effect{type, true, {}}), it = k.fx.end() - 1;
          it->params[param] = Param(v);
        });
        editing_ = ImGui::IsItemActive();
      }
      (void)def;
    };
    fxValue("blur", "radius", 0, 60, 0);
    fxValue("vignette", "amount", 0, 1, 0);
  }
  if (ImGui::CollapsingHeader("Time")) {
    float sp = float(c->speed * 100);
    static bool ripple = true;
    ImGui::Checkbox("Ripple", &ripple);
    if (ImGui::DragFloat("Speed %", &sp, 1, -1000, 1000, "%.0f%%") && std::fabs(sp) >= 1) {
      std::string id = c->id;
      double v = sp / 100;
      s_.apply("speed", [&](Editor& ed) { return ed.setSpeed(id, v, ripple); });
    }
  }
  if (!onVideo && ImGui::CollapsingHeader("Sound", ImGuiTreeNodeFlags_DefaultOpen)) {
    paramRow("Gain", c->gain, local, 0.1f, -60, 24, "%.1f dB");
    paramRow("Balance", c->pan, local, 0.01f, -1, 1, "%.2f");
    float fi = float(toSeconds(c->fadeIn)), fo = float(toSeconds(c->fadeOut));
    if (ImGui::DragFloat("Fade in", &fi, 0.01f, 0, 30, "%.2f s")) editClip("fade", [&](Clip& k) { k.fadeIn = fromSeconds(fi); });
    if (ImGui::DragFloat("Fade out", &fo, 0.01f, 0, 30, "%.2f s")) editClip("fade", [&](Clip& k) { k.fadeOut = fromSeconds(fo); });
  }
  ImGui::End();
}

// ——— scopes ———

void App::scopesPanel(SDL_GPUCommandBuffer* cmd) {
  ImGui::Begin("Scopes");
  const char* modes[] = {"Waveform", "RGB parade", "Vectorscope", "Histogram"};
  ImGui::SetNextItemWidth(160);
  ImGui::Combo("##mode", &scopeMode_, modes, 4);
  bool visible = !ImGui::IsWindowCollapsed();
  if (scopePending_) {
    // last frame queued a small copy of the viewer; its command buffer has been submitted since
    scopePending_ = false;
    auto px = gpu_.download(scopeSrc_);
    scopes_ = scopes::compute(px.data(), scopeSrc_.w, scopeSrc_.h, scopeSrc_.w * 4);
    SDL_GPUCommandBuffer* up = SDL_AcquireGPUCommandBuffer(gpu_.device());
    gpu_.beginUploads(up);
    auto wave = scopes::image(scopes_.waveform, 480, 256, {150, 255, 170}, true);
    gpu_.upload(waveTex_, wave.data(), 480 * 4, 480 * 4, 256);
    auto par = scopes::image(scopes_.parade, 480 * 3, 256, {255, 255, 255}, true);
    for (int y = 0; y < 256; ++y)  // tint the parade's thirds
      for (int x = 0; x < 480 * 3; ++x) {
        uint8_t* o = &par[(size_t(y) * 1440 + x) * 4];
        for (int k = 0; k < 3; ++k)
          if (k != x / 480) o[k] = uint8_t(o[k] / 4);
      }
    gpu_.upload(paradeTex_, par.data(), 1440 * 4, 1440 * 4, 256);
    auto vec = scopes::image(scopes_.vectorscope, 256, 256, {255, 220, 160}, true);
    gpu_.upload(vecTex_, vec.data(), 256 * 4, 256 * 4, 256);
    gpu_.endUploads();
    SDL_SubmitGPUCommandBuffer(up);
  }
  if (visible && scopeCountdown_ > 0 && --scopeCountdown_ == 0 && work_ && s_.seq()) {
    renderer_.output(cmd, work_, scopeSrc_, s_.project, s_.seq()->background);
    scopePending_ = true;
    if (s_.shuttle != 0) scopeCountdown_ = 6;  // every sixth frame while playing
  }
  ImVec2 avail = ImGui::GetContentRegionAvail();
  ImVec2 p0 = ImGui::GetCursorScreenPos();
  ImDrawList* dl = ImGui::GetWindowDrawList();
  if (scopeMode_ == 0 || scopeMode_ == 1) {
    ImGui::Image(ImTextureID(scopeMode_ == 0 ? &waveBind_ : &paradeBind_), avail);
    for (int ire : {0, 25, 50, 75, 100}) {
      float y = p0.y + avail.y * (1 - ire / 100.f);
      dl->AddLine(ImVec2(p0.x, y), ImVec2(p0.x + avail.x, y), IM_COL32(255, 255, 255, 40));
      dl->AddText(ImVec2(p0.x + 2, y - 14), IM_COL32(255, 255, 255, 90), std::to_string(ire).c_str());
    }
  } else if (scopeMode_ == 2) {
    float side = std::min(avail.x, avail.y);
    ImGui::Image(ImTextureID(&vecBind_), ImVec2(side, side));
    ImVec2 c(p0.x + side / 2, p0.y + side / 2);
    dl->AddCircle(c, side / 2 - 1, IM_COL32(255, 255, 255, 50));
    // 75% bar targets (BT.709): R, G, B, Cy, Mg, Yl
    struct T {
      double r, g, b;
      const char* n;
    };
    for (T t : {T{0.75, 0, 0, "R"}, T{0, 0.75, 0, "G"}, T{0, 0, 0.75, "B"}, T{0, 0.75, 0.75, "Cy"}, T{0.75, 0, 0.75, "Mg"},
                T{0.75, 0.75, 0, "Yl"}}) {
      double Y = 0.2126 * t.r + 0.7152 * t.g + 0.0722 * t.b, cb = (t.b - Y) / 1.8556, cr = (t.r - Y) / 1.5748;
      ImVec2 q(c.x + float(cb) * side, c.y - float(cr) * side);
      dl->AddRect(ImVec2(q.x - 5, q.y - 5), ImVec2(q.x + 5, q.y + 5), IM_COL32(255, 255, 255, 120));
      dl->AddText(ImVec2(q.x + 7, q.y - 7), IM_COL32(255, 255, 255, 120), t.n);
    }
    // the skin tone line
    dl->AddLine(c, ImVec2(c.x - side * 0.22f, c.y - side * 0.42f), IM_COL32(255, 200, 150, 70));
  } else {
    dl->AddRectFilled(p0, ImVec2(p0.x + avail.x, p0.y + avail.y), IM_COL32(10, 10, 12, 255));
    uint32_t peak = 1;
    for (int ch = 0; ch < 4; ++ch)
      for (uint32_t v : scopes_.histogram[size_t(ch)]) peak = std::max(peak, v);
    ImU32 cols[4] = {IM_COL32(255, 80, 80, 160), IM_COL32(80, 255, 80, 160), IM_COL32(90, 140, 255, 160), IM_COL32(230, 230, 230, 200)};
    for (int ch = 0; ch < 4; ++ch)
      for (int i = 1; i < 256; ++i) {
        auto h = [&](int k) { return float(std::sqrt(double(scopes_.histogram[size_t(ch)][size_t(k)]) / peak)); };
        dl->AddLine(ImVec2(p0.x + avail.x * (i - 1) / 255, p0.y + avail.y * (1 - h(i - 1))),
                    ImVec2(p0.x + avail.x * i / 255, p0.y + avail.y * (1 - h(i))), cols[ch]);
      }
  }
  ImGui::End();
}

// ——— mixer ———

void App::mixerPanel() {
  ImGui::Begin("Audio");
  Sequence* s = s_.seq();
  if (!s) {
    ImGui::End();
    return;
  }
  auto lv = player_.levels();
  auto meter = [&](float peak, float h) {
    ImVec2 p = ImGui::GetCursorScreenPos();
    ImDrawList* dl = ImGui::GetWindowDrawList();
    float db = float(audio::toDb(peak));
    float k = std::clamp((db + 60) / 60, 0.f, 1.f);
    dl->AddRectFilled(p, ImVec2(p.x + 8, p.y + h), IM_COL32(25, 25, 30, 255));
    ImU32 col = db > -1 ? IM_COL32(255, 70, 60, 255) : db > -9 ? IM_COL32(240, 200, 80, 255) : IM_COL32(90, 200, 120, 255);
    dl->AddRectFilled(ImVec2(p.x, p.y + h * (1 - k)), ImVec2(p.x + 8, p.y + h), col);
    ImGui::Dummy(ImVec2(10, h));
  };
  const float h = 160;
  for (size_t i = 0; i < s->audio.size(); ++i) {
    Track& t = s->audio[i];
    ImGui::PushID(int(i));
    ImGui::BeginGroup();
    ImGui::TextUnformatted(t.name.c_str());
    float g = float(t.gain.value);
    if (ImGui::VSliderFloat("##g", ImVec2(28, h), &g, -60, 12, "%.0f")) {
      if (!editing_) s_.history.push(s_.project, "track gain");
      editing_ = true;
      t.gain.value = g;
      ++s_.revision;
    }
    if (ImGui::IsItemDeactivated()) editing_ = false;
    ImGui::SameLine();
    auto it = lv.find(t.id);
    meter(it == lv.end() ? 0 : std::max(it->second.peakL, it->second.peakR), h);
    if (ImGui::SmallButton(t.mute ? "M●" : "M")) t.mute = !t.mute, ++s_.revision;
    ImGui::SameLine();
    if (ImGui::SmallButton(t.solo ? "S●" : "S")) t.solo = !t.solo, ++s_.revision;
    ImGui::EndGroup();
    ImGui::SameLine(0, 18);
    ImGui::PopID();
  }
  ImGui::BeginGroup();
  ImGui::TextUnformatted("Master");
  auto m = lv.find("master");
  meter(m == lv.end() ? 0 : m->second.peakL, h);
  ImGui::SameLine();
  meter(m == lv.end() ? 0 : m->second.peakR, h);
  ImGui::EndGroup();
  ImGui::SameLine(0, 18);
  ImGui::BeginGroup();
  auto L = player_.loudness();
  auto fmt = [](double v) { return v < -150 ? std::string("—") : std::to_string(int(std::lround(v * 10)) / 10.0).substr(0, 5); };
  ImGui::Text("Momentary  %s LUFS", fmt(L.momentary).c_str());
  ImGui::Text("Short-term %s LUFS", fmt(L.shortTerm).c_str());
  ImGui::Text("Integrated %s LUFS", fmt(L.integrated).c_str());
  ImGui::Text("True peak  %s dBTP", fmt(L.truePeak).c_str());
  if (ImGui::Button("Reset meter")) player_.resetLoudness();
  if (!player_.audioOk()) ImGui::TextColored(ImVec4(1, 0.4f, 0.3f, 1), "no audio device");
  ImGui::EndGroup();
  ImGui::End();
}

// ——— export ———

void App::queueExport(const std::string& presetId, const std::string& out, bool marks) {
  // the job gets its own copy of the project: editing on never changes a running export
  fs::path dir = fs::temp_directory_path() / "rhapsode-pro-jobs";
  std::error_code ec;
  fs::create_directories(dir, ec);
  std::string snap = (dir / ("job-" + std::to_string(SDL_GetTicksNS()) + ".rpro")).string();
  if (std::string e = saveProject(s_.project, snap, {.backups = 0}); !e.empty()) {
    s_.status = e;
    return;
  }
  Job j;
  j.kind = Job::Kind::Export;
  j.title = fs::path(out).filename().string() + " · " + presetId;
  j.output = out;
  j.argv = {rproPath(), "export", snap, presetId, out};
  if (publishExport_ && !webServer_.empty()) {
    j.argv.insert(j.argv.end(), {"--publish", webServer_, "--title", s_.project.name});
    j.title += " → share link";
  }
  if (marks && s_.markIn >= 0 && s_.markOut > s_.markIn) {
    j.argv.insert(j.argv.end(), {"--in", std::to_string(toSeconds(s_.markIn)), "--out", std::to_string(toSeconds(s_.markOut))});
  }
  jobs_.add(j);
  s_.status = "export queued";
}

void App::exportPanel() {
  ImGui::Begin("Export");
  if (ImGui::BeginCombo("Preset", exportPreset_.c_str())) {
    for (auto& p : presets())
      if (ImGui::Selectable(p.name.c_str(), p.id == exportPreset_)) exportPreset_ = p.id;
    ImGui::EndCombo();
  }
  const Preset* pr = findPreset(exportPreset_);
  if (exportPath_.empty() || (pr && fs::path(exportPath_).extension() != "." + pr->ext)) {
    fs::path base = s_.path.empty() ? fs::path(std::getenv("HOME") ? std::getenv("HOME") : ".") / "Videos" / "rhapsode"
                                    : fs::path(s_.path).replace_extension("");
    exportPath_ = base.string() + "-" + exportPreset_ + "." + (pr ? pr->ext : "mp4");
  }
  ImGui::InputText("File", &exportPath_);
  ImGui::Checkbox("In to out only", &exportMarks_);
  ImGui::BeginDisabled(webServer_.empty() || webKey_.empty());
  ImGui::Checkbox("Publish to a share link when done", &publishExport_);
  ImGui::EndDisabled();
  if (webServer_.empty()) ImGui::TextDisabled("Set the Rhapsode server in File ▸ Open a quick-mode render to publish.");
  if (ImGui::Button("Queue export")) {
    std::error_code ec;
    fs::create_directories(fs::path(exportPath_).parent_path(), ec);
    queueExport(exportPreset_, exportPath_, exportMarks_);
  }
  ImGui::SameLine();
  if (ImGui::Button("Clear finished")) jobs_.clearFinished();
  ImGui::Separator();
  auto jobs = jobs_.snapshot();
  for (size_t i = 0; i < jobs.size(); ++i) {
    const Job& j = jobs[i];
    ImGui::PushID(int(i));
    const char* st[] = {"queued", "running", "done", "failed", "cancelled"};
    ImGui::Text("%s", j.title.c_str());
    ImGui::SameLine();
    ImGui::TextDisabled("%s", st[int(j.state)]);
    if (j.state == Job::State::Running) {
      char ov[64];
      std::snprintf(ov, sizeof ov, "%.0f%%  %.0f fps", j.progress * 100, j.fps);
      ImGui::ProgressBar(float(j.progress), ImVec2(-80, 0), ov);
      ImGui::SameLine();
      if (ImGui::SmallButton("Cancel")) jobs_.cancel(i);
    }
    if (j.state == Job::State::Failed) ImGui::TextColored(ImVec4(1, 0.45f, 0.35f, 1), "%s", j.error.c_str());
    ImGui::PopID();
  }
  ImGui::End();
}

void App::shortcutsWindow() {
  ImGui::Begin("Keyboard shortcuts", &showShortcuts_);
  const auto& map = premiereKeys_ ? premiereKeymap() : rhapsodeKeymap();
  if (ImGui::BeginTable("keys", 2, ImGuiTableFlags_RowBg | ImGuiTableFlags_ScrollY)) {
    for (auto& b : map) {
      ImGui::TableNextRow();
      ImGui::TableNextColumn();
      std::string k = (b.mods & kCtrl ? "Ctrl+" : std::string()) + (b.mods & kShift ? "Shift+" : "") + (b.mods & kAlt ? "Alt+" : "") +
                      SDL_GetKeyName(SDL_Keycode(b.key));
      ImGui::TextUnformatted(k.c_str());
      ImGui::TableNextColumn();
      ImGui::TextUnformatted(b.action.c_str());
    }
    ImGui::EndTable();
  }
  ImGui::End();
}

void App::recoveryModal() {
  ImGui::OpenPopup("Recover");
  if (ImGui::BeginPopupModal("Recover", nullptr, ImGuiWindowFlags_AlwaysAutoResize)) {
    ImGui::Text("Rhapsode Pro closed with unsaved changes to %s.", fs::path(recoveryFor_).filename().c_str());
    ImGui::Text("An autosave from after the last save exists.");
    if (ImGui::Button("Recover the autosave")) {
      Project p;
      std::string err;
      if (loadProject(autosavePath(recoveryFor_), p, err)) {
        s_.project = std::move(p);
        ++s_.revision;  // dirty: the user decides when to save over the file
        s_.status = "recovered";
      } else {
        s_.status = err;
      }
      showRecovery_ = false;
      ImGui::CloseCurrentPopup();
    }
    ImGui::SameLine();
    if (ImGui::Button("Keep the saved file")) {
      std::error_code ec;
      fs::remove(autosavePath(recoveryFor_), ec);
      showRecovery_ = false;
      ImGui::CloseCurrentPopup();
    }
    ImGui::EndPopup();
  }
}

}  // namespace rhap::app

namespace rhap::app {

void App::task(const std::string& title, std::function<std::string()> work, std::function<void()> apply) {
  Job j;
  j.kind = Job::Kind::Task;
  j.title = title;
  j.work = std::move(work);
  j.apply = std::move(apply);
  jobs_.add(std::move(j));
  s_.status = title + " started";
}

void App::clipMenu() {
  if (!ImGui::BeginMenu("Clip")) return;
  Sequence* s = s_.seq();
  const Clip* c = s && !s_.selection.empty() ? clipById(*s, *s_.selection.begin()) : nullptr;
  const Media* m = c && c->kind == ClipKind::Media ? s_.project.findMedia(c->ref) : nullptr;
  std::string clipId = c ? c->id : "", seqId = s ? s->id : "", path = m ? m->path : "", mediaId = m ? m->id : "";
  ImGui::BeginDisabled(!m);
  if (ImGui::MenuItem("Transcribe (local)", nullptr, false, ai::transcriptionAvailable())) {
    auto out = std::make_shared<Transcript>();
    out->media = mediaId;
    task("transcribe " + m->name, [path, out] { return ai::transcribe(path, {}, *out); },
         [this, out] {
           std::erase_if(s_.project.transcripts, [&](const Transcript& t) { return t.media == out->media; });
           s_.history.push(s_.project, "transcript");
           s_.project.transcripts.push_back(*out);
           ++s_.revision;
           s_.status = std::to_string(out->words.size()) + " words (" + out->language + ")";
         });
  }
  if (ImGui::MenuItem("Add captions from transcript", nullptr, false, m && s_.project.transcriptOf(mediaId))) {
    s_.apply("captions", [&](Editor&) { return ai::addCaptions(s_.project, seqId, clipId) > 0 ? Err{} : Err{"no words in the clip"}; });
  }
  if (ImGui::MenuItem("Remove silence")) {
    auto sil = std::make_shared<std::vector<ai::Range>>();
    bool linkedPicture = false;
    if (!c->link.empty())
      forEachTrack(*s, [&](const Track& t, TrackRef r) {
        for (auto& o : t.clips)
          if (o.link == c->link && r.kind == TrackKind::Video) linkedPicture = true;
      });
    task("find silence in " + m->name, [path, sil] { *sil = ai::detectSilence(path); return std::string(); },
         [this, sil, seqId, clipId, linkedPicture] {
           std::string err;
           int n = 0;
           s_.apply("remove silence", [&](Editor&) {
             n = ai::removeSilence(s_.project, seqId, clipId, *sil, linkedPicture, &err);
             return n > 0 ? Err{} : Err{err.empty() ? "no silence found" : err};
           });
           if (n) s_.status = std::to_string(n) + " silences removed";
         });
  }
  if (ImGui::MenuItem("Split at scene cuts", nullptr, false, m && m->hasVideo)) {
    auto cuts = std::make_shared<std::vector<Tick>>();
    task("find scene cuts in " + m->name, [path, cuts] { *cuts = ai::detectScenes(path); return std::string(); },
         [this, cuts, seqId, clipId] {
           int n = 0;
           s_.apply("scene edit detection", [&](Editor&) {
             n = ai::splitAtScenes(s_.project, seqId, clipId, *cuts);
             return n > 0 ? Err{} : Err{"no cuts found"};
           });
           if (n) s_.status = std::to_string(n) + " scene cuts";
         });
  }
  if (ImGui::MenuItem("Auto-reframe to the sequence", nullptr, false, m && m->hasVideo)) {
    auto keys = std::make_shared<std::vector<ai::ReframeKey>>();
    task("track the subject in " + m->name, [path, keys] { *keys = ai::trackSubject(path); return std::string(); },
         [this, keys, seqId, clipId] {
           s_.apply("auto reframe", [&](Editor&) { return ai::applyReframe(s_.project, seqId, clipId, *keys) > 0 ? Err{} : Err{"nothing to follow"}; });
         });
  }
  ImGui::Separator();
  auto processed = [&](const char* what, const char* suffix, bool voice) {
    std::string out = (fs::path(path).parent_path() / (fs::path(path).stem().string() + "-" + suffix + ".flac")).string();
    task(std::string(what) + " " + m->name,
         [path, out, voice] { return voice ? ai::isolateVoice(path, out) : ai::denoise(path, out); },
         [this, out, seqId, clipId, suffix] {
           s_.apply(suffix, [&](Editor&) { return ai::swapSound(s_.project, seqId, clipId, out, suffix); });
         });
  };
  if (ImGui::MenuItem("Reduce noise (sound)", nullptr, false, m && m->hasAudio)) processed("clean", "denoised", false);
  if (ImGui::MenuItem("Isolate voice (Demucs)", nullptr, false, m && m->hasAudio)) processed("isolate voice in", "voice", true);
  ImGui::EndDisabled();
  ImGui::EndMenu();
}

void App::transcriptPanel() {
  ImGui::Begin("Transcript");
  transcriptFocused_ = ImGui::IsWindowFocused(ImGuiFocusedFlags_ChildWindows);
  Sequence* s = s_.seq();
  const Clip* c = s && !s_.selection.empty() ? clipById(*s, *s_.selection.begin()) : nullptr;
  if (!c || c->kind != ClipKind::Media) {
    ImGui::TextDisabled("Select a clip with speech. Clip ▸ Transcribe makes its words; delete words here to cut them.");
    ImGui::End();
    return;
  }
  auto words = ai::wordsOnTimeline(s_.project, *s, *c);
  if (words.empty()) {
    ImGui::TextDisabled(s_.project.transcriptOf(c->ref) ? "No words inside this clip." : "No transcript yet: Clip ▸ Transcribe.");
    ImGui::End();
    return;
  }
  if (ImGui::Button("Delete selected words") || (ImGui::IsWindowFocused() && !pickedWords_.empty() &&
                                                (ImGui::IsKeyPressed(ImGuiKey_Delete) || ImGui::IsKeyPressed(ImGuiKey_Backspace)))) {
    std::string id = c->id, seq = s->id, err;
    auto picked = pickedWords_;
    s_.apply("delete words", [&](Editor&) {
      int n = ai::deleteWords(s_.project, seq, id, picked, kFlicks / 20, &err);
      return n > 0 ? Err{} : Err{err.empty() ? "nothing to cut" : err};
    });
    pickedWords_.clear();
  }
  ImGui::SameLine();
  if (ImGui::Button("Export SRT…")) {
    std::vector<Word> placed;
    for (auto& w : words) placed.push_back(Word{w.a, w.b, w.text, 1});
    std::string out = (s_.path.empty() ? fs::temp_directory_path() / "captions" : fs::path(s_.path).replace_extension("")).string() + ".srt";
    s_.status = writeAtomic(out, ai::toSrt(ai::captions(placed))).empty() ? "wrote " + out : "could not write " + out;
  }
  ImGui::Separator();
  ImGui::BeginChild("words");
  float width = ImGui::GetContentRegionAvail().x, x = 0;
  for (size_t i = 0; i < words.size(); ++i) {
    const auto& w = words[i];
    std::string t = w.text.empty() || w.text[0] != ' ' ? w.text : w.text.substr(1);
    ImVec2 sz = ImGui::CalcTextSize(t.c_str());
    if (x > 0 && x + sz.x + 8 < width) ImGui::SameLine(0, 4);
    else x = 0;
    bool now = s_.playhead >= w.a && s_.playhead < w.b;
    bool picked = std::find(pickedWords_.begin(), pickedWords_.end(), w.index) != pickedWords_.end();
    if (now) ImGui::PushStyleColor(ImGuiCol_Text, ImVec4(1, 0.48f, 0.35f, 1));
    ImGui::PushID(int(i));
    if (ImGui::Selectable(t.c_str(), picked, 0, sz)) {
      if (ImGui::GetIO().KeyShift && !pickedWords_.empty()) {
        size_t lo = std::min(wordAnchor_, i), hi = std::max(wordAnchor_, i);
        pickedWords_.clear();
        for (size_t k = lo; k <= hi; ++k) pickedWords_.push_back(words[k].index);
      } else {
        pickedWords_ = {w.index};
        wordAnchor_ = i;
        s_.seek(w.a);
        player_.seeked();
      }
    }
    ImGui::PopID();
    if (now) ImGui::PopStyleColor();
    x += sz.x + 8;
  }
  ImGui::EndChild();
  ImGui::End();
}

}  // namespace rhap::app

namespace rhap::app {

void App::loadWebSettings() {
  const char* home = std::getenv("HOME");
  fs::path f = fs::path(home ? home : ".") / ".config" / "rhapsode-pro-web.json";
  std::ifstream in(f);
  if (!in) return;
  try {
    auto j = nlohmann::json::parse(in);
    webServer_ = j.value("server", "");
    webKey_ = j.value("key", "");
  } catch (...) {
  }
  if (!webKey_.empty()) setenv("RHAPSODE_KEY", webKey_.c_str(), 1);  // children (exports) read it from here
}

void App::saveWebSettings() {
  const char* home = std::getenv("HOME");
  fs::path f = fs::path(home ? home : ".") / ".config" / "rhapsode-pro-web.json";
  std::error_code ec;
  fs::create_directories(f.parent_path(), ec);
  if (writeAtomic(f.string(), nlohmann::json{{"server", webServer_}, {"key", webKey_}}.dump()).empty()) chmod(f.c_str(), 0600);
  if (!webKey_.empty()) setenv("RHAPSODE_KEY", webKey_.c_str(), 1);
}

void App::webModal() {
  ImGui::OpenPopup("Open a quick-mode render");
  ImGui::SetNextWindowSize(ImVec2(560, 0));
  if (ImGui::BeginPopupModal("Open a quick-mode render", &showWeb_)) {
    ImGui::TextWrapped("Paste a share link from Rhapsode quick mode. Its original pieces download beside the new project.");
    ImGui::InputText("Share link", &webLink_);
    ImGui::InputText("Server", &webServer_);
    ImGui::InputText("Invite key", &webKey_, ImGuiInputTextFlags_Password);
    if (ImGui::Button("Open")) {
      std::string server, slug;
      if (!web::parseShareUrl(webLink_, webServer_, server, slug)) {
        s_.status = "that is not a share link";
      } else {
        if (webServer_.empty()) webServer_ = server;
        saveWebSettings();
        web::Remote r{server, webKey_};
        const char* home = std::getenv("HOME");
        fs::path dir = fs::path(home ? home : ".") / "Videos" / "rhapsode" / slug;
        std::string project = (dir / (slug + ".rpro")).string();
        task("open " + slug,
             [r, slug, dir, project] {
               Project p;
               std::string e = web::openRender(r, slug, (dir / "media").string(), p);
               return e.empty() ? saveProject(p, project) : e;
             },
             [this, project] { openPath(project); });
        showWeb_ = false;
        ImGui::CloseCurrentPopup();
      }
    }
    ImGui::SameLine();
    if (ImGui::Button("Cancel")) {
      showWeb_ = false;
      ImGui::CloseCurrentPopup();
    }
    ImGui::EndPopup();
  }
}

}  // namespace rhap::app
