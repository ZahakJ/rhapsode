#include "ticks.h"

#include <cmath>
#include <cstdio>

namespace rhap {

namespace {
int nominal(Rate r) { return int(std::lround(r.fps())); }
bool isDropRate(Rate r) { return r.den == 1001 && (nominal(r) == 30 || nominal(r) == 60); }
}  // namespace

std::string timecode(Tick t, Rate r, bool drop) {
  bool neg = t < 0;
  int64_t f = frameAt(neg ? -t : t, r);
  int fps = nominal(r);
  drop = drop && isDropRate(r);
  if (drop) {
    // SMPTE drop frame: skip frame numbers 0,1 (or 0..3 at 59.94) every minute except each tenth
    int64_t d = fps / 15;  // frames dropped per minute
    int64_t perMin = int64_t(fps) * 60 - d;
    int64_t per10 = perMin * 10 + d;
    int64_t tens = f / per10, rem = f % per10;
    f += 9 * d * tens + (rem > d ? d * ((rem - d) / perMin) : 0);
  }
  int64_t ff = f % fps, s = (f / fps) % 60, m = (f / fps / 60) % 60, h = f / fps / 3600;
  char buf[48];
  std::snprintf(buf, sizeof buf, "%s%02lld:%02lld:%02lld%c%02lld", neg ? "-" : "", (long long)h, (long long)m,
                (long long)s, drop ? ';' : ':', (long long)ff);
  return buf;
}

bool parseTimecode(const std::string& str, Rate r, Tick& out) {
  int h, m, s, f;
  char sep;
  if (std::sscanf(str.c_str(), "%d:%d:%d%c%d", &h, &m, &s, &sep, &f) != 5) return false;
  if (sep != ':' && sep != ';' && sep != '.') return false;
  int fps = nominal(r);
  if (m < 0 || m > 59 || s < 0 || s > 59 || f < 0 || f >= fps || h < 0) return false;
  int64_t frames = (int64_t(h) * 3600 + m * 60 + s) * fps + f;
  if (sep == ';' && isDropRate(r)) {
    int64_t d = fps / 15;
    int64_t totalMin = int64_t(h) * 60 + m;
    frames -= d * (totalMin - totalMin / 10);
  }
  out = frameStart(frames, r);
  return true;
}

}  // namespace rhap
