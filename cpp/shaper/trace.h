// Piecewise-constant network throughput trace that repeats forever.
#pragma once

#include <filesystem>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace avs::shaper {

// Text format: one sample per line, "<time_s> <throughput_mbps>", '#' comments allowed.
// Sample i holds from time t_i until t_{i+1}; the last sample holds for the previous gap.
// Times are re-based so the trace starts at 0, and the trace wraps around at its end.
class Trace {
 public:
  static std::optional<Trace> parse(std::string_view text, std::string* err);
  static std::optional<Trace> load(const std::filesystem::path& file, std::string* err);
  // Single-segment trace with constant throughput.
  static Trace constant(double mbps, double duration_s = 1.0);

  double duration() const { return duration_; }
  std::size_t samples() const { return start_.size(); }
  double mbps_at(double t_s) const;
  double mean_mbps() const;
  // Absolute time (>= start_s, not wrapped) at which `bytes` bytes, sent from start_s at the
  // trace's rate, are fully delivered. +infinity if the trace never carries any data.
  double finish_time(double start_s, double bytes) const;
  // Bytes deliverable between absolute times t0 <= t1.
  double bytes_between(double t0, double t1) const;

 private:
  Trace() = default;
  void build();
  std::size_t segment_at(double phase) const;
  double cum_at(double phase) const;  // bytes delivered from 0 to phase within one period

  std::vector<double> start_;  // segment start times, start_[0] == 0
  std::vector<double> bps_;    // bytes per second in each segment
  std::vector<double> cum_;    // cum_[i] = bytes before segment i; size = n + 1
  double duration_ = 0;
};

}  // namespace avs::shaper
