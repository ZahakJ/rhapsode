#pragma once
// The project model. A project is a value: copying it is a snapshot, which is
// what undo, autosave and the render process all rely on. Nothing here touches
// the GPU, a file or a decoder.

#include <array>
#include <map>
#include <optional>
#include <string>
#include <vector>

#include "../ticks.h"

namespace rhap {

// ——— keyframes ———

enum class Ease { Linear, Hold, In, Out, InOut, Bezier };

struct Keyframe {
  Tick t = 0;  // clip-local time (0 = the clip's first frame on the timeline)
  double v = 0;
  Ease ease = Ease::Linear;  // how the curve leaves this key toward the next
  // CSS-style cubic bezier control points for Ease::Bezier, in the unit square
  double x1 = 0.42, y1 = 0, x2 = 0.58, y2 = 1;
  bool operator==(const Keyframe&) const = default;
};

/** A number that may be animated. With no keys it is just `value`. */
struct Param {
  double value = 0;
  std::vector<Keyframe> keys;  // sorted by t
  Param() = default;
  Param(double v) : value(v) {}
  double at(Tick local) const;
  bool animated() const { return !keys.empty(); }
  /** set a key at t (replacing one at the same t), keeps keys sorted */
  void setKey(Tick t, double v, Ease e = Ease::Linear);
  bool operator==(const Param&) const = default;
};

/** y of a CSS cubic-bezier(x1,y1,x2,y2) at x in [0,1] */
double cubicBezier(double x1, double y1, double x2, double y2, double x);
double easeValue(Ease e, double u, const Keyframe& k);

/** A 2D motion path point (position keys share t with x/y params). */
struct Vec2 {
  double x = 0, y = 0;
  bool operator==(const Vec2&) const = default;
};

// ——— media ———

enum class MediaKind { Video, Audio, Image };

struct ColorInfo {
  // FFmpeg's AVColor* enum values, kept numeric so the model stays FFmpeg-free
  int primaries = 1, transfer = 1, matrix = 1, range = 1;  // 1 = BT.709, range 1 = limited (MPEG)
  int bitDepth = 8;
  bool hdr() const { return transfer == 16 || transfer == 18; }  // PQ (SMPTE 2084) or HLG
  bool operator==(const ColorInfo&) const = default;
};

struct Media {
  std::string id;
  std::string path;   // the original
  std::string proxy;  // empty until a proxy exists
  std::string name;
  MediaKind kind = MediaKind::Video;
  Tick duration = 0;  // 0 for stills (they last as long as the clip)
  Rate rate{30, 1};   // nominal; VFR media is decoded by timestamp, never by frame number
  bool vfr = false;
  int width = 0, height = 0;
  bool hasVideo = false, hasAudio = false;
  int channels = 0, sampleRate = 0;
  std::string videoCodec, audioCodec;
  ColorInfo color;
  Tick startTimecode = 0;  // source timecode of the first frame, for EDL and multicam sync
  bool operator==(const Media&) const = default;
};

// ——— clips ———

enum class ClipKind { Media, Nested, Title, Shape, Solid, Adjustment, Multicam };
enum class Blend { Normal, Add, Multiply, Screen, Overlay };
enum class ShapeKind { Rect, Ellipse };

struct Transform {
  Param x{0}, y{0};         // offset of the centre, in sequence pixels
  Param scale{1}, scaleY{1};  // scaleY multiplies scale (non-uniform when ≠ 1)
  Param rotation{0};        // degrees, clockwise
  Param anchorX{0}, anchorY{0};  // anchor relative to the centre, in source pixels
  Param opacity{1};
  Param cropL{0}, cropR{0}, cropT{0}, cropB{0};  // fractions of the source
  bool flipH = false, flipV = false;
  bool operator==(const Transform&) const = default;
};

struct CurvePoint {
  double x = 0, y = 0;
  bool operator==(const CurvePoint&) const = default;
};

/** The primary grade. Neutral by default. Applied in the working space. */
struct Grade {
  std::array<double, 3> lift{0, 0, 0}, gamma{1, 1, 1}, gain{1, 1, 1}, offset{0, 0, 0};
  double exposure = 0;  // stops
  double contrast = 1, pivot = 0.435;  // pivot is in the log (ACEScct-like) domain
  double saturation = 1;
  double temperature = 0, tint = 0;  // −1..1
  std::vector<CurvePoint> master, red, green, blue;  // empty = identity
  std::string lut;  // a .cube path, applied after the primary
  double lutMix = 1;
  bool enabled = true;
  bool neutral() const;
  bool operator==(const Grade&) const = default;
};

struct Effect {
  std::string type;  // "blur", "vignette", "eq", "compressor", "denoise", ...
  bool enabled = true;
  std::map<std::string, Param> params;
  bool operator==(const Effect&) const = default;
};

struct TextStyle {
  std::string font = "Anton";  // a family the app knows (vendored), or a path
  double size = 96;            // sequence pixels
  std::array<double, 4> color{1, 1, 1, 1};
  std::array<double, 4> outline{0, 0, 0, 1};
  double outlineWidth = 0;
  std::array<double, 4> box{0, 0, 0, 0};  // background box, alpha 0 = none
  int align = 1;  // 0 left, 1 centre, 2 right
  double lineSpacing = 1.1;
  bool operator==(const TextStyle&) const = default;
};

struct Clip {
  std::string id;
  ClipKind kind = ClipKind::Media;
  std::string ref;   // media id (Media), sequence id (Nested, Multicam)
  std::string name;
  Tick start = 0;    // on the timeline
  Tick dur = 0;      // on the timeline
  Tick in = 0;       // in the source
  double speed = 1;  // source advance per timeline tick; negative plays backwards
  bool enabled = true;
  int label = 0;     // colour label index
  std::string link;  // clips sharing a link id move and trim together (video + its audio)

  // picture
  Transform xf;
  Grade grade;
  Blend blend = Blend::Normal;
  std::vector<Effect> fx;
  // a title / shape / solid
  std::string text;
  TextStyle style;
  ShapeKind shape = ShapeKind::Rect;
  std::array<double, 4> fill{1, 1, 1, 1};
  // multicam: which angle (video track index of the multicam sequence) shows
  int angle = 0;

  // sound
  Param gain{0};  // dB
  Param pan{0};   // −1..1
  std::vector<Effect> afx;
  Tick fadeIn = 0, fadeOut = 0;  // audio fades (ticks)

  Tick end() const { return start + dur; }
  /** source time for a timeline time inside the clip */
  Tick sourceAt(Tick t) const;
  /** how much source the clip consumes */
  Tick sourceSpan() const;
  bool operator==(const Clip&) const = default;
};

enum class TransitionKind { Dissolve, DipToBlack, Wipe, Crossfade };

/** A transition straddles the cut between two adjacent clips on a track. */
struct Transition {
  std::string id;
  Tick at = 0;   // the cut
  Tick dur = 0;  // centred on the cut
  TransitionKind kind = TransitionKind::Dissolve;
  bool operator==(const Transition&) const = default;
};

enum class TrackKind { Video, Audio };

struct Track {
  std::string id;
  TrackKind kind = TrackKind::Video;
  std::string name;
  bool mute = false, solo = false, locked = false, hidden = false;
  bool syncLock = true;  // insert / ripple edits on another track shift this one too
  std::vector<Clip> clips;  // sorted by start, never overlapping
  std::vector<Transition> transitions;
  Param gain{0};  // dB, audio tracks
  Param pan{0};
  std::vector<Effect> fx;  // track FX (audio) or track look (video)
  std::string bus;         // output bus id; empty = master
  bool operator==(const Track&) const = default;
};

struct Marker {
  std::string id;
  Tick t = 0, dur = 0;
  std::string name, note;
  int color = 0;
  bool operator==(const Marker&) const = default;
};

/** A spoken word with its media times (from local transcription). */
struct Word {
  Tick a = 0, b = 0;
  std::string text;  // with its leading space, as the recogniser wrote it
  float p = 1;       // confidence
  bool operator==(const Word&) const = default;
};

struct Transcript {
  std::string media;  // media id
  std::string language;
  std::vector<Word> words;
  bool operator==(const Transcript&) const = default;
};

enum class WorkingSpace { Rec709, ACEScct, Rec2020 };
enum class OutputSpace { Rec709, sRGB, Rec2020PQ, Rec2020HLG };

struct Sequence {
  std::string id;
  std::string name;
  int width = 1920, height = 1080;
  Rate rate{30, 1};
  int sampleRate = 48000;
  std::array<double, 3> background{0, 0, 0};
  std::vector<Track> video;  // index 0 is the bottom
  std::vector<Track> audio;
  std::vector<Marker> markers;
  bool multicam = false;  // a multicam source: one video track per angle
  Tick duration() const;
  bool operator==(const Sequence&) const = default;
};

struct Project {
  int version = 1;
  std::string name = "Untitled";
  std::vector<Media> media;
  std::vector<Sequence> sequences;
  std::string active;  // the sequence open in the timeline
  WorkingSpace working = WorkingSpace::Rec709;
  OutputSpace output = OutputSpace::Rec709;
  int nextId = 1;
  std::vector<Transcript> transcripts;
  bool operator==(const Project&) const = default;

  const Transcript* transcriptOf(const std::string& mediaId) const {
    for (auto& t : transcripts)
      if (t.media == mediaId) return &t;
    return nullptr;
  }

  const Media* findMedia(const std::string& id) const;
  Sequence* findSequence(const std::string& id);
  const Sequence* findSequence(const std::string& id) const;
  Sequence* activeSequence() { return findSequence(active); }
  std::string makeId(const char* prefix);
};

// ——— addressing ———

struct TrackRef {
  TrackKind kind = TrackKind::Video;
  int index = 0;
  bool operator==(const TrackRef&) const = default;
};

Track* trackOf(Sequence& s, TrackRef r);
const Track* trackOf(const Sequence& s, TrackRef r);

struct ClipLoc {
  TrackRef track;
  int index = -1;
  explicit operator bool() const { return index >= 0; }
};
ClipLoc findClip(const Sequence& s, const std::string& clipId);
Clip* clipById(Sequence& s, const std::string& clipId);
const Clip* clipById(const Sequence& s, const std::string& clipId);

/** every track, video first */
template <class S, class F>
void forEachTrack(S& s, F&& f) {
  for (size_t i = 0; i < s.video.size(); ++i) f(s.video[i], TrackRef{TrackKind::Video, int(i)});
  for (size_t i = 0; i < s.audio.size(); ++i) f(s.audio[i], TrackRef{TrackKind::Audio, int(i)});
}

}  // namespace rhap
