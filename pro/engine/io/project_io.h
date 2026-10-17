#pragma once
// Project files. A .rpro file is JSON: {"format":"rhapsode-pro","version":1,
// "fnv":"<hash of the project text>","project":{...}}. Writes go to a temp
// file that is fsynced and renamed over the old one, after the old one is
// rotated into .bak1..bak5, so a crash mid-save leaves either the old file or
// the new one, never half of either. A file whose hash does not match its
// body is refused, so a truncated or hand-mangled file never loads as some
// other project.

#include <nlohmann/json_fwd.hpp>
#include <string>

#include "../model/model.h"

namespace rhap {

nlohmann::json toJson(const Project& p);
/** throws std::runtime_error with a readable reason on malformed input */
Project projectFromJson(const nlohmann::json& j);

/** one clip, for formats that carry Rhapsode settings in their metadata */
nlohmann::json clipJson(const Clip& c);
Clip clipFromJson(const nlohmann::json& j);

/** canonical text of a project (stable key order, no whitespace) */
std::string serialize(const Project& p);
Project deserialize(const std::string& text);

struct SaveOptions {
  int backups = 5;
};

/** atomic save; returns "" or the reason it failed (the old file is untouched then) */
std::string saveProject(const Project& p, const std::string& path, SaveOptions o = {});
/** loads and verifies; on failure returns "" in `err` = reason and leaves `out` alone */
bool loadProject(const std::string& path, Project& out, std::string& err);

/** the autosave beside a project: "<dir>/.<name>.autosave.rpro" */
std::string autosavePath(const std::string& projectPath);
/** true when an autosave exists that is newer than the project and differs from it */
bool hasRecovery(const std::string& projectPath);

/** write `data` to `path` atomically (temp + fsync + rename + dir fsync) */
std::string writeAtomic(const std::string& path, const std::string& data);

uint64_t fnv1a(const std::string& s);

}  // namespace rhap
