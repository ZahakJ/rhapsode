#include "jobs.h"

#include <fcntl.h>
#include <signal.h>
#include <sys/wait.h>
#include <unistd.h>

#include <chrono>
#include <cstdio>
#include <filesystem>
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

JobQueue::JobQueue() {
  exportThread_ = std::thread([this] { run(Job::Kind::Export); });
  proxyThread_ = std::thread([this] { run(Job::Kind::Proxy); });
}

JobQueue::~JobQueue() {
  stop_ = true;
  {
    std::lock_guard l(mu_);
    for (auto& j : jobs_)
      if (j->state == Job::State::Running && j->pid > 0) kill(j->pid, SIGTERM);
  }
  exportThread_.join();
  proxyThread_.join();
}

void JobQueue::add(Job j) {
  std::lock_guard l(mu_);
  jobs_.push_back(std::make_shared<Job>(std::move(j)));
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

void JobQueue::clearFinished() {
  std::lock_guard l(mu_);
  std::erase_if(jobs_, [](auto& j) { return j->state != Job::State::Queued && j->state != Job::State::Running; });
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
          break;
        }
    }
    if (!job) {
      std::this_thread::sleep_for(std::chrono::milliseconds(200));
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
    if (job->state == Job::State::Cancelled) continue;
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
  }
}

}  // namespace rhap::app
