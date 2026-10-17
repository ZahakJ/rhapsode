#pragma once
// What is on screen at a time: the layers of a sequence, bottom to top, with
// every animated value resolved. Pure: no GPU, no decoder. The renderer and
// the tests both start here.

#include <array>
#include <string>
#include <vector>

#include "../model/model.h"

namespace rhap {

struct LayerDraw {
  const Clip* clip = nullptr;
  const Media* media = nullptr;       // ClipKind::Media
  const Sequence* nested = nullptr;   // Nested / Multicam: the sequence to render
  int angle = -1;                     // Multicam: the only video track of `nested` to draw
  Tick local = 0;                     // clip-local time (keyframes)
  Tick source = 0;                    // time inside the media or nested sequence
  double opacity = 1;                 // transform opacity × transition mix
  std::string slot;                   // decoder identity: one per clip, so tracks never fight over a seek
  // the resolved transform
  double x = 0, y = 0, scale = 1, scaleY = 1, rotation = 0, anchorX = 0, anchorY = 0;
  double cropL = 0, cropR = 0, cropT = 0, cropB = 0;
};

/** visible picture layers of `s` at time t, bottom first */
std::vector<LayerDraw> evaluate(const Project& p, const Sequence& s, Tick t);

/** NDC corners (TL, TR, BL, BR) and their uvs for a layer whose source is srcW×srcH display pixels */
struct Quad {
  std::array<double, 8> ndc;  // x0 y0 x1 y1 x2 y2 x3 y3
  std::array<double, 8> uv;
};
/** fit: scale the source to fit the canvas (media, nested); otherwise 1:1 pixels (titles) */
Quad place(const LayerDraw& l, double srcW, double srcH, int canvasW, int canvasH, bool fit, int rotation = 0);

/** the sound sources playing at t, for the mixer (one per audible clip, nested flattened) */
struct SoundDraw {
  const Clip* clip = nullptr;
  const Media* media = nullptr;
  const Track* track = nullptr;
  std::vector<const Clip*> parents;  // nested clips this sound is inside, outermost first
  Tick local = 0, source = 0;
};

}  // namespace rhap
