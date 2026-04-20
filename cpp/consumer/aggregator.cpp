#include "consumer/aggregator.h"

#include <algorithm>
#include <cmath>

namespace avs::consumer {

using nlohmann::json;

Aggregator::Aggregator(AggregatorConfig cfg, std::int64_t now_ms)
    : cfg_(std::move(cfg)),
      epoch_start_ms_(now_ms),
      startup_(cfg_.startup_test),
      rebuffer_(cfg_.rebuffer_test) {}

void Aggregator::reset(std::int64_t wall_now_ms) {
  ++epoch_;
  epoch_start_ms_ = wall_now_ms;
  accept_from_ms_ = wall_now_ms;
  max_ts_ = 0;
  sessions_.clear();
  pending_.clear();
  arms_.clear();
  windows_.clear();
  counters_ = Counters{};
  startup_ = TestRecord(cfg_.startup_test);
  rebuffer_ = TestRecord(cfg_.rebuffer_test);
}

int Aggregator::test_arm(const std::string& arm) const {
  if (arm == cfg_.control_arm) return 0;
  if (arm == cfg_.treatment_arm) return 1;
  return -1;
}

WindowArm& Aggregator::window(std::int64_t ts, const std::string& arm) {
  std::int64_t start = ts - ((ts % cfg_.window_ms) + cfg_.window_ms) % cfg_.window_ms;
  return windows_[start][arm];
}

void Aggregator::note_decision(TestRecord& t, std::int64_t wall_now_ms) {
  if (t.decided_wall_ms == 0 && t.test.snapshot().decision == stats::Decision::kReject) {
    t.decided_wall_ms = wall_now_ms;
    t.decided_event_ms = watermark();
  }
}

void Aggregator::ingest(const Event& e, std::int64_t wall_now_ms) {
  counters_.events++;
  if (e.ts < accept_from_ms_ && e.type == EventType::kSessionStart) {
    counters_.pre_epoch++;
    return;
  }
  auto it = sessions_.find(e.sid);
  if (it == sessions_.end()) {
    if (e.type != EventType::kSessionStart) {
      // Unknown session: started before this epoch, evicted, or its start event was lost.
      // Only a startup event lets us reconstruct the start time.
      if (e.type != EventType::kStartup ||
          e.ts - static_cast<std::int64_t>(e.startup_ms) < accept_from_ms_) {
        counters_.orphan++;
        return;
      }
    }
    Session s;
    s.arm = e.arm;
    s.start_ts =
        e.type == EventType::kSessionStart ? e.ts : e.ts - static_cast<std::int64_t>(e.startup_ms);
    it = sessions_.emplace(e.sid, std::move(s)).first;
    arms_[e.arm].sessions++;
    window(it->second.start_ts, e.arm).sessions++;
    pending_.emplace(it->second.start_ts, e.sid);
  }
  Session& s = it->second;
  if (!s.seqs.insert(e.seq).second) {
    counters_.duplicates++;
    return;
  }
  max_ts_ = std::max(max_ts_, e.ts);
  s.last_ts = std::max(s.last_ts, e.ts);
  ArmTotals& arm = arms_[s.arm];
  // Events older than the retained window range are counted but not windowed.
  const bool windowed = e.ts >= max_ts_ - cfg_.window_retention_ms;
  if (!windowed) counters_.late_window++;
  auto win = [&]() -> WindowArm* { return windowed ? &window(e.ts, s.arm) : nullptr; };

  switch (e.type) {
    case EventType::kSessionStart:
      break;  // counted when the session was created
    case EventType::kStartup:
      if (!s.startup_seen) {
        s.startup_seen = true;
        s.startup_ms = e.startup_ms;
        arm.startups++;
        if (auto* w = win()) {
          w->startups++;
          w->startup_sum += std::min(e.startup_ms, cfg_.startup_cap_ms);
        }
      }
      break;
    case EventType::kBitrateSwitch:
      arm.switch_events++;
      if (auto* w = win()) w->switches++;
      break;
    case EventType::kRebufferStart:
      arm.rebuffer_events++;
      if (auto* w = win()) w->rebuffers++;
      break;
    case EventType::kRebufferEnd:
      arm.rebuffer_ms_total += e.duration_ms;
      if (auto* w = win()) w->rebuffer_ms += e.duration_ms;
      break;
    case EventType::kError:
      arm.errors++;
      if (auto* w = win()) w->errors++;
      break;
    case EventType::kSessionEnd: {
      arm.sessions_ended++;
      const double total = e.play_ms + e.rebuffer_ms;
      const double ratio = total > 0 ? e.rebuffer_ms / total : 0.0;
      arm.rebuffer_ratio.add(ratio);
      arm.avg_kbps.add(e.avg_kbps);
      arm.switches.add(static_cast<double>(e.switches));
      arm.rebuffers.add(static_cast<double>(e.rebuffer_count));
      if (auto* w = win()) {
        w->ended++;
        w->play_ms += e.play_ms;
      }
      // Secondary test: per-session rebuffer ratio, in session-end order.
      if (int t = test_arm(s.arm); t >= 0) {
        rebuffer_.test.add(t, ratio);
        note_decision(rebuffer_, wall_now_ms);
      }
      break;
    }
  }
  release_cohorts(wall_now_ms);
  evict_idle();
}

void Aggregator::release_cohorts(std::int64_t wall_now_ms) {
  // A session's startup observation is released once start + cap is behind the watermark,
  // in start order, independent of its value.
  const std::int64_t cap = static_cast<std::int64_t>(cfg_.startup_cap_ms);
  while (!pending_.empty() && pending_.begin()->first + cap <= watermark()) {
    auto node = pending_.begin();
    auto sit = sessions_.find(node->second);
    pending_.erase(node);
    if (sit == sessions_.end() || sit->second.released) continue;
    Session& s = sit->second;
    s.released = true;
    const bool capped = !s.startup_seen || s.startup_ms >= cfg_.startup_cap_ms;
    const double x = capped ? cfg_.startup_cap_ms : s.startup_ms;
    ArmTotals& arm = arms_[s.arm];
    arm.startup_ms.add(x);
    if (capped) arm.startup_capped++;
    if (int t = test_arm(s.arm); t >= 0) {
      startup_.test.add(t, x);
      note_decision(startup_, wall_now_ms);
    } else {
      counters_.ignored_arm++;
    }
  }
}

void Aggregator::evict_idle() {
  const std::int64_t horizon = max_ts_ - cfg_.session_idle_ms;
  const std::int64_t cap = static_cast<std::int64_t>(cfg_.startup_cap_ms);
  for (auto it = sessions_.begin(); it != sessions_.end();) {
    // Keep sessions whose startup observation is still pending release.
    if (it->second.last_ts < horizon && it->second.start_ts + cap <= watermark()) {
      it = sessions_.erase(it);
      counters_.evicted_sessions++;
    } else {
      ++it;
    }
  }
  if (!windows_.empty()) {
    const std::int64_t keep_from = max_ts_ - cfg_.window_retention_ms;
    while (!windows_.empty() && windows_.begin()->first + cfg_.window_ms < keep_from)
      windows_.erase(windows_.begin());
  }
}

const ArmTotals* Aggregator::arm(const std::string& name) const {
  auto it = arms_.find(name);
  return it == arms_.end() ? nullptr : &it->second;
}

namespace {

json stats_json(const stats::RunningStats& s) {
  return {{"n", s.n()}, {"mean", s.mean()}, {"sd", s.stddev()}, {"sem", s.sem()}};
}

json finite_or_null(double x) {
  return std::isfinite(x) ? json(x) : json(nullptr);
}

json test_json(const TestRecord& t, const std::string& metric, const AggregatorConfig& cfg,
               std::int64_t epoch_start) {
  const auto& s = t.test.snapshot();
  const auto& c = t.test.config();
  return {{"metric", metric},
          {"control", cfg.control_arm},
          {"treatment", cfg.treatment_arm},
          {"alpha", c.alpha},
          {"tau", c.tau},
          {"min_n_per_arm", c.min_n_per_arm},
          {"n_control", s.n_a},
          {"n_treatment", s.n_b},
          {"mean_control", s.mean_a},
          {"mean_treatment", s.mean_b},
          {"diff", s.diff},
          {"log_lambda", s.log_lambda},
          {"p_value", s.p_value},
          {"ci_lo", finite_or_null(s.ci_lo)},
          {"ci_hi", finite_or_null(s.ci_hi)},
          {"decision", s.decision == stats::Decision::kReject ? "reject" : "continue"},
          {"decided_at_n", s.decided_at_n},
          {"decided_wall_ms", t.decided_wall_ms},
          {"decided_after_s",
           t.decided_wall_ms ? json(static_cast<double>(t.decided_wall_ms - epoch_start) / 1000.0)
                             : json(nullptr)}};
}

}  // namespace

json Aggregator::state_json(std::int64_t wall_now_ms) const {
  json arms = json::object();
  for (const auto& [name, a] : arms_) {
    arms[name] = {
        {"sessions", a.sessions},
        {"sessions_ended", a.sessions_ended},
        {"startups", a.startups},
        {"startup_ms", stats_json(a.startup_ms)},
        {"startup_capped", a.startup_capped},
        {"rebuffer_ratio", stats_json(a.rebuffer_ratio)},
        {"rebuffers_per_session", stats_json(a.rebuffers)},
        {"avg_kbps", stats_json(a.avg_kbps)},
        {"switches_per_session", stats_json(a.switches)},
        {"rebuffer_events", a.rebuffer_events},
        {"rebuffer_ms_total", a.rebuffer_ms_total},
        {"switch_events", a.switch_events},
        {"errors", a.errors},
    };
  }
  json windows = json::array();
  std::size_t skip =
      windows_.size() > cfg_.windows_in_state ? windows_.size() - cfg_.windows_in_state : 0;
  for (auto it = std::next(windows_.begin(), static_cast<std::ptrdiff_t>(skip));
       it != windows_.end(); ++it) {
    json per_arm = json::object();
    for (const auto& [name, w] : it->second) {
      per_arm[name] = {
          {"sessions", w.sessions},
          {"startups", w.startups},
          {"startup_mean_ms",
           w.startups ? json(w.startup_sum / static_cast<double>(w.startups)) : json(nullptr)},
          {"rebuffers", w.rebuffers},
          {"rebuffer_ms", w.rebuffer_ms},
          {"switches", w.switches},
          {"errors", w.errors},
          {"ended", w.ended}};
    }
    windows.push_back({{"start_ms", it->first}, {"arms", per_arm}});
  }
  return {
      {"epoch", {{"id", epoch_}, {"started_ms", epoch_start_ms_}}},
      {"now_ms", wall_now_ms},
      {"watermark_ms", max_ts_ ? json(watermark()) : json(nullptr)},
      {"config",
       {{"window_ms", cfg_.window_ms},
        {"startup_cap_ms", cfg_.startup_cap_ms},
        {"lateness_ms", cfg_.lateness_ms}}},
      {"counters",
       {{"events", counters_.events},
        {"duplicates", counters_.duplicates},
        {"pre_epoch", counters_.pre_epoch},
        {"orphan", counters_.orphan},
        {"late_window", counters_.late_window},
        {"evicted_sessions", counters_.evicted_sessions},
        {"active_sessions", sessions_.size()},
        {"pending_startup_obs", pending_.size()}}},
      {"arms", arms},
      {"windows", windows},
      {"tests",
       {{"startup_ms",
         test_json(startup_, "startup_ms (capped, cohort order)", cfg_, epoch_start_ms_)},
        {"rebuffer_ratio", test_json(rebuffer_, "rebuffer_ratio (session-end order, secondary)",
                                     cfg_, epoch_start_ms_)}}},
  };
}

}  // namespace avs::consumer
