#pragma once
// Rhapsode web <-> Pro. Opening a quick-mode render downloads its original
// sources and builds a project from the render's sequence; publishing streams
// a finished MP4 up and returns its share link. The invite key travels in the
// x-rhapsode-key header only (never in a URL or an argument list).

#include <functional>
#include <string>

#include "../model/model.h"

namespace rhap::web {

struct Remote {
  std::string server;  // https://host (no trailing slash)
  std::string key;     // the invite key
};

/** "https://host/m/slug" or "https://host/#/r/slug" → server + slug; a bare slug keeps `fallbackServer` */
bool parseShareUrl(const std::string& url, const std::string& fallbackServer, std::string& server, std::string& slug);

/** downloads the render's sources into `mediaDir` and builds the project */
std::string openRender(const Remote& r, const std::string& slug, const std::string& mediaDir, Project& out,
                       const std::function<void(const std::string&)>& progress = {});

/** uploads an MP4; on success `shareUrl` is the public link */
std::string publish(const Remote& r, const std::string& file, const std::string& title, std::string& shareUrl);

}  // namespace rhap::web
