#include "templates.h"

namespace rhap {

const std::vector<std::string>& titleTemplates() {
  static const std::vector<std::string> v = {"Title", "Lower third", "Subtitle", "End card", "Chapter"};
  return v;
}

Clip makeTitle(Project& p, const Sequence& s, const std::string& t, Tick at, const std::string& text) {
  const double W = s.width, H = s.height;
  Clip c;
  c.id = p.makeId("c");
  c.kind = ClipKind::Title;
  c.start = at;
  c.dur = 5 * kFlicks;
  c.name = t;
  const Tick in = kFlicks / 2;  // the length of entrances and exits
  if (t == "Lower third") {
    c.text = text.empty() ? "Name Surname\nWhat they do" : text;
    c.style.font = "Plex";
    c.style.size = H * 0.045;
    c.style.align = 0;
    c.style.box = {0.07, 0.07, 0.09, 0.72};
    c.style.lineSpacing = 1.25;
    // slides in from the left and fades, leaves the same way
    c.xf.x.setKey(0, -W * 0.62, Ease::Out);
    c.xf.x.setKey(in, -W * 0.28);
    c.xf.x.setKey(c.dur - in, -W * 0.28, Ease::In);
    c.xf.x.setKey(c.dur, -W * 0.62);
    c.xf.y = H * 0.32;
    c.xf.opacity.setKey(0, 0, Ease::Out);
    c.xf.opacity.setKey(in, 1);
    c.xf.opacity.setKey(c.dur - in, 1, Ease::In);
    c.xf.opacity.setKey(c.dur, 0);
  } else if (t == "Subtitle") {
    c.text = text.empty() ? "A line of dialogue" : text;
    c.style.font = "Plex";
    c.style.size = H * 0.048;
    c.style.box = {0, 0, 0, 0.55};
    c.xf.y = H * 0.36;
    c.dur = 3 * kFlicks;
  } else if (t == "End card") {
    c.text = text.empty() ? "Thanks for watching" : text;
    c.style.size = H * 0.1;
    c.style.outlineWidth = H * 0.1 * 0.05;
    c.xf.scale.setKey(0, 0.92, Ease::Out);
    c.xf.scale.setKey(c.dur, 1.0);
    c.xf.opacity.setKey(0, 0, Ease::InOut);
    c.xf.opacity.setKey(in * 2, 1);
    c.xf.opacity.setKey(c.dur - in * 2, 1, Ease::InOut);
    c.xf.opacity.setKey(c.dur, 0);
  } else if (t == "Chapter") {
    c.text = text.empty() ? "01\nThe beginning" : text;
    c.style.size = H * 0.085;
    c.style.align = 0;
    c.style.color = {1.0, 0.48, 0.35, 1};
    c.style.outlineWidth = H * 0.085 * 0.04;
    c.xf.x = -W * 0.22;
    c.xf.y.setKey(0, H * 0.06, Ease::Out);
    c.xf.y.setKey(in, 0);
    c.xf.opacity.setKey(0, 0, Ease::Out);
    c.xf.opacity.setKey(in, 1);
  } else {  // Title
    c.text = text.empty() ? "Title" : text;
    c.style.size = H * 0.08;
    c.style.outlineWidth = H * 0.08 * 0.06;
  }
  return c;
}

Clip makeShape(Project& p, const Sequence& s, ClipKind kind, ShapeKind shape, Tick at) {
  Clip c;
  c.id = p.makeId("c");
  c.kind = kind;
  c.shape = shape;
  c.start = at;
  c.dur = 5 * kFlicks;
  c.name = kind == ClipKind::Solid ? "Solid" : shape == ShapeKind::Ellipse ? "Ellipse" : "Rectangle";
  if (kind == ClipKind::Solid) {
    c.fill = {0.07, 0.07, 0.09, 1};
  } else {
    c.fill = {1.0, 0.48, 0.35, 1};
    c.xf.scale = 0.3;
    c.xf.scaleY = double(s.width) / s.height * (shape == ShapeKind::Ellipse ? 1.0 : 0.6);  // a circle, or a 5:3 card
  }
  return c;
}

Err placeGraphic(Project& p, const std::string& seqId, Clip c) {
  Sequence* s = p.findSequence(seqId);
  if (!s) return "no such sequence";
  int top = -1;
  for (int i = 0; i < int(s->video.size()); ++i)
    for (auto& o : s->video[size_t(i)].clips)
      if (o.start < c.end() && c.start < o.end()) top = std::max(top, i);
  Editor ed(p, seqId);
  int dst = top + 1;
  if (dst >= int(s->video.size()))
    if (Err e = ed.addTrack(TrackKind::Video); !e.empty()) return e;
  return ed.overwrite({TrackKind::Video, dst}, std::move(c));
}

}  // namespace rhap
