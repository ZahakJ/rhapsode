#include <doctest.h>

#include <cmath>

#include "gfx/color.h"

using namespace rhap;
using namespace rhap::color;

namespace {
Vec3 yuv(const std::array<double, 16>& m, double y, double cb, double cr) {
  return {m[0] * y + m[1] * cb + m[2] * cr + m[3], m[4] * y + m[5] * cb + m[6] * cr + m[7],
          m[8] * y + m[9] * cb + m[10] * cr + m[11]};
}
}  // namespace

TEST_CASE("Y'CbCr matrices: video levels, full range, every depth") {
  for (int bits : {8, 10, 12}) {
    double n = std::exp2(bits), k = n / 256;
    auto m = yuvToRgb(1, false, bits);
    Vec3 white = yuv(m, 235 * k / n, 128 * k / n, 128 * k / n);
    Vec3 black = yuv(m, 16 * k / n, 128 * k / n, 128 * k / n);
    for (int c = 0; c < 3; ++c) {
      CHECK(white[size_t(c)] == doctest::Approx(1).epsilon(1e-9));
      CHECK(black[size_t(c)] == doctest::Approx(0).epsilon(1e-9));
    }
    // 75% red bar, BT.709 at 8 bits: Y=51 Cb=109 Cr=212
    if (bits == 8) {
      Vec3 red = yuv(m, 51 / 256.0, 109 / 256.0, 212 / 256.0);
      CHECK(red[0] == doctest::Approx(0.75).epsilon(0.02));
      CHECK(std::fabs(red[1]) < 0.01);
      CHECK(std::fabs(red[2]) < 0.012);
    }
  }
  for (int mtx : {1, 5, 6, 9}) {
    auto f = yuvToRgb(mtx, false, 10), b = rgbToYuv(mtx, false, 10);
    Vec3 rgb{0.3, 0.6, 0.9};
    Vec3 y = yuv(b, rgb[0], rgb[1], rgb[2]);
    Vec3 back = yuv(f, y[0], y[1], y[2]);
    for (int c = 0; c < 3; ++c) CHECK(back[size_t(c)] == doctest::Approx(rgb[size_t(c)]).epsilon(1e-9));
  }
}

TEST_CASE("transfer functions round trip and hit their anchors") {
  for (Transfer t : {Transfer::BT1886, Transfer::sRGB, Transfer::PQ, Transfer::HLG, Transfer::Linear, Transfer::Gamma22,
                     Transfer::Gamma28, Transfer::ACEScct})
    for (double v : {0.0, 0.01, 0.18, 0.5, 0.9, 1.0})
      CHECK_MESSAGE(std::fabs(fromLinear(t, toLinear(t, v)) - v) < 2e-6, int(t) << " at " << v);  // PQ's code 0 is 7e-7
  // PQ: reference white 203 cd/m² is linear 1.0 (code ≈ 0.5807); 100 cd/m² is code ≈ 0.5081
  CHECK(fromLinear(Transfer::PQ, 1.0) == doctest::Approx(0.5807).epsilon(1e-3));
  CHECK(fromLinear(Transfer::PQ, 100.0 / 203) == doctest::Approx(0.5081).epsilon(1e-3));
  // ACEScct: 18% grey sits at 0.4135
  CHECK(fromLinear(Transfer::ACEScct, 0.18) == doctest::Approx(0.4135).epsilon(1e-3));
  // HLG: 75% signal is reference white (BT.2408) — within the per-channel OOTF approximation
  CHECK(toLinear(Transfer::HLG, 0.75) == doctest::Approx(1.0).epsilon(0.03));
}

TEST_CASE("gamut conversion") {
  Mat3 m = gamut(Primaries::BT709, Primaries::BT2020);
  // BT.2087: 709 → 2020
  CHECK(m[0] == doctest::Approx(0.6274).epsilon(1e-3));
  CHECK(m[1] == doctest::Approx(0.3293).epsilon(1e-3));
  CHECK(m[2] == doctest::Approx(0.0433).epsilon(1e-2));
  Mat3 r = mul(gamut(Primaries::BT2020, Primaries::BT709), m);
  for (int i = 0; i < 9; ++i) CHECK(r[size_t(i)] == doctest::Approx(i % 4 == 0 ? 1 : 0).epsilon(1e-9));
  // white stays white through the Bradford-adapted ACES conversion
  Vec3 w = mul(gamut(Primaries::BT709, Primaries::AP1), Vec3{1, 1, 1});
  for (double v : w) CHECK(v == doctest::Approx(1).epsilon(2e-3));
}

TEST_CASE(".cube LUTs") {
  std::string cube = "TITLE \"identity\"\n# comment\nLUT_3D_SIZE 2\n";
  for (int b = 0; b < 2; ++b)
    for (int g = 0; g < 2; ++g)
      for (int r = 0; r < 2; ++r) cube += std::to_string(r) + " " + std::to_string(g) + " " + std::to_string(b) + "\n";
  Lut3D l;
  REQUIRE(parseCube(cube, l).empty());
  Vec3 v = l.apply({0.25, 0.5, 0.75});
  CHECK(v[0] == doctest::Approx(0.25));
  CHECK(v[1] == doctest::Approx(0.5));
  CHECK(v[2] == doctest::Approx(0.75));
  CHECK_FALSE(parseCube("LUT_3D_SIZE 3\n0 0 0\n", l).empty());
  CHECK_FALSE(parseCube("LUT_1D_SIZE 3\n", l).empty());
}

TEST_CASE("curves pass through their points and stay monotone") {
  std::vector<CurvePoint> pts{{0, 0}, {0.25, 0.15}, {0.5, 0.6}, {1, 1}};
  auto t = curveTable(pts, 1025);
  CHECK(t[0] == doctest::Approx(0));
  CHECK(t[256] == doctest::Approx(0.15).epsilon(1e-4));
  CHECK(t[512] == doctest::Approx(0.6).epsilon(1e-4));
  CHECK(t[1024] == doctest::Approx(1));
  for (size_t i = 1; i < t.size(); ++i) CHECK(t[i] >= t[i - 1] - 1e-7);
  auto id = curveTable({}, 5);
  CHECK(id[2] == doctest::Approx(0.5));
}

TEST_CASE("a neutral grade is the identity") {
  Grade g;
  CHECK(g.neutral());
  Vec3 v = applyGrade(g, {0.1, 0.5, 0.9});
  CHECK(v[0] == doctest::Approx(0.1));
  CHECK(v[2] == doctest::Approx(0.9));
  g.saturation = 0;
  v = applyGrade(g, {0.2, 0.4, 0.6});
  CHECK(v[0] == doctest::Approx(v[2]));
}
