#pragma once
// Scopes from a display-encoded RGBA8 frame (the viewer's output, downscaled
// on the GPU first): luma waveform, RGB parade, vectorscope (BT.709 Cb/Cr),
// histograms. Counts, not pictures; the UI turns them into images.

#include <array>
#include <cstdint>
#include <vector>

namespace rhap::scopes {

struct Scopes {
  int columns = 0;                    // waveform width (the frame's width)
  std::vector<uint32_t> waveform;     // columns × 256, row = luma code, Rec.709 Y'
  std::vector<uint32_t> parade;       // 3 × columns × 256 (R, G, B side by side)
  std::vector<uint32_t> vectorscope;  // 256 × 256, x = Cb, y = Cr (128 = neutral)
  std::array<std::array<uint32_t, 256>, 4> histogram{};  // R, G, B, Y'
  uint32_t peak = 0;                  // largest waveform count (for scaling)
};

Scopes compute(const uint8_t* rgba, int width, int height, int stride);

/** draws a count field as a greyscale-on-black RGBA image with log scaling (row 0 = top = code 255) */
std::vector<uint8_t> image(const std::vector<uint32_t>& counts, int w, int h, std::array<uint8_t, 3> tint, bool flipY);

}  // namespace rhap::scopes
