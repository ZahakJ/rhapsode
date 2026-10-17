#include <doctest.h>

#include <SDL3/SDL_keycode.h>
#include <signal.h>
#include <sys/wait.h>
#include <unistd.h>

#include <algorithm>
#include <chrono>
#include <filesystem>
#include <random>
#include <thread>

#include "fixtures.h"
#include "io/project_io.h"
#include "session/session.h"

using namespace rhap;
using fx::sec;

/** the child of the crash test: edit and autosave until killed, reporting each edit on `fd` */
int crashChild(const char* path, int fd) {
  Session s(fx::project(3, 3));
  s.path = path;
  auto last = std::chrono::steady_clock::now();
  for (int64_t n = 1;; ++n) {
    s.addMarker();  // one edit; the marker count is the edit count
    s.playhead += frameTicks(s.rate());
    auto now = std::chrono::steady_clock::now();
    if (now - last > std::chrono::milliseconds(20)) {  // the app autosaves on a timer
      s.autosave();
      last = now;
    }
    if (write(fd, &n, sizeof n) < 0) return 1;
  }
}

namespace {
Session ready() {
  Session s(fx::project(3, 3));
  return s;
}
}  // namespace

TEST_CASE("keymaps: every binding names a real action, and Premiere's defaults are where editors expect") {
  const auto& names = actionNames();
  for (const auto* map : {&premiereKeymap(), &rhapsodeKeymap()})
    for (auto& b : *map) CHECK_MESSAGE(std::find(names.begin(), names.end(), b.action) != names.end(), b.action);
  const auto& pm = premiereKeymap();
  CHECK(actionFor(pm, SDLK_J, 0) == "shuttle-back");
  CHECK(actionFor(pm, SDLK_K, 0) == "shuttle-stop");
  CHECK(actionFor(pm, SDLK_L, 0) == "shuttle-forward");
  CHECK(actionFor(pm, SDLK_I, 0) == "mark-in");
  CHECK(actionFor(pm, SDLK_O, 0) == "mark-out");
  CHECK(actionFor(pm, SDLK_COMMA, 0) == "insert");
  CHECK(actionFor(pm, SDLK_PERIOD, 0) == "overwrite");
  CHECK(actionFor(pm, SDLK_SEMICOLON, 0) == "lift");
  CHECK(actionFor(pm, SDLK_APOSTROPHE, 0) == "extract");
  CHECK(actionFor(pm, SDLK_K, kCtrl) == "add-edit");
  CHECK(actionFor(pm, SDLK_Q, 0) == "trim-head-to-playhead");
  CHECK(actionFor(pm, SDLK_W, 0) == "trim-tail-to-playhead");
  CHECK(actionFor(pm, SDLK_DELETE, kShift) == "ripple-delete");
  CHECK(actionFor(pm, SDLK_C, 0) == "tool-razor");
  // Rhapsode's map adds single keys and keeps everything else
  const auto& rm = rhapsodeKeymap();
  CHECK(actionFor(rm, SDLK_X, 0) == "razor-all");
  CHECK(actionFor(rm, SDLK_BACKSPACE, 0) == "ripple-delete");
  CHECK(actionFor(rm, SDLK_G, 0) == "close-gap");
  CHECK(actionFor(rm, SDLK_J, 0) == "shuttle-back");
  // and no key is bound twice in either map
  for (const auto* map : {&pm, &rm})
    for (size_t i = 0; i < map->size(); ++i)
      for (size_t j = i + 1; j < map->size(); ++j)
        CHECK_FALSE(((*map)[i].key == (*map)[j].key && (*map)[i].mods == (*map)[j].mods));
}

TEST_CASE("J/K/L shuttle doubles and reverses like Premiere") {
  Session s = ready();
  runAction(s, "shuttle-forward");
  CHECK(s.shuttle == 1);
  runAction(s, "shuttle-forward");
  CHECK(s.shuttle == 2);
  runAction(s, "shuttle-forward");
  CHECK(s.shuttle == 4);
  runAction(s, "shuttle-back");
  CHECK(s.shuttle == -1);
  runAction(s, "shuttle-stop");
  CHECK(s.shuttle == 0);
  runAction(s, "play-pause");
  CHECK(s.shuttle == 1);
}

TEST_CASE("insert, marks, extract, Q/W, E and undo through actions") {
  Session s = ready();
  s.playhead = 0;
  REQUIRE(s.placeMedia("cam", false, sec(0), sec(10)).empty());
  CHECK(s.playhead == sec(10));
  REQUIRE(s.placeMedia("broll", false, 0, sec(5)).empty());
  CHECK(s.seq()->duration() == sec(15));
  // the cam's sound is linked to its picture
  CHECK(s.seq()->audio[0].clips.size() == 1);
  CHECK(s.seq()->video[0].clips[0].link == s.seq()->audio[0].clips[0].link);
  // extract 2–4 s: everything after moves left 2 s
  s.playhead = sec(2);
  runAction(s, "mark-in");
  s.playhead = sec(4) - frameTicks(s.rate());
  runAction(s, "mark-out");
  REQUIRE(runAction(s, "extract").empty());
  CHECK(s.seq()->duration() == sec(13));
  // Q at 5 s: the clip under the playhead loses its head up to here, ripple
  s.playhead = sec(5);
  REQUIRE(runAction(s, "trim-head-to-playhead").empty());
  CHECK(s.seq()->duration() == sec(12));
  // W at 6 s: the tail goes
  s.playhead = sec(6);
  REQUIRE(runAction(s, "trim-tail-to-playhead").empty());
  Tick d = s.seq()->duration();
  // E: roll the nearest cut to the playhead, length unchanged
  s.playhead = sec(5.5);
  REQUIRE(runAction(s, "extend-edit").empty());
  CHECK(s.seq()->duration() == d);
  // undo walks back every step
  for (int i = 0; i < 5; ++i) REQUIRE(runAction(s, "undo").empty());
  CHECK(s.seq()->duration() == sec(15));
  CHECK(check(s.project).empty());
}

TEST_CASE("razor, select, ripple delete with the Rhapsode keys") {
  Session s = ready();
  REQUIRE(s.placeMedia("cam", false, 0, sec(10)).empty());
  s.playhead = sec(4);
  REQUIRE(runAction(s, "razor-all").empty());
  CHECK(s.seq()->video[0].clips.size() == 2);
  CHECK(s.seq()->audio[0].clips.size() == 2);
  s.selectAt({TrackKind::Video, 0}, sec(1), false);
  CHECK(s.selection.size() == 2);  // picture and its sound
  REQUIRE(runAction(s, "ripple-delete").empty());
  CHECK(s.seq()->duration() == sec(6));
  CHECK(s.seq()->video[0].clips[0].start == 0);
  CHECK(s.seq()->audio[0].clips[0].start == 0);
}

TEST_CASE("autosave and recovery") {
  std::string dir = fx::tmpdir("session");
  Session s = ready();
  REQUIRE(s.save(dir + "/cut.rpro").empty());
  REQUIRE(s.placeMedia("cam", false, 0, sec(10)).empty());
  CHECK(s.dirty());
  REQUIRE(s.autosave().empty());
  CHECK(hasRecovery(dir + "/cut.rpro"));
  Project rec;
  std::string err;
  REQUIRE(loadProject(autosavePath(dir + "/cut.rpro"), rec, err));
  CHECK(rec == s.project);
  REQUIRE(s.save().empty());
  CHECK_FALSE(hasRecovery(dir + "/cut.rpro"));
}

TEST_CASE("kill -9 in the middle of editing never leaves an unreadable autosave") {
  std::string dir = fx::tmpdir("crash");
  std::string path = dir + "/cut.rpro";
  std::mt19937 rng(99);
  int trials = 25, recovered = 0;
  int64_t worstLag = 0;
  for (int t = 0; t < trials; ++t) {
    int fds[2];
    REQUIRE(pipe(fds) == 0);
    pid_t pid = fork();
    if (pid == 0) {
      close(fds[0]);
      std::string fd = std::to_string(fds[1]);
      execl("/proc/self/exe", "rhap_tests", "--crash-child", path.c_str(), fd.c_str(), (char*)nullptr);
      _exit(127);
    }
    close(fds[1]);
    std::this_thread::sleep_for(std::chrono::milliseconds(60 + rng() % 400));
    kill(pid, SIGKILL);
    waitpid(pid, nullptr, 0);
    int64_t n = 0, v;
    while (read(fds[0], &v, sizeof v) == sizeof v) n = v;
    close(fds[0]);
    Project p;
    std::string err;
    bool ok = loadProject(autosavePath(path), p, err);
    CHECK_MESSAGE(ok, "trial " << t << ": " << err);
    if (ok) {
      ++recovered;
      int64_t have = int64_t(p.sequences[0].markers.size());
      CHECK(have <= n + 1);  // the kill can land between an autosave and its report
      worstLag = std::max(worstLag, n - have);
    }
  }
  CHECK(recovered == trials);
  MESSAGE("worst case: the autosave was " << worstLag << " edits behind the moment of the kill");
}
