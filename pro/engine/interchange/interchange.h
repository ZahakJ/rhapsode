#pragma once
// Projects in and out of other editors.
//
//   .otio    OpenTimelineIO JSON — in and out (Rhapsode's own clip settings
//            ride along in metadata, so a Rhapsode → OTIO → Rhapsode trip is lossless)
//   .fcpxml  Final Cut Pro XML 1.10 — in and out (spine + connected clips by lane)
//   .edl     CMX 3600 — in and out (one picture track, cuts and dissolves)
//   .xml     FCP7 / Premiere Pro XML (xmeml v4) — in and out
//   .json    a Rhapsode web studio sequence (quick mode → Pro)
//
// Media paths are resolved against the interchange file's folder when they
// are relative or missing; media that cannot be found stays in the project
// as offline, with the length the file claimed.

#include <map>
#include <string>

#include "../model/model.h"

namespace rhap {

struct ImportOptions {
  Rate rate{30, 1};  // for formats that do not say (EDL)
  bool probeMedia = true;
  /** web sequences: the local file of each source id (filled by the caller) */
  std::map<std::string, std::string> sources;
};

std::string importProject(const std::string& path, Project& out, const ImportOptions& o = {});
std::string importText(const std::string& text, const std::string& format, const std::string& baseDir, Project& out,
                       const ImportOptions& o = {});
/** writes the active sequence; the format follows the extension */
std::string exportProject(const Project& p, const std::string& path);
std::string exportText(const Project& p, const std::string& format, std::string& out);

}  // namespace rhap
