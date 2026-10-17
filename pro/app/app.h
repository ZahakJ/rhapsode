#pragma once
// The editor: panels over a Session. Everything an action does goes through
// the session (so keys, menus and tests share one code path); this file only
// draws, hit-tests and forwards.

#include <SDL3/SDL.h>
#include <imgui.h>

#include <memory>
#include <set>
#include <mutex>
#include <string>
#include <vector>

#include "engine/gfx/gpu.h"
#include "engine/media/prefetch.h"
#include "engine/render/renderer.h"
#include "engine/scopes/scopes.h"
#include "engine/ai/transcribe.h"
#include "engine/session/session.h"
#include "jobs.h"
#include "player.h"

namespace rhap::app {

inline constexpr ImGuiID kDockId = 0x52484450;  // the main dock space

struct Drag {
  enum Kind { None, Move, TrimHead, TrimTail, Slip, Slide, Scrub } kind = None;
  std::string clip;
  TrackRef track;
  float grabX = 0, grabY = 0;
  Tick origStart = 0, delta = 0;
  int trackDelta = 0;
  bool moved = false;
};

class App {
 public:
  App(SDL_Window* w, gfx::Gpu& gpu);
  ~App();
  /** one UI frame: input already fed to ImGui; draws everything and renders the viewer into its texture */
  void frame(SDL_GPUCommandBuffer* cmd);
  void key(const SDL_KeyboardEvent& e);
  bool wantsQuit() const { return quit_; }
  void openPath(const std::string& path);
  Session& session() { return s_; }
  void requestQuit();

 private:
  void menu();
  void viewer(SDL_GPUCommandBuffer* cmd);
  void gizmo(ImVec2 origin, float w, float h, bool hovered);
  void timeline();
  void bin();
  void inspector();
  void scopesPanel(SDL_GPUCommandBuffer* cmd);
  void mixerPanel();
  void exportPanel();
  void shortcutsWindow();
  void transcriptPanel();
  void clipMenu();
  void task(const std::string& title, std::function<std::string()> work, std::function<void()> apply);
  void recoveryModal();
  void webModal();
  void loadWebSettings();
  void saveWebSettings();
  void statusBar();
  void pollDialogs();
  void queueExport(const std::string& presetId, const std::string& out, bool marks);
  void makeProxies(bool heavyOnly);
  void editClip(const char* label, const std::function<void(Clip&)>& f);
  bool paramRow(const char* label, Param& p, Tick local, float speed, float lo, float hi, const char* fmt);

  SDL_Window* window_;
  gfx::Gpu& gpu_;
  Session s_;
  PrefetchPool frames_;
  Renderer renderer_;
  Player player_;
  JobQueue jobs_;
  bool premiereKeys_ = false;
  bool quit_ = false, showShortcuts_ = false, showRecovery_ = false, proxies_ = false;
  std::string recoveryFor_;

  // viewer
  gfx::Texture work_, view_;
  gfx::Texture angleWork_[9], angleView_[9];
  SDL_GPUTextureSamplerBinding angleBind_[9]{};
  bool multicamView_ = true;
  SDL_GPUTextureSamplerBinding viewBind_{};
  Tick renderedAt_ = -1;
  uint64_t renderedRev_ = ~0ull;
  bool renderedProxies_ = false;
  double renderMs_ = 0;

  // scopes
  gfx::Texture scopeSrc_, waveTex_, vecTex_, paradeTex_;
  SDL_GPUTextureSamplerBinding waveBind_{}, vecBind_{}, paradeBind_{};
  scopes::Scopes scopes_;
  int scopeMode_ = 0;
  int scopeCountdown_ = 0;
  bool scopePending_ = false;

  // timeline
  double pxPerSec_ = 60, scroll_ = 0;
  Drag drag_;
  bool editing_ = false;  // an inspector widget is mid-drag (one undo step for the whole drag)
  std::string selectedMedia_;
  std::set<std::string> binPicked_;
  std::set<std::string> proxyPending_;
  bool autoProxies_ = true;  // ctrl-click picks several (multicam)
  std::vector<ai::WordPick> pickedWords_;  // transcript selection, across the track's clips
  size_t wordAnchor_ = 0;
  bool transcriptFocused_ = false;
  bool gizmoDrag_ = false;
  ImVec2 gizmoGrab_{};
  double gizmoX_ = 0, gizmoY_ = 0;  // Delete there cuts words, not clips
  std::string exportPreset_ = "youtube-1080p", exportPath_;
  bool exportMarks_ = false;
  // Rhapsode web (quick mode): where it lives and the invite key
  std::string webServer_, webKey_, webLink_;
  bool showWeb_ = false, publishExport_ = false, smartExport_ = true;

  // async file dialogs
  struct DialogResult {
    std::string tag;
    std::vector<std::string> files;
  };
  static void SDLCALL onDialog(void* user, const char* const* files, int filter);
  std::mutex dialogMu_;
  std::vector<DialogResult> dialogResults_;
  std::string dialogTag_;
  uint64_t lastAutosave_ = 0;
};

}  // namespace rhap::app
