#include "shaper/trace.h"

#include <algorithm>
#include <cmath>
#include <fstream>
#include <limits>
#include <sstream>

namespace avs::shaper {

std::optional<Trace> Trace::parse(std::string_view text, std::string* err) {
  std::vector<double> t, mbps;
  std::istringstream in{std::string(text)};
  std::string line;
  int lineno = 0;
  while (std::getline(in, line)) {
    ++lineno;
    auto hash = line.find('#');
    if (hash != std::string::npos) line.resize(hash);
    std::istringstream ls(line);
    double a, b;
    if (!(ls >> a)) continue;  // blank line
    if (!(ls >> b) || !std::isfinite(a) || !std::isfinite(b) || b < 0) {
      if (err) *err = "bad trace line " + std::to_string(lineno);
      return std::nullopt;
    }
    if (!t.empty() && a <= t.back()) {
      if (err) *err = "non-increasing time at line " + std::to_string(lineno);
      return std::nullopt;
    }
    t.push_back(a);
    mbps.push_back(b);
  }
  if (t.size() < 2) {
    if (err) *err = "trace needs at least 2 samples";
    return std::nullopt;
  }
  Trace tr;
  double t0 = t.front();
  for (std::size_t i = 0; i < t.size(); ++i) {
    tr.start_.push_back(t[i] - t0);
    tr.bps_.push_back(mbps[i] * 1e6 / 8.0);
  }
  tr.duration_ = (t.back() - t0) + (t.back() - t[t.size() - 2]);
  tr.build();
  return tr;
}

std::optional<Trace> Trace::load(const std::filesystem::path& file, std::string* err) {
  std::ifstream f(file);
  if (!f) {
    if (err) *err = "cannot open " + file.string();
    return std::nullopt;
  }
  std::stringstream ss;
  ss << f.rdbuf();
  return parse(ss.str(), err);
}

Trace Trace::constant(double mbps, double duration_s) {
  Trace tr;
  tr.start_ = {0.0};
  tr.bps_ = {mbps * 1e6 / 8.0};
  tr.duration_ = duration_s;
  tr.build();
  return tr;
}

void Trace::build() {
  cum_.assign(start_.size() + 1, 0.0);
  for (std::size_t i = 0; i < start_.size(); ++i) {
    double end = i + 1 < start_.size() ? start_[i + 1] : duration_;
    cum_[i + 1] = cum_[i] + bps_[i] * (end - start_[i]);
  }
}

std::size_t Trace::segment_at(double phase) const {
  auto it = std::upper_bound(start_.begin(), start_.end(), phase);
  return static_cast<std::size_t>(std::max<std::ptrdiff_t>(0, (it - start_.begin()) - 1));
}

double Trace::cum_at(double phase) const {
  std::size_t i = segment_at(phase);
  return cum_[i] + (phase - start_[i]) * bps_[i];
}

double Trace::mbps_at(double t_s) const {
  double phase = std::fmod(t_s, duration_);
  if (phase < 0) phase += duration_;
  return bps_[segment_at(phase)] * 8.0 / 1e6;
}

double Trace::mean_mbps() const {
  return cum_.back() / duration_ * 8.0 / 1e6;
}

double Trace::finish_time(double start_s, double bytes) const {
  if (bytes <= 0) return start_s;
  const double period_bytes = cum_.back();
  if (period_bytes <= 0) return std::numeric_limits<double>::infinity();
  double periods = std::floor(start_s / duration_);
  double phase = start_s - periods * duration_;
  double base = periods * duration_;
  double target = cum_at(phase) + bytes;  // in "bytes since start of this period"
  if (target > period_bytes) {
    double extra = std::ceil(target / period_bytes) - 1;  // whole periods to skip
    target -= extra * period_bytes;
    base += extra * duration_;
  }
  // Find segment i with cum_[i] < target <= cum_[i+1]; such a segment has bps_ > 0.
  auto it = std::lower_bound(cum_.begin() + 1, cum_.end(), target);
  std::size_t i = static_cast<std::size_t>(it - cum_.begin()) - 1;
  i = std::min(i, start_.size() - 1);
  double t_in = start_[i] + (target - cum_[i]) / bps_[i];
  return std::max(start_s, base + t_in);
}

double Trace::bytes_between(double t0, double t1) const {
  if (t1 <= t0) return 0;
  auto absolute = [&](double t) {
    double periods = std::floor(t / duration_);
    return periods * cum_.back() + cum_at(t - periods * duration_);
  };
  return absolute(t1) - absolute(t0);
}

}  // namespace avs::shaper
