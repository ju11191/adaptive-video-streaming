// A/A false-positive-rate simulation under continuous monitoring.
//
// Each experiment draws observations from ONE distribution (no true difference), assigns each
// to arm A or B by a fair coin (like hash assignment), and after EVERY observation:
//   - updates the mSPRT and records whether it has ever rejected;
//   - computes a classic Welch z-test p-value and records whether it was ever < alpha
//     ("peeking" at a fixed-horizon test), and the same when checking only every K obs;
// plus a single fixed-horizon Welch test at the end. Reports rejection rates with Wilson CIs.
//
//   avs_aa_fpr [--experiments 2000] [--max-n 20000] [--alpha 0.05] [--tau 200]
//              [--burn-in 50] [--peek-every 100] [--dist lognormal:1500:0.8] [--seed 1]
//              [--cap X]   (winsorize observations at X)
#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <random>
#include <string>
#include <vector>

#include "bench/samplers.h"
#include "stats/msprt.h"

using namespace avs::stats;

int main(int argc, char** argv) {
  int experiments = 2000;
  int max_n = 20000;
  double alpha = 0.05, tau = 200;
  int burn_in = 50, peek_every = 100;
  std::string dist = "lognormal:1500:0.8";
  unsigned long long seed = 1;
  double cap = 0;
  for (int i = 1; i < argc; ++i) {
    std::string a = argv[i];
    auto next = [&] { return std::string(i + 1 < argc ? argv[++i] : ""); };
    if (a == "--experiments")
      experiments = std::stoi(next());
    else if (a == "--max-n")
      max_n = std::stoi(next());
    else if (a == "--alpha")
      alpha = std::stod(next());
    else if (a == "--tau")
      tau = std::stod(next());
    else if (a == "--burn-in")
      burn_in = std::stoi(next());
    else if (a == "--peek-every")
      peek_every = std::stoi(next());
    else if (a == "--dist")
      dist = next();
    else if (a == "--seed")
      seed = std::stoull(next());
    else if (a == "--cap")
      cap = std::stod(next());
    else {
      std::fprintf(stderr, "unknown argument %s\n", a.c_str());
      return 2;
    }
  }
  std::unique_ptr<avs::bench::Sampler> sampler = avs::bench::make_sampler(dist);
  if (cap > 0) sampler = std::make_unique<avs::bench::CappedSampler>(std::move(sampler), cap);
  std::mt19937_64 rng(seed);
  int msprt_fp = 0, peek_all_fp = 0, peek_k_fp = 0, fixed_fp = 0;
  std::vector<double> msprt_fp_n;
  auto t0 = std::chrono::steady_clock::now();
  for (int e = 0; e < experiments; ++e) {
    MsprtConfig cfg;
    cfg.alpha = alpha;
    cfg.tau = tau;
    cfg.min_n_per_arm = burn_in;
    Msprt test(cfg);
    RunningStats a, b;
    bool peek_all = false, peek_k = false;
    for (int i = 1; i <= max_n; ++i) {
      double x = sampler->sample(rng);
      int arm = static_cast<int>(rng() & 1);
      test.add(arm, x);
      (arm ? b : a).add(x);
      if (a.n() >= burn_in && b.n() >= burn_in) {
        bool sig = (!peek_all || (!peek_k && i % peek_every == 0)) && welch_p_value(a, b) < alpha;
        if (sig) {
          peek_all = true;
          if (i % peek_every == 0) peek_k = true;
        }
      }
    }
    if (test.snapshot().decision == Decision::kReject) {
      ++msprt_fp;
      msprt_fp_n.push_back(static_cast<double>(test.snapshot().decided_at_n));
    }
    peek_all_fp += peek_all;
    peek_k_fp += peek_k;
    fixed_fp += welch_p_value(a, b) < alpha;
  }
  double secs = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();

  std::printf("A/A false-positive simulation\n");
  std::printf("  distribution  : %s\n", sampler->describe().c_str());
  std::printf("  experiments   : %d, observations per experiment: %d (both arms, fair coin)\n",
              experiments, max_n);
  std::printf("  alpha         : %.3f, mSPRT tau: %g, burn-in: %d per arm, seed: %llu\n", alpha,
              tau, burn_in, seed);
  std::printf("  runtime       : %.2f s\n\n", secs);
  std::printf("%-52s %8s %8s %18s\n", "procedure", "rejects", "rate", "95% Wilson CI");
  auto row = [&](const char* name, int k) {
    auto [lo, hi] = avs::bench::wilson(k, experiments);
    std::printf("%-52s %8d %8.4f   [%.4f, %.4f]\n", name, k, static_cast<double>(k) / experiments,
                lo, hi);
  };
  row("mSPRT, checked after every observation", msprt_fp);
  row("naive Welch z-test, checked after every observation", peek_all_fp);
  char buf[96];
  std::snprintf(buf, sizeof buf, "naive Welch z-test, checked every %d observations", peek_every);
  row(buf, peek_k_fp);
  row("fixed-horizon Welch z-test, one look at the end", fixed_fp);
  if (!msprt_fp_n.empty()) {
    std::sort(msprt_fp_n.begin(), msprt_fp_n.end());
    std::printf("\nmSPRT false rejections happened at median n = %.0f (min %.0f, max %.0f)\n",
                msprt_fp_n[msprt_fp_n.size() / 2], msprt_fp_n.front(), msprt_fp_n.back());
  }
  return 0;
}
