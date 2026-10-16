#pragma once
// Shared fixtures: a project with a few media items and an empty sequence.
#include <filesystem>
#include <string>

#include "model/edit.h"

namespace fx {

inline rhap::Media media(const std::string& id, rhap::MediaKind k, double seconds, bool video = true, bool audio = true) {
  rhap::Media m;
  m.id = id;
  m.name = id;
  m.path = "/media/" + id;
  m.kind = k;
  m.duration = k == rhap::MediaKind::Image ? 0 : rhap::fromSeconds(seconds);
  m.hasVideo = video && k != rhap::MediaKind::Audio;
  m.hasAudio = audio && k != rhap::MediaKind::Image;
  m.width = 1920;
  m.height = 1080;
  m.channels = m.hasAudio ? 2 : 0;
  m.sampleRate = m.hasAudio ? 48000 : 0;
  return m;
}

inline rhap::Project project(int videoTracks = 3, int audioTracks = 3) {
  rhap::Project p;
  p.media.push_back(media("cam", rhap::MediaKind::Video, 60));
  p.media.push_back(media("music", rhap::MediaKind::Audio, 120));
  p.media.push_back(media("still", rhap::MediaKind::Image, 0));
  p.media.push_back(media("broll", rhap::MediaKind::Video, 20, true, false));
  rhap::Sequence s;
  s.id = "main";
  s.name = "Main";
  for (int i = 0; i < videoTracks; ++i)
    s.video.push_back(rhap::Track{.id = "v" + std::to_string(i), .kind = rhap::TrackKind::Video});
  for (int i = 0; i < audioTracks; ++i)
    s.audio.push_back(rhap::Track{.id = "a" + std::to_string(i), .kind = rhap::TrackKind::Audio});
  p.sequences.push_back(s);
  p.active = "main";
  return p;
}

inline rhap::Tick sec(double s) { return rhap::fromSeconds(s); }

inline std::string tmpdir(const std::string& name) {
  auto d = std::filesystem::path(RHAP_TEST_TMP) / name;
  std::filesystem::remove_all(d);
  std::filesystem::create_directories(d);
  return d.string();
}

}  // namespace fx
