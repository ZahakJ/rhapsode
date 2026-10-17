#include "sound.h"

#include <sys/wait.h>
#include <unistd.h>

#include <algorithm>
#include <cmath>
#include <filesystem>
#include <map>
#include <vector>

#include "../media/decode.h"
#include "../model/edit.h"

namespace rhap::ai {

namespace fs = std::filesystem;

namespace {
/** runs argv, quietly; returns its exit status (127 when it could not start) */
int run(const std::vector<std::string>& argv) {
  pid_t pid = fork();
  if (pid == 0) {
    std::vector<char*> a;
    for (auto& s : argv) a.push_back(const_cast<char*>(s.c_str()));
    a.push_back(nullptr);
    if (FILE* devnull = std::fopen("/dev/null", "w")) {
      dup2(fileno(devnull), 1);
      dup2(fileno(devnull), 2);
    }
    execvp(a[0], a.data());
    _exit(127);
  }
  int st = 0;
  waitpid(pid, &st, 0);
  return WIFEXITED(st) ? WEXITSTATUS(st) : 128;
}
}  // namespace

namespace {

/** the noise floor: the 10th percentile of 50 ms RMS levels, dBFS */
double noiseFloorDb(const std::string& src) {
  AudioDecoder d;
  if (!d.open(src, 48000, 2).empty()) return -50;
  std::vector<double> lv;
  std::vector<float> buf(2400 * 2);
  for (int64_t at = 0; at + 2400 <= d.lengthSamples(); at += 2400) {
    d.read(at, buf.data(), 2400);
    double e = 0;
    for (float v : buf) e += double(v) * v;
    lv.push_back(10 * std::log10(e / double(buf.size()) + 1e-20));
  }
  if (lv.empty()) return -50;
  std::sort(lv.begin(), lv.end());
  return lv[lv.size() / 10];
}

/** how many samples a filter chain delays its output, measured with an impulse */
int64_t chainDelay(const std::string& af) {
  static std::map<std::string, int64_t> cache;
  auto it = cache.find(af);
  if (it != cache.end()) return it->second;
  fs::path f = fs::temp_directory_path() / ("rhap-delay-" + std::to_string(getpid()) + ".f32");
  int r = run({"ffmpeg", "-nostdin", "-y", "-loglevel", "error", "-f", "lavfi", "-i",
               "aevalsrc='if(eq(n,24000),0.9,0)':s=48000:d=2", "-af", af, "-f", "f32le", "-ac", "1", f.string()});
  int64_t delay = 0;
  if (r == 0) {
    std::vector<float> y(size_t(fs::file_size(f) / 4));
    if (FILE* fp = std::fopen(f.c_str(), "rb")) {
      size_t got = std::fread(y.data(), 4, y.size(), fp);
      std::fclose(fp);
      y.resize(got);
    }
    size_t best = 24000;
    for (size_t i = 24000; i < y.size() && i < 24000 + 48000; ++i)
      if (std::fabs(y[i]) > std::fabs(y[best])) best = i;
    delay = int64_t(best) - 24000;
  }
  fs::remove(f);
  cache[af] = delay;
  return delay;
}

}  // namespace

std::string denoise(const std::string& src, const std::string& out, const DenoiseOptions& o) {
  double nf = std::clamp(noiseFloorDb(src), -80.0, -20.0);
  std::string af = "afftdn=nr=" + std::to_string(o.reductionDb) + ":nf=" + std::to_string(nf);
  if (o.highpassHz > 0) af = "highpass=f=" + std::to_string(o.highpassHz) + "," + af;
  // the spectral filter answers late; trim its delay off the front and pad the end, so every sample keeps its place
  int64_t d = chainDelay(af);
  std::string chain = af;
  if (d > 0) chain += ",atrim=start_sample=" + std::to_string(d) + ",asetpts=PTS-STARTPTS,apad=pad_len=" + std::to_string(d);
  std::string part = out + ".part.flac";
  int r = run({"ffmpeg", "-nostdin", "-y", "-loglevel", "error", "-i", src, "-vn", "-map", "0:a:0", "-af",
               "aresample=48000," + chain, "-c:a", "flac", part});
  if (r != 0) {
    fs::remove(part);
    return "ffmpeg could not clean the sound (exit " + std::to_string(r) + ")";
  }
  fs::rename(part, out);
  return {};
}

std::string isolateVoice(const std::string& src, const std::string& out, const std::string& demucs) {
  fs::path work = fs::path(out).parent_path() / (".demucs-" + std::to_string(getpid()));
  fs::create_directories(work);
  std::string wav = (work / "in.wav").string();
  if (run({"ffmpeg", "-nostdin", "-y", "-loglevel", "error", "-i", src, "-vn", "-map", "0:a:0", "-ac", "2", "-ar", "44100",
           "-c:a", "pcm_s16le", wav}) != 0) {
    fs::remove_all(work);
    return "ffmpeg could not read the sound";
  }
  int r = run({demucs, "-n", "htdemucs", "--two-stems=vocals", "-o", work.string(), "--filename", "{stem}.{ext}", wav});
  fs::path vocals = work / "htdemucs" / "vocals.wav";
  if (r != 0 || !fs::exists(vocals)) {
    fs::remove_all(work);
    return r == 127 ? "Demucs is not installed (uv tool install demucs)" : "Demucs failed";
  }
  r = run({"ffmpeg", "-nostdin", "-y", "-loglevel", "error", "-i", vocals.string(), "-ar", "48000", "-c:a", "flac", out});
  fs::remove_all(work);
  return r == 0 ? std::string() : "could not write " + out;
}

std::string removeBackground(const std::string& src, Tick in, Tick span, Rate rate, const std::string& out,
                             const std::string& model, int maxHeight, const std::string& rembg) {
  fs::path work = fs::path(out).parent_path() / (".matte-" + std::to_string(getpid()) + "-" + std::to_string(in));
  fs::create_directories(work / "in");
  fs::create_directories(work / "out");
  char ss[32], tt[32], fr[48];
  std::snprintf(ss, sizeof ss, "%.6f", toSeconds(in));
  std::snprintf(tt, sizeof tt, "%.6f", toSeconds(span));
  std::snprintf(fr, sizeof fr, "%lld/%lld", (long long)rate.num, (long long)rate.den);
  std::string vf = "fps=" + std::string(fr) + ",scale=-2:'min(ih," + std::to_string(maxHeight) + ")'";
  if (run({"ffmpeg", "-nostdin", "-y", "-loglevel", "error", "-ss", ss, "-t", tt, "-i", src, "-vf", vf, "-an",
           (work / "in" / "%06d.png").string()}) != 0) {
    fs::remove_all(work);
    return "ffmpeg could not read the picture";
  }
  int r = run({rembg, "p", "-m", model, (work / "in").string(), (work / "out").string()});
  if (r != 0) {
    fs::remove_all(work);
    return r == 127 ? "rembg is not installed (uv tool install \"rembg[cpu,cli]\")" : "rembg failed";
  }
  r = run({"ffmpeg", "-nostdin", "-y", "-loglevel", "error", "-framerate", fr, "-i", (work / "out" / "%06d.png").string(),
           "-c:v", "png", "-pix_fmt", "rgba", out});
  fs::remove_all(work);
  return r == 0 ? std::string() : "could not write " + out;
}

std::string swapPicture(Project& p, const std::string& seqId, const std::string& clipId, const std::string& path) {
  Sequence* s = p.findSequence(seqId);
  if (!s) return "no such sequence";
  Clip* c = clipById(*s, clipId);
  if (!c || c->kind != ClipKind::Media) return "not a media clip";
  const Media* orig = p.findMedia(c->ref);
  Media m;
  m.id = p.makeId("m");
  if (std::string e = probe(path, m); !e.empty()) return e;
  m.name = (orig ? orig->name : "clip") + " · cut out";
  p.media.push_back(m);
  c->ref = m.id;
  c->in = 0;
  Tick limit = m.duration;
  if (c->sourceSpan() > limit) c->dur = Tick(double(limit) / std::fabs(c->speed));  // a frame short at most
  return {};
}

std::string swapSound(Project& p, const std::string& seqId, const std::string& clipId, const std::string& path,
                      const std::string& suffix) {
  Sequence* s = p.findSequence(seqId);
  if (!s) return "no such sequence";
  Clip* c = clipById(*s, clipId);
  if (!c || c->kind != ClipKind::Media) return "not a media clip";
  const Media* orig = p.findMedia(c->ref);
  if (!orig) return "the clip has no media";
  std::string id;
  for (auto& m : p.media)
    if (m.path == path) id = m.id;
  if (id.empty()) {
    Media m;
    m.id = p.makeId("m");
    if (std::string e = probe(path, m); !e.empty()) return e;
    m.name = orig->name + " · " + suffix;
    m.startTimecode = orig->startTimecode;
    p.media.push_back(m);
    id = m.id;
    // the processed file must cover what the clip plays
    if (m.duration + kFlicks / 100 < c->in + c->sourceSpan()) return "the processed sound is shorter than the clip";
  }
  c->ref = id;
  return {};
}

}  // namespace rhap::ai
