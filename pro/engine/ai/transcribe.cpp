#include "transcribe.h"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <sstream>
#include <thread>

#include "../media/decode.h"
#include "analysis.h"

#ifdef RHAP_WHISPER
#include <whisper.h>
#endif

namespace rhap::ai {

namespace fs = std::filesystem;

bool transcriptionAvailable() {
#ifdef RHAP_WHISPER
  return true;
#else
  return false;
#endif
}

std::string defaultModelPath() {
  const char* home = std::getenv("HOME");
  fs::path dir = fs::path(home ? home : ".") / ".cache" / "rhapsode-pro" / "models";
  for (const char* m : {"ggml-large-v3-turbo.bin", "ggml-small.bin", "ggml-base.bin", "ggml-base.en.bin", "ggml-tiny.bin"})
    if (fs::exists(dir / m)) return (dir / m).string();
  return (dir / "ggml-base.bin").string();
}

#ifdef RHAP_WHISPER
namespace {
whisper_alignment_heads_preset headsFor(const std::string& model) {
  std::string f = fs::path(model).filename().string();
  auto has = [&](const char* s) { return f.find(s) != std::string::npos; };
  bool en = has(".en");
  if (has("large-v3-turbo")) return WHISPER_AHEADS_LARGE_V3_TURBO;
  if (has("large-v3")) return WHISPER_AHEADS_LARGE_V3;
  if (has("large-v2")) return WHISPER_AHEADS_LARGE_V2;
  if (has("medium")) return en ? WHISPER_AHEADS_MEDIUM_EN : WHISPER_AHEADS_MEDIUM;
  if (has("small")) return en ? WHISPER_AHEADS_SMALL_EN : WHISPER_AHEADS_SMALL;
  if (has("base")) return en ? WHISPER_AHEADS_BASE_EN : WHISPER_AHEADS_BASE;
  if (has("tiny")) return en ? WHISPER_AHEADS_TINY_EN : WHISPER_AHEADS_TINY;
  return WHISPER_AHEADS_NONE;
}
}  // namespace
#endif

std::string transcribe(const std::string& path, const TranscribeOptions& o, Transcript& out) {
#ifndef RHAP_WHISPER
  (void)path;
  (void)o;
  (void)out;
  return "this build has no transcription (configure with whisper.cpp)";
#else
  std::string model = o.model.empty() ? defaultModelPath() : o.model;
  if (!fs::exists(model)) return "no speech model at " + model + " (download a ggml whisper model there)";
  AudioDecoder d;
  if (std::string e = d.open(path, 16000, 1); !e.empty()) return e;
  std::vector<float> pcm(size_t(std::max<int64_t>(0, d.lengthSamples())));
  for (int64_t at = 0; at < int64_t(pcm.size()); at += 160000) {
    int n = int(std::min<int64_t>(160000, int64_t(pcm.size()) - at));
    d.read(at, pcm.data() + at, n);
  }
  whisper_context_params cp = whisper_context_default_params();
  cp.use_gpu = o.gpu;
  cp.dtw_token_timestamps = headsFor(model) != WHISPER_AHEADS_NONE;
  cp.dtw_aheads_preset = headsFor(model);
  whisper_log_set([](ggml_log_level, const char*, void*) {}, nullptr);
  whisper_context* ctx = whisper_init_from_file_with_params(model.c_str(), cp);
  if (!ctx) return "cannot load the speech model";
  whisper_full_params wp = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
  // half the cores, at most 8: whisper's OpenMP loops spin, and on a busy machine more threads run slower
  wp.n_threads = o.threads > 0 ? o.threads : int(std::clamp(std::thread::hardware_concurrency() / 2, 1u, 8u));
  wp.language = o.language.c_str();
  wp.translate = false;
  wp.token_timestamps = true;
  wp.print_progress = wp.print_realtime = wp.print_timestamps = wp.print_special = false;
  wp.suppress_blank = true;
  struct Cb {
    const std::function<void(int)>* f;
  } cb{&o.progress};
  if (o.progress) {
    wp.progress_callback = [](whisper_context*, whisper_state*, int pct, void* u) { (*static_cast<Cb*>(u)->f)(pct); };
    wp.progress_callback_user_data = &cb;
  }
  if (whisper_full(ctx, wp, pcm.data(), int(pcm.size())) != 0) {
    whisper_free(ctx);
    return "transcription failed";
  }
  out.words.clear();
  out.language = whisper_lang_str(whisper_full_lang_id(ctx));
  const whisper_token eot = whisper_token_eot(ctx);
  const Tick cs = kFlicks / 100;
  const Tick end = sampleStart(int64_t(pcm.size()), 16000);
  for (int s = 0; s < whisper_full_n_segments(ctx); ++s) {
    for (int k = 0; k < whisper_full_n_tokens(ctx, s); ++k) {
      whisper_token_data td = whisper_full_get_token_data(ctx, s, k);
      if (td.id >= eot) continue;  // timestamps and specials
      std::string text = whisper_full_get_token_text(ctx, s, k);
      if (text.empty() || text.rfind("[_", 0) == 0) continue;
      Tick t0 = td.t0 * cs, t1 = td.t1 * cs;
      if (td.t_dtw >= 0) t0 = td.t_dtw * cs;  // DTW times sit on the word's start
      bool starts = text[0] == ' ' || out.words.empty();
      if (starts) {
        Word w;
        w.a = t0;
        w.b = std::max(t0 + cs, t1);
        w.text = text;
        w.p = td.p;
        out.words.push_back(w);
      } else {
        Word& w = out.words.back();
        w.text += text;
        w.b = std::max(w.b, t1);
        w.p = std::min(w.p, td.p);
      }
    }
  }
  // keep times ordered and inside the media; a word ends where the next starts at the latest
  for (size_t i = 0; i < out.words.size(); ++i) {
    Word& w = out.words[i];
    if (i > 0) w.a = std::max(w.a, out.words[i - 1].a);
    w.a = std::clamp<Tick>(w.a, 0, end);
    w.b = std::clamp<Tick>(w.b, w.a + cs, end);
    if (i + 1 < out.words.size() && out.words[i + 1].a > w.a) w.b = std::min(w.b, std::max(out.words[i + 1].a, w.a + cs));
  }
  whisper_free(ctx);
  // whisper's times drift into pauses; the sound itself says where a word starts and stops
  SilenceOptions so;
  so.thresholdDb = -40;
  so.minDur = kFlicks * 15 / 100;
  so.pad = 0;
  auto sil = detectSilence(path, so);
  for (size_t i = 0; i < out.words.size(); ++i) {
    Word& w = out.words[i];
    Tick len = w.b - w.a;
    for (auto& r : sil) {
      if (w.a >= r.a && w.a < r.b) {
        // started in a pause (or sits wholly inside one): it begins where the sound does
        w.a = r.b;
        if (w.b <= w.a) w.b = w.a + len;
      }
      if (w.b > r.a && w.b <= r.b && r.a > w.a) w.b = r.a;  // ended in a pause: stop with the sound
    }
    if (i > 0 && out.words[i - 1].b > w.a) out.words[i - 1].b = std::max(out.words[i - 1].a + kFlicks / 100, w.a);
  }
  return {};
#endif
}

// ——— captions ———

namespace {
std::string trim(const std::string& s) {
  size_t a = s.find_first_not_of(' '), b = s.find_last_not_of(' ');
  return a == std::string::npos ? "" : s.substr(a, b - a + 1);
}
bool endsSentence(const std::string& w) {
  std::string t = trim(w);
  return !t.empty() && (t.back() == '.' || t.back() == '?' || t.back() == '!' || t.back() == ':');
}
size_t charCount(const std::string& s) {
  size_t n = 0;
  for (unsigned char c : s)
    if ((c & 0xC0) != 0x80) ++n;
  return n;
}
std::string stamp(Tick t, char sep) {
  int64_t ms = int64_t(std::llround(toSeconds(t) * 1000));
  char b[32];
  std::snprintf(b, sizeof b, "%02lld:%02lld:%02lld%c%03lld", (long long)(ms / 3600000), (long long)(ms / 60000 % 60),
                (long long)(ms / 1000 % 60), sep, (long long)(ms % 1000));
  return b;
}
}  // namespace

std::vector<Cue> captions(const std::vector<Word>& words, const CaptionOptions& o) {
  std::vector<Cue> out;
  std::vector<std::string> lines;
  Cue cur;
  auto flush = [&]() {
    if (lines.empty()) return;
    std::string text;
    for (size_t i = 0; i < lines.size(); ++i) text += (i ? "\n" : "") + lines[i];
    cur.text = text;
    out.push_back(cur);
    lines.clear();
  };
  for (size_t i = 0; i < words.size(); ++i) {
    const Word& w = words[i];
    std::string t = trim(w.text);
    if (t.empty()) continue;
    bool pause = !lines.empty() && w.a - cur.b > o.minGap;
    bool tooLong = !lines.empty() && w.b - cur.a > o.maxDur;
    bool fits = !lines.empty() && charCount(lines.back()) + 1 + charCount(t) <= size_t(o.maxChars);
    bool full = !lines.empty() && !fits && int(lines.size()) >= o.maxLines;
    bool sentence = !lines.empty() && i > 0 && endsSentence(words[i - 1].text) &&
                    (lines.size() > 1 || charCount(lines.back()) > size_t(o.maxChars) / 2);
    if (pause || tooLong || full || sentence) flush();
    if (lines.empty()) {
      cur.a = w.a;
      lines.push_back(t);
    } else if (charCount(lines.back()) + 1 + charCount(t) <= size_t(o.maxChars)) {
      lines.back() += " " + t;
    } else {
      lines.push_back(t);
    }
    cur.b = w.b;
  }
  flush();
  // a cue lasts until the next one starts, if the pause is short
  for (size_t i = 0; i + 1 < out.size(); ++i)
    if (out[i + 1].a - out[i].b < o.minGap) out[i].b = out[i + 1].a;
  return out;
}

std::string toSrt(const std::vector<Cue>& cues) {
  std::ostringstream os;
  for (size_t i = 0; i < cues.size(); ++i)
    os << (i + 1) << "\n" << stamp(cues[i].a, ',') << " --> " << stamp(cues[i].b, ',') << "\n" << cues[i].text << "\n\n";
  return os.str();
}

std::string toVtt(const std::vector<Cue>& cues) {
  std::ostringstream os;
  os << "WEBVTT\n\n";
  for (auto& c : cues) os << stamp(c.a, '.') << " --> " << stamp(c.b, '.') << "\n" << c.text << "\n\n";
  return os.str();
}

std::vector<Cue> fromSrt(const std::string& text) {
  std::vector<Cue> out;
  std::istringstream in(text);
  std::string line;
  Cue cur;
  bool inCue = false;
  auto parse = [](const std::string& s, Tick& t) {
    int h, m, sec, ms;
    char sep;
    if (std::sscanf(s.c_str(), "%d:%d:%d%c%d", &h, &m, &sec, &sep, &ms) != 5) return false;
    t = fromSeconds(h * 3600.0 + m * 60.0 + sec + ms / 1000.0);
    return true;
  };
  while (std::getline(in, line)) {
    if (!line.empty() && line.back() == '\r') line.pop_back();
    auto arrow = line.find("-->");
    if (arrow != std::string::npos) {
      if (inCue && !cur.text.empty()) out.push_back(cur);
      cur = {};
      inCue = parse(trim(line.substr(0, arrow)), cur.a) && parse(trim(line.substr(arrow + 3)), cur.b);
      continue;
    }
    if (!inCue) continue;
    if (trim(line).empty()) {
      if (!cur.text.empty()) out.push_back(cur);
      cur = {};
      inCue = false;
      continue;
    }
    cur.text += (cur.text.empty() ? "" : "\n") + line;
  }
  if (inCue && !cur.text.empty()) out.push_back(cur);
  return out;
}

// ——— on the timeline ———

std::vector<PlacedWord> wordsOnTimeline(const Project& p, const Sequence&, const Clip& c) {
  std::vector<PlacedWord> out;
  if (c.kind != ClipKind::Media || c.speed <= 0) return out;
  const Transcript* t = p.transcriptOf(c.ref);
  if (!t) return out;
  Tick lo = c.in, hi = c.in + c.sourceSpan();
  for (size_t i = 0; i < t->words.size(); ++i) {
    const Word& w = t->words[i];
    Tick mid = (w.a + w.b) / 2;
    if (mid < lo || mid >= hi) continue;  // a word belongs to the clip that plays its middle
    Tick a = c.start + Tick(std::llround(double(std::max(w.a, lo) - c.in) / c.speed));
    Tick b = c.start + Tick(std::llround(double(std::min(w.b, hi) - c.in) / c.speed));
    out.push_back({i, a, b, w.text});
  }
  return out;
}

int addCaptions(Project& p, const std::string& seqId, const std::string& clipId, const CaptionOptions& o) {
  Sequence* s = p.findSequence(seqId);
  if (!s) return 0;
  const Clip* c = clipById(*s, clipId);
  if (!c) return 0;
  std::vector<Word> placed;
  for (auto& w : wordsOnTimeline(p, *s, *c)) placed.push_back(Word{w.a, w.b, w.text, 1});
  auto cues = captions(placed, o);
  if (cues.empty()) return 0;
  Editor ed(p, seqId);
  // one captions track for the whole sequence: reuse it, or add it on top
  int top = -1;
  for (int i = 0; i < int(s->video.size()); ++i)
    if (s->video[size_t(i)].name == "Captions") top = i;
  if (top < 0) {
    if (!ed.addTrack(TrackKind::Video).empty()) return 0;
    s = p.findSequence(seqId);
    top = int(s->video.size()) - 1;
    s->video[size_t(top)].name = "Captions";
  }
  s = p.findSequence(seqId);
  int n = 0;
  for (auto& q : cues) {
    Clip t;
    t.id = p.makeId("c");
    t.kind = ClipKind::Title;
    t.name = q.text.substr(0, 40);
    t.text = q.text;
    t.start = q.a;
    t.dur = std::max<Tick>(frameTicks(s->rate), q.b - q.a);
    t.style.font = "Plex";
    t.style.size = s->height * 0.048;
    t.style.box = {0, 0, 0, 0.55};
    t.xf.y = s->height * 0.36;
    if (ed.overwrite({TrackKind::Video, top}, t).empty()) ++n;
  }
  return n;
}

int deleteWords(Project& p, const std::string& seqId, const std::string& clipId, const std::vector<size_t>& del, Tick keep,
                std::string* err) {
  Sequence* s = p.findSequence(seqId);
  if (!s) return 0;
  const Clip* c = clipById(*s, clipId);
  if (!c) return 0;
  auto placed = wordsOnTimeline(p, *s, *c);
  if (placed.empty()) {
    if (err) *err = "the clip has no transcript";
    return 0;
  }
  std::vector<bool> gone(placed.size(), false);
  for (size_t i = 0; i < placed.size(); ++i) gone[i] = std::find(del.begin(), del.end(), placed[i].index) != del.end();
  const Rate r = s->rate;
  const Tick cStart = c->start, cEnd = c->end();
  std::vector<std::pair<Tick, Tick>> cuts;
  for (size_t i = 0; i < placed.size();) {
    if (!gone[i]) {
      ++i;
      continue;
    }
    size_t j = i;
    while (j + 1 < placed.size() && gone[j + 1]) ++j;
    Tick a = i > 0 ? std::min(placed[i - 1].b + keep, placed[i].a) : cStart;
    Tick b = j + 1 < placed.size() ? std::max(placed[j + 1].a - keep, placed[j].b) : cEnd;
    a = std::max(a, cStart);
    b = std::min(b, cEnd);
    a = frameStart(frameAt(a + frameTicks(r) / 2, r), r);
    b = frameStart(frameAt(b + frameTicks(r) / 2, r), r);
    if (b > a) cuts.push_back({a, b});
    i = j + 1;
  }
  std::vector<TrackRef> tracks;
  ClipLoc loc = findClip(*s, clipId);
  tracks.push_back(loc.track);
  if (!c->link.empty())
    forEachTrack(*s, [&](const Track& t, TrackRef ref) {
      for (auto& o : t.clips)
        if (o.link == c->link && o.id != clipId && !(ref == loc.track)) {
          tracks.push_back(ref);
          break;
        }
    });
  Editor ed(p, seqId);
  int n = 0;
  for (auto it = cuts.rbegin(); it != cuts.rend(); ++it) {
    if (Err e = ed.extract(tracks, it->first, it->second); !e.empty()) {
      if (err) *err = e;
      break;
    }
    ++n;
  }
  return n;
}

std::vector<size_t> fillerWords(const Project& p, const Sequence& s, const Clip& c) {
  static const char* fillers[] = {"um", "umm", "uh", "uhh", "erm", "er", "ah", "hmm", "mm", "mhm", "eh"};
  std::vector<size_t> out;
  for (auto& w : wordsOnTimeline(p, s, c)) {
    std::string t;
    for (char ch : w.text)
      if (std::isalpha(static_cast<unsigned char>(ch))) t += char(std::tolower(static_cast<unsigned char>(ch)));
    for (const char* f : fillers)
      if (t == f) out.push_back(w.index);
  }
  return out;
}

}  // namespace rhap::ai
