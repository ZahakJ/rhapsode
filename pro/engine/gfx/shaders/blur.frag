#version 450
// One axis of a Gaussian blur on a premultiplied image, two taps per fetch.
layout(location = 0) in vec2 v_uv;
layout(location = 0) out vec4 o_color;
layout(set = 2, binding = 0) uniform sampler2D s_src;
layout(set = 3, binding = 0) uniform Blur {
  vec4 u_p;  // xy = one texel along the axis (uv), z = sigma in texels
};
void main() {
  float sigma = max(u_p.z, 0.01);
  int r = int(ceil(sigma * 3.0));
  vec4 acc = texture(s_src, v_uv);
  float wsum = 1.0;
  for (int i = 1; i <= r; i += 2) {
    float w0 = exp(-float(i * i) / (2.0 * sigma * sigma));
    float w1 = exp(-float((i + 1) * (i + 1)) / (2.0 * sigma * sigma));
    float w = w0 + w1;
    float o = (float(i) * w0 + float(i + 1) * w1) / w;
    acc += w * (texture(s_src, v_uv + u_p.xy * o) + texture(s_src, v_uv - u_p.xy * o));
    wsum += 2.0 * w;
  }
  o_color = acc / wsum;
}
