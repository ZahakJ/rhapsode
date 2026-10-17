#pragma once
// Export: the viewer's renderer and mixer, offline and frame-exact, into
// libavcodec. The GPU writes Y'CbCr planes straight in the encoder's layout
// (NV12, P010, planar 4:2:2), three frames stay in flight so the GPU, the
// readback and the encoder overlap.

#include <functional>
#include <string>
#include <vector>

#include "../model/model.h"

namespace rhap {

enum class PixFmt { NV12, P010, YUV420P, YUV422P, YUV422P10 };

struct Preset {
  std::string id, name, ext;
  std::vector<std::string> encoders;  // first that opens wins (NVENC first, software after)
  PixFmt pix = PixFmt::NV12;
  int cq = 0;              // constant quality (NVENC cq / x264 crf); 0 = use bitrate
  int64_t bitrate = 0;     // bits/s
  std::string profile;
  std::string acodec = "aac";
  int64_t abitrate = 320000;
  int width = 0, height = 0;  // 0 = the sequence's
  bool hdr = false;           // tags and output in Rec.2020 PQ
  int gop = 0;                // 0 = encoder default; 1 = intra only
};

const std::vector<Preset>& presets();
const Preset* findPreset(const std::string& id);

struct ExportJob {
  Project project;
  std::string sequence;  // empty = the active one
  Preset preset;
  std::string path;
  Tick in = 0, out = -1;  // -1 = to the end
  bool hwDecode = true;
};

struct ExportProgress {
  int64_t frame = 0, total = 0;
  double fps = 0;
  std::string encoder;
};

/** Runs an export to completion; returns "" or the reason. `progress` returning false cancels. */
std::string runExport(const ExportJob& job, const std::function<bool(const ExportProgress&)>& progress = {},
                      ExportProgress* summary = nullptr);

}  // namespace rhap
