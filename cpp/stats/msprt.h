// Mixture sequential probability ratio test (mSPRT) for a two-sample difference in means,
// giving always-valid p-values and confidence intervals (Johari, Pekelis, Walsh 2017;
// Robbins 1970). Safe to evaluate after every observation ("continuous peeking").
#pragma once

#include <cstdint>
#include <limits>

#include "stats/running_stats.h"

namespace avs::stats {

struct MsprtConfig {
  double alpha = 0.05;
  // Std-dev of the normal mixing distribution over the true difference theta = mu_B - mu_A.
  // Should be on the order of the smallest effect worth detecting (same units as the data).
  double tau = 1.0;
  // No decision before each arm has this many observations (plug-in variance is unstable).
  std::int64_t min_n_per_arm = 50;
};

enum class Decision { kContinue, kReject };

struct MsprtSnapshot {
  std::int64_t n_a = 0, n_b = 0;
  double mean_a = 0, mean_b = 0;
  double sd_a = 0, sd_b = 0;
  double diff = 0;        // mean_b - mean_a
  double variance = 0;    // V = s_a^2/n_a + s_b^2/n_b
  double log_lambda = 0;  // log mixture likelihood ratio
  double p_value = 1;     // always-valid p (running minimum of 1/Lambda)
  double ci_lo = -std::numeric_limits<double>::infinity();  // always-valid CI on diff
  double ci_hi = std::numeric_limits<double>::infinity();
  Decision decision = Decision::kContinue;
  std::int64_t decided_at_n = 0;  // total observations when the test first rejected
};

class Msprt {
 public:
  explicit Msprt(MsprtConfig cfg) : cfg_(cfg) {}
  // arm: 0 = A (control), 1 = B (treatment). Updates the test after every observation.
  void add(int arm, double x);
  const MsprtSnapshot& snapshot() const { return s_; }
  const MsprtConfig& config() const { return cfg_; }
  void reset() { *this = Msprt(cfg_); }

  // log Lambda for observed difference `diff` with sampling variance V and mixing var tau^2:
  //   Lambda = sqrt(V/(V+tau^2)) * exp(tau^2 diff^2 / (2 V (V+tau^2)))
  static double log_lambda(double diff, double variance, double tau2);
  // Half-width of the (1-alpha) always-valid CI at this point (before intersecting).
  static double ci_half_width(double variance, double tau2, double alpha);

 private:
  MsprtConfig cfg_;
  RunningStats a_, b_;
  MsprtSnapshot s_;
};

// Classic two-sided Welch z-test p-value (normal approximation, large samples). This is the
// fixed-horizon test that is INVALID when checked repeatedly; used for comparison only.
double welch_p_value(const RunningStats& a, const RunningStats& b);

// Two-sided p-value of a standard normal z statistic.
double normal_two_sided_p(double z);

}  // namespace avs::stats
