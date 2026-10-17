#include "prefetch.h"

#include <chrono>

namespace rhap {

struct PrefetchPool::Worker {
  std::string path;
  bool hw = true, isStill = false;
  int depth = 8;
  std::thread th;
  std::mutex mu;
  std::condition_variable cv;
  std::deque<std::shared_ptr<VideoFrame>> ring;  // ascending pts
  std::shared_ptr<VideoFrame> held;              // what the caller is looking at
  Tick want = 0, seekTo = 0;
  uint64_t seekGen = 0, doneGen = 0;
  bool eof = false, stop = false, used = true;
  std::string error;

  void run() {
    VideoDecoder dec;
    std::string e = dec.open(path, hw);
    {
      std::lock_guard l(mu);
      error = e;
    }
    cv.notify_all();
    if (!e.empty()) return;
    for (;;) {
      uint64_t gen;
      Tick target;
      bool seek;
      {
        std::unique_lock l(mu);
        cv.wait(l, [&] { return stop || seekGen != doneGen || (!eof && int(ring.size()) < depth); });
        if (stop) return;
        seek = seekGen != doneGen;
        gen = seekGen;
        target = seekTo;
        if (seek) {
          ring.clear();
          eof = false;
        }
      }
      const VideoFrame* f = seek ? dec.frameAt(target) : dec.next();
      std::shared_ptr<VideoFrame> copy = f ? std::make_shared<VideoFrame>(*f) : nullptr;
      {
        std::lock_guard l(mu);
        if (seekGen != gen) continue;  // overtaken by a newer seek
        if (seek) doneGen = gen;
        if (copy) {
          if (ring.empty() || copy->pts > ring.back()->pts) ring.push_back(std::move(copy));
          // keep only what is near the playhead: one frame behind it
          while (ring.size() > 1 && ring[1]->pts <= want) ring.pop_front();
        } else {
          eof = true;
        }
      }
      cv.notify_all();
    }
  }
};

PrefetchPool::PrefetchPool(bool hw, int depth, size_t maxWorkers) : hw_(hw), depth_(depth), max_(maxWorkers) {}

PrefetchPool::~PrefetchPool() {
  for (auto& [k, w] : workers_) {
    {
      std::lock_guard l(w->mu);
      w->stop = true;
    }
    w->cv.notify_all();
    if (w->th.joinable()) w->th.join();
  }
}

void PrefetchPool::sweep() {
  for (auto it = workers_.begin(); it != workers_.end();) {
    Worker& w = *it->second;
    bool idle;
    {
      std::lock_guard l(w.mu);
      idle = !w.used;
      w.used = false;
    }
    if (idle) {
      {
        std::lock_guard l(w.mu);
        w.stop = true;
      }
      w.cv.notify_all();
      w.th.join();
      it = workers_.erase(it);
    } else {
      ++it;
    }
  }
}

PrefetchPool::Stats PrefetchPool::stats() const {
  std::lock_guard l(statsMu_);
  return stats_;
}

const VideoFrame* PrefetchPool::video(const Media& m, const std::string& slot, Tick t) {
  const std::string& path = proxies_ && !m.proxy.empty() ? m.proxy : m.path;
  std::string key = slot + "|" + path;
  auto& wp = workers_[key];
  if (!wp) {
    if (workers_.size() > max_) sweep();
    wp = std::make_unique<Worker>();
    wp->path = path;
    wp->hw = hw_;
    wp->depth = m.kind == MediaKind::Image ? 1 : depth_;
    wp->isStill = m.kind == MediaKind::Image;
    wp->seekGen = 1;
    wp->seekTo = m.kind == MediaKind::Image ? 0 : t;
    Worker* raw = wp.get();
    wp->th = std::thread([raw] { raw->run(); });
  }
  Worker& w = *wp;
  if (w.isStill) t = 0;
  auto t0 = std::chrono::steady_clock::now();
  std::unique_lock l(w.mu);
  w.used = true;
  w.want = t;
  if (!w.error.empty()) return nullptr;
  auto covering = [&]() -> std::shared_ptr<VideoFrame> {
    for (size_t i = 0; i < w.ring.size(); ++i) {
      if (w.ring[i]->pts > t) return nullptr;
      bool last = i + 1 == w.ring.size();
      if (!last && w.ring[i + 1]->pts > t) return w.ring[i];
      if (last && (w.eof || w.isStill) && w.seekGen == w.doneGen) return w.ring[i];
    }
    return nullptr;
  };
  bool waited = false, sought = false;
  for (int round = 0; round < 3; ++round) {
    // outside what the ring holds or is about to hold: jump
    bool behind = !w.ring.empty() && t < w.ring.front()->pts && w.seekGen == w.doneGen;
    bool farAhead = !w.ring.empty() && t > w.ring.back()->pts + kFlicks && w.seekGen == w.doneGen;
    if (w.ring.empty() && w.seekGen == w.doneGen && w.eof) behind = true;
    // the ring is full and still short of t (playback ran ahead of decode by more than the ring): jump
    if (!w.ring.empty() && w.seekGen == w.doneGen && int(w.ring.size()) >= w.depth && w.ring.back()->pts < t) farAhead = true;
    if (round > 0 && w.eof && !w.ring.empty() && t > w.ring.back()->pts) break;  // past the end: hold the last
    if (behind || farAhead) {
      w.seekTo = t;
      ++w.seekGen;
      sought = true;
      w.cv.notify_all();
    }
    while (w.ring.size() > 1 && w.ring[1]->pts <= t && w.seekGen == w.doneGen) w.ring.pop_front();
    w.cv.notify_all();
    std::shared_ptr<VideoFrame> f = covering();
    if (!f) {
      waited = true;
      bool ok = w.cv.wait_for(l, std::chrono::seconds(3), [&] {
        while (w.ring.size() > 1 && w.ring[1]->pts <= t && w.seekGen == w.doneGen) w.ring.pop_front();
        bool settled = w.seekGen == w.doneGen && !w.ring.empty();
        return !w.error.empty() || (f = covering()) != nullptr || (settled && w.ring.front()->pts > t) ||
               (settled && int(w.ring.size()) >= w.depth && w.ring.back()->pts < t) || (settled && w.eof);
      });
      if (!ok || !w.error.empty()) return nullptr;
      if (!f) continue;  // the decoder landed after t: seek again (round 2)
    }
    w.held = f;
    l.unlock();
    double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
    std::lock_guard sl(statsMu_);
    (waited ? stats_.waits : stats_.hits)++;
    if (sought) stats_.seeks++;
    stats_.waitMs += waited ? ms : 0;
    return w.held.get();
  }
  // the stream starts after t (or ends before it): show its nearest frame
  if (!w.ring.empty()) {
    w.held = t < w.ring.front()->pts ? w.ring.front() : w.ring.back();
    return w.held.get();
  }
  return nullptr;
}

}  // namespace rhap
