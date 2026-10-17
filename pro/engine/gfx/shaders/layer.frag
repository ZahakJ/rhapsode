#version 450
// One layer: decode the source samples to linear light in the working gamut,
// apply the primary grade in the working encoding, write premultiplied linear.
#include "color.glsl"

layout(location = 0) in vec2 v_uv;
layout(location = 0) out vec4 o_color;

layout(set = 2, binding = 0) uniform sampler2D s_plane0;
layout(set = 2, binding = 1) uniform sampler2D s_plane1;
layout(set = 2, binding = 2) uniform sampler2D s_plane2;
layout(set = 2, binding = 3) uniform sampler2D s_curves;  // N×1, rgb = per-channel curve after master
layout(set = 2, binding = 4) uniform sampler3D s_lut;
layout(set = 2, binding = 5) uniform sampler3D s_inLut;  // OCIO input transform: encoded source -> ACEScct

layout(set = 3, binding = 0) uniform Layer {
  vec4 u_yuvR, u_yuvG, u_yuvB;  // (y, cb, cr, 1) → R'G'B'
  vec4 u_gamR, u_gamG, u_gamB;  // source linear → working linear
  vec4 u_p0;      // x layout (0 two-plane, 1 three-plane, 2 straight rgba, 3 premultiplied linear, 4 fill), y source transfer, z sample scale, w opacity
  vec4 u_p1;      // x working encoding, y grade on, z lut mix, w curves on
  vec4 u_lift, u_gammaInv, u_gain, u_offset;
  vec4 u_p2;      // x contrast, y pivot, z saturation, w exposure multiplier
  vec4 u_wb;      // xyz white balance multipliers, w vignette
  vec4 u_lutDom;  // xyz domain min, w lut size
  vec4 u_lutInv;  // xyz 1 / (max − min), w curve table size
  vec4 u_fill;    // fill colour (working linear, straight alpha)
  vec4 u_shape;   // x shape (0 none, 1 rect, 2 ellipse), y feather in uv, z corner radius in uv
  vec4 u_inLut;   // x on, y size
};

float shapeMask(vec2 uv) {
  int s = int(u_shape.x);
  if (s == 0) return 1.0;
  vec2 p = abs(uv - 0.5) * 2.0;  // 0 at the centre, 1 at the edges
  float f = max(u_shape.y, 1e-4);
  if (s == 2) return 1.0 - smoothstep(1.0 - f, 1.0, length(p));
  vec2 q = p - (1.0 - u_shape.z);
  float d = length(max(q, 0.0)) / max(u_shape.z, 1e-4);
  float edge = u_shape.z > 0.0 ? d : max(p.x, p.y);
  return 1.0 - smoothstep(1.0 - f, 1.0, edge);
}

float curve(float x, int c) {
  float n = u_lutInv.w;
  float cx = clamp(x, 0.0, 1.0);
  float v = texture(s_curves, vec2((cx * (n - 1.0) + 0.5) / n, 0.5))[c];
  return v + (x - cx);
}

void main() {
  int layout_ = int(u_p0.x);
  vec3 lin;
  float a = 1.0;
  if (layout_ == 4) {
    lin = u_fill.rgb;
    a = u_fill.a * shapeMask(v_uv);
  } else if (layout_ == 3) {
    vec4 t = texture(s_plane0, v_uv);
    a = t.a;
    lin = a > 0.0 ? t.rgb / a : vec3(0.0);
  } else {
    vec3 rgb;
    if (layout_ == 2) {
      vec4 t = texture(s_plane0, v_uv);
      rgb = t.rgb;
      a = t.a;
    } else {
      vec3 yuv;
      yuv.x = texture(s_plane0, v_uv).r;
      if (layout_ == 0) {
        yuv.yz = texture(s_plane1, v_uv).rg;
      } else {
        yuv.y = texture(s_plane1, v_uv).r;
        yuv.z = texture(s_plane2, v_uv).r;
      }
      vec4 q = vec4(yuv * u_p0.z, 1.0);
      rgb = vec3(dot(u_yuvR, q), dot(u_yuvG, q), dot(u_yuvB, q));
    }
    vec3 l;
    if (u_inLut.x > 0.5) {
      float n = u_inLut.y;
      l = toLinear(7, texture(s_inLut, (clamp(rgb, 0.0, 1.0) * (n - 1.0) + 0.5) / n).rgb);  // ACEScct -> linear AP1
    } else {
      l = toLinear(int(u_p0.y), rgb);
    }
    lin = vec3(dot(u_gamR.xyz, l), dot(u_gamG.xyz, l), dot(u_gamB.xyz, l));
    a *= shapeMask(v_uv);
  }

  if (u_p1.y > 0.5) {
    int enc = int(u_p1.x);
    vec3 e = fromLinear(enc, lin * u_p2.w * u_wb.xyz);
    e += u_offset.xyz;
    e = u_gain.xyz * (e + u_lift.xyz * (1.0 - e));
    e = vec3(spow(e.r, u_gammaInv.r), spow(e.g, u_gammaInv.g), spow(e.b, u_gammaInv.b));
    e = (e - u_p2.y) * u_p2.x + u_p2.y;
    float luma = dot(e, vec3(0.2126, 0.7152, 0.0722));
    e = luma + (e - luma) * u_p2.z;
    if (u_p1.w > 0.5) e = vec3(curve(e.r, 0), curve(e.g, 1), curve(e.b, 2));
    if (u_p1.z > 0.0) {
      float n = u_lutDom.w;
      vec3 p = clamp((e - u_lutDom.xyz) * u_lutInv.xyz, 0.0, 1.0);
      vec3 l3 = texture(s_lut, (p * (n - 1.0) + 0.5) / n).rgb;
      e = mix(e, l3, u_p1.z);
    }
    lin = toLinear(enc, e);
  }
  if (u_wb.w > 0.0) lin *= 1.0 - u_wb.w * smoothstep(0.35, 1.0, length(v_uv - 0.5) * 1.41421);
  float k = a * u_p0.w;
  o_color = vec4(lin * k, k);
}
