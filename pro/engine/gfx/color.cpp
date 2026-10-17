#include "color.h"

#include <algorithm>
#include <cmath>
#include <fstream>
#include <sstream>

namespace rhap::color {

Mat3 identity() { return {1, 0, 0, 0, 1, 0, 0, 0, 1}; }

Mat3 mul(const Mat3& a, const Mat3& b) {
  Mat3 r{};
  for (int i = 0; i < 3; ++i)
    for (int j = 0; j < 3; ++j)
      for (int k = 0; k < 3; ++k) r[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j];
  return r;
}

Vec3 mul(const Mat3& m, const Vec3& v) {
  return {m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
          m[6] * v[0] + m[7] * v[1] + m[8] * v[2]};
}

Mat3 inverse(const Mat3& m) {
  double a = m[0], b = m[1], c = m[2], d = m[3], e = m[4], f = m[5], g = m[6], h = m[7], i = m[8];
  double A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  double det = a * A + b * B + c * C;
  return {A / det, -(b * i - c * h) / det, (b * f - c * e) / det,
          B / det, (a * i - c * g) / det,  -(a * f - c * d) / det,
          C / det, -(a * h - b * g) / det, (a * e - b * d) / det};
}

namespace {
struct Chroma {
  double rx, ry, gx, gy, bx, by, wx, wy;
};
Chroma chroma(Primaries p) {
  switch (p) {
    case Primaries::BT709: return {0.64, 0.33, 0.30, 0.60, 0.15, 0.06, 0.3127, 0.3290};
    case Primaries::BT2020: return {0.708, 0.292, 0.170, 0.797, 0.131, 0.046, 0.3127, 0.3290};
    case Primaries::P3D65: return {0.680, 0.320, 0.265, 0.690, 0.150, 0.060, 0.3127, 0.3290};
    case Primaries::BT601_525: return {0.630, 0.340, 0.310, 0.595, 0.155, 0.070, 0.3127, 0.3290};
    case Primaries::BT601_625: return {0.64, 0.33, 0.29, 0.60, 0.15, 0.06, 0.3127, 0.3290};
    case Primaries::AP1: return {0.713, 0.293, 0.165, 0.830, 0.128, 0.044, 0.32168, 0.33767};
    case Primaries::AP0: return {0.7347, 0.2653, 0.0, 1.0, 0.0001, -0.0770, 0.32168, 0.33767};
  }
  return chroma(Primaries::BT709);
}
Vec3 xyzOf(double x, double y) { return {x / y, 1.0, (1 - x - y) / y}; }
}  // namespace

Primaries primariesOf(int av) {
  switch (av) {
    case 9: return Primaries::BT2020;
    case 11:
    case 12: return Primaries::P3D65;
    case 6:
    case 7: return Primaries::BT601_525;
    case 5: return Primaries::BT601_625;
    default: return Primaries::BT709;
  }
}

Transfer transferOf(int av) {
  switch (av) {
    case 13: return Transfer::sRGB;
    case 16: return Transfer::PQ;
    case 18: return Transfer::HLG;
    case 8: return Transfer::Linear;
    case 4: return Transfer::Gamma22;
    case 5: return Transfer::Gamma28;
    default: return Transfer::BT1886;
  }
}

Mat3 rgbToXyz(Primaries p) {
  Chroma c = chroma(p);
  Vec3 r = xyzOf(c.rx, c.ry), g = xyzOf(c.gx, c.gy), b = xyzOf(c.bx, c.by), w = xyzOf(c.wx, c.wy);
  Mat3 m{r[0], g[0], b[0], r[1], g[1], b[1], r[2], g[2], b[2]};
  Vec3 s = mul(inverse(m), w);
  return {m[0] * s[0], m[1] * s[1], m[2] * s[2], m[3] * s[0], m[4] * s[1],
          m[5] * s[2], m[6] * s[0], m[7] * s[1], m[8] * s[2]};
}

Mat3 gamut(Primaries from, Primaries to) {
  if (from == to) return identity();
  Mat3 m = mul(inverse(rgbToXyz(to)), rgbToXyz(from));
  Chroma a = chroma(from), b = chroma(to);
  if (a.wx != b.wx || a.wy != b.wy) {
    // Bradford chromatic adaptation between the whites
    const Mat3 brad{0.8951, 0.2664, -0.1614, -0.7502, 1.7135, 0.0367, 0.0389, -0.0685, 1.0296};
    Vec3 ws = mul(brad, xyzOf(a.wx, a.wy)), wd = mul(brad, xyzOf(b.wx, b.wy));
    Mat3 scale{wd[0] / ws[0], 0, 0, 0, wd[1] / ws[1], 0, 0, 0, wd[2] / ws[2]};
    Mat3 adapt = mul(inverse(brad), mul(scale, brad));
    m = mul(inverse(rgbToXyz(to)), mul(adapt, rgbToXyz(from)));
  }
  return m;
}

namespace {
constexpr double kPqM1 = 2610.0 / 16384, kPqM2 = 2523.0 / 4096 * 128, kPqC1 = 3424.0 / 4096,
                 kPqC2 = 2413.0 / 4096 * 32, kPqC3 = 2392.0 / 4096 * 32;
constexpr double kHlgA = 0.17883277, kHlgB = 0.28466892, kHlgC = 0.55991073;
constexpr double kRefWhite = 203.0;  // cd/m², BT.2408
double spow(double v, double p) { return v < 0 ? -std::pow(-v, p) : std::pow(v, p); }
}  // namespace

double toLinear(Transfer t, double v) {
  switch (t) {
    case Transfer::BT1886: return spow(v, 2.4);
    case Transfer::Gamma22: return spow(v, 2.2);
    case Transfer::Gamma28: return spow(v, 2.8);
    case Transfer::Linear: return v;
    case Transfer::sRGB: {
      double a = std::fabs(v);
      double l = a <= 0.04045 ? a / 12.92 : std::pow((a + 0.055) / 1.055, 2.4);
      return v < 0 ? -l : l;
    }
    case Transfer::PQ: {
      double e = std::pow(std::max(v, 0.0), 1 / kPqM2);
      double y = std::pow(std::max(e - kPqC1, 0.0) / (kPqC2 - kPqC3 * e), 1 / kPqM1);
      return y * 10000 / kRefWhite;
    }
    case Transfer::HLG: {
      double e = v <= 0.5 ? v * v / 3 : (std::exp((v - kHlgC) / kHlgA) + kHlgB) / 12;
      return 1000 * std::pow(std::max(e, 0.0), 1.2) / kRefWhite;  // OOTF at 1000 cd/m², per channel
    }
    case Transfer::ACEScct:
      return v <= 0.155251141552511 ? (v - 0.0729055341958355) / 10.5402377416545 : std::exp2(v * 17.52 - 9.72);
  }
  return v;
}

double fromLinear(Transfer t, double l) {
  switch (t) {
    case Transfer::BT1886: return spow(l, 1 / 2.4);
    case Transfer::Gamma22: return spow(l, 1 / 2.2);
    case Transfer::Gamma28: return spow(l, 1 / 2.8);
    case Transfer::Linear: return l;
    case Transfer::sRGB: {
      double a = std::fabs(l);
      double v = a <= 0.0031308 ? a * 12.92 : 1.055 * std::pow(a, 1 / 2.4) - 0.055;
      return l < 0 ? -v : v;
    }
    case Transfer::PQ: {
      double y = std::max(l * kRefWhite / 10000, 0.0);
      double p = std::pow(y, kPqM1);
      return std::pow((kPqC1 + kPqC2 * p) / (1 + kPqC3 * p), kPqM2);
    }
    case Transfer::HLG: {
      double e = std::pow(std::max(l * kRefWhite / 1000, 0.0), 1 / 1.2);
      return e <= 1.0 / 12 ? std::sqrt(3 * e) : kHlgA * std::log(12 * e - kHlgB) + kHlgC;
    }
    case Transfer::ACEScct:
      return l <= 0.0078125 ? 10.5402377416545 * l + 0.0729055341958355 : (std::log2(std::max(l, 1e-10)) + 9.72) / 17.52;
  }
  return l;
}

namespace {
void coeffs(int m, double& kr, double& kb) {
  switch (m) {
    case 5:
    case 6: kr = 0.299, kb = 0.114; break;
    case 9:
    case 10: kr = 0.2627, kb = 0.0593; break;
    case 7: kr = 0.212, kb = 0.087; break;
    default: kr = 0.2126, kb = 0.0722; break;
  }
}
}  // namespace

std::array<double, 16> yuvToRgb(int avMatrix, bool full, int bits) {
  if (avMatrix == 0) return {1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1};
  double kr, kb;
  coeffs(avMatrix, kr, kb);
  double kg = 1 - kr - kb;
  // normalise: Y' = (y − yo)·ys, C' = (c − 0.5)·cs
  double n = std::exp2(bits);
  double yo = full ? 0 : 16.0 / 256, ys = full ? n / (n - 1) : 256.0 / 219, cs = full ? n / (n - 1) : 256.0 / 224;
  // R' = Y' + 2(1−kr)Cr', B' = Y' + 2(1−kb)Cb', G' = Y' − (2kb(1−kb)/kg)Cb' − (2kr(1−kr)/kg)Cr'
  double rCr = 2 * (1 - kr), bCb = 2 * (1 - kb), gCb = -2 * kb * (1 - kb) / kg, gCr = -2 * kr * (1 - kr) / kg;
  auto row = [&](double fy, double fcb, double fcr) {
    // fy·(y−yo)ys + fcb·(cb−0.5)cs + fcr·(cr−0.5)cs
    return std::array<double, 4>{fy * ys, fcb * cs, fcr * cs, -fy * ys * yo - (fcb + fcr) * cs * 0.5};
  };
  auto r = row(1, 0, rCr), g = row(1, gCb, gCr), b = row(1, bCb, 0);
  return {r[0], r[1], r[2], r[3], g[0], g[1], g[2], g[3], b[0], b[1], b[2], b[3], 0, 0, 0, 1};
}

std::array<double, 16> rgbToYuv(int avMatrix, bool full, int bits) {
  auto m = yuvToRgb(avMatrix, full, bits);
  // invert the affine: [A t; 0 1]⁻¹ = [A⁻¹ −A⁻¹t; 0 1]
  Mat3 a{m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]};
  Mat3 ai = inverse(a);
  Vec3 t = mul(ai, Vec3{m[3], m[7], m[11]});
  return {ai[0], ai[1], ai[2], -t[0], ai[3], ai[4], ai[5], -t[1], ai[6], ai[7], ai[8], -t[2], 0, 0, 0, 1};
}

Primaries workingPrimaries(WorkingSpace w) {
  switch (w) {
    case WorkingSpace::ACEScct: return Primaries::AP1;
    case WorkingSpace::Rec2020: return Primaries::BT2020;
    default: return Primaries::BT709;
  }
}
Transfer workingEncoding(WorkingSpace w) { return w == WorkingSpace::ACEScct ? Transfer::ACEScct : Transfer::BT1886; }
Primaries outputPrimaries(OutputSpace o) {
  return o == OutputSpace::Rec2020PQ || o == OutputSpace::Rec2020HLG ? Primaries::BT2020 : Primaries::BT709;
}
Transfer outputTransfer(OutputSpace o) {
  switch (o) {
    case OutputSpace::sRGB: return Transfer::sRGB;
    case OutputSpace::Rec2020PQ: return Transfer::PQ;
    case OutputSpace::Rec2020HLG: return Transfer::HLG;
    default: return Transfer::BT1886;
  }
}

// ——— LUTs ———

std::string parseCube(const std::string& text, Lut3D& out) {
  Lut3D l;
  std::istringstream in(text);
  std::string line;
  while (std::getline(in, line)) {
    auto h = line.find('#');
    if (h != std::string::npos) line.resize(h);
    std::istringstream ls(line);
    std::string key;
    if (!(ls >> key)) continue;
    if (key == "TITLE") continue;
    if (key == "LUT_1D_SIZE") return "1D LUTs are not supported, only 3D";
    if (key == "LUT_3D_SIZE") {
      ls >> l.size;
      if (l.size < 2 || l.size > 256) return "LUT_3D_SIZE out of range";
      l.rgb.reserve(size_t(l.size) * l.size * l.size * 3);
      continue;
    }
    if (key == "DOMAIN_MIN") {
      ls >> l.domainMin[0] >> l.domainMin[1] >> l.domainMin[2];
      continue;
    }
    if (key == "DOMAIN_MAX") {
      ls >> l.domainMax[0] >> l.domainMax[1] >> l.domainMax[2];
      continue;
    }
    if (key == "LUT_3D_INPUT_RANGE") {
      double a, b;
      ls >> a >> b;
      l.domainMin = {a, a, a};
      l.domainMax = {b, b, b};
      continue;
    }
    char* end = nullptr;
    float r = std::strtof(key.c_str(), &end);
    if (end == key.c_str()) continue;  // unknown keyword
    float g, b;
    if (!(ls >> g >> b)) return "a malformed data line";
    l.rgb.insert(l.rgb.end(), {r, g, b});
  }
  if (l.size == 0) return "no LUT_3D_SIZE";
  if (l.rgb.size() != size_t(l.size) * l.size * l.size * 3) return "the LUT has the wrong number of entries";
  out = std::move(l);
  return {};
}

std::string loadCube(const std::string& path, Lut3D& out) {
  std::ifstream f(path);
  if (!f) return "cannot open " + path;
  std::stringstream ss;
  ss << f.rdbuf();
  return parseCube(ss.str(), out);
}

Vec3 Lut3D::apply(const Vec3& v) const {
  if (size < 2) return v;
  double p[3];
  int i0[3], i1[3];
  double f[3];
  for (int c = 0; c < 3; ++c) {
    p[c] = std::clamp((v[c] - domainMin[c]) / (domainMax[c] - domainMin[c]), 0.0, 1.0) * (size - 1);
    i0[c] = std::min(int(p[c]), size - 2);
    i1[c] = i0[c] + 1;
    f[c] = p[c] - i0[c];
  }
  auto at = [&](int r, int g, int b, int c) { return double(rgb[(size_t(b) * size * size + size_t(g) * size + r) * 3 + c]); };
  Vec3 o;
  for (int c = 0; c < 3; ++c) {
    double c00 = at(i0[0], i0[1], i0[2], c) * (1 - f[0]) + at(i1[0], i0[1], i0[2], c) * f[0];
    double c10 = at(i0[0], i1[1], i0[2], c) * (1 - f[0]) + at(i1[0], i1[1], i0[2], c) * f[0];
    double c01 = at(i0[0], i0[1], i1[2], c) * (1 - f[0]) + at(i1[0], i0[1], i1[2], c) * f[0];
    double c11 = at(i0[0], i1[1], i1[2], c) * (1 - f[0]) + at(i1[0], i1[1], i1[2], c) * f[0];
    double c0 = c00 * (1 - f[1]) + c10 * f[1], c1 = c01 * (1 - f[1]) + c11 * f[1];
    o[c] = c0 * (1 - f[2]) + c1 * f[2];
  }
  return o;
}

// ——— curves and the grade ———

std::vector<float> curveTable(const std::vector<CurvePoint>& in, int n) {
  std::vector<float> t(static_cast<size_t>(n));
  std::vector<CurvePoint> p = in;
  std::sort(p.begin(), p.end(), [](auto& a, auto& b) { return a.x < b.x; });
  p.erase(std::unique(p.begin(), p.end(), [](auto& a, auto& b) { return a.x == b.x; }), p.end());
  if (p.size() < 2) {
    for (int i = 0; i < n; ++i) t[size_t(i)] = float(i) / float(n - 1);
    return t;
  }
  size_t k = p.size();
  std::vector<double> d(k - 1), m(k);
  for (size_t i = 0; i + 1 < k; ++i) d[i] = (p[i + 1].y - p[i].y) / (p[i + 1].x - p[i].x);
  m[0] = d[0];
  m[k - 1] = d[k - 2];
  for (size_t i = 1; i + 1 < k; ++i) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (size_t i = 0; i + 1 < k; ++i) {
    if (d[i] == 0) {
      m[i] = m[i + 1] = 0;
      continue;
    }
    double a = m[i] / d[i], b = m[i + 1] / d[i], s = a * a + b * b;
    if (s > 9) {
      double tau = 3 / std::sqrt(s);
      m[i] = tau * a * d[i];
      m[i + 1] = tau * b * d[i];
    }
  }
  for (int j = 0; j < n; ++j) {
    double x = double(j) / double(n - 1);
    double y;
    if (x <= p.front().x) {
      y = p.front().y;
    } else if (x >= p.back().x) {
      y = p.back().y;
    } else {
      size_t i = 0;
      while (i + 2 < k && x > p[i + 1].x) ++i;
      double h = p[i + 1].x - p[i].x, u = (x - p[i].x) / h;
      double h00 = 2 * u * u * u - 3 * u * u + 1, h10 = u * u * u - 2 * u * u + u, h01 = -2 * u * u * u + 3 * u * u,
             h11 = u * u * u - u * u;
      y = h00 * p[i].y + h10 * h * m[i] + h01 * p[i + 1].y + h11 * h * m[i + 1];
    }
    t[size_t(j)] = float(y);
  }
  return t;
}

Vec3 whiteBalance(double temperature, double tint) {
  Vec3 w{std::exp2(0.35 * temperature), std::exp2(-0.35 * tint), std::exp2(-0.35 * temperature)};
  double y = 0.2126 * w[0] + 0.7152 * w[1] + 0.0722 * w[2];
  return {w[0] / y, w[1] / y, w[2] / y};
}

namespace {
double tableAt(const std::vector<float>& t, double x) {
  int n = int(t.size());
  if (x <= 0) return t[0] + x;  // extrapolate with unit slope outside [0, 1]
  if (x >= 1) return t[size_t(n - 1)] + (x - 1);
  double p = x * (n - 1);
  int i = std::min(int(p), n - 2);
  double f = p - i;
  return t[size_t(i)] * (1 - f) + t[size_t(i + 1)] * f;
}
}  // namespace

Vec3 applyGrade(const Grade& g, const Vec3& in) {
  Vec3 v = in;
  if (!g.enabled) return v;
  for (int c = 0; c < 3; ++c) {
    double x = v[c] + g.offset[size_t(c)];
    x = g.gain[size_t(c)] * (x + g.lift[size_t(c)] * (1 - x));
    x = spow(x, 1 / std::max(g.gamma[size_t(c)], 1e-3));
    x = (x - g.pivot) * g.contrast + g.pivot;
    v[c] = x;
  }
  double l = 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
  for (int c = 0; c < 3; ++c) v[c] = l + (v[c] - l) * g.saturation;
  if (!g.master.empty() || !g.red.empty() || !g.green.empty() || !g.blue.empty()) {
    auto master = curveTable(g.master, 1024);
    const std::vector<CurvePoint>* ch[3] = {&g.red, &g.green, &g.blue};
    for (int c = 0; c < 3; ++c) {
      double x = tableAt(master, v[c]);
      v[c] = tableAt(curveTable(*ch[c], 1024), x);
    }
  }
  return v;
}

}  // namespace rhap::color
