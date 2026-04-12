// Per-session bandwidth shaping driven by a trace.
#pragma once

#include <chrono>
#include <cstdint>
#include <filesystem>
#include <map>
#include <memory>
#include <mutex>
#include <string>

#include "shaper/trace.h"

namespace avs::shaper {

// Pure timing model of one session's bottleneck link, in trace-time seconds.
// Requests share the link FIFO: a response starts transmitting when the previous one ends.
class LinkModel {
 public:
  struct Reservation {
    double start = 0;  // trace time the first byte enters the link
    double end = 0;    // trace time the last byte is delivered
    std::uint64_t bytes = 0;
  };

  LinkModel(std::shared_ptr<const Trace> trace, double rtt_s)
      : trace_(std::move(trace)), rtt_s_(rtt_s) {}

  // Reserve the link for a response of `bytes` to a request that arrived at `now`.
  Reservation reserve(double now, std::uint64_t bytes);
  // Trace time by which the first `sent` bytes of `r` are delivered.
  double deadline(const Reservation& r, std::uint64_t sent) const;
  // Give back the unused tail of a reservation (e.g. client disconnected) at time `now`.
  void release(const Reservation& r, double now);
  double free_at() const { return free_at_; }
  const Trace& trace() const { return *trace_; }

 private:
  std::shared_ptr<const Trace> trace_;
  double rtt_s_;
  double free_at_ = 0;
};

// Thread-safe registry: session id -> link, with traces loaded lazily from a directory.
class ShaperRegistry {
 public:
  using Clock = std::chrono::steady_clock;

  ShaperRegistry(std::filesystem::path trace_dir, std::chrono::seconds idle_ttl)
      : trace_dir_(std::move(trace_dir)), idle_ttl_(idle_ttl) {}

  struct Ticket {
    LinkModel::Reservation res;
    Clock::time_point epoch;  // wall time corresponding to trace time `offset_s`
    double offset_s = 0;
    std::string key;
  };

  // Returns false (with err) if the trace name is invalid or cannot be loaded.
  bool reserve(const std::string& sid, const std::string& trace_name, double offset_s, double rtt_s,
               std::uint64_t bytes, Ticket* out, std::string* err);
  // Wall-clock time at which the first `sent` bytes of the ticket may have been written.
  Clock::time_point deadline(const Ticket& t, std::uint64_t sent);
  void release(const Ticket& t);
  std::size_t session_count();

  static bool valid_trace_name(const std::string& name);

 private:
  struct Session {
    std::unique_ptr<LinkModel> link;
    Clock::time_point epoch;
    double offset_s = 0;
    Clock::time_point last_used;
  };
  std::shared_ptr<const Trace> get_trace(const std::string& name, std::string* err);
  void evict_idle(Clock::time_point now);
  double trace_now(const Session& s, Clock::time_point now) const;

  std::filesystem::path trace_dir_;
  std::chrono::seconds idle_ttl_;
  std::mutex mu_;
  std::map<std::string, std::shared_ptr<const Trace>> traces_;
  std::map<std::string, Session> sessions_;
};

}  // namespace avs::shaper
