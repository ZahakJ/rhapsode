// rpro: the engine without the editor — probe, build, export, render a
// frame, and measure. Exports run here as a separate process so a crash in a
// render never takes the editor down.

#include <SDL3/SDL.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <nlohmann/json.hpp>
#include <numeric>
#include <random>
#include <string>
#include <vector>

#define STB_IMAGE_WRITE_IMPLEMENTATION
#include <stb_image_write.h>

#include "engine/audio/mixer.h"
#include "engine/io/project_io.h"
#include "engine/media/decode.h"
#include "engine/media/prefetch.h"
#include "engine/model/edit.h"
#include "engine/render/export.h"
#include "engine/render/renderer.h"
#include "interchange/interchange.h"

using namespace rhap;
namespace fs = std::filesystem;

namespace {

int usage() {
  std::fprintf(stderr,
               "usage:\n"
               "  rpro probe FILE...                     media info as JSON\n"
               "  rpro presets                           export presets\n"
               "  rpro new OUT.rpro FILE...              a project with the files cut end to end\n"
               "  rpro export PROJECT PRESET OUT [--in S] [--out S] [--sw-decode]\n"
               "  rpro frame PROJECT SECONDS OUT.png     render one frame\n"
               "  rpro loudness PROJECT                  integrated loudness of the active sequence\n"
               "  rpro convert IN OUT                    project interchange (.rpro .otio .fcpxml .edl .xml)\n"
               "  rpro bench playback [--tracks N] [--size WxH] [--fps F] [--seconds S] [--codec hevc10|h264|prores]\n"
               "  rpro bench export   (same options) [--preset ID]\n");
  return 2;
}

std::string arg(int argc, char** argv, const char* name, const std::string& fallback) {
  for (int i = 0; i + 1 < argc; ++i)
    if (std::strcmp(argv[i], name) == 0) return argv[i + 1];
  return fallback;
}
bool flag(int argc, char** argv, const char* name) {
  for (int i = 0; i < argc; ++i)
    if (std::strcmp(argv[i], name) == 0) return true;
  return false;
}

bool load(const std::string& path, Project& p) {
  std::string err;
  if (path.ends_with(".rpro")) {
    if (loadProject(path, p, err)) return true;
  } else {
    err = importProject(path, p);
    if (err.empty()) return true;
  }
  std::fprintf(stderr, "rpro: %s: %s\n", path.c_str(), err.c_str());
  return false;
}

nlohmann::json mediaJson(const Media& m) {
  return {{"path", m.path},          {"kind", m.kind == MediaKind::Video ? "video" : m.kind == MediaKind::Audio ? "audio" : "image"},
          {"duration", toSeconds(m.duration)}, {"fps", m.rate.fps()},        {"vfr", m.vfr},
          {"width", m.width},        {"height", m.height},                 {"video", m.videoCodec},
          {"audio", m.audioCodec},   {"channels", m.channels},             {"sampleRate", m.sampleRate},
          {"bitDepth", m.color.bitDepth}, {"hdr", m.color.hdr()},          {"nvdec", nvdecAvailable()}};
}

int cmdProbe(int argc, char** argv) {
  nlohmann::json out = nlohmann::json::array();
  for (int i = 2; i < argc; ++i) {
    Media m;
    std::string e = probe(argv[i], m);
    out.push_back(e.empty() ? mediaJson(m) : nlohmann::json{{"path", argv[i]}, {"error", e}});
  }
  std::printf("%s\n", out.dump(2).c_str());
  return 0;
}

/** a project with each file one after another on V1 / A1, video and sound linked */
Project build(const std::vector<std::string>& files, std::string* err) {
  Project p;
  Sequence s;
  s.id = p.makeId("s");
  s.name = "Sequence 1";
  for (int i = 0; i < 3; ++i) s.video.push_back(Track{.id = p.makeId("t"), .kind = TrackKind::Video, .name = "V" + std::to_string(i + 1)});
  for (int i = 0; i < 3; ++i) s.audio.push_back(Track{.id = p.makeId("t"), .kind = TrackKind::Audio, .name = "A" + std::to_string(i + 1)});
  for (auto& f : files) {
    Media m;
    m.id = p.makeId("m");
    if (std::string e = probe(fs::absolute(f).string(), m); !e.empty()) {
      if (err) *err = f + ": " + e;
      return p;
    }
    if (p.media.empty() && m.hasVideo) {
      s.width = m.width;
      s.height = m.height;
      s.rate = m.rate;
    }
    p.media.push_back(m);
  }
  p.sequences.push_back(s);
  p.active = s.id;
  Editor ed(p, p.active);
  Tick at = 0;
  for (auto& m : p.media) {
    Clip v = clipOf(p, m, at), a = v;
    a.id = p.makeId("c");
    std::string link = p.makeId("l");
    v.link = a.link = link;
    if (m.hasVideo || m.kind == MediaKind::Image) ed.overwrite({TrackKind::Video, 0}, v);
    if (m.hasAudio) ed.overwrite({TrackKind::Audio, 0}, a);
    at += v.dur;
  }
  return p;
}

int cmdNew(int argc, char** argv) {
  if (argc < 4) return usage();
  std::vector<std::string> files(argv + 3, argv + argc);
  std::string err;
  Project p = build(files, &err);
  if (!err.empty()) {
    std::fprintf(stderr, "rpro: %s\n", err.c_str());
    return 1;
  }
  if (std::string e = saveProject(p, argv[2]); !e.empty()) {
    std::fprintf(stderr, "rpro: %s\n", e.c_str());
    return 1;
  }
  std::printf("%s: %zu media, %.2f s\n", argv[2], p.media.size(), toSeconds(p.sequences[0].duration()));
  return 0;
}

int cmdExport(int argc, char** argv) {
  if (argc < 5) return usage();
  ExportJob job;
  if (!load(argv[2], job.project)) return 1;
  const Preset* pr = findPreset(argv[3]);
  if (!pr) {
    std::fprintf(stderr, "rpro: no preset %s (see rpro presets)\n", argv[3]);
    return 1;
  }
  job.preset = *pr;
  job.path = argv[4];
  job.in = fromSeconds(std::stod(arg(argc, argv, "--in", "0")));
  std::string out = arg(argc, argv, "--out", "");
  if (!out.empty()) job.out = fromSeconds(std::stod(out));
  job.hwDecode = !flag(argc, argv, "--sw-decode");
  if (flag(argc, argv, "--native-size")) job.preset.width = job.preset.height = 0;
  ExportProgress sum;
  auto t0 = std::chrono::steady_clock::now();
  std::string e = runExport(job, [&](const ExportProgress& p) {
    if (p.frame % 30 == 0 || p.frame == p.total)
      std::fprintf(stderr, "\r%lld/%lld  %.1f fps  %s   ", (long long)p.frame, (long long)p.total, p.fps, p.encoder.c_str());
    return true;
  }, &sum);
  std::fprintf(stderr, "\n");
  if (!e.empty()) {
    std::fprintf(stderr, "rpro: %s\n", e.c_str());
    return 1;
  }
  double el = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
  std::printf("%s\n", nlohmann::json{{"path", job.path}, {"frames", sum.total}, {"seconds", el}, {"fps", sum.fps},
                                     {"encoder", sum.encoder}}
                          .dump()
                          .c_str());
  return 0;
}

int cmdFrame(int argc, char** argv) {
  if (argc < 5) return usage();
  Project p;
  if (!load(argv[2], p)) return 1;
  const Sequence* s = p.findSequence(p.active);
  if (!s) return 1;
  gfx::Gpu gpu;
  if (std::string e = gpu.init(nullptr); !e.empty()) {
    std::fprintf(stderr, "rpro: %s\n", e.c_str());
    return 1;
  }
  DecoderPool pool(true);
  Renderer r(gpu, pool);
  gfx::Texture work, out = gpu.make(s->width, s->height, SDL_GPU_TEXTUREFORMAT_R8G8B8A8_UNORM,
                                    SDL_GPU_TEXTUREUSAGE_COLOR_TARGET | SDL_GPU_TEXTUREUSAGE_SAMPLER);
  SDL_GPUCommandBuffer* cmd = SDL_AcquireGPUCommandBuffer(gpu.device());
  r.render(cmd, p, *s, fromSeconds(std::stod(argv[3])), work);
  r.output(cmd, work, out, p, s->background);
  SDL_SubmitGPUCommandBuffer(cmd);
  auto px = gpu.download(out);
  stbi_write_png(argv[4], s->width, s->height, 4, px.data(), s->width * 4);
  gpu.release(work);
  gpu.release(out);
  return 0;
}

int cmdLoudness(int argc, char** argv) {
  if (argc < 3) return usage();
  Project p;
  if (!load(argv[2], p)) return 1;
  double tp, lra;
  double i = audio::measureLoudness(p, *p.findSequence(p.active), &tp, &lra);
  std::printf("%s\n", nlohmann::json{{"integrated", i}, {"truePeak", tp}, {"range", lra}}.dump().c_str());
  return 0;
}

int cmdConvert(int argc, char** argv) {
  if (argc < 4) return usage();
  Project p;
  if (!load(argv[2], p)) return 1;
  std::string out = argv[3];
  std::string e = out.ends_with(".rpro") ? saveProject(p, out) : exportProject(p, out);
  if (!e.empty()) {
    std::fprintf(stderr, "rpro: %s\n", e.c_str());
    return 1;
  }
  return 0;
}

// ——— benchmarks ———

struct BenchSpec {
  int tracks = 3, w = 3840, h = 2160, fps = 60, seconds = 60;
  std::string codec = "hevc10";
};

BenchSpec benchSpec(int argc, char** argv) {
  BenchSpec b;
  b.tracks = std::stoi(arg(argc, argv, "--tracks", "3"));
  std::string size = arg(argc, argv, "--size", "3840x2160");
  std::sscanf(size.c_str(), "%dx%d", &b.w, &b.h);
  b.fps = std::stoi(arg(argc, argv, "--fps", "60"));
  b.seconds = std::stoi(arg(argc, argv, "--seconds", "60"));
  b.codec = arg(argc, argv, "--codec", "hevc10");
  return b;
}

/** synthetic camera-like sources, made once with ffmpeg (NVENC when there is one) and cached */
std::vector<std::string> benchSources(const BenchSpec& b) {
  fs::path dir = fs::path(arg(0, nullptr, "", "")).empty() ? fs::current_path() / "build" / "bench" : fs::path();
  if (const char* d = std::getenv("RPRO_BENCH_DIR")) dir = d;
  fs::create_directories(dir);
  std::vector<std::string> out;
  const char* patterns[] = {"testsrc2", "smptehdbars", "rgbtestsrc", "testsrc", "pal100bars", "yuvtestsrc"};
  for (int i = 0; i < b.tracks; ++i) {
    std::string ext = b.codec == "prores" ? "mov" : "mp4";
    fs::path f = dir / ("src" + std::to_string(i) + "-" + b.codec + "-" + std::to_string(b.w) + "x" + std::to_string(b.h) + "p" +
                        std::to_string(b.fps) + "-" + std::to_string(b.seconds) + "s." + ext);
    if (!fs::exists(f)) {
      std::string venc = b.codec == "hevc10" ? "-pix_fmt p010le -c:v hevc_nvenc -profile:v main10 -preset p4 -b:v 60M -g " + std::to_string(b.fps * 2)
                         : b.codec == "h264" ? "-pix_fmt yuv420p -c:v h264_nvenc -preset p4 -b:v 60M -g " + std::to_string(b.fps * 2)
                                             : "-pix_fmt yuv422p10le -c:v prores_ks -profile:v 2";
      // moving noise over the pattern keeps the encoder honest about bits
      std::string cmd = "ffmpeg -nostdin -loglevel error -y -f lavfi -i " + std::string(patterns[i % 6]) + "=s=" +
                        std::to_string(b.w) + "x" + std::to_string(b.h) + ":r=" + std::to_string(b.fps) + ":d=" +
                        std::to_string(b.seconds) + " -f lavfi -i sine=frequency=" + std::to_string(220 * (i + 1)) +
                        ":duration=" + std::to_string(b.seconds) + " -vf noise=alls=12:allf=t " + venc +
                        " -c:a aac -shortest '" + f.string() + ".part." + ext + "' && mv '" + f.string() + ".part." + ext + "' '" + f.string() + "'";
      std::fprintf(stderr, "making %s\n", f.c_str());
      if (std::system(cmd.c_str()) != 0) return {};
    }
    out.push_back(f.string());
  }
  return out;
}

/** the benchmark timeline: a full-frame base, the other tracks as graded, scaled, rotated pictures-in-picture */
Project benchProject(const BenchSpec& b, const std::vector<std::string>& files) {
  Project p = build({files[0]}, nullptr);
  Sequence& s = p.sequences[0];
  s.width = b.w;
  s.height = b.h;
  s.rate = Rate{b.fps, 1};
  while (int(s.video.size()) < b.tracks) s.video.push_back(Track{.id = p.makeId("t"), .kind = TrackKind::Video});
  Editor ed(p, s.id);
  for (int i = 1; i < b.tracks; ++i) {
    Media m;
    m.id = p.makeId("m");
    probe(files[size_t(i)], m);
    p.media.push_back(m);
    Clip c = clipOf(p, p.media.back(), 0);
    c.xf.scale = 0.45;
    c.xf.x = (i % 2 ? 1 : -1) * b.w * 0.22;
    c.xf.y = (i % 4 < 2 ? -1 : 1) * b.h * 0.2;
    c.xf.rotation = 3.0 * i;
    c.grade.saturation = 1.2;
    c.grade.lift = {0.02, 0.0, -0.02};
    c.grade.gain = {1.05, 1.0, 0.95};
    c.grade.master = {{0, 0}, {0.3, 0.25}, {0.7, 0.78}, {1, 1}};
    ed.overwrite({TrackKind::Video, i}, c);
  }
  // the base gets a grade too
  ed.seq().video[0].clips[0].grade.contrast = 1.1;
  ed.seq().video[0].clips[0].grade.saturation = 0.9;
  return p;
}

double pct(std::vector<double> v, double q) {
  if (v.empty()) return 0;
  std::sort(v.begin(), v.end());
  return v[size_t(std::clamp(q, 0.0, 1.0) * double(v.size() - 1))];
}

int cmdBenchPlayback(int argc, char** argv) {
  BenchSpec b = benchSpec(argc, argv);
  auto files = benchSources(b);
  if (files.empty()) return 1;
  Project p = benchProject(b, files);
  const Sequence& s = p.sequences[0];
  gfx::Gpu gpu;
  if (std::string e = gpu.init(nullptr); !e.empty()) {
    std::fprintf(stderr, "rpro: %s\n", e.c_str());
    return 1;
  }
  PrefetchPool pool(!flag(argc, argv, "--sw-decode"), 8);
  Renderer ren(gpu, pool);
  // a display-sized output, as the viewer draws
  gfx::Texture work, view = gpu.make(1920, 1080, SDL_GPU_TEXTUREFORMAT_R8G8B8A8_UNORM,
                                     SDL_GPU_TEXTUREUSAGE_COLOR_TARGET | SDL_GPU_TEXTUREUSAGE_SAMPLER);
  const int64_t frames = int64_t(b.fps) * b.seconds;
  const double budget = 1000.0 / b.fps;
  bool paced = !flag(argc, argv, "--unpaced");
  std::vector<double> ms;
  int dropped = 0;
  SDL_GPUFence* prev = nullptr;
  auto start = std::chrono::steady_clock::now();
  for (int64_t f = 0; f < frames; ++f) {
    auto t0 = std::chrono::steady_clock::now();
    SDL_GPUCommandBuffer* cmd = SDL_AcquireGPUCommandBuffer(gpu.device());
    ren.render(cmd, p, s, frameStart(f, s.rate), work);
    ren.output(cmd, work, view, p, s.background);
    SDL_GPUFence* fence = SDL_SubmitGPUCommandBufferAndAcquireFence(cmd);
    // a swapchain keeps one frame in flight: wait for the previous one
    if (prev) {
      SDL_WaitForGPUFences(gpu.device(), true, &prev, 1);
      SDL_ReleaseGPUFence(gpu.device(), prev);
    }
    prev = fence;
    double d = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
    ms.push_back(d);
    if (paced) {
      // a real-time clock: a frame late past its slot is a drop (the next is shown instead)
      double due = (f + 1) * budget;
      double now = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - start).count();
      if (now > due + budget) {
        int64_t skip = int64_t((now - due) / budget);
        dropped += int(skip);
        f += skip;
      } else if (now < due) {
        SDL_DelayPrecise(Uint64((due - now) * 1e6));
      }
    }
  }
  if (prev) {
    SDL_WaitForGPUFences(gpu.device(), true, &prev, 1);
    SDL_ReleaseGPUFence(gpu.device(), prev);
  }
  double total = std::chrono::duration<double>(std::chrono::steady_clock::now() - start).count();
  // scrubbing: random seeks, time to the frame on screen
  std::mt19937 rng(5);
  std::vector<double> seek;
  for (int i = 0; i < 40; ++i) {
    int64_t f = int64_t(rng() % uint64_t(frames));
    auto t0 = std::chrono::steady_clock::now();
    SDL_GPUCommandBuffer* cmd = SDL_AcquireGPUCommandBuffer(gpu.device());
    ren.render(cmd, p, s, frameStart(f, s.rate), work);
    ren.output(cmd, work, view, p, s.background);
    SDL_GPUFence* fence = SDL_SubmitGPUCommandBufferAndAcquireFence(cmd);
    SDL_WaitForGPUFences(gpu.device(), true, &fence, 1);
    SDL_ReleaseGPUFence(gpu.device(), fence);
    seek.push_back(std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count());
  }
  auto st = pool.stats();
  nlohmann::json j{{"tracks", b.tracks},
                   {"size", std::to_string(b.w) + "x" + std::to_string(b.h)},
                   {"fps", b.fps},
                   {"codec", b.codec},
                   {"decode", flag(argc, argv, "--sw-decode") ? "software" : (nvdecAvailable() ? "nvdec" : "software")},
                   {"paced", paced},
                   {"frames", frames},
                   {"dropped", dropped},
                   {"wall_s", total},
                   {"achieved_fps", double(frames - dropped) / total},
                   {"frame_ms_p50", pct(ms, 0.5)},
                   {"frame_ms_p95", pct(ms, 0.95)},
                   {"frame_ms_p99", pct(ms, 0.99)},
                   {"frame_ms_max", pct(ms, 1)},
                   {"seek_ms_p50", pct(seek, 0.5)},
                   {"seek_ms_p95", pct(seek, 0.95)},
                   {"seek_ms_max", pct(seek, 1)},
                   {"prefetch_waits", st.waits},
                   {"prefetch_hits", st.hits}};
  std::printf("%s\n", j.dump(2).c_str());
  gpu.release(work);
  gpu.release(view);
  return 0;
}

int cmdBenchExport(int argc, char** argv) {
  BenchSpec b = benchSpec(argc, argv);
  auto files = benchSources(b);
  if (files.empty()) return 1;
  ExportJob job;
  job.project = benchProject(b, files);
  const Preset* pr = findPreset(arg(argc, argv, "--preset", "youtube-4k"));
  if (!pr) return usage();
  job.preset = *pr;
  job.preset.width = job.preset.height = 0;
  fs::path out = fs::path(files[0]).parent_path() / ("export-" + pr->id + "." + pr->ext);
  job.path = out.string();
  ExportProgress sum;
  auto t0 = std::chrono::steady_clock::now();
  std::string e = runExport(job, {}, &sum);
  if (!e.empty()) {
    std::fprintf(stderr, "rpro: %s\n", e.c_str());
    return 1;
  }
  double el = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
  nlohmann::json j{{"preset", pr->id}, {"encoder", sum.encoder}, {"frames", sum.total}, {"seconds", el},
                   {"fps", double(sum.total) / el}, {"realtime_x", double(sum.total) / el / b.fps},
                   {"bytes", fs::file_size(out)}};
  std::printf("%s\n", j.dump(2).c_str());
  return 0;
}

}  // namespace

int main(int argc, char** argv) {
  if (argc < 2) return usage();
  std::string c = argv[1];
  if (c == "probe") return cmdProbe(argc, argv);
  if (c == "presets") {
    for (auto& p : presets()) std::printf("%-20s %s\n", p.id.c_str(), p.name.c_str());
    return 0;
  }
  if (c == "new") return cmdNew(argc, argv);
  if (c == "export") return cmdExport(argc, argv);
  if (c == "frame") return cmdFrame(argc, argv);
  if (c == "loudness") return cmdLoudness(argc, argv);
  if (c == "convert") return cmdConvert(argc, argv);
  if (c == "bench" && argc > 2 && std::string(argv[2]) == "playback") return cmdBenchPlayback(argc, argv);
  if (c == "bench" && argc > 2 && std::string(argv[2]) == "export") return cmdBenchExport(argc, argv);
  return usage();
}
