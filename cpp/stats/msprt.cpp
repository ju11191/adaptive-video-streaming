#include "stats/msprt.h"

#include <algorithm>
#include <cmath>

namespace avs::stats {

double Msprt::log_lambda(double diff, double variance, double tau2) {
  return 0.5 * std::log(variance / (variance + tau2)) +
         tau2 * diff * diff / (2.0 * variance * (variance + tau2));
}

double Msprt::ci_half_width(double variance, double tau2, double alpha) {
  return std::sqrt(variance * (variance + tau2) / tau2 *
                   (2.0 * std::log(1.0 / alpha) + std::log((variance + tau2) / variance)));
}

void Msprt::add(int arm, double x) {
  (arm == 0 ? a_ : b_).add(x);
  s_.n_a = a_.n();
  s_.n_b = b_.n();
  s_.mean_a = a_.mean();
  s_.mean_b = b_.mean();
  s_.sd_a = a_.stddev();
  s_.sd_b = b_.stddev();
  s_.diff = s_.mean_b - s_.mean_a;
  if (a_.n() < 2 || b_.n() < 2) return;
  s_.variance =
      a_.variance() / static_cast<double>(a_.n()) + b_.variance() / static_cast<double>(b_.n());
  if (!(s_.variance > 0)) return;
  if (a_.n() < cfg_.min_n_per_arm || b_.n() < cfg_.min_n_per_arm) return;

  const double tau2 = cfg_.tau * cfg_.tau;
  s_.log_lambda = log_lambda(s_.diff, s_.variance, tau2);
  s_.p_value = std::min(s_.p_value, std::min(1.0, std::exp(-s_.log_lambda)));
  const double hw = ci_half_width(s_.variance, tau2, cfg_.alpha);
  s_.ci_lo = std::max(s_.ci_lo, s_.diff - hw);
  s_.ci_hi = std::min(s_.ci_hi, s_.diff + hw);
  if (s_.decision == Decision::kContinue && s_.p_value <= cfg_.alpha) {
    s_.decision = Decision::kReject;
    s_.decided_at_n = a_.n() + b_.n();
  }
}

double normal_two_sided_p(double z) {
  return std::erfc(std::fabs(z) / std::sqrt(2.0));
}

double welch_p_value(const RunningStats& a, const RunningStats& b) {
  if (a.n() < 2 || b.n() < 2) return 1.0;
  double v = a.variance() / static_cast<double>(a.n()) + b.variance() / static_cast<double>(b.n());
  if (!(v > 0)) return 1.0;
  return normal_two_sided_p((b.mean() - a.mean()) / std::sqrt(v));
}

}  // namespace avs::stats
