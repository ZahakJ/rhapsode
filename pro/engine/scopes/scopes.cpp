#include "scopes.h"

#include <algorithm>
#include <cmath>

namespace rhap::scopes {

Scopes compute(const uint8_t* px, int w, int h, int stride) {
  Scopes s;
  s.columns = w;
  s.waveform.assign(size_t(w) * 256, 0);
  s.parade.assign(size_t(w) * 3 * 256, 0);
  s.vectorscope.assign(256 * 256, 0);
  for (int y = 0; y < h; ++y) {
    const uint8_t* row = px + size_t(y) * stride;
    for (int x = 0; x < w; ++x) {
      int r = row[x * 4], g = row[x * 4 + 1], b = row[x * 4 + 2];
      // full-range BT.709 on the encoded values, as a display scope reads them
      double Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      double cb = (b - Y) / 1.8556 + 128, cr = (r - Y) / 1.5748 + 128;
      int yi = std::clamp(int(std::lround(Y)), 0, 255);
      s.waveform[size_t(yi) * w + x]++;
      s.parade[size_t(r) * w * 3 + x]++;
      s.parade[size_t(g) * w * 3 + w + x]++;
      s.parade[size_t(b) * w * 3 + 2 * w + x]++;
      int cx = std::clamp(int(std::lround(cb)), 0, 255), cy = std::clamp(int(std::lround(cr)), 0, 255);
      s.vectorscope[size_t(cy) * 256 + cx]++;
      s.histogram[0][size_t(r)]++;
      s.histogram[1][size_t(g)]++;
      s.histogram[2][size_t(b)]++;
      s.histogram[3][size_t(yi)]++;
    }
  }
  for (uint32_t v : s.waveform) s.peak = std::max(s.peak, v);
  return s;
}

std::vector<uint8_t> image(const std::vector<uint32_t>& c, int w, int h, std::array<uint8_t, 3> tint, bool flipY) {
  std::vector<uint8_t> out(size_t(w) * h * 4, 0);
  uint32_t peak = 1;
  for (uint32_t v : c) peak = std::max(peak, v);
  double lp = std::log1p(double(peak));
  for (int y = 0; y < h; ++y)
    for (int x = 0; x < w; ++x) {
      uint32_t v = c[size_t(y) * w + x];
      int oy = flipY ? h - 1 - y : y;
      uint8_t* o = &out[(size_t(oy) * w + x) * 4];
      if (!v) {
        o[3] = 255;
        continue;
      }
      double k = 0.25 + 0.75 * std::log1p(double(v)) / lp;
      for (int i = 0; i < 3; ++i) o[i] = uint8_t(std::min(255.0, tint[size_t(i)] * k));
      o[3] = 255;
    }
  return out;
}

}  // namespace rhap::scopes
