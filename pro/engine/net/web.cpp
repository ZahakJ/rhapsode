#include "web.h"

#include <curl/curl.h>

#include <cstdio>
#include <filesystem>
#include <mutex>
#include <nlohmann/json.hpp>

#include "../interchange/interchange.h"

namespace rhap::web {

namespace fs = std::filesystem;
using nlohmann::json;

namespace {

void globalInit() {
  static std::once_flag once;
  std::call_once(once, [] { curl_global_init(CURL_GLOBAL_DEFAULT); });
}

size_t toString(char* p, size_t s, size_t n, void* u) {
  static_cast<std::string*>(u)->append(p, s * n);
  return s * n;
}
size_t toFile(char* p, size_t s, size_t n, void* u) { return std::fwrite(p, s, n, static_cast<FILE*>(u)) * s; }
size_t fromFile(char* p, size_t s, size_t n, void* u) { return std::fread(p, s, n, static_cast<FILE*>(u)); }

struct Response {
  long status = 0;
  std::string body;
  std::string error;
};

curl_slist* headers(const Remote& r, const char* contentType = nullptr) {
  curl_slist* h = nullptr;
  h = curl_slist_append(h, ("x-rhapsode-key: " + r.key).c_str());
  if (contentType) h = curl_slist_append(h, (std::string("content-type: ") + contentType).c_str());
  return h;
}

Response get(const Remote& r, const std::string& path, FILE* sink = nullptr) {
  globalInit();
  Response res;
  CURL* c = curl_easy_init();
  curl_slist* h = headers(r);
  curl_easy_setopt(c, CURLOPT_URL, (r.server + path).c_str());
  curl_easy_setopt(c, CURLOPT_HTTPHEADER, h);
  curl_easy_setopt(c, CURLOPT_FOLLOWLOCATION, 0L);
  curl_easy_setopt(c, CURLOPT_FAILONERROR, 0L);
  if (sink) {
    curl_easy_setopt(c, CURLOPT_WRITEFUNCTION, toFile);
    curl_easy_setopt(c, CURLOPT_WRITEDATA, sink);
  } else {
    curl_easy_setopt(c, CURLOPT_WRITEFUNCTION, toString);
    curl_easy_setopt(c, CURLOPT_WRITEDATA, &res.body);
  }
  CURLcode e = curl_easy_perform(c);
  if (e != CURLE_OK) res.error = curl_easy_strerror(e);
  curl_easy_getinfo(c, CURLINFO_RESPONSE_CODE, &res.status);
  curl_slist_free_all(h);
  curl_easy_cleanup(c);
  return res;
}

std::string errorOf(const Response& r) {
  if (!r.error.empty()) return r.error;
  try {
    auto j = json::parse(r.body);
    if (j.contains("error")) return j["error"].get<std::string>();
  } catch (...) {
  }
  return "HTTP " + std::to_string(r.status);
}

}  // namespace

bool parseShareUrl(const std::string& url, const std::string& fallback, std::string& server, std::string& slug) {
  auto scheme = url.find("://");
  if (scheme == std::string::npos) {
    server = fallback;
    slug = url;
    return !slug.empty() && !server.empty();
  }
  auto pathAt = url.find('/', scheme + 3);
  server = url.substr(0, pathAt);
  std::string rest = pathAt == std::string::npos ? "" : url.substr(pathAt);
  for (const char* pre : {"/m/", "/#/r/", "/#/remix/"}) {
    auto at = rest.find(pre);
    if (at != std::string::npos) {
      slug = rest.substr(at + std::string(pre).size());
      auto q = slug.find_first_of("?#/.");
      if (q != std::string::npos) slug.resize(q);
      return !slug.empty();
    }
  }
  return false;
}

std::string openRender(const Remote& r, const std::string& slug, const std::string& mediaDir, Project& out,
                       const std::function<void(const std::string&)>& progress) {
  Response rec = get(r, "/api/renders/" + slug + "/recipe");
  if (rec.status != 200) return "cannot open " + slug + ": " + errorOf(rec);
  json j;
  try {
    j = json::parse(rec.body);
  } catch (const std::exception& e) {
    return std::string("the server answered nonsense: ") + e.what();
  }
  if (!j.contains("asSequence")) return "the server is too old for Pro (no asSequence)";
  std::error_code ec;
  fs::create_directories(mediaDir, ec);
  ImportOptions o;
  for (const json& s : j.value("sources", json::array())) {
    std::string id = s.value("id", ""), ext = s.value("ext", "bin"), title = s.value("title", id);
    fs::path file = fs::path(mediaDir) / (id + "." + ext);
    if (!fs::exists(file)) {
      if (progress) progress("downloading " + title);
      std::string part = file.string() + ".part";
      FILE* f = std::fopen(part.c_str(), "wb");
      if (!f) return "cannot write " + part;
      Response d = get(r, "/api/sources/" + id + "/original", f);
      std::fclose(f);
      if (d.status != 200) {
        fs::remove(part, ec);
        return "cannot download " + title + ": " + errorOf(d);
      }
      fs::rename(part, file, ec);
    }
    o.sources[id] = file.string();
  }
  json seq = j["asSequence"];
  seq["title"] = j.value("title", slug);
  if (std::string e = importText(seq.dump(), "json", mediaDir, out, o); !e.empty()) return e;
  out.name = j.value("title", slug).empty() ? slug : j.value("title", slug);
  // media names: the web titles read better than ids
  for (const json& s : j.value("sources", json::array()))
    for (auto& m : out.media)
      if (m.path == o.sources[s.value("id", "")]) m.name = s.value("title", m.name);
  return {};
}

std::string publish(const Remote& r, const std::string& file, const std::string& title, std::string& shareUrl) {
  globalInit();
  FILE* f = std::fopen(file.c_str(), "rb");
  if (!f) return "cannot read " + file;
  curl_off_t size = curl_off_t(fs::file_size(file));
  char* esc = curl_easy_escape(nullptr, title.c_str(), int(title.size()));
  std::string url = r.server + "/api/renders/publish?title=" + (esc ? esc : "");
  curl_free(esc);
  Response res;
  CURL* c = curl_easy_init();
  curl_slist* h = headers(r, "video/mp4");
  curl_easy_setopt(c, CURLOPT_URL, url.c_str());
  curl_easy_setopt(c, CURLOPT_HTTPHEADER, h);
  curl_easy_setopt(c, CURLOPT_POST, 1L);
  curl_easy_setopt(c, CURLOPT_READFUNCTION, fromFile);
  curl_easy_setopt(c, CURLOPT_READDATA, f);
  curl_easy_setopt(c, CURLOPT_POSTFIELDSIZE_LARGE, size);
  curl_easy_setopt(c, CURLOPT_WRITEFUNCTION, toString);
  curl_easy_setopt(c, CURLOPT_WRITEDATA, &res.body);
  CURLcode e = curl_easy_perform(c);
  if (e != CURLE_OK) res.error = curl_easy_strerror(e);
  curl_easy_getinfo(c, CURLINFO_RESPONSE_CODE, &res.status);
  curl_slist_free_all(h);
  curl_easy_cleanup(c);
  std::fclose(f);
  if (res.status != 201) return "publish failed: " + errorOf(res);
  try {
    shareUrl = json::parse(res.body).value("shareUrl", "");
  } catch (...) {
    return "the server answered nonsense";
  }
  return {};
}

}  // namespace rhap::web
