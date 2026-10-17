#include "text.h"

#include <ft2build.h>
#include FT_FREETYPE_H
#include FT_GLYPH_H
#include FT_STROKER_H
#include <hb-ft.h>
#include <hb.h>

#include <algorithm>
#include <cmath>
#include <filesystem>
#include <mutex>

#ifndef RHAP_FONT_DIR
#define RHAP_FONT_DIR "fonts"
#endif

namespace rhap::gfx {

namespace {
std::string& dirRef() {
  static std::string d = RHAP_FONT_DIR;
  return d;
}
std::mutex gFt;
FT_Library gLib = nullptr;

bool hasArabic(const std::string& s) {
  for (size_t i = 0; i < s.size();) {
    unsigned char c = static_cast<unsigned char>(s[i]);
    uint32_t cp;
    int n;
    if (c < 0x80) cp = c, n = 1;
    else if ((c >> 5) == 6) cp = c & 0x1F, n = 2;
    else if ((c >> 4) == 14) cp = c & 0x0F, n = 3;
    else cp = c & 0x07, n = 4;
    for (int k = 1; k < n && i + size_t(k) < s.size(); ++k) cp = (cp << 6) | (static_cast<unsigned char>(s[i + k]) & 0x3F);
    if ((cp >= 0x0600 && cp <= 0x06FF) || (cp >= 0x0750 && cp <= 0x077F) || (cp >= 0xFB50 && cp <= 0xFDFF) ||
        (cp >= 0xFE70 && cp <= 0xFEFF))
      return true;
    i += size_t(n);
  }
  return false;
}

std::vector<std::string> lines(const std::string& s) {
  std::vector<std::string> out(1);
  for (char c : s) {
    if (c == '\n') out.emplace_back();
    else out.back() += c;
  }
  return out;
}

struct Cov {
  int w = 0, h = 0;
  std::vector<uint8_t> a;
  void put(const FT_Bitmap& b, int x0, int y0) {
    for (unsigned y = 0; y < b.rows; ++y)
      for (unsigned x = 0; x < b.width; ++x) {
        int X = x0 + int(x), Y = y0 + int(y);
        if (X < 0 || Y < 0 || X >= w || Y >= h) continue;
        uint8_t v = b.buffer[y * unsigned(std::abs(b.pitch)) + x];
        uint8_t& d = a[size_t(Y) * w + X];
        d = std::max(d, v);
      }
  }
};
}  // namespace

void setFontDir(const std::string& dir) { dirRef() = dir; }
const std::string& fontDir() { return dirRef(); }

std::string fontFileFor(const std::string& family, const std::string& text) {
  if (std::filesystem::exists(family) && family.find('/') != std::string::npos) return family;
  const std::string& d = fontDir();
  if (hasArabic(text)) return d + "/IBMPlexSansArabic-Bold.ttf";
  if (family == "Anton" || family.empty()) return d + "/Anton-Regular.ttf";
  return d + "/IBMPlexSans-Bold.woff";
}

std::string rasterize(const std::string& text, const TextStyle& st, TextImage& out) {
  std::lock_guard lock(gFt);
  if (!gLib && FT_Init_FreeType(&gLib)) return "FreeType did not start";
  std::string file = fontFileFor(st.font, text);
  FT_Face face;
  if (FT_New_Face(gLib, file.c_str(), 0, &face)) return "cannot load the font " + file;
  struct FaceGuard {
    FT_Face f;
    ~FaceGuard() { FT_Done_Face(f); }
  } guard{face};
  int px = std::clamp(int(std::lround(st.size)), 4, 1000);
  FT_Set_Pixel_Sizes(face, 0, FT_UInt(px));
  hb_font_t* hb = hb_ft_font_create_referenced(face);

  struct Glyph {
    unsigned id;
    double x, y;  // pen position, pixels, y down from the line's baseline
  };
  struct Line {
    std::vector<Glyph> g;
    double width = 0;
  };
  std::vector<Line> ls;
  for (const std::string& s : lines(text)) {
    Line L;
    hb_buffer_t* buf = hb_buffer_create();
    hb_buffer_add_utf8(buf, s.c_str(), int(s.size()), 0, int(s.size()));
    hb_buffer_guess_segment_properties(buf);
    hb_shape(hb, buf, nullptr, 0);
    unsigned n;
    hb_glyph_info_t* info = hb_buffer_get_glyph_infos(buf, &n);
    hb_glyph_position_t* pos = hb_buffer_get_glyph_positions(buf, &n);
    double pen = 0;
    for (unsigned i = 0; i < n; ++i) {
      L.g.push_back({info[i].codepoint, pen + pos[i].x_offset / 64.0, -pos[i].y_offset / 64.0});
      pen += pos[i].x_advance / 64.0;
    }
    L.width = pen;
    hb_buffer_destroy(buf);
    ls.push_back(std::move(L));
  }
  hb_font_destroy(hb);

  double asc = face->size->metrics.ascender / 64.0, desc = -face->size->metrics.descender / 64.0;
  double lineH = (asc + desc) * st.lineSpacing;
  double stroke = std::max(0.0, st.outlineWidth);
  double pad = std::ceil(stroke + 2 + (st.box[3] > 0 ? st.size * 0.25 : 0));
  double maxW = 0;
  for (auto& l : ls) maxW = std::max(maxW, l.width);
  int W = int(std::ceil(maxW + 2 * pad)), H = int(std::ceil(lineH * double(ls.size() - 1) + asc + desc + 2 * pad));
  W = std::max(W, 1);
  H = std::max(H, 1);
  Cov fill{W, H, std::vector<uint8_t>(size_t(W) * H)}, edge{W, H, std::vector<uint8_t>(size_t(W) * H)};
  FT_Stroker stroker = nullptr;
  if (stroke > 0) {
    FT_Stroker_New(gLib, &stroker);
    FT_Stroker_Set(stroker, FT_Fixed(stroke * 64), FT_STROKER_LINECAP_ROUND, FT_STROKER_LINEJOIN_ROUND, 0);
  }
  for (size_t li = 0; li < ls.size(); ++li) {
    const Line& L = ls[li];
    double x0 = pad + (st.align == 0 ? 0 : st.align == 2 ? maxW - L.width : (maxW - L.width) / 2);
    double base = pad + asc + lineH * double(li);
    for (const Glyph& g : L.g) {
      if (FT_Load_Glyph(face, g.id, FT_LOAD_NO_BITMAP)) continue;
      FT_Glyph glyph;
      if (FT_Get_Glyph(face->glyph, &glyph)) continue;
      FT_Vector origin{FT_Pos(std::lround((x0 + g.x - std::floor(x0 + g.x)) * 64)), 0};
      int ox = int(std::floor(x0 + g.x)), oy = int(std::lround(base + g.y));
      if (stroker) {
        FT_Glyph sg = glyph;
        FT_Glyph_Copy(glyph, &sg);
        if (!FT_Glyph_StrokeBorder(&sg, stroker, 0, 1) && !FT_Glyph_To_Bitmap(&sg, FT_RENDER_MODE_NORMAL, &origin, 1)) {
          auto* bg = reinterpret_cast<FT_BitmapGlyph>(sg);
          edge.put(bg->bitmap, ox + bg->left, oy - bg->top);
        }
        FT_Done_Glyph(sg);
      }
      if (!FT_Glyph_To_Bitmap(&glyph, FT_RENDER_MODE_NORMAL, &origin, 1)) {
        auto* bg = reinterpret_cast<FT_BitmapGlyph>(glyph);
        fill.put(bg->bitmap, ox + bg->left, oy - bg->top);
      }
      FT_Done_Glyph(glyph);
    }
  }
  if (stroker) FT_Stroker_Done(stroker);

  out.width = W;
  out.height = H;
  out.rgba.assign(size_t(W) * H * 4, 0);
  auto over = [](double* d, const std::array<double, 4>& c, double cov) {
    double a = c[3] * cov;
    double oa = a + d[3] * (1 - a);
    for (int k = 0; k < 3; ++k) d[k] = oa > 0 ? (c[size_t(k)] * a + d[k] * d[3] * (1 - a)) / oa : 0;
    d[3] = oa;
  };
  for (int i = 0; i < W * H; ++i) {
    double px4[4] = {0, 0, 0, 0};
    if (st.box[3] > 0) over(px4, st.box, 1);
    if (stroker || stroke > 0) over(px4, st.outline, edge.a[size_t(i)] / 255.0);
    over(px4, st.color, fill.a[size_t(i)] / 255.0);
    for (int k = 0; k < 4; ++k) out.rgba[size_t(i) * 4 + k] = uint8_t(std::lround(std::clamp(px4[k], 0.0, 1.0) * 255));
  }
  return {};
}

}  // namespace rhap::gfx
