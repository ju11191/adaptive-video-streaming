// Offline time-to-detect simulation for the startup-time regression test (no pipeline).
//
// Sessions arrive as a Poisson process at `rate` per second and are split 50/50 by a fair coin.
// Each session's startup time is drawn from the sampler; arm B gets `effect` ms added BEFORE the
// optional cap (as a real regression would). The observation becomes available when startup
// completes (arrival + startup) or, in "cohort" mode, at arrival + cap; the mSPRT is updated
// in that order. Detection time is the
// time from the start of the experiment to the first rejection. The grid runs every
// (rate, effect) pair.
//
//   avs_detect_sim --dist empirical:bench/out/startup_samples.txt --cap 10000
//     --rates 5,10,20,50 --effects 0,100,300,500 --runs 200 --horizon-s 3600 --tau 250
//     [--inclusion cohort|completion]
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <random>
#include <sstream>
#include <string>
#include <vector>

#include "bench/samplers.h"
#include "stats/msprt.h"

using namespace avs::stats;

namespace {

std::vector<double> parse_list(const std::string& s) {
  std::vector<double> out;
  std::stringstream ss(s);
  std::string item;
  while (std::getline(ss, item, ',')) out.push_back(std::stod(item));
  return out;
}

double quantile(std::vector<double> xs, double p) {
  if (xs.empty()) return NAN;
  std::sort(xs.begin(), xs.end());
  double h = (static_cast<double>(xs.size()) - 1) * p;
  auto lo = static_cast<std::size_t>(std::floor(h));
  auto hi = static_cast<std::size_t>(std::ceil(h));
  return xs[lo] + (h - static_cast<double>(lo)) * (xs[hi] - xs[lo]);
}

}  // namespace

int main(int argc, char** argv) {
  std::string dist = "lognormal:1500:0.8";
  double cap = 0, alpha = 0.05, tau = 250, horizon = 3600;
  int runs = 200, burn_in = 50;
  // "completion": a session enters the test when its startup completes (value-dependent order).
  // "cohort": it enters at arrival + cap, in arrival order (value-independent; needs --cap).
  std::string inclusion = "cohort";
  unsigned long long seed = 1;
  std::vector<double> rates{5, 10, 20, 50}, effects{0, 100, 300, 500};
  for (int i = 1; i < argc; ++i) {
    std::string a = argv[i];
    auto next = [&] { return std::string(i + 1 < argc ? argv[++i] : ""); };
    if (a == "--dist")
      dist = next();
    else if (a == "--cap")
      cap = std::stod(next());
    else if (a == "--alpha")
      alpha = std::stod(next());
    else if (a == "--tau")
      tau = std::stod(next());
    else if (a == "--horizon-s")
      horizon = std::stod(next());
    else if (a == "--runs")
      runs = std::stoi(next());
    else if (a == "--burn-in")
      burn_in = std::stoi(next());
    else if (a == "--seed")
      seed = std::stoull(next());
    else if (a == "--rates")
      rates = parse_list(next());
    else if (a == "--effects")
      effects = parse_list(next());
    else if (a == "--inclusion")
      inclusion = next();
    else {
      std::fprintf(stderr, "unknown argument %s\n", a.c_str());
      return 2;
    }
  }
  if (inclusion != "completion" && inclusion != "cohort") {
    std::fprintf(stderr, "--inclusion must be completion or cohort\n");
    return 2;
  }
  if (inclusion == "cohort" && cap <= 0) {
    std::fprintf(stderr, "--inclusion cohort requires --cap\n");
    return 2;
  }
  auto sampler = avs::bench::make_sampler(dist);
  std::printf("Offline time-to-detect (mSPRT on mean startup time, no pipeline)\n");
  std::printf("  distribution: %s%s\n", sampler->describe().c_str(),
              cap > 0
                  ? (", capped at " + std::to_string(cap) + " ms after adding the effect").c_str()
                  : "");
  std::printf(
      "  alpha %.3f, tau %g ms, burn-in %d/arm, %d runs per cell, horizon %.0f s, seed %llu\n",
      alpha, tau, burn_in, runs, horizon, seed);
  std::printf("  inclusion: %s\n\n",
              inclusion == "cohort"
                  ? "cohort (session enters the test at arrival + cap, in arrival order)"
                  : "completion (session enters the test when its startup completes)");
  std::printf("%10s %10s %10s %12s %12s %12s %12s %14s\n", "rate/s", "effect_ms", "detected",
              "p10_s", "median_s", "p90_s", "mean_s", "median_n");
  for (double rate : rates) {
    for (double effect : effects) {
      std::mt19937_64 rng(seed ^ (static_cast<unsigned long long>(rate * 1000) << 20) ^
                          static_cast<unsigned long long>(effect));
      std::exponential_distribution<double> gap(rate);
      std::vector<double> times, ns;
      int detected = 0;
      for (int r = 0; r < runs; ++r) {
        struct Obs {
          double t;
          int arm;
          double x;
        };
        std::vector<Obs> obs;
        for (double t = gap(rng); t < horizon; t += gap(rng)) {
          int arm = static_cast<int>(rng() & 1);
          double x = sampler->sample(rng) + (arm ? effect : 0.0);
          if (cap > 0) x = std::min(x, cap);
          double ready = inclusion == "cohort" ? t + cap / 1000.0 : t + x / 1000.0;
          obs.push_back({ready, arm, x});
        }
        std::sort(obs.begin(), obs.end(), [](const Obs& a, const Obs& b) { return a.t < b.t; });
        MsprtConfig cfg;
        cfg.alpha = alpha;
        cfg.tau = tau;
        cfg.min_n_per_arm = burn_in;
        Msprt test(cfg);
        for (const auto& o : obs) {
          if (o.t > horizon) break;
          test.add(o.arm, o.x);
          if (test.snapshot().decision == Decision::kReject) {
            ++detected;
            times.push_back(o.t);
            ns.push_back(static_cast<double>(test.snapshot().decided_at_n));
            break;
          }
        }
      }
      std::printf("%10g %10g %6d/%-3d %12.1f %12.1f %12.1f %12.1f %14.0f\n", rate, effect, detected,
                  runs, quantile(times, 0.1), quantile(times, 0.5), quantile(times, 0.9),
                  times.empty() ? NAN : [&] {
                    double s = 0;
                    for (double t : times) s += t;
                    return s / static_cast<double>(times.size());
                  }(),
                  quantile(ns, 0.5));
    }
  }
  std::printf(
      "\n(effect 0 rows are A/A: 'detected' there are false positives within the horizon;\n"
      " time statistics are over detected runs only)\n");
  return 0;
}
