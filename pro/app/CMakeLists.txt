add_executable(rhapsode-pro main.cpp app.cpp player.cpp jobs.cpp ${CMAKE_SOURCE_DIR}/third_party/imgui/misc/cpp/imgui_stdlib.cpp)
target_include_directories(rhapsode-pro PRIVATE ${CMAKE_CURRENT_SOURCE_DIR} ${CMAKE_SOURCE_DIR})
target_link_libraries(rhapsode-pro PRIVATE rhap rhap_imgui rhap_stb)
# rpro sits beside the editor so exports can run as their own process
add_dependencies(rhapsode-pro rpro)
set_target_properties(rhapsode-pro PROPERTIES RUNTIME_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/bin)
set_target_properties(rpro PROPERTIES RUNTIME_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/bin)
