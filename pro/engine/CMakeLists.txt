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
  interchange/web.cpp interchange/interchange.cpp
  session/session.cpp scopes/scopes.cpp
  ai/analysis.cpp ai/sound.cpp ai/transcribe.cpp
  net/web.cpp)
target_include_directories(rhap PUBLIC ${CMAKE_CURRENT_SOURCE_DIR} ${CMAKE_CURRENT_SOURCE_DIR}/..)
pkg_check_modules(FT REQUIRED IMPORTED_TARGET freetype2 harfbuzz)
pkg_check_modules(CURL REQUIRED IMPORTED_TARGET libcurl)
target_link_libraries(rhap PUBLIC nlohmann_json::nlohmann_json pugixml::pugixml PkgConfig::FFMPEG PkgConfig::FT PkgConfig::CURL
                      SDL3::SDL3 Threads::Threads)
target_compile_definitions(rhap PUBLIC RHAP_FONT_DIR="${CMAKE_CURRENT_SOURCE_DIR}/../../server/render/fonts")
target_compile_options(rhap PRIVATE -Wall -Wextra -Wno-missing-field-initializers)
rhap_shaders(rhap NAME rhap_shaders SOURCES
  gfx/shaders/quad.vert gfx/shaders/layer.frag gfx/shaders/output.frag gfx/shaders/blur.frag)

# Local speech recognition: whisper.cpp, cloned into the build dir (see pro/README.md).
set(RHAP_WHISPER_DIR "${CMAKE_BINARY_DIR}/whisper.cpp" CACHE PATH "whisper.cpp source tree")
option(RHAP_WHISPER_CUDA "Build whisper.cpp with CUDA" OFF)
if(EXISTS "${RHAP_WHISPER_DIR}/CMakeLists.txt")
  set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
  set(WHISPER_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
  set(WHISPER_BUILD_TESTS OFF CACHE BOOL "" FORCE)
  set(WHISPER_BUILD_SERVER OFF CACHE BOOL "" FORCE)
  set(GGML_CUDA ${RHAP_WHISPER_CUDA} CACHE BOOL "" FORCE)
  set(GGML_NATIVE ON CACHE BOOL "" FORCE)
  add_subdirectory(${RHAP_WHISPER_DIR} ${CMAKE_BINARY_DIR}/whisper-build EXCLUDE_FROM_ALL)
  target_link_libraries(rhap PUBLIC whisper)
  target_compile_definitions(rhap PUBLIC RHAP_WHISPER=1)
  message(STATUS "rhap: transcription with whisper.cpp (CUDA ${RHAP_WHISPER_CUDA})")
else()
  message(STATUS "rhap: no whisper.cpp at ${RHAP_WHISPER_DIR}; transcription disabled")
endif()
