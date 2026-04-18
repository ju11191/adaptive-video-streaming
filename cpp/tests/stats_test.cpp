#include <gtest/gtest.h>

#include <cmath>
#include <random>
#include <vector>

#include "stats/msprt.h"
#include "stats/running_stats.h"

using namespace avs::stats;

TEST(RunningStats, MatchesDirectFormulas) {
  std::vector<double> xs{2, 4, 4, 4, 5, 5, 7, 9};
  RunningStats s;
  for (double x : xs) s.add(x);
  EXPECT_EQ(s.n(), 8);
  EXPECT_DOUBLE_EQ(s.mean(), 5.0);
  EXPECT_NEAR(s.variance(), 32.0 / 7.0, 1e-12);  // sum sq dev = 32
  EXPECT_NEAR(s.sem(), std::sqrt(32.0 / 7.0 / 8.0), 1e-12);
}

TEST(RunningStats, MergeEqualsSequentialAndIsStable) {
  std::mt19937_64 rng(7);
  std::normal_distribution<double> d(1e9, 3.0);  // large offset: naive sum-of-squares fails
  RunningStats all, a, b;
  for (int i = 0; i < 10000; ++i) {
    double x = d(rng);
    all.add(x);
    (i % 3 ? a : b).add(x);
  }
  a.merge(b);
  EXPECT_EQ(a.n(), all.n());
  EXPECT_NEAR(a.mean(), all.mean(), 1e-14 * std::fabs(all.mean()));  // a few ULPs at 1e9
  EXPECT_NEAR(a.variance(), all.variance(), 1e-6);
  EXPECT_NEAR(all.variance(), 9.0, 0.5);
  RunningStats empty;
  empty.merge(all);
  EXPECT_EQ(empty.n(), all.n());
}

TEST(Msprt, LogLambdaClosedForm) {
  // diff = 0: Lambda = sqrt(V/(V+tau^2)) < 1
  EXPECT_NEAR(Msprt::log_lambda(0, 1.0, 3.0), 0.5 * std::log(0.25), 1e-12);
  // V = 1, tau^2 = 1, diff = 2: 0.5 log(1/2) + 4/(2*1*2) = 1 - 0.3466
  EXPECT_NEAR(Msprt::log_lambda(2.0, 1.0, 1.0), 1.0 + 0.5 * std::log(0.5), 1e-12);
  // symmetric and increasing in |diff|
  EXPECT_DOUBLE_EQ(Msprt::log_lambda(-1.5, 0.3, 2.0), Msprt::log_lambda(1.5, 0.3, 2.0));
  EXPECT_GT(Msprt::log_lambda(2.0, 0.3, 2.0), Msprt::log_lambda(1.0, 0.3, 2.0));
}

TEST(Msprt, CiBoundaryIsWhereLambdaHitsOneOverAlpha) {
  for (double v : {0.01, 0.5, 4.0}) {
    for (double tau2 : {0.1, 1.0, 25.0}) {
      double hw = Msprt::ci_half_width(v, tau2, 0.05);
      EXPECT_NEAR(Msprt::log_lambda(hw, v, tau2), std::log(20.0), 1e-9);
    }
  }
}

TEST(Msprt, BurnInThenDetectsLargeEffect) {
  MsprtConfig cfg;
  cfg.tau = 1.0;
  cfg.min_n_per_arm = 50;
  Msprt t(cfg);
  std::mt19937_64 rng(1);
  std::normal_distribution<double> d(0, 1);
  // Effect of one standard deviation: huge, must reject quickly but not before burn-in.
  for (int i = 0; i < 2000 && t.snapshot().decision == Decision::kContinue; ++i) {
    t.add(i % 2, d(rng) + (i % 2 ? 1.0 : 0.0));
    if (t.snapshot().n_a < 50 || t.snapshot().n_b < 50) {
      EXPECT_EQ(t.snapshot().decision, Decision::kContinue);
      EXPECT_EQ(t.snapshot().p_value, 1.0);
    }
  }
  const auto& s = t.snapshot();
  ASSERT_EQ(s.decision, Decision::kReject);
  EXPECT_GE(s.decided_at_n, 100);
  EXPECT_LT(s.decided_at_n, 400);
  EXPECT_LE(s.p_value, 0.05);
  EXPECT_GT(s.ci_lo, 0.0);  // CI excludes zero at rejection
  EXPECT_GT(s.diff, 0.5);
}

TEST(Msprt, PValueMonotoneCiNestedAndDecisionSticky) {
  MsprtConfig cfg;
  cfg.tau = 0.5;
  cfg.min_n_per_arm = 20;
  Msprt t(cfg);
  std::mt19937_64 rng(3);
  std::normal_distribution<double> d(0, 1);
  double p = 1, lo = -INFINITY, hi = INFINITY;
  bool rejected = false;
  for (int i = 0; i < 5000; ++i) {
    // Effect appears and then disappears: decision must stay rejected once made.
    double eff = (i > 400 && i < 1400 && i % 2) ? 0.8 : 0.0;
    t.add(i % 2, d(rng) + eff);
    const auto& s = t.snapshot();
    EXPECT_LE(s.p_value, p);
    EXPECT_GE(s.ci_lo, lo);
    EXPECT_LE(s.ci_hi, hi);
    if (rejected) EXPECT_EQ(s.decision, Decision::kReject);
    rejected = s.decision == Decision::kReject;
    p = s.p_value;
    lo = s.ci_lo;
    hi = s.ci_hi;
  }
  EXPECT_TRUE(rejected);
}

TEST(Welch, PValueAtKnownZ) {
  EXPECT_NEAR(normal_two_sided_p(1.959963984540054), 0.05, 1e-9);
  EXPECT_NEAR(normal_two_sided_p(0.0), 1.0, 1e-12);
  RunningStats a, b;
  EXPECT_EQ(welch_p_value(a, b), 1.0);
}

// Small deterministic version of bench/aa_fpr: under H0 with continuous monitoring, mSPRT keeps
// the false-positive rate near/below alpha while naive repeated Welch tests inflate it.
TEST(Msprt, AaContinuousMonitoringFprVersusNaivePeeking) {
  const int experiments = 300, n = 2000;
  std::mt19937_64 rng(11);
  std::normal_distribution<double> d(0, 1);
  int msprt_fp = 0, naive_fp = 0;
  for (int e = 0; e < experiments; ++e) {
    MsprtConfig cfg;
    cfg.tau = 0.2;
    Msprt t(cfg);
    RunningStats a, b;
    bool naive = false;
    for (int i = 0; i < n; ++i) {
      double x = d(rng);
      int arm = static_cast<int>(rng() & 1);
      t.add(arm, x);
      (arm ? b : a).add(x);
      if (!naive && a.n() >= 50 && b.n() >= 50 && welch_p_value(a, b) < 0.05) naive = true;
    }
    msprt_fp += t.snapshot().decision == Decision::kReject;
    naive_fp += naive;
  }
  double msprt_rate = static_cast<double>(msprt_fp) / experiments;
  double naive_rate = static_cast<double>(naive_fp) / experiments;
  EXPECT_LE(msprt_rate, 0.07);  // 0.05 plus Monte Carlo slack (sd ~0.0126 at n=300)
  EXPECT_GT(naive_rate, 0.25);  // continuous peeking at a fixed-horizon test
}
