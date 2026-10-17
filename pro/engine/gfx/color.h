#pragma once
// Colour science shared by the shaders (as uniforms) and the CPU reference
// paths the tests compare them with. Codes follow FFmpeg's AVColor* enums so
// a stream's tags map straight through.
//
// Linear light is scene-referred with 1.0 = SDR reference white. PQ and HLG
// map 203 cd/m² (BT.2408 reference white) to 1.0, so SDR and HDR clips mix on
// one timeline at the brightness a viewer expects.

#include <array>
#include <string>
#include <vector>

#include "../model/model.h"

namespace rhap::color {

using Mat3 = std::array<double, 9>;  // row-major
using Vec3 = std::array<double, 3>;

Mat3 mul(const Mat3& a, const Mat3& b);
Vec3 mul(const Mat3& m, const Vec3& v);
Mat3 inverse(const Mat3& m);
Mat3 identity();

enum class Primaries { BT709, BT2020, P3D65, BT601_525, BT601_625, AP1, AP0 };
enum class Transfer { BT1886, sRGB, PQ, HLG, Linear, Gamma22, Gamma28, ACEScct };

Primaries primariesOf(int avPrimaries);
Transfer transferOf(int avTransfer);
/** RGB → XYZ for a set of primaries (D65 or ACES white as appropriate) */
Mat3 rgbToXyz(Primaries p);
/** linear RGB in one gamut to linear RGB in another (Bradford-adapted when the whites differ) */
Mat3 gamut(Primaries from, Primaries to);

/** encoded value → linear (scene, 1.0 = reference white) */
double toLinear(Transfer t, double v);
/** linear → encoded */
double fromLinear(Transfer t, double v);

/**
 * Y'CbCr → R'G'B' as a 4×4 affine (row-major, applied to (y, cb, cr, 1)) where
 * y, cb, cr are code / 2^bits, the domain every bit depth shares. avMatrix 0
 * means the samples are already RGB.
 */
std::array<double, 16> yuvToRgb(int avMatrix, bool fullRange, int bits);
/** R'G'B' → Y'CbCr, the inverse, producing code / 2^bits values */
std::array<double, 16> rgbToYuv(int avMatrix, bool fullRange, int bits);

/** working space → its primaries and grading encoding */
Primaries workingPrimaries(WorkingSpace w);
Transfer workingEncoding(WorkingSpace w);
Primaries outputPrimaries(OutputSpace o);
Transfer outputTransfer(OutputSpace o);

/** A 3D LUT from a .cube file: size³ RGB triples, red fastest. */
struct Lut3D {
  int size = 0;
  std::array<double, 3> domainMin{0, 0, 0}, domainMax{1, 1, 1};
  std::vector<float> rgb;
  Vec3 apply(const Vec3& v) const;  // trilinear, the same as the GPU sampler
};
/** parses a .cube; returns "" or the reason */
std::string loadCube(const std::string& path, Lut3D& out);
std::string parseCube(const std::string& text, Lut3D& out);

/** Monotone cubic (Fritsch–Carlson) through the points, sampled at n evenly spaced inputs. */
std::vector<float> curveTable(const std::vector<CurvePoint>& pts, int n);

/** The primary grade on one encoded RGB value — the reference the shader is tested against. */
Vec3 applyGrade(const Grade& g, const Vec3& encoded);
/** white balance multipliers (linear) for temperature / tint in −1..1 */
Vec3 whiteBalance(double temperature, double tint);

}  // namespace rhap::color
