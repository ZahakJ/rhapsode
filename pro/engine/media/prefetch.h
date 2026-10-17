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
  /**
   * depth: frames each clip decodes ahead at most; budget: bytes of decoded frames the pool may hold in all,
   * shared by the clips playing (so many 4K layers lower each one's depth instead of growing memory)
   */
  explicit PrefetchPool(bool hw = true, int depth = 8, size_t maxWorkers = 24, size_t budget = size_t(1536) << 20);
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
  /** bytes of decoded frames held right now */
  size_t heldBytes() const;

 private:
  struct Worker;
  std::map<std::string, std::unique_ptr<Worker>> workers_;
  bool hw_, proxies_ = false;
  int depth_;
  size_t max_, budget_;
  uint64_t calls_ = 0;
  void rebalance();
  mutable std::mutex statsMu_;
  Stats stats_;
};

}  // namespace rhap
