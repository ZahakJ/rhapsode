// OpenTimelineIO JSON (Timeline.1 / Stack.1 / Track.1 / Clip.2 / Gap.1 / Transition.1).
#include <cmath>
#include <functional>
#include <nlohmann/json.hpp>

#include "../io/project_io.h"
#include "common.h"

namespace rhap::ix {

using nlohmann::json;

namespace {

json rt(Tick t, Rate r) {
  // values are frames at the sequence rate; fractional when the tick is between frames
  double v = double(t) * double(r.num) / (double(kFlicks) * double(r.den));
  if (std::fabs(v - std::round(v)) < 1e-9) v = std::round(v);
  return {{"OTIO_SCHEMA", "RationalTime.1"}, {"rate", r.fps()}, {"value", v}};
}
json range(Tick start, Tick dur, Rate r) {
  return {{"OTIO_SCHEMA", "TimeRange.1"}, {"start_time", rt(start, r)}, {"duration", rt(dur, r)}};
}
Tick fromRt(const json& j) {
  double rate = j.value("rate", 30.0), v = j.value("value", 0.0);
  if (rate <= 0) return 0;
  Rate R = rateOf(rate);
  if (std::fabs(v - std::round(v)) < 1e-9 && R.den != 1000) return frameStart(int64_t(std::llround(v)), R);
  return fromSeconds(v / rate);
}
std::string schema(const json& j) {
  std::string s = j.value("OTIO_SCHEMA", "");
  return s.substr(0, s.find('.'));
}
const char* markerColor(int c) {
  static const char* names[] = {"RED", "ORANGE", "YELLOW", "GREEN", "CYAN", "BLUE", "PURPLE", "MAGENTA", "WHITE", "BLACK"};
  return names[std::clamp(c, 0, 9)];
}
int markerColorOf(const std::string& s) {
  static const char* names[] = {"RED", "ORANGE", "YELLOW", "GREEN", "CYAN", "BLUE", "PURPLE", "MAGENTA", "WHITE", "BLACK"};
  for (int i = 0; i < 10; ++i)
    if (s == names[i]) return i;
  return 0;
}

json writeStack(const Project& p, const Sequence& s, int depth);

json writeTrack(const Project& p, const Sequence& s, const Track& t, int depth) {
  const Rate r = s.rate;
  json children = json::array();
  Tick pos = 0;
  for (size_t i = 0; i < t.clips.size(); ++i) {
    const Clip& c = t.clips[i];
    if (c.start > pos) children.push_back({{"OTIO_SCHEMA", "Gap.1"}, {"name", ""}, {"source_range", range(0, c.start - pos, r)}});
    for (auto& x : t.transitions)
      if (x.at == c.start && i > 0) {
        std::string type = x.kind == TransitionKind::Wipe ? "SMPTE_Wipe" : "SMPTE_Dissolve";
        children.push_back({{"OTIO_SCHEMA", "Transition.1"}, {"name", ""}, {"transition_type", type},
                            {"in_offset", rt(x.dur / 2, r)}, {"out_offset", rt(x.dur - x.dur / 2, r)},
                            {"metadata", {{"rhapsode", {{"kind", int(x.kind)}}}}}});
      }
    json meta{{"rhapsode", clipJson(c)}};
    if (c.kind == ClipKind::Nested || c.kind == ClipKind::Multicam) {
      const Sequence* n = p.findSequence(c.ref);
      if (n && depth < 8) {
        json st = writeStack(p, *n, depth + 1);
        st["source_range"] = range(c.in, c.dur, r);
        st["metadata"] = meta;
        children.push_back(st);
      }
    } else {
      json ref;
      if (c.kind == ClipKind::Media) {
        const Media* m = p.findMedia(c.ref);
        ref = {{"OTIO_SCHEMA", "ExternalReference.1"},
               {"name", m ? m->name : ""},
               {"target_url", m ? urlFromPath(m->path) : ""},
               {"available_range", m && m->duration > 0 ? range(0, m->duration, r) : json(nullptr)},
               {"metadata", json::object()}};
      } else {
        const char* kind = c.kind == ClipKind::Title ? "Title" : c.kind == ClipKind::Solid ? "SolidColor" : "Generator";
        ref = {{"OTIO_SCHEMA", "GeneratorReference.1"}, {"name", c.name}, {"generator_kind", kind},
               {"parameters", {{"text", c.text}}}, {"available_range", nullptr}, {"metadata", json::object()}};
      }
      json clip{{"OTIO_SCHEMA", "Clip.2"},
                {"name", c.name},
                {"source_range", range(c.in, c.dur, r)},
                {"media_references", {{"DEFAULT_MEDIA", ref}}},
                {"active_media_reference_key", "DEFAULT_MEDIA"},
                {"effects", json::array()},
                {"markers", json::array()},
                {"enabled", c.enabled},
                {"metadata", meta}};
      if (c.speed != 1) clip["effects"].push_back({{"OTIO_SCHEMA", "LinearTimeWarp.1"}, {"name", ""}, {"effect_name", ""},
                                                   {"time_scalar", c.speed}, {"metadata", json::object()}});
      children.push_back(clip);
    }
    pos = c.end();
  }
  return {{"OTIO_SCHEMA", "Track.1"},
          {"name", t.name},
          {"kind", t.kind == TrackKind::Video ? "Video" : "Audio"},
          {"children", children},
          {"source_range", nullptr},
          {"effects", json::array()},
          {"markers", json::array()},
          {"enabled", !(t.mute || t.hidden)},
          {"metadata", json::object()}};
}

json writeStack(const Project& p, const Sequence& s, int depth) {
  json tracks = json::array();
  for (auto& t : s.video) tracks.push_back(writeTrack(p, s, t, depth));
  for (auto& t : s.audio) tracks.push_back(writeTrack(p, s, t, depth));
  json markers = json::array();
  for (auto& m : s.markers)
    markers.push_back({{"OTIO_SCHEMA", "Marker.2"}, {"name", m.name}, {"comment", m.note}, {"color", markerColor(m.color)},
                       {"marked_range", range(m.t, m.dur, s.rate)}, {"metadata", json::object()}});
  return {{"OTIO_SCHEMA", "Stack.1"}, {"name", s.name},     {"children", tracks},          {"source_range", nullptr},
          {"effects", json::array()}, {"markers", markers}, {"enabled", true},             {"metadata",
          {{"rhapsode", {{"width", s.width}, {"height", s.height}, {"rate", {s.rate.num, s.rate.den}}, {"multicam", s.multicam}}}}}};
}

struct Reader {
  Project& p;
  const ImportOptions& o;
  std::string base;

  std::string readStack(const json& st, const std::string& name, int depth, Rate rate) {
    int w = 1920, h = 1080;
    bool mc = false;
    if (st.contains("metadata") && st["metadata"].contains("rhapsode")) {
      const json& m = st["metadata"]["rhapsode"];
      w = m.value("width", w);
      h = m.value("height", h);
      if (m.contains("rate")) rate = Rate{m["rate"][0].get<int64_t>(), m["rate"][1].get<int64_t>()};
      mc = m.value("multicam", false);
    }
    std::string id = addSequence(p, name, w, h, rate, 0, 0).id;
    int vi = 0, ai = 0;
    for (const json& t : st.value("children", json::array())) {
      if (schema(t) != "Track") continue;
      bool audio = t.value("kind", "Video") == "Audio";
      TrackRef ref{audio ? TrackKind::Audio : TrackKind::Video, audio ? ai++ : vi++};
      readTrack(id, t, ref, depth);
      Sequence& s = *p.findSequence(id);
      Track& tr = *trackOf(s, ref);
      tr.name = t.value("name", tr.name);
      if (!t.value("enabled", true)) (audio ? tr.mute : tr.hidden) = true;
    }
    Sequence& s = *p.findSequence(id);
    s.multicam = mc;
    for (const json& m : st.value("markers", json::array())) {
      Marker mk;
      mk.id = p.makeId("m");
      mk.name = m.value("name", "");
      mk.note = m.value("comment", "");
      mk.color = markerColorOf(m.value("color", "RED"));
      if (m.contains("marked_range")) {
        mk.t = fromRt(m["marked_range"]["start_time"]);
        mk.dur = fromRt(m["marked_range"]["duration"]);
      }
      s.markers.push_back(mk);
    }
    std::sort(s.markers.begin(), s.markers.end(), [](auto& a, auto& b) { return a.t < b.t; });
    return id;
  }

  void readTrack(const std::string& seqId, const json& t, TrackRef ref, int depth) {
    Tick pos = 0;
    // make sure the track exists even when empty
    {
      Sequence& s = *p.findSequence(seqId);
      place(s, ref, Clip{});
    }
    for (const json& ch : t.value("children", json::array())) {
      std::string sc = schema(ch);
      if (sc == "Gap") {
        pos += fromRt(ch["source_range"]["duration"]);
      } else if (sc == "Transition") {
        Tick dur = fromRt(ch["in_offset"]) + fromRt(ch["out_offset"]);
        Transition x;
        x.id = p.makeId("x");
        x.at = pos;
        x.dur = dur;
        x.kind = ch.value("transition_type", "") == "SMPTE_Wipe" ? TransitionKind::Wipe
                 : ref.kind == TrackKind::Audio                    ? TransitionKind::Crossfade
                                                                   : TransitionKind::Dissolve;
        if (ch.contains("metadata") && ch["metadata"].contains("rhapsode"))
          x.kind = TransitionKind(ch["metadata"]["rhapsode"].value("kind", int(x.kind)));
        trackOf(*p.findSequence(seqId), ref)->transitions.push_back(x);
      } else if (sc == "Clip" || sc == "Stack") {
        Clip c;
        bool own = ch.contains("metadata") && ch["metadata"].contains("rhapsode") && ch["metadata"]["rhapsode"].is_object();
        if (own) {
          try {
            c = clipFromJson(ch["metadata"]["rhapsode"]);
          } catch (...) {
            own = false;
            c = Clip{};
          }
        }
        c.id = p.makeId("c");
        c.name = ch.value("name", c.name);
        Tick in = 0, dur = 0;
        if (ch.contains("source_range") && ch["source_range"].is_object()) {
          in = fromRt(ch["source_range"]["start_time"]);
          dur = fromRt(ch["source_range"]["duration"]);
        }
        c.start = pos;
        c.in = in;
        c.dur = dur;
        c.enabled = ch.value("enabled", true);
        for (const json& e : ch.value("effects", json::array()))
          if (schema(e) == "LinearTimeWarp") c.speed = e.value("time_scalar", 1.0);
        if (sc == "Stack") {
          if (depth > 8) {
            pos += dur;
            continue;
          }
          c.ref = readStack(ch, c.name, depth + 1, p.findSequence(seqId)->rate);
          if (c.kind != ClipKind::Multicam) c.kind = ClipKind::Nested;
        } else {
          json ref = ch.contains("media_references")
                         ? ch["media_references"].value(ch.value("active_media_reference_key", "DEFAULT_MEDIA"), json::object())
                         : ch.value("media_reference", json::object());
          std::string rs = schema(ref);
          if (rs == "GeneratorReference") {
            std::string kind = ref.value("generator_kind", "");
            if (!own) {
              c.kind = kind == "Title" ? ClipKind::Title : ClipKind::Solid;
              if (ref.contains("parameters")) c.text = ref["parameters"].value("text", "");
            }
          } else {
            Tick avail = 0;
            if (ref.contains("available_range") && ref["available_range"].is_object())
              avail = fromRt(ref["available_range"]["start_time"]) + fromRt(ref["available_range"]["duration"]);
            Media& m = mediaFor(p, pathFromUrl(ref.value("target_url", "")), ref.value("name", c.name), avail, o, base);
            c.kind = ClipKind::Media;
            c.ref = m.id;
          }
        }
        place(*p.findSequence(seqId), ref, c);
        pos += dur;
      }
    }
  }
};

}  // namespace

std::string writeOtio(const Project& p, std::string& out) {
  const Sequence* s = p.findSequence(p.active);
  if (!s) return "no active sequence";
  json tl{{"OTIO_SCHEMA", "Timeline.1"},
          {"name", s->name},
          {"global_start_time", rt(0, s->rate)},
          {"tracks", writeStack(p, *s, 0)},
          {"metadata", {{"rhapsode", {{"project", p.name}}}}}};
  out = tl.dump(2) + "\n";
  return {};
}

std::string readOtio(const std::string& text, const std::string& baseDir, Project& p, const ImportOptions& o) {
  json j;
  try {
    j = json::parse(text);
  } catch (const std::exception& e) {
    return std::string("not OTIO JSON: ") + e.what();
  }
  if (schema(j) != "Timeline") return "not an OTIO timeline";
  Reader r{p, o, baseDir};
  p.name = j.value("name", "Imported");
  std::string id = r.readStack(j.value("tracks", json::object()), j.value("name", "Timeline"), 0, o.rate);
  finish(p, id);
  return {};
}

}  // namespace rhap::ix
