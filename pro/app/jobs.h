#pragma once
// Background work that must never stall or crash the editor: exports run as
// `rpro export` child processes (a crash there is just a failed job), proxies
// as ffmpeg children. One job at a time per lane; progress parsed from stderr.

#include <atomic>
#include <functional>
#include <deque>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace rhap::app {

struct Job {
  enum class Kind { Export, Proxy, Task } kind = Kind::Export;
  enum class State { Queued, Running, Done, Failed, Cancelled } state = State::Queued;
  std::string title, output, error;
  std::vector<std::string> argv;
  double progress = 0;  // 0..1
  double fps = 0;
  double duration = 0;  // seconds, for ffmpeg's out_time progress
  std::string mediaId;  // proxies: whose proxy this is
  int pid = 0;
  /** Task jobs: work runs on the task thread; apply runs on the UI thread after it succeeds */
  std::function<std::string()> work;
  std::function<void()> apply;
};

class JobQueue {
 public:
  JobQueue();
  ~JobQueue();
  void add(Job j);
  void cancel(size_t index);
  /** a copy of every job for drawing */
  std::vector<Job> snapshot();
  /** finished proxy jobs not yet collected: (media id, proxy path) */
  std::vector<std::pair<std::string, std::string>> takeProxies();
  /** finished tasks' apply steps, to run on the UI thread */
  std::vector<std::function<void()>> takeApplies();
  void clearFinished();

 private:
  void run(Job::Kind lane);
  std::mutex mu_;
  std::deque<std::shared_ptr<Job>> jobs_;
  std::vector<std::pair<std::string, std::string>> proxies_;
  std::atomic<bool> stop_{false};
  std::vector<std::function<void()>> applies_;
  std::thread exportThread_, proxyThread_, taskThread_;
};

/** where rpro lives: next to the running editor */
std::string rproPath();

}  // namespace rhap::app
