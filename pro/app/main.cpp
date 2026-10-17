// Rhapsode Pro: the editor window.
//   rhapsode-pro [PROJECT.rpro | TIMELINE.otio/.fcpxml/.edl/.xml | MEDIA...]
//   --screenshot OUT.png [--frames N] [--size WxH]   render N frames, save the window, quit
//   --script FILE   timed input for headless UI tests, one event per line:
//                   "<frame> key <name> [ctrl] [shift] [alt]" | "<frame> down|move|up <x> <y>" | "<frame> save <path>"

#include <SDL3/SDL.h>
#include <imgui.h>
#include <imgui_internal.h>
#include <imgui_impl_sdl3.h>
#include <imgui_impl_sdlgpu3.h>

#include <cstdio>
#include <cstring>
#include <fstream>
#include <sstream>
#include <filesystem>
#include <string>
#include <vector>

#define STB_IMAGE_WRITE_IMPLEMENTATION
#include <stb_image_write.h>

#include "app.h"
#include "engine/gfx/text.h"

namespace {

void theme() {
  ImGuiStyle& st = ImGui::GetStyle();
  ImGui::StyleColorsDark(&st);
  st.WindowRounding = 4;
  st.FrameRounding = 3;
  st.GrabRounding = 3;
  st.TabRounding = 3;
  st.WindowBorderSize = 0;
  st.FramePadding = ImVec2(7, 4);
  st.ItemSpacing = ImVec2(8, 6);
  ImVec4* c = st.Colors;
  const ImVec4 obsidian(0.067f, 0.067f, 0.082f, 1), panel(0.094f, 0.094f, 0.114f, 1), raised(0.15f, 0.15f, 0.18f, 1);
  const ImVec4 coral(1.0f, 0.478f, 0.349f, 1), coralDim(1.0f, 0.478f, 0.349f, 0.45f), gold(1.0f, 0.78f, 0.36f, 1);
  c[ImGuiCol_WindowBg] = panel;
  c[ImGuiCol_ChildBg] = panel;
  c[ImGuiCol_PopupBg] = ImVec4(0.11f, 0.11f, 0.13f, 0.98f);
  c[ImGuiCol_MenuBarBg] = obsidian;
  c[ImGuiCol_TitleBg] = obsidian;
  c[ImGuiCol_TitleBgActive] = obsidian;
  c[ImGuiCol_FrameBg] = raised;
  c[ImGuiCol_FrameBgHovered] = ImVec4(0.2f, 0.2f, 0.24f, 1);
  c[ImGuiCol_FrameBgActive] = ImVec4(0.24f, 0.22f, 0.24f, 1);
  c[ImGuiCol_Button] = raised;
  c[ImGuiCol_ButtonHovered] = coralDim;
  c[ImGuiCol_ButtonActive] = coral;
  c[ImGuiCol_Header] = ImVec4(1.0f, 0.478f, 0.349f, 0.25f);
  c[ImGuiCol_HeaderHovered] = coralDim;
  c[ImGuiCol_HeaderActive] = coral;
  c[ImGuiCol_Tab] = obsidian;
  c[ImGuiCol_TabHovered] = coralDim;
  c[ImGuiCol_TabSelected] = panel;
  c[ImGuiCol_TabSelectedOverline] = coral;
  c[ImGuiCol_TabDimmed] = obsidian;
  c[ImGuiCol_TabDimmedSelected] = panel;
  c[ImGuiCol_DockingPreview] = coralDim;
  c[ImGuiCol_SliderGrab] = coral;
  c[ImGuiCol_SliderGrabActive] = gold;
  c[ImGuiCol_CheckMark] = coral;
  c[ImGuiCol_PlotHistogram] = coral;
  c[ImGuiCol_SeparatorHovered] = coralDim;
  c[ImGuiCol_SeparatorActive] = coral;
  c[ImGuiCol_ResizeGrip] = ImVec4(0, 0, 0, 0);
  c[ImGuiCol_TextSelectedBg] = coralDim;
  c[ImGuiCol_DockingEmptyBg] = obsidian;
}

void fonts(float scale) {
  ImGuiIO& io = ImGui::GetIO();
  float px = 15.f * scale;
  const char* latin[] = {"/usr/share/fonts/noto/NotoSans-Regular.ttf", "/usr/share/fonts/TTF/DejaVuSans.ttf"};
  bool loaded = false;
  // Latin plus the punctuation the UI uses (— · × • … → ◆ ◇ ●)
  static ImVector<ImWchar> ranges;
  ImFontGlyphRangesBuilder rb;
  rb.AddRanges(io.Fonts->GetGlyphRangesDefault());
  static const ImWchar extra[] = {0x0100, 0x017F, 0x2000, 0x206F, 0x2190, 0x21FF, 0x00D7, 0x00D7, 0};
  rb.AddRanges(extra);
  rb.BuildRanges(&ranges);
  for (const char* f : latin)
    if (std::filesystem::exists(f)) {
      io.Fonts->AddFontFromFileTTF(f, px, nullptr, ranges.Data);
      loaded = true;
      break;
    }
  std::string plex = rhap::gfx::fontDir() + "/IBMPlexSansArabic-Bold.ttf";
  ImFontConfig merge;
  merge.MergeMode = loaded;
  static const ImWchar arabic[] = {0x0600, 0x06FF, 0x0750, 0x077F, 0xFB50, 0xFDFF, 0xFE70, 0xFEFF, 0};
  static const ImWchar symbols[] = {0x2200, 0x22FF, 0x25A0, 0x25FF, 0};
  if (std::filesystem::exists(plex)) io.Fonts->AddFontFromFileTTF(plex.c_str(), px, &merge, arabic);
  const char* sym = "/usr/share/fonts/TTF/DejaVuSans.ttf";
  if (std::filesystem::exists(sym)) {
    ImFontConfig m2;
    m2.MergeMode = true;
    io.Fonts->AddFontFromFileTTF(sym, px, &m2, symbols);
  }
  if (!loaded && !std::filesystem::exists(plex)) io.Fonts->AddFontDefault();
}

/** a first layout: viewer and scopes on top, timeline below, bin and inspector at the side */
void defaultLayout(ImGuiID dock) {
  ImGui::DockBuilderRemoveNode(dock);
  ImGui::DockBuilderAddNode(dock, ImGuiDockNodeFlags_DockSpace);
  ImGui::DockBuilderSetNodeSize(dock, ImGui::GetMainViewport()->Size);
  ImGuiID top, bottom, left, right, centre, scopes;
  ImGui::DockBuilderSplitNode(dock, ImGuiDir_Down, 0.42f, &bottom, &top);
  ImGui::DockBuilderSplitNode(top, ImGuiDir_Left, 0.24f, &left, &centre);
  ImGui::DockBuilderSplitNode(centre, ImGuiDir_Right, 0.30f, &right, &centre);
  ImGui::DockBuilderSplitNode(right, ImGuiDir_Down, 0.5f, &scopes, &right);
  ImGuiID audio, tl;
  ImGui::DockBuilderSplitNode(bottom, ImGuiDir_Right, 0.22f, &audio, &tl);
  ImGui::DockBuilderDockWindow("Media", left);
  ImGui::DockBuilderDockWindow("Export", left);
  ImGui::DockBuilderDockWindow("Program", centre);
  ImGui::DockBuilderDockWindow("Inspector", right);
  ImGui::DockBuilderDockWindow("Scopes", scopes);
  ImGui::DockBuilderDockWindow("Timeline", tl);
  ImGui::DockBuilderDockWindow("Audio", audio);
  ImGui::DockBuilderDockWindow("Transcript", left);
  ImGui::DockBuilderFinish(dock);
}

struct ScriptEvent {
  int frame;
  std::string what;
  std::vector<std::string> args;
};

std::vector<ScriptEvent> loadScript(const std::string& path) {
  std::vector<ScriptEvent> v;
  std::ifstream f(path);
  std::string line;
  while (std::getline(f, line)) {
    std::istringstream ls(line);
    ScriptEvent e;
    if (!(ls >> e.frame >> e.what)) continue;
    for (std::string a; ls >> a;) e.args.push_back(a);
    v.push_back(e);
  }
  return v;
}

void inject(const ScriptEvent& e, SDL_Window* win, rhap::app::App& app) {
  if (e.what == "key" && !e.args.empty()) {
    SDL_KeyboardEvent k{};
    k.type = SDL_EVENT_KEY_DOWN;
    k.key = SDL_GetKeyFromName(e.args[0].c_str());
    for (size_t i = 1; i < e.args.size(); ++i) {
      if (e.args[i] == "ctrl") k.mod |= SDL_KMOD_LCTRL;
      if (e.args[i] == "shift") k.mod |= SDL_KMOD_LSHIFT;
      if (e.args[i] == "alt") k.mod |= SDL_KMOD_LALT;
    }
    k.down = true;
    app.key(k);
  } else if ((e.what == "down" || e.what == "up" || e.what == "move") && e.args.size() >= 2) {
    float x = std::stof(e.args[0]), y = std::stof(e.args[1]);
    ImGuiIO& io = ImGui::GetIO();
    io.AddMousePosEvent(x, y);
    if (e.what != "move") io.AddMouseButtonEvent(0, e.what == "down");
    (void)win;
  } else if (e.what == "save" && !e.args.empty()) {
    app.session().save(e.args[0]);
  }
}

}  // namespace

int main(int argc, char** argv) {
  std::string shot;
  int shotFrames = 30, W = 1600, H = 960;
  std::vector<std::string> open;
  std::vector<ScriptEvent> script;
  for (int i = 1; i < argc; ++i) {
    std::string a = argv[i];
    if (a == "--screenshot" && i + 1 < argc) shot = argv[++i];
    else if (a == "--frames" && i + 1 < argc) shotFrames = std::stoi(argv[++i]);
    else if (a == "--size" && i + 1 < argc) std::sscanf(argv[++i], "%dx%d", &W, &H);
    else if (a == "--script" && i + 1 < argc) script = loadScript(argv[++i]);
    else open.push_back(a);
  }
  // a screenshot run never shows a window: SDL's offscreen driver, the GPU without a swapchain
  if (!shot.empty()) SDL_SetHint(SDL_HINT_VIDEO_DRIVER, "offscreen");
  if (!SDL_Init(SDL_INIT_VIDEO | SDL_INIT_AUDIO) && !SDL_Init(SDL_INIT_VIDEO)) {
    std::fprintf(stderr, "rhapsode-pro: %s\n", SDL_GetError());
    return 1;
  }
  SDL_Window* win = SDL_CreateWindow("Rhapsode Pro", W, H, SDL_WINDOW_RESIZABLE | SDL_WINDOW_HIGH_PIXEL_DENSITY |
                                                               (shot.empty() ? 0 : SDL_WINDOW_HIDDEN));
  if (!win) {
    std::fprintf(stderr, "rhapsode-pro: %s\n", SDL_GetError());
    return 1;
  }
  rhap::gfx::Gpu gpu;
  std::string gerr = gpu.init(shot.empty() ? win : nullptr);
  if (!gerr.empty()) {
    std::fprintf(stderr, "rhapsode-pro: %s\n", gerr.c_str());
    return 1;
  }
  bool hasSwapchain = gpu.window() != nullptr;
  if (hasSwapchain) SDL_SetGPUSwapchainParameters(gpu.device(), win, SDL_GPU_SWAPCHAINCOMPOSITION_SDR, SDL_GPU_PRESENTMODE_VSYNC);
  IMGUI_CHECKVERSION();
  ImGui::CreateContext();
  ImGuiIO& io = ImGui::GetIO();
  io.ConfigFlags |= ImGuiConfigFlags_DockingEnable | ImGuiConfigFlags_NavEnableKeyboard;
  static std::string ini = (std::filesystem::path(std::getenv("HOME") ? std::getenv("HOME") : ".") / ".config" / "rhapsode-pro.ini").string();
  io.IniFilename = shot.empty() ? ini.c_str() : nullptr;
  theme();
  float scale = SDL_GetWindowDisplayScale(win);
  fonts(scale > 0 ? scale : 1);
  ImGui_ImplSDL3_InitForSDLGPU(win);
  // the UI draws into its own texture (so a screenshot is a readback), then onto the swapchain
  const SDL_GPUTextureFormat uiFormat = SDL_GPU_TEXTUREFORMAT_R8G8B8A8_UNORM;
  ImGui_ImplSDLGPU3_InitInfo info;
  info.Device = gpu.device();
  info.ColorTargetFormat = uiFormat;
  ImGui_ImplSDLGPU3_Init(&info);

  {
    rhap::app::App app(win, gpu);
    for (auto& f : open) app.openPath(f);
    bool layoutDone = std::filesystem::exists(ini) && shot.empty();
    rhap::gfx::Texture ui;
    int frame = 0;
    while (!app.wantsQuit()) {
      SDL_Event e;
      while (SDL_PollEvent(&e)) {
        ImGui_ImplSDL3_ProcessEvent(&e);
        if (e.type == SDL_EVENT_QUIT) app.requestQuit();
        if (e.type == SDL_EVENT_KEY_DOWN && !e.key.repeat) {
          if (e.key.key == SDLK_Q && (e.key.mod & SDL_KMOD_CTRL)) app.requestQuit();
          else app.key(e.key);
        } else if (e.type == SDL_EVENT_KEY_DOWN && e.key.repeat) {
          // held arrows keep stepping
          if (e.key.key == SDLK_LEFT || e.key.key == SDLK_RIGHT) app.key(e.key);
        }
        if (e.type == SDL_EVENT_DROP_FILE && e.drop.data) app.openPath(e.drop.data);
      }
      for (auto& ev : script)
        if (ev.frame == frame) inject(ev, win, app);
      ImGui_ImplSDLGPU3_NewFrame();
      ImGui_ImplSDL3_NewFrame();
      ImGui::NewFrame();
      if (!layoutDone) {
        defaultLayout(rhap::app::kDockId);
        layoutDone = true;
      }
      SDL_GPUCommandBuffer* cmd = SDL_AcquireGPUCommandBuffer(gpu.device());
      app.frame(cmd);
      ImGui::Render();
      ImDrawData* dd = ImGui::GetDrawData();
      int fw = int(dd->DisplaySize.x * dd->FramebufferScale.x), fh = int(dd->DisplaySize.y * dd->FramebufferScale.y);
      SDL_GPUTexture* swap = nullptr;
      Uint32 sw = 0, sh = 0;
      if (hasSwapchain && !SDL_WaitAndAcquireGPUSwapchainTexture(cmd, win, &swap, &sw, &sh)) swap = nullptr;
      if (shot.empty() && swap) fw = int(sw), fh = int(sh);
      if (fw > 0 && fh > 0) {
        gpu.ensure(ui, fw, fh, uiFormat, SDL_GPU_TEXTUREUSAGE_COLOR_TARGET | SDL_GPU_TEXTUREUSAGE_SAMPLER);
        Imgui_ImplSDLGPU3_PrepareDrawData(dd, cmd);
        SDL_GPUColorTargetInfo ct{};
        ct.texture = ui.tex;
        ct.clear_color = {0.067f, 0.067f, 0.082f, 1};
        ct.load_op = SDL_GPU_LOADOP_CLEAR;
        ct.store_op = SDL_GPU_STOREOP_STORE;
        SDL_GPURenderPass* rp = SDL_BeginGPURenderPass(cmd, &ct, 1, nullptr);
        ImGui_ImplSDLGPU3_RenderDrawData(dd, cmd, rp);
        SDL_EndGPURenderPass(rp);
        if (swap) {
          SDL_GPUBlitInfo bi{};
          bi.source.texture = ui.tex;
          bi.source.w = Uint32(fw);
          bi.source.h = Uint32(fh);
          bi.destination.texture = swap;
          bi.destination.w = sw;
          bi.destination.h = sh;
          bi.load_op = SDL_GPU_LOADOP_DONT_CARE;
          bi.filter = SDL_GPU_FILTER_LINEAR;
          SDL_BlitGPUTexture(cmd, &bi);
        }
      }
      SDL_SubmitGPUCommandBuffer(cmd);
      ++frame;
      if (!shot.empty() && frame >= shotFrames) {
        auto px = gpu.download(ui);
        stbi_write_png(shot.c_str(), ui.w, ui.h, 4, px.data(), ui.w * 4);
        std::printf("%s %dx%d\n", shot.c_str(), ui.w, ui.h);
        break;
      }
    }
    gpu.wait();
    gpu.release(ui);
  }
  ImGui_ImplSDL3_Shutdown();
  ImGui_ImplSDLGPU3_Shutdown();
  ImGui::DestroyContext();
  gpu.shutdown();
  SDL_DestroyWindow(win);
  SDL_Quit();
  return 0;
}
