#pragma once
// Ready-made titles and shapes. A template is just a clip with its style,
// place and motion keyframes set; everything stays editable afterwards.

#include <string>
#include <vector>

#include "edit.h"

namespace rhap {

const std::vector<std::string>& titleTemplates();  // "Title", "Lower third", "Subtitle", "End card", "Chapter"

/** a title clip from a template at `at` on sequence `s` */
Clip makeTitle(Project& p, const Sequence& s, const std::string& tmpl, Tick at, const std::string& text = "");

/** a rectangle, an ellipse or a full-frame solid */
Clip makeShape(Project& p, const Sequence& s, ClipKind kind, ShapeKind shape, Tick at);

/**
 * Places a graphic on the lowest picture track above every clip it would
 * cover, adding a track when none is free, so a template never cuts footage.
 */
Err placeGraphic(Project& p, const std::string& seqId, Clip c);

}  // namespace rhap
