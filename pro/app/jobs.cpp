#include "jobs.h"

#include <fcntl.h>
#include <sys/prctl.h>
#include <signal.h>
#include <sys/wait.h>
#include <unistd.h>

#include <chrono>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <nlohmann/json.hpp>
#include <regex>

namespace rhap::app {

std::string rproPath() {
  char buf[4096];
  ssize_t n = readlink("/proc/self/exe", buf, sizeof buf - 1);
  if (n <= 0) return "rpro";
  buf[n] = 0;
  std::filesystem::path self(buf);
  for (auto cand : {self.parent_path() / "rpro", self.parent_path().parent_path() / "tools" / "rpro"})
    if (std::filesystem::exists(cand)) return cand.string();
  return "rpro";
}

JobQueue::JobQueue(std::string statePath) : statePath_(std::move(statePath)) {
  restore();
  exportThread_ = std::thread([this] { run(Job::Kind::Export); });
  proxyThread_ = std::thread([this] { run(Job::Kind::Proxy); });
  taskThread_ = std::thread([this] { run(Job::Kind::Task); });
}

JobQueue::~JobQueue() {
  stop_ = true;
  {
    std::lock_guard l(mu_);
    // closing the editor mid-export is not a cancel: the export comes back next time
    statePath_.clear();
    for (auto& j : jobs_)
      if (j->state == Job::State::Running && j->pid > 0) kill(j->pid, SIGTERM);
  }
  exportThread_.join();
  proxyThread_.join();
  taskThread_.join();
}

void JobQueue::add(Job j) {
  std::lock_guard l(mu_);
  jobs_.push_back(std::make_shared<Job>(std::move(j)));
  persist();
}

void JobQueue::persist() {
  if (statePath_.empty()) return;
  nlohmann::json a = nlohmann::json::array();
  for (auto& j : jobs_) {
    if (j->kind != Job::Kind::Export) continue;  // proxies and tasks are cheap to ask for again
    a.push_back({{"title", j->title}, {"output", j->output}, {"argv", j->argv}, {"state", int(j->state)}, {"error", j->error}});
  }
  std::string tmp = statePath_ + ".tmp";
  {
    std::ofstream f(tmp, std::ios::trunc);
    f << a.dump(1);
  }
  std::filesystem::rename(tmp, statePath_);
}

void JobQueue::restore() {
  if (statePath_.empty()) return;
  std::ifstream f(statePath_);
  if (!f) return;
  try {
    for (auto& e : nlohmann::json::parse(f)) {
      auto j = std::make_shared<Job>();
      j->kind = Job::Kind::Export;
      j->title = e.value("title", "");
      j->output = e.value("output", "");
      j->argv = e.value("argv", std::vector<std::string>{});
      j->error = e.value("error", "");
      auto st = Job::State(e.value("state", 0));
      // an export that was waiting or running when the editor died starts again (smart render reuses its finished stretches)
      j->state = st == Job::State::Running ? Job::State::Queued : st;
      if (j->state == Job::State::Queued) j->title += " (resumed)";
      jobs_.push_back(j);
    }
  } catch (...) {
  }
}

void JobQueue::cancel(size_t i) {
  std::lock_guard l(mu_);
  if (i >= jobs_.size()) return;
  auto& j = jobs_[i];
  if (j->state == Job::State::Queued) j->state = Job::State::Cancelled;
  if (j->state == Job::State::Running && j->pid > 0) {
    kill(j->pid, SIGTERM);
    j->state = Job::State::Cancelled;
  }
}

std::vector<Job> JobQueue::snapshot() {
  std::lock_guard l(mu_);
  std::vector<Job> v;
  for (auto& j : jobs_) v.push_back(*j);
  return v;
}

std::vector<std::pair<std::string, std::string>> JobQueue::takeProxies() {
  std::lock_guard l(mu_);
  auto v = std::move(proxies_);
  proxies_.clear();
  return v;
}

std::vector<std::function<void()>> JobQueue::takeApplies() {
  std::lock_guard l(mu_);
  auto v = std::move(applies_);
  applies_.clear();
  return v;
}

void JobQueue::clearFinished() {
  std::lock_guard l(mu_);
  std::erase_if(jobs_, [](auto& j) { return j->state != Job::State::Queued && j->state != Job::State::Running; });
  persist();
}

void JobQueue::run(Job::Kind lane) {
  std::regex prog(R"((\d+)/(\d+)\s+([0-9.]+) fps)");
  std::regex ffTime(R"(out_time_us=(\d+))");
  while (!stop_) {
    std::shared_ptr<Job> job;
    {
      std::lock_guard l(mu_);
      for (auto& j : jobs_)
        if (j->kind == lane && j->state == Job::State::Queued) {
          job = j;
          job->state = Job::State::Running;
          persist();
          break;
        }
    }
    if (!job) {
      std::this_thread::sleep_for(std::chrono::milliseconds(200));
      continue;
    }
    if (job->work) {
      std::string e = job->work();
      std::lock_guard l(mu_);
      if (job->state == Job::State::Cancelled) continue;
      job->state = e.empty() ? Job::State::Done : Job::State::Failed;
      job->error = e;
      job->progress = 1;
      if (e.empty() && job->apply) applies_.push_back(job->apply);
      continue;
    }
    int pipefd[2];
    if (pipe(pipefd) != 0) {
      std::lock_guard l(mu_);
      job->state = Job::State::Failed;
      job->error = "no pipe";
      continue;
    }
    pid_t pid = fork();
    if (pid == 0) {
      prctl(PR_SET_PDEATHSIG, SIGKILL);  // an export never outlives the editor; the queue brings it back
      dup2(pipefd[1], 2);
      dup2(pipefd[1], 1);
      close(pipefd[0]);
      std::vector<char*> args;
      for (auto& a : job->argv) args.push_back(const_cast<char*>(a.c_str()));
      args.push_back(nullptr);
      execvp(args[0], args.data());
      _exit(127);
    }
    close(pipefd[1]);
    {
      std::lock_guard l(mu_);
      job->pid = pid;
    }
    std::string buf, last;
    char chunk[512];
    ssize_t n;
    while ((n = read(pipefd[0], chunk, sizeof chunk)) > 0) {
      buf.append(chunk, size_t(n));
      size_t cut;
      while ((cut = buf.find_first_of("\r\n")) != std::string::npos) {
        std::string line = buf.substr(0, cut);
        buf.erase(0, cut + 1);
        if (line.empty()) continue;
        std::smatch m;
        std::lock_guard l(mu_);
        if (std::regex_search(line, m, prog)) {
          job->progress = std::stod(m[1]) / std::max(1.0, std::stod(m[2]));
          job->fps = std::stod(m[3]);
        } else if (std::regex_search(line, m, ffTime) && job->duration > 0) {
          job->progress = std::min(1.0, std::stod(m[1]) / 1e6 / job->duration);
        } else if (line.find("rpro:") != std::string::npos || line.find("Error") != std::string::npos) {
          last = line;
        }
      }
    }
    close(pipefd[0]);
    int status = 0;
    waitpid(pid, &status, 0);
    std::lock_guard l(mu_);
    if (job->state == Job::State::Cancelled) {
      persist();
      continue;
    }
    if (WIFEXITED(status) && WEXITSTATUS(status) == 0) {
      job->state = Job::State::Done;
      job->progress = 1;
      if (job->kind == Job::Kind::Proxy) proxies_.push_back({job->mediaId, job->output});
    } else {
      job->state = Job::State::Failed;
      job->error = last.empty() ? (WIFSIGNALED(status) ? "the export process crashed (signal " + std::to_string(WTERMSIG(status)) + ")"
                                                       : "failed")
                                : last;
    }
    persist();
  }
}

}  // namespace rhap::app
