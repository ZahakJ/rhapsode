#pragma once
// OpenColorIO, baked: the editor's shaders apply OCIO transforms as 3D LUTs
// on a log-encoded (ACEScct) signal, so scene-linear range survives the bake.
//   input:  a camera's encoding (S-Log3, LogC, V-Log, ...) -> ACEScct
//   output: ACEScct -> an OCIO display/view (ACES 2.0 SDR or HDR, ...)
// Built when OpenColorIO was found (RHAP_OCIO); otherwise every call says so.

#include <string>
#include <vector>

#include "color.h"

namespace rhap::ocio {

bool available();
/** the recommended built-in config (ACES 2.0 studio config) */
const char* defaultConfig();
std::vector<std::string> displays(const std::string& config);
std::vector<std::string> views(const std::string& config, const std::string& display);
/** colourspaces a clip can be tagged with (camera logs, display-referred spaces) */
std::vector<std::string> inputSpaces(const std::string& config);

/** ACEScct in, display/view out, sampled on an n³ grid; "" or the reason */
std::string bakeOutput(const std::string& config, const std::string& display, const std::string& view, int n, color::Lut3D& out);
/** a colourspace's encoded values in, ACEScct out */
std::string bakeInput(const std::string& config, const std::string& space, int n, color::Lut3D& out);

/** the reference: one value through OCIO on the CPU (scene-linear ACEScg in, display out) */
std::string applyOutput(const std::string& config, const std::string& display, const std::string& view, float rgb[3]);
/** a colourspace's encoded value to scene-linear ACEScg */
std::string applyInput(const std::string& config, const std::string& space, float rgb[3]);

}  // namespace rhap::ocio
