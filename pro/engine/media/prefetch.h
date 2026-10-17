#pragma once
// Playback-speed frames: one worker thread per clip decodes ahead of the
// playhead into a small ring, so the render thread only uploads. A request
// outside the ring is a seek; the worker jumps there and the caller waits for
// that one frame (scrub latency is measured by the benchmark).

#include <atomic>
#include <condition_variable>
#include <deque>
#include <map>
#include <memory>
#include <mutex>
#include <thread>

#include "../render/renderer.h"

namespace rhap {

class PrefetchPool : public FrameSource {
 public:
  explicit PrefetchPool(bool hw = true, int depth = 8, size_t maxWorkers = 24);
  ~PrefetchPool() override;
  const VideoFrame* video(const Media& m, const std::string& slot, Tick t) override;
  void setProxies(bool on) { proxies_ = on; }
  /** stop workers whose clip has not been asked for since the last sweep */
  void sweep();
  struct Stats {
    int64_t hits = 0, waits = 0, seeks = 0;
    double waitMs = 0;
  };
  Stats stats() const;

 private:
  struct Worker;
  std::map<std::string, std::unique_ptr<Worker>> workers_;
  bool hw_, proxies_ = false;
  int depth_;
  size_t max_;
  mutable std::mutex statsMu_;
  Stats stats_;
};

}  // namespace rhap
