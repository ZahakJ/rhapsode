#version 450
// The working image to an output: RGB for a viewer or an encoder, or one
// Y'CbCr plane (Y, or interleaved CbCr at the chroma size) for export.
#include "color.glsl"

layout(location = 0) in vec2 v_uv;
layout(location = 0) out vec4 o_color;
layout(set = 2, binding = 0) uniform sampler2D s_src;  // premultiplied linear, working gamut

layout(set = 3, binding = 0) uniform Output {
  vec4 u_gamR, u_gamG, u_gamB;  // working linear → output linear
  vec4 u_yuvY, u_yuvU, u_yuvV;  // R'G'B' → code/2^bits
  vec4 u_bg;    // background (output linear), w = 1 to flatten alpha
  vec4 u_p0;    // x transfer, y mode (0 rgb, 1 Y, 2 CbCr), z store scale, w highlight roll-off on
};

vec3 encode(vec4 c) {
  vec3 lin = vec3(dot(u_gamR.xyz, c.rgb), dot(u_gamG.xyz, c.rgb), dot(u_gamB.xyz, c.rgb));
  if (u_bg.w > 0.5) lin += u_bg.rgb * (1.0 - c.a);
  if (u_p0.w > 0.5) {
    // soft shoulder above 0.8 for HDR material on an SDR output
    vec3 over = max(lin - 0.8, 0.0);
    lin = min(lin, 0.8) + 0.2 * (1.0 - exp(-over / 0.2));
  }
  return clamp(fromLinear(int(u_p0.x), lin), 0.0, 1.0);
}

void main() {
  int mode = int(u_p0.y);
  vec4 c = texture(s_src, v_uv);
  vec3 e = encode(c);
  if (mode == 0) {
    o_color = vec4(e, u_bg.w > 0.5 ? 1.0 : c.a);
    return;
  }
  vec4 q = vec4(e, 1.0);
  if (mode == 1) {
    o_color = vec4(dot(u_yuvY, q) * u_p0.z, 0.0, 0.0, 1.0);
  } else {
    o_color = vec4(dot(u_yuvU, q) * u_p0.z, dot(u_yuvV, q) * u_p0.z, 0.0, 1.0);
  }
}
