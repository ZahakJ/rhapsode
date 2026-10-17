add_library(rhap STATIC
  ticks.cpp
  model/model.cpp model/edit.cpp
  io/project_io.cpp
  media/decode.cpp)
target_include_directories(rhap PUBLIC ${CMAKE_CURRENT_SOURCE_DIR} ${CMAKE_CURRENT_SOURCE_DIR}/..)
target_link_libraries(rhap PUBLIC nlohmann_json::nlohmann_json pugixml::pugixml PkgConfig::FFMPEG Threads::Threads)
target_compile_options(rhap PRIVATE -Wall -Wextra -Wno-missing-field-initializers)
