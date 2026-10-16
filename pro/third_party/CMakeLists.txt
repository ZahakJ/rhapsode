add_library(rhap_doctest INTERFACE)
target_include_directories(rhap_doctest SYSTEM INTERFACE doctest)

add_library(rhap_stb INTERFACE)
target_include_directories(rhap_stb SYSTEM INTERFACE stb)

find_package(SDL3 REQUIRED CONFIG GLOBAL)

add_library(rhap_imgui STATIC
  imgui/imgui.cpp imgui/imgui_draw.cpp imgui/imgui_tables.cpp imgui/imgui_widgets.cpp imgui/imgui_demo.cpp
  imgui/backends/imgui_impl_sdl3.cpp imgui/backends/imgui_impl_sdlgpu3.cpp)
target_include_directories(rhap_imgui SYSTEM PUBLIC imgui imgui/backends)
target_link_libraries(rhap_imgui PUBLIC SDL3::SDL3)
