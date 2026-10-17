#pragma once
// Shared by the interchange readers and writers.
#include <algorithm>
#include <cmath>
#include <cstring>
#include <set>
#include <string>

#include "../model/edit.h"
#include "interchange.h"

namespace rhap::ix {

/** file:///a%20b → /a b; plain paths pass through */
std::string pathFromUrl(const std::string& url);
std::string urlFromPath(const std::string& path);
/** a media item for a path, reused when the project already has it; probed when it exists */
Media& mediaFor(Project& p, const std::string& path, const std::string& name, Tick claimedDuration, const ImportOptions& o,
                const std::string& baseDir);
/** a fresh sequence with n video and m audio tracks, added to the project */
Sequence& addSequence(Project& p, const std::string& name, int w, int h, Rate rate, int video, int audio);
/** place without the editor's cut-through (imports never overlap by construction; overlaps are skipped) */
void place(Sequence& s, TrackRef r, Clip c);
/** a rate from a float (29.97 → 30000/1001) */
Rate rateOf(double fps);
std::string fileStem(const std::string& path);
std::string dirOf(const std::string& path);
/** gcd-reduced "num/dens" (or "Ns") for FCPXML */
std::string rationalSeconds(Tick t);
/** parses FCPXML time "1001/30000s", "5s", "0s" */
Tick parseRationalSeconds(const std::string& s);
/** after an import: ensure the project has an active sequence and valid ids */
void finish(Project& p, const std::string& active);

}  // namespace rhap::ix
