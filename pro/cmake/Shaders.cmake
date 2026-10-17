# rhap_shaders(<target> NAME <name> SOURCES a.vert b.frag c.comp ...)
# Compiles GLSL to SPIR-V with glslc and embeds each as `rhap::shaders::<file_id>`
# (a std::span-like {data, size}) in a generated <name>.h on the target's include path.
find_program(RHAP_GLSLC glslc REQUIRED)
set(RHAP_EMBED_SCRIPT ${CMAKE_CURRENT_LIST_DIR}/embed.cmake)

function(rhap_shaders target)
  cmake_parse_arguments(S "" "NAME" "SOURCES" ${ARGN})
  set(outdir ${CMAKE_CURRENT_BINARY_DIR}/shaders)
  file(MAKE_DIRECTORY ${outdir})
  set(entries "")
  set(deps "")
  foreach(src ${S_SOURCES})
    get_filename_component(abs ${src} ABSOLUTE)
    get_filename_component(file ${src} NAME)
    string(REGEX REPLACE "[^A-Za-z0-9]" "_" id ${file})
    set(spv ${outdir}/${file}.spv)
    add_custom_command(OUTPUT ${spv}
      COMMAND ${RHAP_GLSLC} --target-env=vulkan1.0 -O -MD -MF ${spv}.d -o ${spv} ${abs}
      DEPENDS ${abs} DEPFILE ${spv}.d COMMENT "GLSL -> SPIR-V ${file}" VERBATIM)
    list(APPEND deps ${spv})
    list(APPEND entries "${id}|${spv}")
  endforeach()
  set(header ${outdir}/${S_NAME}.h)
  set(list_file ${outdir}/${S_NAME}.list)
  file(WRITE ${list_file} "${entries}")
  add_custom_command(OUTPUT ${header}
    COMMAND ${CMAKE_COMMAND} -DOUT=${header} -DLIST=${list_file} -P ${RHAP_EMBED_SCRIPT}
    DEPENDS ${deps} ${list_file} ${RHAP_EMBED_SCRIPT} COMMENT "Embedding ${S_NAME}.h" VERBATIM)
  add_custom_target(${target}_${S_NAME} DEPENDS ${header})
  add_dependencies(${target} ${target}_${S_NAME})
  target_sources(${target} PRIVATE ${header})
  target_include_directories(${target} PRIVATE ${outdir})
endfunction()
