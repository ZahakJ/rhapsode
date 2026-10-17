// FCP7 / Premiere Pro XML (xmeml v4). Times are frames at the sequence's
// <rate>; a clip next to a transition has start or end −1 and takes the
// transition's centre as its cut.
#include <cmath>
#include <pugixml.hpp>
#include <sstream>

#include "common.h"

namespace rhap::ix {

namespace {

Rate rateNode(pugi::xml_node n, Rate fallback) {
  if (!n) return fallback;
  int tb = n.child("timebase").text().as_int(0);
  if (tb <= 0) return fallback;
  std::string ntsc = n.child("ntsc").text().as_string("FALSE");
  bool isNtsc = ntsc == "TRUE" || ntsc == "true";
  return isNtsc ? Rate{int64_t(tb) * 1000, 1001} : Rate{tb, 1};
}

void writeRate(pugi::xml_node parent, Rate r) {
  auto n = parent.append_child("rate");
  bool ntsc = r.den == 1001;
  n.append_child("timebase").text() = int(std::lround(r.fps()));
  n.append_child("ntsc").text() = ntsc ? "TRUE" : "FALSE";
}

struct Reader {
  Project& p;
  const ImportOptions& o;
  std::string base;
  std::map<std::string, std::string> files;  // file id → media id

  std::string media(pugi::xml_node clip, Rate r) {
    auto f = clip.child("file");
    if (!f) return "";
    std::string id = f.attribute("id").as_string();
    if (!id.empty() && files.count(id)) return files[id];
    std::string url = f.child("pathurl").text().as_string();
    Rate fr = rateNode(f.child("rate"), r);
    Tick dur = frameStart(f.child("duration").text().as_llong(0), fr);
    Media& m = mediaFor(p, pathFromUrl(url), f.child("name").text().as_string(), dur, o, base);
    if (auto tc = f.child("timecode"))
      m.startTimecode = frameStart(tc.child("frame").text().as_llong(0), rateNode(tc.child("rate"), fr));
    if (!id.empty()) files[id] = m.id;
    return m.id;
  }

  void track(Sequence& s, pugi::xml_node tr, TrackRef ref, Rate r) {
    // first pass: transitions, so −1 ends can be resolved
    std::vector<std::pair<Tick, Tick>> trans;  // start, end in frames
    for (auto n : tr.children("transitionitem"))
      trans.push_back({n.child("start").text().as_llong(), n.child("end").text().as_llong()});
    auto centreNear = [&](int64_t frame, bool before) -> int64_t {
      // the transition whose start (before) / end (after) touches the clip
      for (auto [a, b] : trans)
        if ((before && a <= frame && frame <= b) || (!before && a <= frame && frame <= b)) return (a + b) / 2;
      return frame;
    };
    std::vector<std::pair<int64_t, int64_t>> pending;
    int64_t lastEnd = 0;
    for (auto n : tr.children()) {
      std::string name = n.name();
      if (name == "transitionitem") {
        int64_t a = n.child("start").text().as_llong(), b = n.child("end").text().as_llong();
        Transition x;
        x.id = p.makeId("x");
        x.at = frameStart((a + b) / 2, r);
        x.dur = frameStart(b - a, r);
        x.kind = ref.kind == TrackKind::Audio ? TransitionKind::Crossfade : TransitionKind::Dissolve;
        std::string ename = n.child("effect").child("name").text().as_string();
        if (ename.find("Dip") != std::string::npos) x.kind = TransitionKind::DipToBlack;
        trackOf(s, ref)->transitions.push_back(x);
        continue;
      }
      if (name != "clipitem" && name != "generatoritem") continue;
      int64_t start = n.child("start").text().as_llong(), end = n.child("end").text().as_llong();
      int64_t in = n.child("in").text().as_llong(), out = n.child("out").text().as_llong();
      if (start < 0) {
        // the cut is the centre of the transition before this clip
        start = centreNear(lastEnd, true);
        in = out - (end - start);
      }
      if (end < 0) {
        int64_t probeFrom = start + (out - in);
        end = probeFrom;
        for (auto [a, b] : trans)
          if (a <= probeFrom && probeFrom <= b) end = (a + b) / 2;
        out = in + (end - start);
      }
      lastEnd = end;
      Clip c;
      c.id = p.makeId("c");
      c.name = n.child("name").text().as_string();
      c.start = frameStart(start, r);
      c.dur = frameStart(end, r) - c.start;
      c.in = frameStart(in, r);
      c.enabled = std::string(n.child("enabled").text().as_string("TRUE")) != "FALSE";
      if (name == "generatoritem") {
        std::string ename = n.child("effect").child("name").text().as_string();
        c.kind = ename.find("Text") != std::string::npos || ename.find("Title") != std::string::npos ? ClipKind::Title : ClipKind::Solid;
        c.text = c.name;
        c.in = 0;
      } else {
        std::string mid = media(n, r);
        if (mid.empty()) continue;
        c.kind = ClipKind::Media;
        c.ref = mid;
        const Media* m = p.findMedia(mid);
        if (m && m->duration > 0 && c.in + c.dur > m->duration) c.dur = std::max<Tick>(frameTicks(r), m->duration - c.in);
      }
      // speed: the "Time Remap" filter's speed parameter, in percent
      for (auto f : n.children("filter"))
        for (auto prm : f.child("effect").children("parameter"))
          if (std::string(prm.child("parameterid").text().as_string()) == "speed")
            c.speed = prm.child("value").text().as_double(100) / 100.0;
      // links: Premiere lists the clipitems that move together
      std::string myId = n.attribute("id").as_string();
      std::string group;
      for (auto l : n.children("link")) group += std::string(l.child("linkclipref").text().as_string()) + ",";
      if (!group.empty() && group.find(myId) != std::string::npos) c.link = "x" + std::to_string(std::hash<std::string>{}(group) % 1000000007);
      place(s, ref, c);
    }
  }
};

}  // namespace

std::string readXmeml(const std::string& text, const std::string& baseDir, Project& p, const ImportOptions& o) {
  pugi::xml_document doc;
  if (!doc.load_string(text.c_str())) return "not XML";
  auto root = doc.child("xmeml");
  if (!root) return "not an FCP7 / Premiere XML (xmeml)";
  std::vector<pugi::xml_node> seqs;
  for (auto s : root.children("sequence")) seqs.push_back(s);
  if (auto prj = root.child("project"))
    for (auto ch : prj.child("children").children("sequence")) seqs.push_back(ch);
  if (seqs.empty()) return "no sequence in the XML";
  Reader r{p, o, baseDir};
  std::string active;
  for (auto sq : seqs) {
    Rate rate = rateNode(sq.child("rate"), o.rate);
    auto fmt = sq.child("media").child("video").child("format").child("samplecharacteristics");
    int w = fmt.child("width").text().as_int(1920), h = fmt.child("height").text().as_int(1080);
    Sequence& s = addSequence(p, sq.child("name").text().as_string("Sequence"), w, h, rate, 0, 0);
    std::string id = s.id;
    if (active.empty()) active = id;
    int vi = 0, ai = 0;
    for (auto t : sq.child("media").child("video").children("track")) {
      Sequence& q = *p.findSequence(id);
      TrackRef ref{TrackKind::Video, vi++};
      place(q, ref, Clip{});
      r.track(q, t, ref, rate);
      if (std::string(t.child("enabled").text().as_string("TRUE")) == "FALSE") trackOf(q, ref)->hidden = true;
    }
    for (auto t : sq.child("media").child("audio").children("track")) {
      Sequence& q = *p.findSequence(id);
      TrackRef ref{TrackKind::Audio, ai++};
      place(q, ref, Clip{});
      r.track(q, t, ref, rate);
    }
    Sequence& q = *p.findSequence(id);
    for (auto mk : sq.children("marker")) {
      Marker m;
      m.id = p.makeId("m");
      m.name = mk.child("name").text().as_string();
      m.note = mk.child("comment").text().as_string();
      int64_t in = mk.child("in").text().as_llong(), out = mk.child("out").text().as_llong(-1);
      m.t = frameStart(in, rate);
      m.dur = out > in ? frameStart(out - in, rate) : 0;
      q.markers.push_back(m);
    }
    std::sort(q.markers.begin(), q.markers.end(), [](auto& a, auto& b) { return a.t < b.t; });
  }
  finish(p, active);
  return {};
}

std::string writeXmeml(const Project& p, std::string& out) {
  const Sequence* s = p.findSequence(p.active);
  if (!s) return "no active sequence";
  const Rate r = s->rate;
  auto fr = [&](Tick t) { return (long long)frameAt(t + frameTicks(r) / 2, r); };
  pugi::xml_document doc;
  auto decl = doc.append_child(pugi::node_declaration);
  decl.append_attribute("version") = "1.0";
  decl.append_attribute("encoding") = "UTF-8";
  doc.append_child(pugi::node_doctype).set_value("xmeml");
  auto root = doc.append_child("xmeml");
  root.append_attribute("version") = "4";
  auto sq = root.append_child("sequence");
  sq.append_attribute("id") = s->id.c_str();
  sq.append_child("name").text() = s->name.c_str();
  sq.append_child("duration").text() = fr(s->duration());
  writeRate(sq, r);
  auto media = sq.append_child("media");
  auto video = media.append_child("video");
  auto sc = video.append_child("format").append_child("samplecharacteristics");
  sc.append_child("width").text() = s->width;
  sc.append_child("height").text() = s->height;
  writeRate(sc, r);
  std::set<std::string> fileDone;
  int clipNo = 1;
  std::map<std::string, std::vector<std::string>> links;  // link id → clipitem ids
  std::map<const Clip*, std::string> itemId;
  auto pre = [&](const Track& t) {
    for (auto& c : t.clips) {
      std::string id = "clipitem-" + std::to_string(clipNo++);
      itemId[&c] = id;
      if (!c.link.empty()) links[c.link].push_back(id);
    }
  };
  for (auto& t : s->video) pre(t);
  for (auto& t : s->audio) pre(t);
  auto writeTrack = [&](pugi::xml_node parent, const Track& t, bool audio) {
    auto tr = parent.append_child("track");
    for (size_t i = 0; i < t.clips.size(); ++i) {
      const Clip& c = t.clips[i];
      for (auto& x : t.transitions)
        if (x.at == c.start && i > 0) {
          auto ti = tr.append_child("transitionitem");
          ti.append_child("start").text() = fr(x.at - x.dur / 2);
          ti.append_child("end").text() = fr(x.at + x.dur - x.dur / 2);
          ti.append_child("alignment").text() = "center";
          auto e = ti.append_child("effect");
          e.append_child("name").text() = audio ? "Cross Fade (+3dB)" : x.kind == TransitionKind::DipToBlack ? "Dip to Color Dissolve" : "Cross Dissolve";
          e.append_child("effecttype").text() = "transition";
          e.append_child("mediatype").text() = audio ? "audio" : "video";
        }
      const Media* m = c.kind == ClipKind::Media ? p.findMedia(c.ref) : nullptr;
      auto ci = tr.append_child(m ? "clipitem" : "generatoritem");
      ci.append_attribute("id") = itemId[&c].c_str();
      ci.append_child("name").text() = (c.name.empty() ? (m ? m->name : c.text) : c.name).c_str();
      ci.append_child("enabled").text() = c.enabled ? "TRUE" : "FALSE";
      ci.append_child("duration").text() = fr(m ? m->duration : c.dur);
      writeRate(ci, r);
      ci.append_child("start").text() = fr(c.start);
      ci.append_child("end").text() = fr(c.end());
      ci.append_child("in").text() = fr(c.in);
      ci.append_child("out").text() = fr(c.in + c.sourceSpan());
      if (m) {
        auto f = ci.append_child("file");
        std::string fid = "file-" + m->id;
        f.append_attribute("id") = fid.c_str();
        if (fileDone.insert(fid).second) {
          f.append_child("name").text() = m->name.c_str();
          f.append_child("pathurl").text() = urlFromPath(m->path).c_str();
          writeRate(f, m->rate);
          f.append_child("duration").text() = (long long)frameAt(m->duration, m->rate);
          auto tc = f.append_child("timecode");
          writeRate(tc, m->rate);
          tc.append_child("frame").text() = (long long)frameAt(m->startTimecode, m->rate);
          auto fm = f.append_child("media");
          if (m->hasVideo) {
            auto v = fm.append_child("video").append_child("samplecharacteristics");
            v.append_child("width").text() = m->width;
            v.append_child("height").text() = m->height;
          }
          if (m->hasAudio) {
            auto a = fm.append_child("audio");
            a.append_child("channelcount").text() = m->channels > 0 ? m->channels : 2;
          }
        }
      } else {
        auto e = ci.append_child("effect");
        e.append_child("name").text() = c.kind == ClipKind::Title ? "Text" : "Color";
        e.append_child("effecttype").text() = "generator";
        e.append_child("mediatype").text() = "video";
      }
      if (c.speed != 1) {
        auto fl = ci.append_child("filter").append_child("effect");
        fl.append_child("name").text() = "Time Remap";
        fl.append_child("effectid").text() = "timeremap";
        auto prm = fl.append_child("parameter");
        prm.append_child("parameterid").text() = "speed";
        prm.append_child("value").text() = c.speed * 100;
      }
      if (!c.link.empty())
        for (auto& id : links[c.link]) ci.append_child("link").append_child("linkclipref").text() = id.c_str();
    }
  };
  for (auto& t : s->video) writeTrack(video, t, false);
  auto audioNode = media.append_child("audio");
  for (auto& t : s->audio) writeTrack(audioNode, t, true);
  for (auto& mk : s->markers) {
    auto m = sq.append_child("marker");
    m.append_child("name").text() = mk.name.c_str();
    m.append_child("comment").text() = mk.note.c_str();
    m.append_child("in").text() = fr(mk.t);
    m.append_child("out").text() = mk.dur > 0 ? fr(mk.t + mk.dur) : -1;
  }
  std::ostringstream os;
  doc.save(os, "  ");
  out = os.str();
  return {};
}

}  // namespace rhap::ix
