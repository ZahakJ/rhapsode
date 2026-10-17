#version 450
// Four corners in NDC with their uvs; drawn as a triangle strip without a vertex buffer.
layout(location = 0) out vec2 v_uv;
layout(set = 1, binding = 0) uniform Quad {
  vec4 u_corner[4];  // xy = NDC, zw = uv; order: top-left, top-right, bottom-left, bottom-right
};
void main() {
  vec4 c = u_corner[gl_VertexIndex];
  v_uv = c.zw;
  gl_Position = vec4(c.xy, 0.0, 1.0);
}
