#include "project_io.h"

#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

#include <cstdio>
#include <filesystem>
#include <fstream>
#include <nlohmann/json.hpp>
#include <sstream>
#include <stdexcept>

namespace rhap {

using nlohmann::json;

NLOHMANN_JSON_SERIALIZE_ENUM(Ease, {{Ease::Linear, "linear"},
                                    {Ease::Hold, "hold"},
                                    {Ease::In, "in"},
                                    {Ease::Out, "out"},
                                    {Ease::InOut, "inout"},
                                    {Ease::Bezier, "bezier"}})
NLOHMANN_JSON_SERIALIZE_ENUM(MediaKind, {{MediaKind::Video, "video"}, {MediaKind::Audio, "audio"}, {MediaKind::Image, "image"}})
NLOHMANN_JSON_SERIALIZE_ENUM(ClipKind, {{ClipKind::Media, "media"},
                                        {ClipKind::Nested, "nested"},
                                        {ClipKind::Title, "title"},
                                        {ClipKind::Shape, "shape"},
                                        {ClipKind::Solid, "solid"},
                                        {ClipKind::Adjustment, "adjustment"},
                                        {ClipKind::Multicam, "multicam"}})
NLOHMANN_JSON_SERIALIZE_ENUM(Blend, {{Blend::Normal, "normal"},
                                     {Blend::Add, "add"},
                                     {Blend::Multiply, "multiply"},
                                     {Blend::Screen, "screen"},
                                     {Blend::Overlay, "overlay"}})
NLOHMANN_JSON_SERIALIZE_ENUM(ShapeKind, {{ShapeKind::Rect, "rect"}, {ShapeKind::Ellipse, "ellipse"}})
NLOHMANN_JSON_SERIALIZE_ENUM(TransitionKind, {{TransitionKind::Dissolve, "dissolve"},
                                              {TransitionKind::DipToBlack, "dip"},
                                              {TransitionKind::Wipe, "wipe"},
                                              {TransitionKind::Crossfade, "crossfade"}})
NLOHMANN_JSON_SERIALIZE_ENUM(TrackKind, {{TrackKind::Video, "video"}, {TrackKind::Audio, "audio"}})
NLOHMANN_JSON_SERIALIZE_ENUM(WorkingSpace, {{WorkingSpace::Rec709, "rec709"},
                                            {WorkingSpace::ACEScct, "acescct"},
                                            {WorkingSpace::Rec2020, "rec2020"}})
NLOHMANN_JSON_SERIALIZE_ENUM(OutputSpace, {{OutputSpace::Rec709, "rec709"},
                                           {OutputSpace::sRGB, "srgb"},
                                           {OutputSpace::Rec2020PQ, "rec2020pq"},
                                           {OutputSpace::Rec2020HLG, "rec2020hlg"}})

void to_json(json& j, const Rate& r) { j = json::array({r.num, r.den}); }
void from_json(const json& j, Rate& r) {
  r.num = j.at(0).get<int64_t>();
  r.den = j.at(1).get<int64_t>();
  if (r.num <= 0 || r.den <= 0) throw std::runtime_error("a frame rate must be positive");
}

NLOHMANN_DEFINE_TYPE_NON_INTRUSIVE_WITH_DEFAULT(Keyframe, t, v, ease, x1, y1, x2, y2)

void to_json(json& j, const Param& p) {
  if (p.keys.empty())
    j = p.value;
  else
    j = json{{"v", p.value}, {"keys", p.keys}};
}
void from_json(const json& j, Param& p) {
  if (j.is_number()) {
    p.value = j.get<double>();
    p.keys.clear();
    return;
  }
  p.value = j.value("v", 0.0);
  p.keys = j.value("keys", std::vector<Keyframe>{});
  for (size_t i = 1; i < p.keys.size(); ++i)
    if (p.keys[i - 1].t >= p.keys[i].t) throw std::runtime_error("keyframes out of order");
}

NLOHMANN_DEFINE_TYPE_NON_INTRUSIVE_WITH_DEFAULT(ColorInfo, primaries, transfer, matrix, range, bitDepth)
NLOHMANN_DEFINE_TYPE_NON_INTRUSIVE_WITH_DEFAULT(Media, id, path, proxy, name, kind, duration, rate, vfr, width, height,
                                                hasVideo, hasAudio, channels, sampleRate, videoCodec, audioCodec, color,
                                                startTimecode)
NLOHMANN_DEFINE_TYPE_NON_INTRUSIVE_WITH_DEFAULT(Transform, x, y, scale, scaleY, rotation, anchorX, anchorY, opacity,
                                                cropL, cropR, cropT, cropB, flipH, flipV)
NLOHMANN_DEFINE_TYPE_NON_INTRUSIVE_WITH_DEFAULT(CurvePoint, x, y)
NLOHMANN_DEFINE_TYPE_NON_INTRUSIVE_WITH_DEFAULT(Grade, lift, gamma, gain, offset, exposure, contrast, pivot,
                                                saturation, temperature, tint, master, red, green, blue, lut, lutMix,
                                                enabled)
NLOHMANN_DEFINE_TYPE_NON_INTRUSIVE_WITH_DEFAULT(Effect, type, enabled, params)
NLOHMANN_DEFINE_TYPE_NON_INTRUSIVE_WITH_DEFAULT(TextStyle, font, size, color, outline, outlineWidth, box, align,
                                                lineSpacing)
NLOHMANN_DEFINE_TYPE_NON_INTRUSIVE_WITH_DEFAULT(Clip, id, kind, ref, name, start, dur, in, speed, enabled, label, link,
                                                xf, grade, blend, fx, text, style, shape, fill, angle, gain, pan, afx,
                                                fadeIn, fadeOut)
NLOHMANN_DEFINE_TYPE_NON_INTRUSIVE_WITH_DEFAULT(Transition, id, at, dur, kind)
NLOHMANN_DEFINE_TYPE_NON_INTRUSIVE_WITH_DEFAULT(Track, id, kind, name, mute, solo, locked, hidden, syncLock, clips,
                                                transitions, gain, pan, fx, bus)
NLOHMANN_DEFINE_TYPE_NON_INTRUSIVE_WITH_DEFAULT(Marker, id, t, dur, name, note, color)
NLOHMANN_DEFINE_TYPE_NON_INTRUSIVE_WITH_DEFAULT(Sequence, id, name, width, height, rate, sampleRate, background, video,
                                                audio, markers, multicam)
NLOHMANN_DEFINE_TYPE_NON_INTRUSIVE_WITH_DEFAULT(Project, version, name, media, sequences, active, working, output,
                                                nextId)

json toJson(const Project& p) { return p; }
json clipJson(const Clip& c) { return c; }
Clip clipFromJson(const json& j) { return j.get<Clip>(); }

Project projectFromJson(const json& j) {
  try {
    Project p = j.get<Project>();
    if (p.version > 1) throw std::runtime_error("made by a newer version of Rhapsode Pro");
    return p;
  } catch (const json::exception& e) {
    throw std::runtime_error(std::string("not a valid project: ") + e.what());
  }
}

std::string serialize(const Project& p) { return json(p).dump(); }

Project deserialize(const std::string& text) {
  json j;
  try {
    j = json::parse(text);
  } catch (const json::exception& e) {
    throw std::runtime_error(std::string("not JSON: ") + e.what());
  }
  return projectFromJson(j);
}

uint64_t fnv1a(const std::string& s) {
  uint64_t h = 1469598103934665603ull;
  for (unsigned char c : s) {
    h ^= c;
    h *= 1099511628211ull;
  }
  return h;
}

namespace {
std::string hex(uint64_t v) {
  char b[17];
  std::snprintf(b, sizeof b, "%016llx", (unsigned long long)v);
  return b;
}

std::string readFile(const std::string& path, bool& ok) {
  std::ifstream f(path, std::ios::binary);
  ok = bool(f);
  std::stringstream ss;
  ss << f.rdbuf();
  return ss.str();
}
}  // namespace

std::string writeAtomic(const std::string& path, const std::string& data) {
  namespace fs = std::filesystem;
  fs::path target(path);
  fs::path dir = target.parent_path().empty() ? fs::path(".") : target.parent_path();
  std::string tmp = (dir / ("." + target.filename().string() + ".tmp-" + std::to_string(::getpid()))).string();
  int fd = ::open(tmp.c_str(), O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0644);
  if (fd < 0) return "cannot write " + tmp;
  size_t off = 0;
  while (off < data.size()) {
    ssize_t n = ::write(fd, data.data() + off, data.size() - off);
    if (n <= 0) {
      ::close(fd);
      ::unlink(tmp.c_str());
      return "write failed (disk full?)";
    }
    off += size_t(n);
  }
  if (::fsync(fd) != 0) {
    ::close(fd);
    ::unlink(tmp.c_str());
    return "fsync failed";
  }
  ::close(fd);
  if (::rename(tmp.c_str(), path.c_str()) != 0) {
    ::unlink(tmp.c_str());
    return "rename failed";
  }
  int dfd = ::open(dir.c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  if (dfd >= 0) {
    ::fsync(dfd);
    ::close(dfd);
  }
  return {};
}

std::string saveProject(const Project& p, const std::string& path, SaveOptions o) {
  namespace fs = std::filesystem;
  std::string body = serialize(p);
  json file{{"format", "rhapsode-pro"}, {"version", 1}, {"fnv", hex(fnv1a(body))}, {"project", json::parse(body)}};
  std::string text = file.dump(1, '\t') + "\n";
  std::error_code ec;
  if (o.backups > 0 && fs::exists(path, ec)) {
    for (int i = o.backups; i > 1; --i) {
      std::string from = path + ".bak" + std::to_string(i - 1), to = path + ".bak" + std::to_string(i);
      if (fs::exists(from, ec)) fs::rename(from, to, ec);
    }
    fs::copy_file(path, path + ".bak1", fs::copy_options::overwrite_existing, ec);
  }
  return writeAtomic(path, text);
}

bool loadProject(const std::string& path, Project& out, std::string& err) {
  bool ok;
  std::string text = readFile(path, ok);
  if (!ok) {
    err = "cannot open " + path;
    return false;
  }
  try {
    json j = json::parse(text);
    if (j.value("format", "") != "rhapsode-pro") throw std::runtime_error("not a Rhapsode Pro project");
    std::string body = j.at("project").dump();
    if (j.value("fnv", "") != hex(fnv1a(body))) throw std::runtime_error("the file is damaged (checksum mismatch)");
    out = projectFromJson(j.at("project"));
    return true;
  } catch (const std::exception& e) {
    err = e.what();
    return false;
  }
}

std::string autosavePath(const std::string& projectPath) {
  std::filesystem::path p(projectPath);
  return (p.parent_path() / ("." + p.stem().string() + ".autosave.rpro")).string();
}

bool hasRecovery(const std::string& projectPath) {
  namespace fs = std::filesystem;
  std::error_code ec;
  std::string a = autosavePath(projectPath);
  if (!fs::exists(a, ec)) return false;
  if (!fs::exists(projectPath, ec)) return true;
  Project pa, pp;
  std::string e1, e2;
  if (!loadProject(a, pa, e1)) return false;
  if (!loadProject(projectPath, pp, e2)) return true;
  return !(pa == pp) && fs::last_write_time(a, ec) >= fs::last_write_time(projectPath, ec);
}

}  // namespace rhap
