// CMX 3600 EDL: one picture track (V1) with its linked sound as "B" events,
// cuts and dissolves. Record time starts at 01:00:00:00.
#include <cstdio>
#include <regex>
#include <sstream>

#include "common.h"

namespace rhap::ix {

namespace {
constexpr int64_t kRecHour = 3600;

std::string reelOf(const Media& m) {
  std::string r;
  for (char c : fileStem(m.name.empty() ? m.path : m.name))
    if (std::isalnum(static_cast<unsigned char>(c)) || c == '_') r += char(std::toupper(static_cast<unsigned char>(c)));
  if (r.empty()) r = "AX";
  return r.substr(0, 32);
}
}  // namespace

std::string writeEdl(const Project& p, std::string& out) {
  const Sequence* s = p.findSequence(p.active);
  if (!s) return "no active sequence";
  const Rate r = s->rate;
  bool drop = r.den == 1001;
  std::ostringstream os;
  os << "TITLE: " << s->name << "\n" << "FCM: " << (drop ? "DROP FRAME" : "NON-DROP FRAME") << "\n\n";
  if (s->video.empty()) {
    out = os.str();
    return {};
  }
  const Track& t = s->video[0];
  const Tick rec0 = kRecHour * kFlicks;
  auto tc = [&](Tick x) { return timecode(x, r, drop); };
  int ev = 1;
  auto hasSound = [&](const Clip& c) {
    if (c.link.empty()) return false;
    for (auto& a : s->audio)
      for (auto& ac : a.clips)
        if (ac.link == c.link) return true;
    return false;
  };
  char buf[256];
  for (size_t i = 0; i < t.clips.size(); ++i) {
    const Clip& c = t.clips[i];
    const Media* m = c.kind == ClipKind::Media ? p.findMedia(c.ref) : nullptr;
    std::string reel = m ? reelOf(*m) : c.kind == ClipKind::Solid ? "BL" : "AX";
    std::string chan = hasSound(c) ? "B" : "V";
    Tick src0 = (m ? m->startTimecode : 0) + c.in;
    const Transition* x = nullptr;
    for (auto& tx : t.transitions)
      if (tx.at == c.start && i > 0 && t.clips[i - 1].end() == c.start) x = &tx;
    if (x) {
      // outgoing side: a zero-length event at the dissolve start, then the dissolve into this clip
      const Clip& a = t.clips[i - 1];
      const Media* am = a.kind == ClipKind::Media ? p.findMedia(a.ref) : nullptr;
      Tick d0 = x->at - x->dur / 2;
      Tick aSrc = (am ? am->startTimecode : 0) + a.in + (d0 - a.start);
      std::snprintf(buf, sizeof buf, "%03d  %-8s %-5s C        %s %s %s %s\n", ev, am ? reelOf(*am).c_str() : "AX", chan.c_str(),
                    tc(aSrc).c_str(), tc(aSrc).c_str(), tc(rec0 + d0).c_str(), tc(rec0 + d0).c_str());
      os << buf;
      long frames = long(frameAt(x->dur, r));
      Tick bSrc = src0 - (c.start - d0);
      std::snprintf(buf, sizeof buf, "%03d  %-8s %-5s D    %03ld %s %s %s %s\n", ev, reel.c_str(), chan.c_str(), frames,
                    tc(bSrc).c_str(), tc(src0 + c.dur).c_str(), tc(rec0 + d0).c_str(), tc(rec0 + c.end()).c_str());
      os << buf;
    } else {
      std::snprintf(buf, sizeof buf, "%03d  %-8s %-5s C        %s %s %s %s\n", ev, reel.c_str(), chan.c_str(),
                    tc(src0).c_str(), tc(src0 + c.sourceSpan()).c_str(), tc(rec0 + c.start).c_str(), tc(rec0 + c.end()).c_str());
      os << buf;
    }
    if (c.speed != 1) {
      std::snprintf(buf, sizeof buf, "M2   %-8s %+06.1f %s\n", reel.c_str(), c.speed * r.fps(), tc(src0).c_str());
      os << buf;
    }
    if (m) os << "* FROM CLIP NAME: " << m->name << "\n" << "* SOURCE FILE: " << m->path << "\n";
    for (auto& mk : s->markers)
      if (mk.t >= c.start && mk.t < c.end()) os << "* LOC: " << tc(rec0 + mk.t) << " RED " << mk.name << "\n";
    os << "\n";
    ++ev;
  }
  out = os.str();
  return {};
}

std::string readEdl(const std::string& text, const std::string& baseDir, Project& p, const ImportOptions& o) {
  Rate r = o.rate;
  std::istringstream in(text);
  std::string line, title = "EDL";
  bool dropTc = false;
  struct Ev {
    std::string reel, chan, kind, file, name;
    int frames = 0;
    Tick sIn = 0, sOut = 0, rIn = 0, rOut = 0;
    double speed = 1;
    std::vector<std::pair<Tick, std::string>> locs;
  };
  std::vector<Ev> evs;
  std::regex evRe(R"(^\s*(\d{1,6})\s+(\S+)\s+(\S+)\s+(C|D|W\d{3}|K\S*)\s+(\d{1,4})?\s*(\d\d[:;]\d\d[:;]\d\d[:;.]\d\d)\s+(\d\d[:;]\d\d[:;]\d\d[:;.]\d\d)\s+(\d\d[:;]\d\d[:;]\d\d[:;.]\d\d)\s+(\d\d[:;]\d\d[:;]\d\d[:;.]\d\d))");
  std::smatch m;
  auto parse = [&](const std::string& s) {
    Tick t = 0;
    parseTimecode(s, r, t);
    return t;
  };
  while (std::getline(in, line)) {
    if (!line.empty() && line.back() == '\r') line.pop_back();
    if (line.rfind("TITLE:", 0) == 0) {
      title = line.substr(6);
      title.erase(0, title.find_first_not_of(' '));
      continue;
    }
    if (line.rfind("FCM:", 0) == 0) {
      dropTc = line.find("NON-DROP") == std::string::npos && line.find("DROP") != std::string::npos;
      continue;
    }
    if (std::regex_search(line, m, evRe)) {
      Ev e;
      e.reel = m[2];
      e.chan = m[3];
      e.kind = m[4];
      e.frames = m[5].matched ? std::stoi(m[5]) : 0;
      e.sIn = parse(m[6]);
      e.sOut = parse(m[7]);
      e.rIn = parse(m[8]);
      e.rOut = parse(m[9]);
      evs.push_back(e);
      continue;
    }
    if (evs.empty()) continue;
    auto after = [&](const char* key) -> std::string {
      auto at = line.find(key);
      if (at == std::string::npos) return "";
      std::string v = line.substr(at + std::strlen(key));
      v.erase(0, v.find_first_not_of(' '));
      return v;
    };
    if (auto v = after("FROM CLIP NAME:"); !v.empty()) evs.back().name = v;
    if (auto v = after("SOURCE FILE:"); !v.empty()) evs.back().file = v;
    if (auto v = after("* LOC:"); !v.empty()) {
      auto sp = v.find(' ');
      Tick t = parse(v.substr(0, sp));
      std::string rest = sp == std::string::npos ? "" : v.substr(sp + 1);
      auto sp2 = rest.find(' ');
      evs.back().locs.push_back({t, sp2 == std::string::npos ? rest : rest.substr(sp2 + 1)});
    }
    if (line.rfind("M2", 0) == 0) {
      std::istringstream ms(line);
      std::string tag, reel;
      double fps;
      ms >> tag >> reel >> fps;
      evs.back().speed = fps / r.fps();
    }
  }
  (void)dropTc;
  Tick rec0 = 0;
  if (!evs.empty()) {
    Tick lo = evs.front().rIn;
    for (auto& e : evs) lo = std::min(lo, e.rIn);
    if (lo >= kRecHour * kFlicks) rec0 = kRecHour * kFlicks;
  }
  Sequence& s = addSequence(p, title, 1920, 1080, r, 1, 1);
  std::string sid = s.id;
  bool sized = false;
  for (size_t i = 0; i < evs.size(); ++i) {
    Ev& e = evs[i];
    if (e.kind == "C" && e.rIn == e.rOut) continue;  // the outgoing half of a dissolve
    std::string path = e.file.empty() ? e.name : e.file;
    Media& md = mediaFor(p, path, e.name.empty() ? e.reel : e.name, 0, o, baseDir);
    if (!sized && md.width > 0) {
      p.findSequence(sid)->width = md.width;
      p.findSequence(sid)->height = md.height;
      sized = true;
    }
    Clip c;
    c.id = p.makeId("c");
    c.kind = ClipKind::Media;
    c.ref = md.id;
    c.name = md.name;
    c.start = e.rIn - rec0;
    c.dur = e.rOut - e.rIn;
    c.in = std::max<Tick>(0, e.sIn - md.startTimecode);
    c.speed = e.speed;
    Sequence& sq = *p.findSequence(sid);
    if (e.kind == "D" && e.frames > 0) {
      // the dissolve starts at rIn; Rhapsode centres it on a cut: move the cut to the middle
      Tick d = frameStart(e.frames, r), half = d / 2;
      Track& v = sq.video[0];
      if (!v.clips.empty() && v.clips.back().end() == c.start) {
        Clip& a = v.clips.back();
        a.dur += half;
        if (!a.link.empty())
          for (auto& ac : sq.audio[0].clips)
            if (ac.link == a.link) ac.dur += half;
      }
      c.start += half;
      c.in += half;
      c.dur -= half;
      v.transitions.push_back(Transition{p.makeId("x"), c.start, d, TransitionKind::Dissolve});
    }
    bool sound = e.chan.find('A') != std::string::npos || e.chan == "B";
    bool picture = e.chan.find('V') != std::string::npos || e.chan == "B";
    if (sound && picture) {
      Clip a = c;
      a.id = p.makeId("c");
      c.link = a.link = p.makeId("l");
      place(sq, {TrackKind::Audio, 0}, a);
    }
    place(sq, sound && !picture ? TrackRef{TrackKind::Audio, 0} : TrackRef{TrackKind::Video, 0}, c);
    for (auto& [t, name] : e.locs) {
      Marker mk;
      mk.id = p.makeId("m");
      mk.t = t - rec0;
      mk.name = name;
      sq.markers.push_back(mk);
    }
  }
  finish(p, sid);
  return {};
}

}  // namespace rhap::ix
