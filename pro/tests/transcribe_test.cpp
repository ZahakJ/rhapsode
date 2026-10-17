#include <doctest.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <filesystem>

#include "ai/analysis.h"
#include "ai/transcribe.h"
#include "media/decode.h"
#include "media_fixtures.h"

using namespace rhap;
using fx::sec;

namespace {
/** three spoken phrases with known pauses; returns the file and each phrase's [start, end) */
std::string speech(std::vector<std::pair<double, double>>& spans) {
  const char* lines[] = {"Welcome to the show.", "Um, so today we talk about editing.", "Thanks for watching."};
  const double gaps[] = {0.5, 1.0, 0.8, 0.5};
  std::string dir = fx::mediaDir();
  std::string out = dir + "/speech.wav";
  double t = gaps[0];
  std::string list;
  for (int i = 0; i < 3; ++i) {
    std::string w = dir + "/phrase" + std::to_string(i) + ".wav";
    if (!std::filesystem::exists(w)) std::system(("espeak-ng -s 150 -w '" + w + "' '" + lines[i] + "' 2>/dev/null").c_str());
    Media m;
    if (!probe(w, m).empty()) return "";
    double d = toSeconds(m.duration);
    spans.push_back({t, t + d});
    t += d + gaps[i + 1];
  }
  if (!std::filesystem::exists(out)) {
    // pad each phrase with its pause and join, at 48 kHz
    std::string cmd = "ffmpeg -nostdin -loglevel error -y -f lavfi -i anullsrc=r=48000:cl=mono:d=0.5";
    for (int i = 0; i < 3; ++i)
      cmd += " -i '" + dir + "/phrase" + std::to_string(i) + ".wav' -f lavfi -i anullsrc=r=48000:cl=mono:d=" + std::to_string(gaps[i + 1]);
    cmd += " -filter_complex \"";
    for (int i = 0; i < 7; ++i) cmd += "[" + std::to_string(i) + "]aresample=48000,aformat=channel_layouts=mono[s" + std::to_string(i) + "];";
    for (int i = 0; i < 7; ++i) cmd += "[s" + std::to_string(i) + "]";
    cmd += "concat=n=7:v=0:a=1\" '" + out + "'";
    if (std::system(cmd.c_str()) != 0) return "";
  }
  return out;
}

std::string lower(std::string s) {
  for (auto& c : s) c = char(std::tolower(static_cast<unsigned char>(c)));
  return s;
}
}  // namespace

TEST_CASE("transcription: words, times, captions and cutting by deleting words") {
  if (!ai::transcriptionAvailable() || !std::filesystem::exists(ai::defaultModelPath())) {
    MESSAGE("no whisper.cpp or model; skipped");
    return;
  }
  std::vector<std::pair<double, double>> spans;
  std::string path = speech(spans);
  REQUIRE(!path.empty());
  Media m;
  m.id = "talk";
  REQUIRE(probe(path, m).empty());
  Transcript tr;
  tr.media = "talk";
  ai::TranscribeOptions o;
  o.language = "en";
  o.gpu = false;
  auto t0 = std::chrono::steady_clock::now();
  REQUIRE(ai::transcribe(path, o, tr).empty());
  double secs = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
  std::string all;
  for (auto& w : tr.words) all += w.text;
  MESSAGE("\"" << all << "\" in " << secs << " s for " << toSeconds(m.duration) << " s of speech (" << toSeconds(m.duration) / secs
               << "× real time, CPU)");
  for (const char* want : {"welcome", "show", "today", "editing", "thanks", "watching"})
    CHECK_MESSAGE(lower(all).find(want) != std::string::npos, want);
  // the true phrase onsets: where the silences end (espeak pads its own files with silence)
  ai::SilenceOptions so;
  so.pad = 0;
  so.minDur = kFlicks / 5;
  auto sil = ai::detectSilence(path, so);
  // the silence that ends just after the scripted start of the third phrase (espeak's own lead-in)
  double scripted = spans[2].first;
  for (auto& r : sil)
    if (toSeconds(r.b) >= scripted - 0.05 && toSeconds(r.b) <= scripted + 0.8) spans[2].first = toSeconds(r.b);
  REQUIRE(spans[2].first != scripted);
  // "Thanks" starts with the third phrase
  auto it = std::find_if(tr.words.begin(), tr.words.end(), [](const Word& w) { return lower(w.text).find("thank") != std::string::npos; });
  REQUIRE(it != tr.words.end());
  CHECK_MESSAGE(std::fabs(toSeconds(it->a) - spans[2].first) < 0.35, "thanks at " << toSeconds(it->a) << " want " << spans[2].first);

  // captions and SRT
  auto cues = ai::captions(tr.words);
  CHECK(cues.size() >= 2);
  auto back = ai::fromSrt(ai::toSrt(cues));
  REQUIRE(back.size() == cues.size());
  CHECK(std::llabs(back[0].a - cues[0].a) < kFlicks / 1000);
  CHECK(back[0].text == cues[0].text);

  // the edit: delete the second phrase's words; the cut takes the phrase and most of its pauses
  Project p = fx::project();
  p.media.push_back(m);
  p.transcripts.push_back(tr);
  Editor ed(p, "main");
  Clip c = clipOf(p, m, 0);
  REQUIRE(ed.overwrite({TrackKind::Audio, 0}, c).empty());
  std::vector<size_t> second;
  for (size_t i = 0; i < tr.words.size(); ++i) {
    double mid = toSeconds((tr.words[i].a + tr.words[i].b) / 2);
    if (mid > spans[1].first - 0.2 && mid < spans[1].second + 0.2) second.push_back(i);
  }
  REQUIRE(!second.empty());
  Tick before = p.sequences[0].duration();
  std::string err;
  CHECK(ai::deleteWords(p, "main", c.id, second, kFlicks / 20, &err) == 1);
  double removed = toSeconds(before - p.sequences[0].duration());
  MESSAGE("removed " << removed << " s");
  CHECK(removed > spans[1].second - spans[1].first - 0.3);
  CHECK(check(p).empty());
  // the words either side of the cut now sit 2 × keep apart (to the frame)
  const auto& clips = p.sequences[0].audio[0].clips;
  REQUIRE(clips.size() == 2);
  auto before_ = ai::wordsOnTimeline(p, p.sequences[0], clips[0]);
  auto after_ = ai::wordsOnTimeline(p, p.sequences[0], clips[1]);
  REQUIRE(!before_.empty());
  REQUIRE(!after_.empty());
  double gap = toSeconds(after_.front().a - before_.back().b);
  CHECK_MESSAGE(std::fabs(gap - 0.1) <= 1.0 / 30 + 1e-6, "gap " << gap);
  // the remaining words are the first and third phrases
  std::string left;
  for (auto& w : ai::wordsOnTimeline(p, p.sequences[0], p.sequences[0].audio[0].clips[0])) left += w.text;
  for (auto& w : ai::wordsOnTimeline(p, p.sequences[0], p.sequences[0].audio[0].clips.back())) left += w.text;
  CHECK(lower(left).find("editing") == std::string::npos);
  CHECK(lower(left).find("watching") != std::string::npos);
}
