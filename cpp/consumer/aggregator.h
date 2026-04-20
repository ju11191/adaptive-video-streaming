// Per-arm streaming aggregation of telemetry plus live sequential tests.
//
// Not thread-safe; the caller serialises access (the consumer holds a mutex).
#pragma once

#include <cstdint>
#include <map>
#include <nlohmann/json.hpp>
#include <set>
#include <string>
#include <unordered_map>
#include <vector>

#include "consumer/event.h"
#include "stats/msprt.h"
#include "stats/running_stats.h"

namespace avs::consumer {

struct AggregatorConfig {
  std::int64_t window_ms = 10'000;  // tumbling event-time window size
  std::int64_t window_retention_ms = 30 * 60'000;
  std::int64_t session_idle_ms = 10 * 60'000;  // evict sessions idle this long (event time)
  std::int64_t lateness_ms = 2'000;            // watermark = max event ts - lateness
  double startup_cap_ms = 10'000;              // winsorization cap; also the cohort delay
  std::string control_arm = "A";
  std::string treatment_arm = "B";
  stats::MsprtConfig startup_test{0.05, 250.0, 200};
  stats::MsprtConfig rebuffer_test{0.05, 0.01, 200};
  std::size_t windows_in_state = 60;
};

struct ArmTotals {
  std::int64_t sessions = 0;  // session_start seen
  std::int64_t sessions_ended = 0;
  std::int64_t startups = 0;           // startup events seen
  std::int64_t startup_capped = 0;     // cohort observations released at the cap
  stats::RunningStats startup_ms;      // cohort-released, capped values (what the test sees)
  stats::RunningStats rebuffer_ratio;  // per ended session
  stats::RunningStats avg_kbps;        // per ended session
  stats::RunningStats switches;        // per ended session
  stats::RunningStats rebuffers;       // count per ended session
  std::int64_t rebuffer_events = 0;
  double rebuffer_ms_total = 0;
  std::int64_t switch_events = 0;
  std::int64_t errors = 0;
};

struct WindowArm {
  std::int64_t sessions = 0, startups = 0, rebuffers = 0, switches = 0, errors = 0, ended = 0;
  double startup_sum = 0, rebuffer_ms = 0, play_ms = 0;
};

struct TestRecord {
  stats::Msprt test;
  std::int64_t decided_wall_ms = 0;   // consumer wall time when it first rejected
  std::int64_t decided_event_ms = 0;  // watermark at that moment
  explicit TestRecord(stats::MsprtConfig c) : test(c) {}
};

class Aggregator {
 public:
  explicit Aggregator(AggregatorConfig cfg, std::int64_t now_ms = 0);

  void ingest(const Event& e, std::int64_t wall_now_ms);
  // Starts a new experiment epoch: clears stats/tests; sessions starting before now are ignored.
  // The initial epoch (before any reset) accepts all sessions, so replays work.
  void reset(std::int64_t wall_now_ms);
  nlohmann::json state_json(std::int64_t wall_now_ms) const;

  const ArmTotals* arm(const std::string& name) const;
  const stats::MsprtSnapshot& startup_snapshot() const { return startup_.test.snapshot(); }
  const stats::MsprtSnapshot& rebuffer_snapshot() const { return rebuffer_.test.snapshot(); }
  std::int64_t watermark() const { return max_ts_ - cfg_.lateness_ms; }
  std::int64_t epoch_start_ms() const { return epoch_start_ms_; }

  struct Counters {
    std::int64_t events = 0, duplicates = 0, pre_epoch = 0, late_window = 0, orphan = 0,
                 evicted_sessions = 0, ignored_arm = 0;
  };
  const Counters& counters() const { return counters_; }
  std::size_t active_sessions() const { return sessions_.size(); }

 private:
  struct Session {
    std::string arm;
    std::int64_t start_ts = 0;
    std::int64_t last_ts = 0;
    bool startup_seen = false;
    double startup_ms = 0;
    bool released = false;  // startup observation has entered the test
    std::set<std::int64_t> seqs;
  };

  void release_cohorts(std::int64_t wall_now_ms);
  void evict_idle();
  void note_decision(TestRecord& t, std::int64_t wall_now_ms);
  WindowArm& window(std::int64_t ts, const std::string& arm);
  int test_arm(const std::string& arm) const;  // 0 control, 1 treatment, -1 other

  AggregatorConfig cfg_;
  std::int64_t epoch_ = 0;
  std::int64_t epoch_start_ms_ = 0;  // wall time the epoch began (for time-to-decision)
  std::int64_t accept_from_ms_ = 0;  // sessions starting before this are ignored (0 = all)
  std::int64_t max_ts_ = 0;
  Counters counters_;
  std::unordered_map<std::string, Session> sessions_;
  std::multimap<std::int64_t, std::string> pending_;  // start_ts -> sid awaiting release
  std::map<std::string, ArmTotals> arms_;
  std::map<std::int64_t, std::map<std::string, WindowArm>> windows_;
  TestRecord startup_;
  TestRecord rebuffer_;
};

}  // namespace avs::consumer
