add_executable(rhapsode-pro main.cpp app.cpp player.cpp jobs.cpp ${CMAKE_SOURCE_DIR}/third_party/imgui/misc/cpp/imgui_stdlib.cpp)
target_include_directories(rhapsode-pro PRIVATE ${CMAKE_CURRENT_SOURCE_DIR} ${CMAKE_SOURCE_DIR})
target_link_libraries(rhapsode-pro PRIVATE rhap rhap_imgui rhap_stb)
# rpro sits beside the editor so exports can run as their own process
add_dependencies(rhapsode-pro rpro)
set_target_properties(rhapsode-pro PROPERTIES RUNTIME_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/bin)
set_target_properties(rpro PROPERTIES RUNTIME_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/bin)
# the window icon: icon.png is docs/brand/rhapsode.svg at 128 px (rsvg-convert -w 128 -h 128)
set(RHAP_ICON_DIR ${CMAKE_CURRENT_BINARY_DIR}/embed)
file(MAKE_DIRECTORY ${RHAP_ICON_DIR})
file(WRITE ${RHAP_ICON_DIR}/icon.list "app_icon|${CMAKE_CURRENT_SOURCE_DIR}/icon.png")
add_custom_command(OUTPUT ${RHAP_ICON_DIR}/icon.h
  COMMAND ${CMAKE_COMMAND} -DOUT=${RHAP_ICON_DIR}/icon.h -DLIST=${RHAP_ICON_DIR}/icon.list -DNS=rhap::app::embedded
          -P ${RHAP_EMBED_SCRIPT}
  DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/icon.png ${RHAP_EMBED_SCRIPT} COMMENT "Embedding icon.h" VERBATIM)
target_sources(rhapsode-pro PRIVATE ${RHAP_ICON_DIR}/icon.h)
target_include_directories(rhapsode-pro PRIVATE ${RHAP_ICON_DIR})
