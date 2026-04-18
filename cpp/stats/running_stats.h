// Welford's online mean/variance: numerically stable, O(1) per update, mergeable.
#pragma once

#include <cmath>
#include <cstdint>

namespace avs::stats {

class RunningStats {
 public:
  void add(double x) {
    ++n_;
    double d = x - mean_;
    mean_ += d / static_cast<double>(n_);
    m2_ += d * (x - mean_);
  }
  // Chan et al. parallel combination.
  void merge(const RunningStats& o) {
    if (o.n_ == 0) return;
    if (n_ == 0) {
      *this = o;
      return;
    }
    double n = static_cast<double>(n_ + o.n_);
    double d = o.mean_ - mean_;
    mean_ += d * static_cast<double>(o.n_) / n;
    m2_ += o.m2_ + d * d * static_cast<double>(n_) * static_cast<double>(o.n_) / n;
    n_ += o.n_;
  }
  std::int64_t n() const { return n_; }
  double mean() const { return n_ ? mean_ : 0.0; }
  // Unbiased sample variance (n - 1 denominator); 0 for n < 2.
  double variance() const { return n_ > 1 ? m2_ / static_cast<double>(n_ - 1) : 0.0; }
  double stddev() const { return std::sqrt(variance()); }
  // Standard error of the mean.
  double sem() const { return n_ > 1 ? std::sqrt(variance() / static_cast<double>(n_)) : 0.0; }

 private:
  std::int64_t n_ = 0;
  double mean_ = 0;
  double m2_ = 0;
};

}  // namespace avs::stats
