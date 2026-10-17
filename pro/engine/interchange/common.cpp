#include "common.h"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <set>
#include <cstdio>
#include <filesystem>
#include <numeric>

#include "../media/decode.h"

namespace rhap::ix {

namespace fs = std::filesystem;

std::string pathFromUrl(const std::string& url) {
  std::string s = url;
  for (const char* pre : {"file://localhost", "file://"})
    if (s.rfind(pre, 0) == 0) {
      s = s.substr(std::string(pre).size());
      break;
    }
  std::string out;
  for (size_t i = 0; i < s.size(); ++i) {
    if (s[i] == '%' && i + 2 < s.size() && std::isxdigit(static_cast<unsigned char>(s[i + 1])) &&
        std::isxdigit(static_cast<unsigned char>(s[i + 2]))) {
      out += char(std::stoi(s.substr(i + 1, 2), nullptr, 16));
      i += 2;
    } else {
      out += s[i];
    }
  }
  return out;
}

std::string urlFromPath(const std::string& path) {
  std::string out = "file://";
  for (unsigned char c : path) {
    if (std::isalnum(c) || c == '/' || c == '-' || c == '_' || c == '.' || c == '~') {
      out += char(c);
    } else {
      char b[4];
      std::snprintf(b, sizeof b, "%%%02X", c);
      out += b;
    }
  }
  return out;
}

std::string fileStem(const std::string& path) { return fs::path(path).stem().string(); }
std::string dirOf(const std::string& path) { return fs::path(path).parent_path().string(); }

Media& mediaFor(Project& p, const std::string& rawPath, const std::string& name, Tick claimed, const ImportOptions& o,
                const std::string& baseDir) {
  std::string path = rawPath;
  std::error_code ec;
  if (!path.empty() && !fs::exists(path, ec) && !baseDir.empty()) {
    // moved with the project: look beside the interchange file
    fs::path alt = fs::path(baseDir) / fs::path(path).filename();
    if (fs::exists(alt, ec)) path = alt.string();
    else if (fs::path(path).is_relative() && fs::exists(fs::path(baseDir) / path, ec)) path = (fs::path(baseDir) / path).string();
  }
  for (auto& m : p.media)
    if (m.path == path && !path.empty()) return m;
  Media m;
  m.id = p.makeId("m");
  m.name = name.empty() ? fs::path(path).filename().string() : name;
  m.path = path;
  bool probed = false;
  if (o.probeMedia && !path.empty() && fs::exists(path, ec)) probed = probe(path, m).empty();
  if (!probed) {
    // offline: trust what the interchange file said
    m.kind = MediaKind::Video;
    m.hasVideo = true;
    m.hasAudio = true;
    m.channels = 2;
    m.sampleRate = 48000;
    m.duration = claimed > 0 ? claimed : 3600 * kFlicks;
  }
  if (m.name.empty()) m.name = name;
  p.media.push_back(m);
  return p.media.back();
}

Sequence& addSequence(Project& p, const std::string& name, int w, int h, Rate rate, int video, int audio) {
  Sequence s;
  s.id = p.makeId("s");
  s.name = name.empty() ? "Sequence" : name;
  s.width = w > 0 ? w : 1920;
  s.height = h > 0 ? h : 1080;
  s.rate = rate;
  for (int i = 0; i < video; ++i) s.video.push_back(Track{.id = p.makeId("t"), .kind = TrackKind::Video, .name = "V" + std::to_string(i + 1)});
  for (int i = 0; i < audio; ++i) s.audio.push_back(Track{.id = p.makeId("t"), .kind = TrackKind::Audio, .name = "A" + std::to_string(i + 1)});
  p.sequences.push_back(std::move(s));
  return p.sequences.back();
}

void place(Sequence& s, TrackRef r, Clip c) {
  auto& v = r.kind == TrackKind::Video ? s.video : s.audio;
  while (int(v.size()) <= r.index) {
    Track t;
    t.id = s.id + "-" + (r.kind == TrackKind::Video ? "v" : "a") + std::to_string(v.size() + 1);
    t.kind = r.kind;
    t.name = (r.kind == TrackKind::Video ? "V" : "A") + std::to_string(v.size() + 1);
    v.push_back(t);
  }
  Track& t = v[size_t(r.index)];
  if (c.dur <= 0) return;
  for (auto& o : t.clips)
    if (o.start < c.end() && c.start < o.end()) return;
  t.clips.push_back(std::move(c));
  std::sort(t.clips.begin(), t.clips.end(), [](const Clip& a, const Clip& b) { return a.start < b.start; });
}

Rate rateOf(double fps) {
  for (Rate r : {Rate{24, 1}, Rate{25, 1}, Rate{30, 1}, Rate{48, 1}, Rate{50, 1}, Rate{60, 1}, Rate{120, 1}, kRate23976,
                 kRate2997, kRate5994})
    if (std::fabs(r.fps() - fps) < 0.005) return r;
  return Rate{int64_t(std::lround(fps * 1000)), 1000};
}

std::string rationalSeconds(Tick t) {
  int64_t g = std::gcd(t < 0 ? -t : t, kFlicks);
  if (g == 0) return "0s";
  int64_t num = t / g, den = kFlicks / g;
  return den == 1 ? std::to_string(num) + "s" : std::to_string(num) + "/" + std::to_string(den) + "s";
}

Tick parseRationalSeconds(const std::string& s) {
  if (s.empty()) return 0;
  std::string v = s.back() == 's' ? s.substr(0, s.size() - 1) : s;
  auto slash = v.find('/');
  if (slash == std::string::npos) return fromSeconds(std::stod(v));
  long double num = std::stold(v.substr(0, slash)), den = std::stold(v.substr(slash + 1));
  return Tick(std::llround(num * (long double)kFlicks / den));
}

void finish(Project& p, const std::string& active) {
  p.active = active;
  if (p.active.empty() && !p.sequences.empty()) p.active = p.sequences.front().id;
  // ids made by imports must be unique project-wide
  std::set<std::string> seen;
  for (auto& s : p.sequences)
    forEachTrack(s, [&](Track& t, TrackRef) {
      for (auto& c : t.clips)
        if (c.id.empty() || !seen.insert(c.id).second) c.id = p.makeId("c");
    });
}

}  // namespace rhap::ix
