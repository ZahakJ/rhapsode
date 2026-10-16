#pragma once
// Time is one integer type: flicks, 1/705 600 000 of a second. Every common
// frame rate (23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 120) and sample
// rate (44.1, 48, 88.2, 96 kHz) divides it exactly, so edits never drift and a
// frame boundary is always an integer.

#include <cstdint>
#include <string>

namespace rhap {

using Tick = int64_t;
inline constexpr Tick kFlicks = 705'600'000;

struct Rate {
  int64_t num = 30, den = 1;  // frames per second = num / den
  double fps() const { return double(num) / double(den); }
  bool operator==(const Rate&) const = default;
};

inline constexpr Rate kRate23976{24000, 1001};
inline constexpr Rate kRate2997{30000, 1001};
inline constexpr Rate kRate5994{60000, 1001};

/** the duration of one frame; exact for every rate whose num divides kFlicks * den */
constexpr Tick frameTicks(Rate r) { return kFlicks * r.den / r.num; }
constexpr Tick sampleTicks(int rate) { return kFlicks / rate; }

inline Tick fromSeconds(double s) { return Tick(s * double(kFlicks) + (s >= 0 ? 0.5 : -0.5)); }
inline double toSeconds(Tick t) { return double(t) / double(kFlicks); }

/** floor division that rounds toward −∞ for negative ticks */
constexpr int64_t floorDiv(int64_t a, int64_t b) { return a / b - ((a % b != 0) && ((a < 0) != (b < 0))); }

/** the frame containing t */
constexpr int64_t frameAt(Tick t, Rate r) {
  __int128 a = __int128(t) * r.num, b = __int128(kFlicks) * r.den;
  return int64_t(a / b - ((a % b != 0) && (a < 0)));
}
constexpr Tick frameStart(int64_t frame, Rate r) { return Tick(__int128(frame) * kFlicks * r.den / r.num); }
/** t rounded to the nearest frame boundary */
constexpr Tick snapFrame(Tick t, Rate r) { return frameStart(frameAt(t + frameTicks(r) / 2, r), r); }

constexpr int64_t sampleAt(Tick t, int rate) { return floorDiv(t * rate, kFlicks); }
constexpr Tick sampleStart(int64_t s, int rate) { return s * kFlicks / rate; }

/** HH:MM:SS:FF, or HH;MM;SS;FF drop-frame for 29.97 / 59.94 when drop is set */
std::string timecode(Tick t, Rate r, bool drop = false);
/** parses HH:MM:SS:FF (or ;) back to ticks; returns false on malformed input */
bool parseTimecode(const std::string& s, Rate r, Tick& out);

}  // namespace rhap
