#include <doctest.h>

#include "ticks.h"

using namespace rhap;

TEST_CASE("flicks divide every common rate exactly") {
  for (Rate r : {Rate{24, 1}, Rate{25, 1}, Rate{30, 1}, Rate{48, 1}, Rate{50, 1}, Rate{60, 1}, Rate{120, 1}, kRate23976,
                 kRate2997, kRate5994}) {
    CHECK(kFlicks * r.den % r.num == 0);
    // a day of frames maps back to the same frame numbers
    for (int64_t f : {int64_t(0), int64_t(1), int64_t(1799), int64_t(107892), int64_t(5'000'000)}) {
      CHECK(frameAt(frameStart(f, r), r) == f);
      CHECK(frameAt(frameStart(f, r) + frameTicks(r) - 1, r) == f);
    }
  }
  for (int sr : {44100, 48000, 88200, 96000}) CHECK(kFlicks % sr == 0);
}

TEST_CASE("negative time floors") {
  CHECK(frameAt(-1, Rate{30, 1}) == -1);
  CHECK(frameAt(-frameTicks(Rate{30, 1}), Rate{30, 1}) == -1);
}

TEST_CASE("timecode, including drop frame") {
  CHECK(timecode(fromSeconds(3661) + frameStart(5, Rate{25, 1}), Rate{25, 1}) == "01:01:01:05");
  // 29.97 DF: frame 1800 is 00:01:00;02
  CHECK(timecode(frameStart(1800, kRate2997), kRate2997, true) == "00:01:00;02");
  CHECK(timecode(frameStart(17982, kRate2997), kRate2997, true) == "00:10:00;00");
  for (int64_t f : {int64_t(0), int64_t(1799), int64_t(1800), int64_t(17982), int64_t(107891), int64_t(123456)}) {
    Tick t;
    REQUIRE(parseTimecode(timecode(frameStart(f, kRate2997), kRate2997, true), kRate2997, t));
    CHECK(frameAt(t, kRate2997) == f);
    REQUIRE(parseTimecode(timecode(frameStart(f, kRate2997), kRate2997, false), kRate2997, t));
    CHECK(frameAt(t, kRate2997) == f);
  }
  Tick t;
  CHECK_FALSE(parseTimecode("00:00:61:00", Rate{25, 1}, t));
  CHECK_FALSE(parseTimecode("garbage", Rate{25, 1}, t));
}
