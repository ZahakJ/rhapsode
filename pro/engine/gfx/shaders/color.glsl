// Transfer functions; ids match rhap::color::Transfer.
// 0 BT1886  1 sRGB  2 PQ  3 HLG  4 Linear  5 Gamma22  6 Gamma28  7 ACEScct
// Linear 1.0 is SDR reference white; PQ / HLG put 203 cd/m² there.

float spow(float v, float p) { return v < 0.0 ? -pow(-v, p) : pow(v, p); }

float toLinear1(int t, float v) {
  if (t == 0) return spow(v, 2.4);
  if (t == 1) {
    float a = abs(v);
    float l = a <= 0.04045 ? a / 12.92 : pow((a + 0.055) / 1.055, 2.4);
    return v < 0.0 ? -l : l;
  }
  if (t == 2) {
    float e = pow(max(v, 0.0), 1.0 / 78.84375);
    float y = pow(max(e - 0.8359375, 0.0) / (18.8515625 - 18.6875 * e), 1.0 / 0.1593017578125);
    return y * 10000.0 / 203.0;
  }
  if (t == 3) {
    float e = v <= 0.5 ? v * v / 3.0 : (exp((v - 0.55991073) / 0.17883277) + 0.28466892) / 12.0;
    return 1000.0 * pow(max(e, 0.0), 1.2) / 203.0;
  }
  if (t == 4) return v;
  if (t == 5) return spow(v, 2.2);
  if (t == 6) return spow(v, 2.8);
  return v <= 0.155251141552511 ? (v - 0.0729055341958355) / 10.5402377416545 : exp2(v * 17.52 - 9.72);
}

float fromLinear1(int t, float l) {
  if (t == 0) return spow(l, 1.0 / 2.4);
  if (t == 1) {
    float a = abs(l);
    float v = a <= 0.0031308 ? a * 12.92 : 1.055 * pow(a, 1.0 / 2.4) - 0.055;
    return l < 0.0 ? -v : v;
  }
  if (t == 2) {
    float y = max(l * 203.0 / 10000.0, 0.0);
    float p = pow(y, 0.1593017578125);
    return pow((0.8359375 + 18.8515625 * p) / (1.0 + 18.6875 * p), 78.84375);
  }
  if (t == 3) {
    float e = pow(max(l * 203.0 / 1000.0, 0.0), 1.0 / 1.2);
    return e <= 1.0 / 12.0 ? sqrt(3.0 * e) : 0.17883277 * log(12.0 * e - 0.28466892) + 0.55991073;
  }
  if (t == 4) return l;
  if (t == 5) return spow(l, 1.0 / 2.2);
  if (t == 6) return spow(l, 1.0 / 2.8);
  return l <= 0.0078125 ? 10.5402377416545 * l + 0.0729055341958355 : (log2(max(l, 1e-10)) + 9.72) / 17.52;
}

vec3 toLinear(int t, vec3 v) { return vec3(toLinear1(t, v.r), toLinear1(t, v.g), toLinear1(t, v.b)); }
vec3 fromLinear(int t, vec3 v) { return vec3(fromLinear1(t, v.r), fromLinear1(t, v.g), fromLinear1(t, v.b)); }
