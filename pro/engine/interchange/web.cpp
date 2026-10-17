// A Rhapsode web studio sequence (shared/sequence.ts, v1) as a Pro project:
// visual tracks become picture tracks (with each clip's own sound linked on
// a sound track), audio tracks sound tracks, text tracks titles.
#include <cmath>
#include <filesystem>
#include <nlohmann/json.hpp>

#include "../audio/dsp.h"
#include "common.h"

namespace rhap::ix {

using nlohmann::json;

namespace {
std::array<double, 4> hex(const std::string& h, double a = 1) {
  if (h.size() != 6) return {1, 1, 1, a};
  auto v = [&](int i) { return std::stoi(h.substr(size_t(i), 2), nullptr, 16) / 255.0; };
  return {v(0), v(2), v(4), a};
}
}  // namespace

std::string readWeb(const std::string& text, const std::string& baseDir, Project& p, const ImportOptions& o) {
  json j;
  try {
    j = json::parse(text);
  } catch (const std::exception& e) {
    return std::string("not JSON: ") + e.what();
  }
  if (j.contains("sequence")) j = j["sequence"];
  if (j.value("v", 0) != 1 || !j.contains("tracks")) return "not a Rhapsode sequence";
  json canvas = j.value("canvas", json::object());
  std::string aspect = canvas.value("aspect", "16:9");
  int W = 1920, H = 1080;
  if (aspect == "9:16") W = 1080, H = 1920;
  else if (aspect == "1:1") W = 1080, H = 1080;
  else if (aspect == "4:5") W = 1080, H = 1350;
  auto mediaOf = [&](const std::string& id) -> Media& {
    auto it = o.sources.find(id);
    if (it != o.sources.end()) return mediaFor(p, it->second, id, 0, o, baseDir);
    // a hand-written sequence may name files instead of server ids
    std::filesystem::path f = std::filesystem::path(id).is_absolute() ? std::filesystem::path(id) : std::filesystem::path(baseDir) / id;
    std::error_code ec;
    bool file = std::filesystem::exists(f, ec);
    return mediaFor(p, file ? f.string() : "", file ? f.filename().string() : id, 0, o, baseDir);
  };
  if (aspect == "source" && canvas.contains("sourceOf")) {
    Media& m = mediaOf(canvas["sourceOf"]);
    if (m.width > 0) W = m.width + (m.width & 1), H = m.height + (m.height & 1);
  }
  Rate rate{canvas.value("fps", 30), 1};
  Sequence& s0 = addSequence(p, j.value("title", "Quick edit"), W, H, rate, 0, 0);
  std::string sid = s0.id;
  if (canvas.contains("background")) s0.background = {hex(canvas["background"])[0], hex(canvas["background"])[1], hex(canvas["background"])[2]};
  int vi = 0, ai = 0;
  auto sec = [](const json& c, const char* k, double d = 0) { return fromSeconds(c.value(k, d)); };
  // the web stacks visual tracks bottom → top in array order, as Pro does
  for (const json& t : j["tracks"]) {
    std::string kind = t.value("kind", "");
    bool muted = t.value("muted", false);
    if (kind == "visual") {
      TrackRef vr{TrackKind::Video, vi++};
      TrackRef ar{TrackKind::Audio, ai++};
      Sequence& s = *p.findSequence(sid);
      place(s, vr, Clip{});
      place(s, ar, Clip{});
      trackOf(s, vr)->name = t.value("name", "video");
      trackOf(s, vr)->hidden = muted;
      for (const json& c : t["clips"]) {
        Media& m = mediaOf(c.value("source", ""));
        Clip v;
        v.id = p.makeId("c");
        v.kind = ClipKind::Media;
        v.ref = m.id;
        v.name = m.name;
        v.start = sec(c, "at");
        v.dur = sec(c, "duration");
        v.in = m.kind == MediaKind::Image ? 0 : sec(c, "in");
        double sw = m.width > 0 ? m.width : W, sh = m.height > 0 ? m.height : H;
        double base = std::min(W / sw, H / sh);
        std::string fit = c.value("fit", "contain");
        double scale = 1, cx = 0, cy = 0;
        if (fit == "cover") scale = std::max(W / sw, H / sh) / base;
        if (fit == "free" && c.contains("box")) {
          const json& b = c["box"];
          double bw = b.value("w", 1.0) * W;
          scale = bw / (sw * base);
          double bh = bw * sh / sw;
          cx = b.value("x", 0.0) * W + bw / 2 - W / 2.0;
          cy = b.value("y", 0.0) * H + bh / 2 - H / 2.0;
        }
        if (c.contains("transform")) {
          const json& x = c["transform"];
          cx += x.value("x", 0.0) * W;
          cy += x.value("y", 0.0) * H;
          scale *= x.value("scale", 1.0);
          v.xf.rotation = x.value("rotate", 0.0);
        }
        v.xf.scale = scale;
        v.xf.x = cx;
        v.xf.y = cy;
        double op = c.value("opacity", 1.0), fi = c.value("fadeIn", 0.0), fo = c.value("fadeOut", 0.0);
        if (fi > 0 || fo > 0) {
          if (fi > 0) {
            v.xf.opacity.setKey(0, 0);
            v.xf.opacity.setKey(fromSeconds(fi), op);
          }
          if (fo > 0) {
            v.xf.opacity.setKey(std::max<Tick>(0, v.dur - fromSeconds(fo)), op);
            v.xf.opacity.setKey(v.dur, 0);
          }
          if (fi <= 0) v.xf.opacity.setKey(0, op);
        } else {
          v.xf.opacity = op;
        }
        if (c.contains("look")) {
          const json& l = c["look"];
          v.grade.contrast = l.value("contrast", 1.0);
          v.grade.saturation = l.value("grayscale", false) ? 0 : l.value("saturation", 1.0);
          double g = l.value("gamma", 1.0);
          v.grade.gamma = {g, g, g};
          double br = l.value("brightness", 0.0);
          v.grade.offset = {br, br, br};
          if (double bl = l.value("blur", 0.0); bl > 0) v.fx.push_back(Effect{"blur", true, {{"radius", Param(bl)}}});
          if (double vg = l.value("vignette", 0.0); vg > 0) v.fx.push_back(Effect{"vignette", true, {{"amount", Param(vg)}}});
        }
        double vol = c.value("volume", 1.0);
        std::string soundFrom = c.value("soundFrom", "");
        Media* sm = soundFrom.empty() ? &m : &mediaOf(soundFrom);
        if (vol > 0 && sm->hasAudio && m.kind != MediaKind::Image) {
          Clip a;
          a.id = p.makeId("c");
          a.kind = ClipKind::Media;
          a.ref = sm->id;
          a.name = sm->name;
          a.start = v.start;
          a.dur = v.dur;
          a.in = v.in;
          a.gain = audio::toDb(vol);
          v.link = a.link = p.makeId("l");
          place(*p.findSequence(sid), ar, a);
        }
        place(*p.findSequence(sid), vr, v);
      }
    } else if (kind == "audio") {
      TrackRef ar{TrackKind::Audio, ai++};
      Sequence& s = *p.findSequence(sid);
      place(s, ar, Clip{});
      trackOf(s, ar)->name = t.value("name", "audio");
      trackOf(s, ar)->mute = muted;
      for (const json& c : t["clips"]) {
        Media& m = mediaOf(c.value("source", ""));
        Clip a;
        a.id = p.makeId("c");
        a.kind = ClipKind::Media;
        a.ref = m.id;
        a.name = m.name;
        a.start = sec(c, "at");
        a.in = sec(c, "in");
        a.dur = sec(c, "out") - a.in;
        a.gain = audio::toDb(c.value("gain", 1.0));
        a.fadeIn = sec(c, "fadeIn");
        a.fadeOut = sec(c, "fadeOut");
        place(*p.findSequence(sid), ar, a);
      }
    } else if (kind == "text") {
      TrackRef vr{TrackKind::Video, vi++};
      Sequence& s = *p.findSequence(sid);
      place(s, vr, Clip{});
      trackOf(s, vr)->name = t.value("name", "text");
      trackOf(s, vr)->hidden = muted;
      for (const json& c : t["clips"]) {
        Clip x;
        x.id = p.makeId("c");
        x.kind = ClipKind::Title;
        x.start = sec(c, "at");
        x.dur = sec(c, "duration");
        x.text = c.value("text", "");
        if (c.contains("sub") && !c["sub"].get<std::string>().empty()) x.text += "\n" + c["sub"].get<std::string>();
        x.name = x.text.substr(0, 40);
        std::string style = c.value("style", "outline");
        x.style.font = style == "outline" ? "Anton" : "Plex";
        x.style.size = c.value("size", 0.055) * H;
        x.style.color = hex(c.value("color", "ffffff"));
        x.style.outlineWidth = style == "outline" ? x.style.size * 0.08 : 0;
        if (style == "box") x.style.box = {0, 0, 0, 0.6};
        std::string al = c.value("align", "center");
        x.style.align = al == "left" ? 0 : al == "right" ? 2 : 1;
        x.xf.x = (c.value("x", 0.5) - 0.5) * W;
        x.xf.y = (c.value("y", 0.88) - 0.5) * H;
        place(*p.findSequence(sid), vr, x);
      }
    }
  }
  Sequence& s = *p.findSequence(sid);
  if (s.video.empty()) place(s, {TrackKind::Video, 0}, Clip{});
  if (s.audio.empty()) place(s, {TrackKind::Audio, 0}, Clip{});
  finish(p, sid);
  return {};
}

}  // namespace rhap::ix
