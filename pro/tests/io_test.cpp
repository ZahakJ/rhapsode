#include <doctest.h>

#include <filesystem>
#include <fstream>

#include "fixtures.h"
#include "io/project_io.h"

using namespace rhap;
using fx::sec;

namespace {
Project busy() {
  Project p = fx::project();
  Editor ed(p, "main");
  Clip c = clipOf(p, *p.findMedia("cam"), 0, sec(10));
  c.xf.scale.setKey(0, 1, Ease::Bezier);
  c.xf.scale.setKey(sec(5), 1.5);
  c.grade.lift = {0.01, -0.02, 0.03};
  c.grade.master = {{0, 0}, {0.5, 0.6}, {1, 1}};
  c.fx.push_back(Effect{"blur", true, {{"radius", Param(4.5)}}});
  REQUIRE(ed.overwrite({TrackKind::Video, 0}, c).empty());
  REQUIRE(ed.addMarker(sec(2), "intro").empty());
  return p;
}
}  // namespace

TEST_CASE("save and load are lossless") {
  std::string dir = fx::tmpdir("io");
  Project p = busy();
  std::string path = dir + "/a.rpro";
  REQUIRE(saveProject(p, path).empty());
  Project q;
  std::string err;
  REQUIRE_MESSAGE(loadProject(path, q, err), err);
  CHECK(q == p);
  CHECK(serialize(q) == serialize(p));
}

TEST_CASE("saves rotate backups and never leave a temp file") {
  std::string dir = fx::tmpdir("io-bak");
  Project p = busy();
  std::string path = dir + "/a.rpro";
  for (int i = 0; i < 8; ++i) {
    p.name = "v" + std::to_string(i);
    REQUIRE(saveProject(p, path).empty());
  }
  int files = 0;
  for (auto& e : std::filesystem::directory_iterator(dir)) {
    ++files;
    CHECK(e.path().string().find(".tmp-") == std::string::npos);
  }
  CHECK(files == 6);  // the project + bak1..bak5
  Project b;
  std::string err;
  REQUIRE(loadProject(path + ".bak1", b, err));
  CHECK(b.name == "v6");
}

TEST_CASE("a damaged file is refused, never misread") {
  std::string dir = fx::tmpdir("io-bad");
  Project p = busy();
  std::string path = dir + "/a.rpro";
  REQUIRE(saveProject(p, path).empty());
  std::string text;
  {
    std::ifstream f(path);
    text.assign(std::istreambuf_iterator<char>(f), {});
  }
  // every truncation point fails to load
  int loaded = 0;
  for (size_t cut = 0; cut + 2 < text.size(); cut += 7) {
    std::ofstream(path, std::ios::trunc) << text.substr(0, cut);
    Project q;
    std::string err;
    if (loadProject(path, q, err)) ++loaded;
  }
  CHECK(loaded == 0);
  // a flipped digit inside the body fails the checksum
  std::string bad = text;
  auto at = bad.find("\"intro\"");
  REQUIRE(at != std::string::npos);
  bad[at + 1] = 'I';
  std::ofstream(path, std::ios::trunc) << bad;
  Project q;
  std::string err;
  CHECK_FALSE(loadProject(path, q, err));
  CHECK(err.find("checksum") != std::string::npos);
}

TEST_CASE("recovery is offered only when the autosave is newer and different") {
  std::string dir = fx::tmpdir("io-rec");
  Project p = busy();
  std::string path = dir + "/a.rpro";
  REQUIRE(saveProject(p, path).empty());
  CHECK_FALSE(hasRecovery(path));
  REQUIRE(saveProject(p, autosavePath(path), {.backups = 0}).empty());
  CHECK_FALSE(hasRecovery(path));  // same content
  p.name = "changed";
  REQUIRE(saveProject(p, autosavePath(path), {.backups = 0}).empty());
  CHECK(hasRecovery(path));
}
