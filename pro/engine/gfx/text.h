#pragma once
// Titles: text shaped with HarfBuzz (so Arabic joins and runs right to left),
// rasterised with FreeType into a straight-alpha sRGB RGBA8 image, with an
// optional stroke and a background box.

#include <cstdint>
#include <string>
#include <vector>

#include "../model/model.h"

namespace rhap::gfx {

struct TextImage {
  int width = 0, height = 0;
  std::vector<uint8_t> rgba;  // straight alpha, sRGB
};

/** where the vendored faces live; set once at start-up (defaults to RHAP_FONT_DIR) */
void setFontDir(const std::string& dir);
const std::string& fontDir();

/** the font file for a family name and the text (Arabic text picks an Arabic face) */
std::string fontFileFor(const std::string& family, const std::string& text);

/** renders `text` (lines split on \n); returns "" or the reason */
std::string rasterize(const std::string& text, const TextStyle& style, TextImage& out);

}  // namespace rhap::gfx
