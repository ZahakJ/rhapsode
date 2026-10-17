#pragma once
// Media fixtures made with the ffmpeg CLI on first use and cached under the
// build dir. Every frame's luma is (n * 7) mod 256 with n its frame number,
// so a decoded frame names itself.
#include <cstdlib>
#include <filesystem>
#include <string>

#include "fixtures.h"

namespace fx {

inline std::string mediaDir() {
  auto d = std::filesystem::path(RHAP_TEST_TMP) / "media";
  std::filesystem::create_directories(d);
  return d.string();
}

/** frames numbered by luma; `codec` args go after the filter */
inline std::string numbered(const std::string& name, const std::string& codecArgs, double seconds = 4, int fps = 30,
                            const std::string& extraFilter = "", const std::string& size = "320x240",
                            const std::string& pre = "") {
  std::string out = mediaDir() + "/" + name;
  if (std::filesystem::exists(out)) return out;
  std::string vf = "geq=lum='mod(N*7\\,256)':cb=128:cr=128" + (extraFilter.empty() ? "" : "," + extraFilter);
  std::string cmd = "ffmpeg -nostdin -loglevel error -y -f lavfi -i color=c=gray:s=" + size + ":r=" + std::to_string(fps) +
                    ":d=" + std::to_string(seconds) + " -f lavfi -i sine=frequency=440:sample_rate=48000:duration=" +
                    std::to_string(seconds) + " " + pre + " -vf \"" + vf + "\" " + codecArgs + " -shortest '" + out + ".part." +
                    std::filesystem::path(out).extension().string().substr(1) + "' && mv '" + out + ".part." +
                    std::filesystem::path(out).extension().string().substr(1) + "' '" + out + "'";
  if (std::system(cmd.c_str()) != 0) return "";
  return out;
}

/** the frame number a decoded luma value names (mod 256/7 ambiguity resolved near `expect`) */
inline int lumaToFrame(int y, int expect) {
  for (int d = 0; d < 37; ++d)
    for (int f : {expect - d, expect + d})
      if (f >= 0 && std::abs((f * 7) % 256 - y) <= 2) return f;
  return -1;
}

}  // namespace fx
