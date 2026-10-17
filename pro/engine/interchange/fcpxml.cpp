// Final Cut Pro XML 1.10. V1 (with its linked sound) is the primary
// storyline; every other clip is a connected clip on lane +n (picture track
// n+1) or −n (sound track n+1), attached to the spine item it starts over.
#include <pugixml.hpp>
#include <sstream>

#include "common.h"

namespace rhap::ix {

namespace {

std::string frameDur(Rate r) { return rationalSeconds(frameTicks(r)); }

struct Writer {
  const Project& p;
  const Sequence& s;
  pugi::xml_node resources;
  std::map<std::string, std::string> assetIds;  // media id → asset id
  std::map<std::string, std::string> nestedIds;  // sequence id → media id
  int next = 1;
  std::string formatId;

  std::string format(const Sequence& q) {
    std::string id = "r" + std::to_string(next++);
    auto f = resources.append_child("format");
    f.append_attribute("id") = id.c_str();
    f.append_attribute("name") = ("FFVideoFormat" + std::to_string(q.height) + "p" + std::to_string(int(std::lround(q.rate.fps() * 100)))).c_str();
    f.append_attribute("frameDuration") = frameDur(q.rate).c_str();
    f.append_attribute("width") = q.width;
    f.append_attribute("height") = q.height;
    f.append_attribute("colorSpace") = "1-1-1 (Rec. 709)";
    return id;
  }

  std::string asset(const Media& m) {
    auto it = assetIds.find(m.id);
    if (it != assetIds.end()) return it->second;
    std::string id = "r" + std::to_string(next++);
    auto a = resources.append_child("asset");
    a.append_attribute("id") = id.c_str();
    a.append_attribute("name") = m.name.c_str();
    a.append_attribute("start") = rationalSeconds(m.startTimecode).c_str();
    a.append_attribute("duration") = rationalSeconds(m.duration > 0 ? m.duration : 3600 * kFlicks).c_str();
    a.append_attribute("hasVideo") = m.hasVideo ? "1" : "0";
    a.append_attribute("hasAudio") = m.hasAudio ? "1" : "0";
    if (m.hasAudio) {
      a.append_attribute("audioSources") = "1";
      a.append_attribute("audioChannels") = m.channels > 0 ? m.channels : 2;
      a.append_attribute("audioRate") = m.sampleRate > 0 ? m.sampleRate : 48000;
    }
    if (m.hasVideo) a.append_attribute("format") = formatId.c_str();
    auto rep = a.append_child("media-rep");
    rep.append_attribute("kind") = "original-media";
    rep.append_attribute("src") = urlFromPath(m.path).c_str();
    assetIds[m.id] = id;
    return id;
  }

  void clipAttrs(pugi::xml_node n, const Clip& c, Tick offset, Tick sourceStart) {
    n.append_attribute("name") = c.name.c_str();
    n.append_attribute("offset") = rationalSeconds(offset).c_str();
    n.append_attribute("start") = rationalSeconds(sourceStart).c_str();
    n.append_attribute("duration") = rationalSeconds(c.dur).c_str();
    if (!c.enabled) n.append_attribute("enabled") = "0";
  }

  /** writes one clip as a spine item or a connected child of `parent` */
  pugi::xml_node clip(pugi::xml_node parent, const Clip& c, Tick offset, int lane) {
    pugi::xml_node n;
    if (c.kind == ClipKind::Media) {
      const Media* m = p.findMedia(c.ref);
      if (!m) return n;
      n = parent.append_child("asset-clip");
      n.append_attribute("ref") = asset(*m).c_str();
      clipAttrs(n, c, offset, m->startTimecode + c.in);
      if (lane < 0 || !m->hasVideo) n.append_attribute("audioRole") = "dialogue";
    } else if (c.kind == ClipKind::Title) {
      n = parent.append_child("title");
      n.append_attribute("ref") = titleEffect().c_str();
      clipAttrs(n, c, offset, 0);
      auto text = n.append_child("text").append_child("text-style");
      text.append_attribute("ref") = "ts1";
      text.text() = c.text.c_str();
    } else if (c.kind == ClipKind::Nested || c.kind == ClipKind::Multicam) {
      const Sequence* q = p.findSequence(c.ref);
      if (!q) return n;
      n = parent.append_child("ref-clip");
      n.append_attribute("ref") = compound(*q).c_str();
      clipAttrs(n, c, offset, c.in);
    } else {
      n = parent.append_child("gap");
      clipAttrs(n, c, offset, 0);
    }
    if (lane != 0) n.append_attribute("lane") = lane;
    if (c.speed != 1) {
      auto tm = n.append_child("timeMap");
      auto a = tm.append_child("timept");
      a.append_attribute("time") = "0s";
      a.append_attribute("value") = rationalSeconds(c.in).c_str();
      a.append_attribute("interp") = "linear";
      auto b = tm.append_child("timept");
      b.append_attribute("time") = rationalSeconds(c.dur).c_str();
      b.append_attribute("value") = rationalSeconds(c.in + c.sourceSpan()).c_str();
      b.append_attribute("interp") = "linear";
    }
    return n;
  }

  std::string titleId;
  std::string titleEffect() {
    if (!titleId.empty()) return titleId;
    titleId = "r" + std::to_string(next++);
    auto e = resources.append_child("effect");
    e.append_attribute("id") = titleId.c_str();
    e.append_attribute("name") = "Basic Title";
    e.append_attribute("uid") = ".../Titles.localized/Bumper:Opener.localized/Basic Title.localized/Basic Title.moti";
    return titleId;
  }

  std::string compound(const Sequence& q) {
    auto it = nestedIds.find(q.id);
    if (it != nestedIds.end()) return it->second;
    std::string id = "r" + std::to_string(next++);
    nestedIds[q.id] = id;
    auto media = resources.append_child("media");
    media.append_attribute("id") = id.c_str();
    media.append_attribute("name") = q.name.c_str();
    auto seq = media.append_child("sequence");
    seq.append_attribute("format") = formatId.c_str();
    seq.append_attribute("duration") = rationalSeconds(q.duration()).c_str();
    seq.append_attribute("tcStart") = "0s";
    spine(seq.append_child("spine"), q);
    return id;
  }

  void spine(pugi::xml_node sp, const Sequence& q) {
    // the primary storyline: V1 with gaps
    struct Item {
      Tick start, end;
      Tick localStart;  // the item's own "start" (its local time origin)
      pugi::xml_node node;
    };
    std::vector<Item> items;
    Tick pos = 0;
    const Track* v1 = q.video.empty() ? nullptr : &q.video[0];
    std::set<std::string> covered;  // sound already carried by a V1 asset-clip
    auto gap = [&](Tick a, Tick b) {
      auto g = sp.append_child("gap");
      g.append_attribute("name") = "Gap";
      g.append_attribute("offset") = rationalSeconds(a).c_str();
      g.append_attribute("start") = "0s";
      g.append_attribute("duration") = rationalSeconds(b - a).c_str();
      items.push_back({a, b, 0, g});
    };
    if (v1) {
      for (size_t i = 0; i < v1->clips.size(); ++i) {
        const Clip& c = v1->clips[i];
        if (c.start > pos) gap(pos, c.start);
        for (auto& x : v1->transitions)
          if (x.at == c.start && i > 0) {
            auto t = sp.append_child("transition");
            t.append_attribute("name") = "Cross Dissolve";
            t.append_attribute("offset") = rationalSeconds(x.at - x.dur / 2).c_str();
            t.append_attribute("duration") = rationalSeconds(x.dur).c_str();
          }
        const Media* m = c.kind == ClipKind::Media ? p.findMedia(c.ref) : nullptr;
        pugi::xml_node n = clip(sp, c, c.start, 0);
        if (!n) {
          gap(c.start, c.end());
        } else {
          items.push_back({c.start, c.end(), m ? m->startTimecode + c.in : c.in, n});
          if (!c.link.empty())
            for (auto& a : q.audio)
              for (auto& ac : a.clips)
                if (ac.link == c.link && ac.ref == c.ref && ac.start == c.start && ac.in == c.in) covered.insert(ac.id);
        }
        pos = c.end();
      }
    }
    Tick end = q.duration();
    if (end > pos || items.empty()) gap(pos, std::max(end, pos + frameTicks(q.rate)));
    auto attach = [&](const Clip& c, int lane) {
      for (auto& it : items)
        if (c.start >= it.start && c.start < it.end) {
          clip(it.node, c, it.localStart + (c.start - it.start), lane);
          return;
        }
    };
    for (size_t vi = 1; vi < q.video.size(); ++vi)
      for (auto& c : q.video[vi].clips) attach(c, int(vi));
    for (size_t ai = 0; ai < q.audio.size(); ++ai)
      for (auto& c : q.audio[ai].clips)
        if (!covered.count(c.id)) attach(c, -int(ai + 1));
    for (auto& mk : q.markers)
      for (auto& it : items)
        if (mk.t >= it.start && mk.t < it.end) {
          auto m = it.node.append_child("marker");
          m.append_attribute("start") = rationalSeconds(it.localStart + mk.t - it.start).c_str();
          m.append_attribute("duration") = rationalSeconds(mk.dur > 0 ? mk.dur : frameTicks(q.rate)).c_str();
          m.append_attribute("value") = mk.name.c_str();
          if (!mk.note.empty()) m.append_attribute("note") = mk.note.c_str();
          break;
        }
  }
};

// ——— reading ———

struct Reader {
  Project& p;
  const ImportOptions& o;
  std::string base;
  std::map<std::string, std::string> assets;     // asset id → media id
  std::map<std::string, pugi::xml_node> medias;  // compound media id → node
  std::map<std::string, std::string> compounds;  // compound media id → sequence id
  std::map<std::string, Rate> formats;
  std::map<std::string, std::pair<int, int>> sizes;

  void resources(pugi::xml_node res) {
    for (auto f : res.children("format")) {
      Tick fd = parseRationalSeconds(f.attribute("frameDuration").as_string("1/30s"));
      formats[f.attribute("id").as_string()] = rateOf(fd > 0 ? double(kFlicks) / double(fd) : 30);
      sizes[f.attribute("id").as_string()] = {f.attribute("width").as_int(1920), f.attribute("height").as_int(1080)};
    }
    for (auto a : res.children("asset")) {
      std::string src = a.attribute("src").as_string();
      if (auto rep = a.child("media-rep")) src = rep.attribute("src").as_string(src.c_str());
      Tick dur = parseRationalSeconds(a.attribute("duration").as_string("0s"));
      Media& m = mediaFor(p, pathFromUrl(src), a.attribute("name").as_string(), dur, o, base);
      m.startTimecode = parseRationalSeconds(a.attribute("start").as_string("0s"));
      if (!o.probeMedia || m.width == 0) {
        m.hasVideo = a.attribute("hasVideo").as_int(1) != 0;
        m.hasAudio = a.attribute("hasAudio").as_int(0) != 0;
      }
      assets[a.attribute("id").as_string()] = m.id;
    }
    for (auto m : res.children("media")) medias[m.attribute("id").as_string()] = m;
  }

  std::string compound(const std::string& mid, int depth) {
    auto it = compounds.find(mid);
    if (it != compounds.end()) return it->second;
    auto node = medias[mid];
    auto seq = node.child("sequence");
    std::string fmt = seq.attribute("format").as_string();
    Rate r = formats.count(fmt) ? formats[fmt] : o.rate;
    auto sz = sizes.count(fmt) ? sizes[fmt] : std::pair<int, int>{1920, 1080};
    std::string id = addSequence(p, node.attribute("name").as_string("Compound"), sz.first, sz.second, r, 1, 1).id;
    compounds[mid] = id;
    readSpine(id, seq.child("spine"), depth + 1);
    return id;
  }

  Tick t(pugi::xml_node n, const char* a) { return parseRationalSeconds(n.attribute(a).as_string("0s")); }

  /** one spine or connected item; `at` is its timeline position */
  void item(const std::string& seqId, pugi::xml_node n, Tick at, int lane, int depth) {
    std::string name = n.name();
    Clip c;
    c.id = p.makeId("c");
    c.name = n.attribute("name").as_string();
    c.start = at;
    c.dur = t(n, "duration");
    c.enabled = n.attribute("enabled").as_int(1) != 0;
    Tick localStart = t(n, "start");
    bool place_ = true;
    std::string ref = n.attribute("ref").as_string();
    if (name == "asset-clip" || name == "clip" || name == "video" || name == "audio") {
      if (name == "clip") {
        // a clip wraps its media in a <video>/<audio> child
        auto inner = n.child("video") ? n.child("video") : n.child("audio") ? n.child("audio") : n.child("asset-clip");
        if (inner) ref = inner.attribute("ref").as_string();
        if (inner && inner.attribute("start")) localStart = localStart - t(n, "start") + t(inner, "start");
      }
      auto it = assets.find(ref);
      if (it == assets.end()) {
        place_ = false;
      } else {
        const Media* m = p.findMedia(it->second);
        c.kind = ClipKind::Media;
        c.ref = m->id;
        c.in = std::max<Tick>(0, localStart - m->startTimecode);
        bool audioOnly = lane < 0 || !m->hasVideo;
        TrackRef tr = audioOnly ? TrackRef{TrackKind::Audio, lane < 0 ? -lane - 1 : 0} : TrackRef{TrackKind::Video, lane};
        if (auto tm = n.child("timeMap")) {
          auto pts = tm.children("timept");
          std::vector<pugi::xml_node> v(pts.begin(), pts.end());
          if (v.size() >= 2) {
            Tick dt = t(v.back(), "time") - t(v.front(), "time"), dv = t(v.back(), "value") - t(v.front(), "value");
            if (dt > 0) c.speed = double(dv) / double(dt);
            c.in = t(v.front(), "value");
          }
        }
        Sequence& s = *p.findSequence(seqId);
        if (!audioOnly && m->hasAudio && lane == 0) {
          Clip a = c;
          a.id = p.makeId("c");
          c.link = a.link = p.makeId("l");
          place(s, {TrackKind::Audio, 0}, a);
        }
        place(s, tr, c);
        place_ = false;
      }
    } else if (name == "ref-clip" || name == "sync-clip" || name == "mc-clip") {
      if (medias.count(ref) && depth < 8) {
        c.kind = ClipKind::Nested;
        c.ref = compound(ref, depth);
        c.in = localStart;
      } else {
        place_ = false;
      }
    } else if (name == "title") {
      c.kind = ClipKind::Title;
      for (auto ts : n.child("text").children("text-style")) c.text += ts.text().as_string();
      if (c.text.empty()) c.text = c.name;
    } else {
      place_ = false;  // gap, transition, unknown
    }
    if (place_) place(*p.findSequence(seqId), {TrackKind::Video, std::max(0, lane)}, c);
    // connected children: their offset is in this item's local time
    for (auto ch : n.children()) {
      std::string cn = ch.name();
      if (cn == "marker" || cn == "chapter-marker") {
        if (lane != 0) continue;
        Marker mk;
        mk.id = p.makeId("m");
        mk.t = at + t(ch, "start") - localStart;
        mk.dur = t(ch, "duration");
        mk.name = ch.attribute("value").as_string();
        mk.note = ch.attribute("note").as_string();
        p.findSequence(seqId)->markers.push_back(mk);
        continue;
      }
      if (!ch.attribute("lane")) continue;
      item(seqId, ch, at + t(ch, "offset") - localStart, ch.attribute("lane").as_int(), depth);
    }
  }

  void readSpine(const std::string& seqId, pugi::xml_node sp, int depth) {
    for (auto n : sp.children()) {
      std::string name = n.name();
      Tick at = t(n, "offset");
      if (name == "transition") {
        Transition x;
        x.id = p.makeId("x");
        x.dur = t(n, "duration");
        x.at = at + x.dur / 2;
        p.findSequence(seqId)->video[0].transitions.push_back(x);
        continue;
      }
      if (name == "spine") {  // a secondary storyline
        readSpine(seqId, n, depth);
        continue;
      }
      item(seqId, n, at, 0, depth);
    }
    Sequence& s = *p.findSequence(seqId);
    // a transition belongs to the cut nearest its centre
    for (auto& x : s.video[0].transitions)
      for (auto& c : s.video[0].clips)
        if (std::llabs(c.start - x.at) <= x.dur / 2 + 1) x.at = c.start;
    std::sort(s.markers.begin(), s.markers.end(), [](auto& a, auto& b) { return a.t < b.t; });
  }
};

}  // namespace

std::string writeFcpxml(const Project& p, std::string& out) {
  const Sequence* s = p.findSequence(p.active);
  if (!s) return "no active sequence";
  pugi::xml_document doc;
  auto decl = doc.append_child(pugi::node_declaration);
  decl.append_attribute("version") = "1.0";
  decl.append_attribute("encoding") = "UTF-8";
  doc.append_child(pugi::node_doctype).set_value("fcpxml");
  auto root = doc.append_child("fcpxml");
  root.append_attribute("version") = "1.10";
  Writer w{p, *s, root.append_child("resources")};
  w.formatId = w.format(*s);
  auto seq = root.append_child("library").append_child("event");
  seq.append_attribute("name") = "Rhapsode";
  auto project = seq.append_child("project");
  project.append_attribute("name") = s->name.c_str();
  auto sq = project.append_child("sequence");
  sq.append_attribute("format") = w.formatId.c_str();
  sq.append_attribute("duration") = rationalSeconds(s->duration()).c_str();
  sq.append_attribute("tcStart") = "0s";
  sq.append_attribute("tcFormat") = "NDF";
  sq.append_attribute("audioLayout") = "stereo";
  sq.append_attribute("audioRate") = "48k";
  w.spine(sq.append_child("spine"), *s);
  std::ostringstream os;
  doc.save(os, "  ");
  out = os.str();
  return {};
}

std::string readFcpxml(const std::string& text, const std::string& baseDir, Project& p, const ImportOptions& o) {
  pugi::xml_document doc;
  if (!doc.load_string(text.c_str())) return "not XML";
  auto root = doc.child("fcpxml");
  if (!root) return "not FCPXML";
  Reader r{p, o, baseDir};
  r.resources(root.child("resources"));
  std::string active;
  // projects live in library/event/project or directly under fcpxml
  std::vector<pugi::xml_node> projects;
  for (auto ev : root.child("library").children("event"))
    for (auto pr : ev.children("project")) projects.push_back(pr);
  for (auto ev : root.children("event"))
    for (auto pr : ev.children("project")) projects.push_back(pr);
  for (auto pr : root.children("project")) projects.push_back(pr);
  if (projects.empty()) return "no project in the FCPXML";
  for (auto pr : projects) {
    auto seq = pr.child("sequence");
    std::string fmt = seq.attribute("format").as_string();
    Rate rate = r.formats.count(fmt) ? r.formats[fmt] : o.rate;
    auto sz = r.sizes.count(fmt) ? r.sizes[fmt] : std::pair<int, int>{1920, 1080};
    std::string id = addSequence(p, pr.attribute("name").as_string("Project"), sz.first, sz.second, rate, 1, 1).id;
    if (active.empty()) active = id;
    r.readSpine(id, seq.child("spine"), 0);
  }
  finish(p, active);
  return {};
}

}  // namespace rhap::ix
