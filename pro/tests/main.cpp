#define DOCTEST_CONFIG_IMPLEMENT
#include <doctest.h>

#include <cstring>
#include <string>

int crashChild(const char* path, int fd);  // session_test.cpp

int main(int argc, char** argv) {
  // the crash test re-runs this binary as the process it kills
  if (argc == 4 && std::strcmp(argv[1], "--crash-child") == 0) return crashChild(argv[2], std::stoi(argv[3]));
  doctest::Context ctx(argc, argv);
  return ctx.run();
}
