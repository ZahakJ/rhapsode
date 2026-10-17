#pragma once
// Sound clean-up rendered to a new file beside the original, on the same
// timeline sample for sample, so a clip can swap to it (and back) without
// moving: noise reduction (FFmpeg's spectral afftdn + a rumble high-pass) and
// voice isolation (Demucs' vocals stem, on the GPU when there is one).

#include <string>

#include "../model/model.h"

namespace rhap::ai {

struct DenoiseOptions {
  double reductionDb = 18;  // how much the noise floor is pulled down
  double highpassHz = 70;   // 0 = off
};

/** writes a FLAC of `src`'s sound with the noise reduced; returns "" or the reason */
std::string denoise(const std::string& src, const std::string& out, const DenoiseOptions& o = {});

/** writes a FLAC of the voice alone (Demucs, two-stem); "" or the reason (Demucs missing included) */
std::string isolateVoice(const std::string& src, const std::string& out, const std::string& demucs = "demucs");

/**
 * Points a sound clip at a processed version of its media: adds the new file
 * as media (once) and swaps the clip's ref. Timing is untouched.
 */
std::string swapSound(Project& p, const std::string& seqId, const std::string& clipId, const std::string& processedPath,
                      const std::string& suffix);

}  // namespace rhap::ai
