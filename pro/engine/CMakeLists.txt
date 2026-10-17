add_library(rhap STATIC
  ticks.cpp
  model/model.cpp model/edit.cpp
  io/project_io.cpp
  media/decode.cpp media/prefetch.cpp
  gfx/color.cpp gfx/gpu.cpp gfx/text.cpp
  render/evaluate.cpp render/renderer.cpp
  audio/dsp.cpp audio/mixer.cpp
  render/export.cpp
  interchange/common.cpp interchange/otio.cpp interchange/fcpxml.cpp interchange/edl.cpp interchange/xmeml.cpp
  interchange/web.cpp interchange/interchange.cpp)
target_include_directories(rhap PUBLIC ${CMAKE_CURRENT_SOURCE_DIR} ${CMAKE_CURRENT_SOURCE_DIR}/..)
pkg_check_modules(FT REQUIRED IMPORTED_TARGET freetype2 harfbuzz)
target_link_libraries(rhap PUBLIC nlohmann_json::nlohmann_json pugixml::pugixml PkgConfig::FFMPEG PkgConfig::FT
                      SDL3::SDL3 Threads::Threads)
target_compile_definitions(rhap PUBLIC RHAP_FONT_DIR="${CMAKE_CURRENT_SOURCE_DIR}/../../server/render/fonts")
target_compile_options(rhap PRIVATE -Wall -Wextra -Wno-missing-field-initializers)
rhap_shaders(rhap NAME rhap_shaders SOURCES
  gfx/shaders/quad.vert gfx/shaders/layer.frag gfx/shaders/output.frag gfx/shaders/blur.frag)
