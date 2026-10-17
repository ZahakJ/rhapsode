#include "interchange.h"

#include <filesystem>
#include <fstream>
#include <sstream>

#include "../io/project_io.h"
#include "common.h"

namespace rhap {

namespace ix {
std::string writeOtio(const Project&, std::string&);
std::string readOtio(const std::string&, const std::string&, Project&, const ImportOptions&);
std::string writeFcpxml(const Project&, std::string&);
std::string readFcpxml(const std::string&, const std::string&, Project&, const ImportOptions&);
std::string writeEdl(const Project&, std::string&);
std::string readEdl(const std::string&, const std::string&, Project&, const ImportOptions&);
std::string writeXmeml(const Project&, std::string&);
std::string readXmeml(const std::string&, const std::string&, Project&, const ImportOptions&);
std::string readWeb(const std::string&, const std::string&, Project&, const ImportOptions&);
}  // namespace ix

namespace {
std::string extOf(const std::string& path) {
  std::string e = std::filesystem::path(path).extension().string();
  for (auto& c : e) c = char(std::tolower(static_cast<unsigned char>(c)));
  return e.empty() ? e : e.substr(1);
}
}  // namespace

std::string importText(const std::string& text, const std::string& format, const std::string& baseDir, Project& out,
                       const ImportOptions& o) {
  Project p;
  p.name = "Imported";
  std::string e;
  if (format == "otio") e = ix::readOtio(text, baseDir, p, o);
  else if (format == "fcpxml") e = ix::readFcpxml(text, baseDir, p, o);
  else if (format == "edl") e = ix::readEdl(text, baseDir, p, o);
  else if (format == "xml") e = ix::readXmeml(text, baseDir, p, o);
  else if (format == "json") e = ix::readWeb(text, baseDir, p, o);
  else return "unknown interchange format ." + format;
  if (!e.empty()) return e;
  auto errs = check(p);
  if (!errs.empty()) return "the import broke an invariant: " + errs[0];
  out = std::move(p);
  return {};
}

std::string importProject(const std::string& path, Project& out, const ImportOptions& o) {
  std::ifstream f(path, std::ios::binary);
  if (!f) return "cannot open " + path;
  std::stringstream ss;
  ss << f.rdbuf();
  std::string e = importText(ss.str(), extOf(path), ix::dirOf(std::filesystem::absolute(path).string()), out, o);
  if (e.empty() && out.name == "Imported") out.name = ix::fileStem(path);
  return e;
}

std::string exportText(const Project& p, const std::string& format, std::string& out) {
  if (format == "otio") return ix::writeOtio(p, out);
  if (format == "fcpxml") return ix::writeFcpxml(p, out);
  if (format == "edl") return ix::writeEdl(p, out);
  if (format == "xml") return ix::writeXmeml(p, out);
  return "cannot write ." + format;
}

std::string exportProject(const Project& p, const std::string& path) {
  std::string text;
  if (std::string e = exportText(p, extOf(path), text); !e.empty()) return e;
  return writeAtomic(path, text);
}

}  // namespace rhap
