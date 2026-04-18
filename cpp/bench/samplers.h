// Observation generators for the statistical benchmarks.
#pragma once

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <fstream>
#include <memory>
#include <random>
#include <stdexcept>
#include <string>
#include <vector>

namespace avs::bench {

class Sampler {
 public:
  virtual ~Sampler() = default;
  virtual double sample(std::mt19937_64& rng) = 0;
  virtual std::string describe() const = 0;
};

class NormalSampler : public Sampler {
 public:
  NormalSampler(double mean, double sd) : d_(mean, sd), mean_(mean), sd_(sd) {}
  double sample(std::mt19937_64& rng) override { return d_(rng); }
  std::string describe() const override {
    return "normal(mean=" + std::to_string(mean_) + ", sd=" + std::to_string(sd_) + ")";
  }

 private:
  std::normal_distribution<double> d_;
  double mean_, sd_;
};

class LognormalSampler : public Sampler {
 public:
  LognormalSampler(double median, double sigma)
      : d_(std::log(median), sigma), median_(median), sigma_(sigma) {}
  double sample(std::mt19937_64& rng) override { return d_(rng); }
  std::string describe() const override {
    return "lognormal(median=" + std::to_string(median_) + ", sigma=" + std::to_string(sigma_) +
           ")";
  }

 private:
  std::lognormal_distribution<double> d_;
  double median_, sigma_;
};

// Bootstrap from an empirical sample (one number per line).
class EmpiricalSampler : public Sampler {
 public:
  explicit EmpiricalSampler(const std::string& path) : path_(path) {
    std::ifstream f(path);
    double x;
    while (f >> x) xs_.push_back(x);
    if (xs_.size() < 2) throw std::runtime_error("empirical sample file too small: " + path);
    pick_ = std::uniform_int_distribution<std::size_t>(0, xs_.size() - 1);
  }
  double sample(std::mt19937_64& rng) override { return xs_[pick_(rng)]; }
  std::string describe() const override {
    double m = 0;
    for (double x : xs_) m += x;
    m /= static_cast<double>(xs_.size());
    double v = 0;
    for (double x : xs_) v += (x - m) * (x - m);
    v /= static_cast<double>(xs_.size() - 1);
    char buf[256];
    std::snprintf(buf, sizeof buf, "empirical(%s, n=%zu, mean=%.1f, sd=%.1f)", path_.c_str(),
                  xs_.size(), m, std::sqrt(v));
    return buf;
  }

 private:
  std::string path_;
  std::vector<double> xs_;
  std::uniform_int_distribution<std::size_t> pick_;
};

// Clamps another sampler's values at `cap` (winsorizing the upper tail).
class CappedSampler : public Sampler {
 public:
  CappedSampler(std::unique_ptr<Sampler> inner, double cap) : inner_(std::move(inner)), cap_(cap) {}
  double sample(std::mt19937_64& rng) override { return std::min(inner_->sample(rng), cap_); }
  std::string describe() const override {
    return inner_->describe() + " capped at " + std::to_string(cap_);
  }

 private:
  std::unique_ptr<Sampler> inner_;
  double cap_;
};

// "normal:MEAN:SD" | "lognormal:MEDIAN:SIGMA" | "empirical:PATH"
inline std::unique_ptr<Sampler> make_sampler(const std::string& spec) {
  auto colon = spec.find(':');
  std::string kind = spec.substr(0, colon);
  std::string rest = colon == std::string::npos ? "" : spec.substr(colon + 1);
  auto two = [&](double* a, double* b) {
    auto c = rest.find(':');
    if (c == std::string::npos) throw std::runtime_error("bad sampler spec: " + spec);
    *a = std::stod(rest.substr(0, c));
    *b = std::stod(rest.substr(c + 1));
  };
  double a, b;
  if (kind == "normal") {
    two(&a, &b);
    return std::make_unique<NormalSampler>(a, b);
  }
  if (kind == "lognormal") {
    two(&a, &b);
    return std::make_unique<LognormalSampler>(a, b);
  }
  if (kind == "empirical") return std::make_unique<EmpiricalSampler>(rest);
  throw std::runtime_error("unknown sampler: " + spec);
}

// Wilson score interval for a binomial proportion.
inline std::pair<double, double> wilson(int k, int n, double z = 1.959963984540054) {
  if (n == 0) return {0, 1};
  double p = static_cast<double>(k) / n, nn = n;
  double denom = 1 + z * z / nn;
  double centre = (p + z * z / (2 * nn)) / denom;
  double half = z * std::sqrt(p * (1 - p) / nn + z * z / (4 * nn * nn)) / denom;
  return {centre - half, centre + half};
}

}  // namespace avs::bench
