#include <gtest/gtest.h>

#include <random>
#include <string>

#include "consumer/aggregator.h"
#include "consumer/event.h"

using namespace avs::consumer;

namespace {

std::string ev(const std::string& type, const std::string& sid, const std::string& arm,
               std::int64_t ts, int seq, const std::string& extra = "") {
  // Built with append() rather than chained operator+ to dodge GCC 12's -Wrestrict false
  // positive (GCC bug 105329).
  std::string s = R"({"v":1,"type":")";
  s.append(type).append(R"(","sid":")").append(sid).append(R"(","exp":"e1","arm":")");
  s.append(arm).append(R"(","ts":)").append(std::to_string(ts)).append(R"(,"seq":)");
  s.append(std::to_string(seq));
  if (!extra.empty()) s.append(",").append(extra);
  s.append("}");
  return s;
}

Event parse(const std::string& s) {
  std::string err;
  auto e = parse_event(s, &err);
  EXPECT_TRUE(e) << err << " in " << s;
  return *e;
}

AggregatorConfig small_cfg() {
  AggregatorConfig c;
  c.startup_cap_ms = 10'000;
  c.lateness_ms = 0;
  c.startup_test.min_n_per_arm = 2;
  c.rebuffer_test.min_n_per_arm = 2;
  return c;
}

constexpr std::int64_t T0 = 1'700'000'000'000;

}  // namespace

TEST(EventParse, AllTypes) {
  EXPECT_EQ(parse(ev("session_start", "s", "A", T0, 0, R"("abr":"bba")")).abr, "bba");
  EXPECT_EQ(parse(ev("startup", "s", "A", T0, 1, R"("startupMs":812.5)")).startup_ms, 812.5);
  auto sw =
      parse(ev("bitrate_switch", "s", "A", T0, 2, R"("fromKbps":300,"toKbps":750,"segment":3)"));
  EXPECT_EQ(sw.to_kbps, 750);
  EXPECT_EQ(parse(ev("rebuffer_start", "s", "A", T0, 3)).type, EventType::kRebufferStart);
  EXPECT_EQ(parse(ev("rebuffer_end", "s", "A", T0, 4, R"("durationMs":1200)")).duration_ms, 1200);
  EXPECT_EQ(parse(ev("error", "s", "A", T0, 5, R"("code":"MSE","message":"x")")).code, "MSE");
  auto end =
      parse(ev("session_end", "s", "A", T0, 6,
               R"("playMs":1000,"rebufferMs":250,"rebufferCount":1,"avgKbps":900,"switches":2)"));
  EXPECT_EQ(end.rebuffer_count, 1);
  EXPECT_EQ(end.switches, 2);
}

TEST(EventParse, RejectsInvalid) {
  std::string err;
  EXPECT_FALSE(parse_event("not json", &err));
  EXPECT_FALSE(parse_event("[]", &err));
  EXPECT_FALSE(parse_event(R"({"v":2,"type":"startup"})", &err));
  EXPECT_FALSE(parse_event(ev("nope", "s", "A", T0, 0), &err));
  EXPECT_FALSE(parse_event(ev("startup", "s", "A", T0, 0, R"("startupMs":-5)"), &err));
  EXPECT_FALSE(parse_event(ev("startup", "s", "A", T0, 0), &err));
  EXPECT_FALSE(parse_event(ev("startup", "bad sid", "A", T0, 0, R"("startupMs":5)"), &err));
  EXPECT_FALSE(parse_event(ev("startup", "s", "A", 0, 0, R"("startupMs":5)"), &err));
  EXPECT_FALSE(parse_event(ev("session_start", "s", "A", T0, 0), &err));  // missing abr
}

TEST(Aggregator, StitchesSessionsIntoArmTotals) {
  Aggregator agg(small_cfg(), T0);
  agg.ingest(parse(ev("session_start", "s1", "A", T0, 0, R"("abr":"bba")")), T0);
  agg.ingest(parse(ev("startup", "s1", "A", T0 + 800, 1, R"("startupMs":800)")), T0);
  agg.ingest(parse(ev("bitrate_switch", "s1", "A", T0 + 5000, 2,
                      R"("fromKbps":300,"toKbps":750,"segment":2)")),
             T0);
  agg.ingest(parse(ev("rebuffer_start", "s1", "A", T0 + 9000, 3)), T0);
  agg.ingest(parse(ev("rebuffer_end", "s1", "A", T0 + 10500, 4, R"("durationMs":1500)")), T0);
  agg.ingest(
      parse(ev("session_end", "s1", "A", T0 + 60000, 5,
               R"("playMs":58500,"rebufferMs":1500,"rebufferCount":1,"avgKbps":700,"switches":1)")),
      T0);
  const ArmTotals* a = agg.arm("A");
  ASSERT_NE(a, nullptr);
  EXPECT_EQ(a->sessions, 1);
  EXPECT_EQ(a->startups, 1);
  EXPECT_EQ(a->switch_events, 1);
  EXPECT_EQ(a->rebuffer_events, 1);
  EXPECT_DOUBLE_EQ(a->rebuffer_ms_total, 1500);
  EXPECT_EQ(a->sessions_ended, 1);
  EXPECT_DOUBLE_EQ(a->rebuffer_ratio.mean(), 1500.0 / 60000.0);
  EXPECT_DOUBLE_EQ(a->avg_kbps.mean(), 700);
  // Startup was released (watermark T0+60000 >= start + cap) with its true value.
  EXPECT_EQ(a->startup_ms.n(), 1);
  EXPECT_DOUBLE_EQ(a->startup_ms.mean(), 800);
}

TEST(Aggregator, CohortReleaseIsDelayedOrderedAndCapped) {
  Aggregator agg(small_cfg(), T0);
  // s1 starts first but reports a long startup; s2 starts later with a short one.
  agg.ingest(parse(ev("session_start", "s1", "A", T0, 0, R"("abr":"x")")), T0);
  agg.ingest(parse(ev("session_start", "s2", "A", T0 + 1000, 0, R"("abr":"x")")), T0);
  agg.ingest(parse(ev("startup", "s2", "A", T0 + 1300, 1, R"("startupMs":300)")), T0);
  EXPECT_EQ(agg.arm("A")->startup_ms.n(), 0);  // nothing released before start + cap
  agg.ingest(parse(ev("startup", "s1", "A", T0 + 9000, 1, R"("startupMs":9000)")), T0);
  EXPECT_EQ(agg.arm("A")->startup_ms.n(), 0);
  // s3 never reports startup at all; s4 reports a startup above the cap.
  agg.ingest(parse(ev("session_start", "s3", "A", T0 + 2000, 0, R"("abr":"x")")), T0);
  agg.ingest(parse(ev("session_start", "s4", "A", T0 + 2500, 0, R"("abr":"x")")), T0);
  agg.ingest(parse(ev("startup", "s4", "A", T0 + 17500, 1, R"("startupMs":15000)")), T0);
  // Watermark is now T0+17500: s1 (T0+10000), s2 (T0+11000), s3 (T0+12000), s4 (T0+12500) out.
  const ArmTotals* a = agg.arm("A");
  EXPECT_EQ(a->startup_ms.n(), 4);
  EXPECT_EQ(a->startup_capped, 2);  // s3 (missing) and s4 (> cap)
  EXPECT_DOUBLE_EQ(a->startup_ms.mean(), (9000.0 + 300.0 + 10000.0 + 10000.0) / 4.0);
}

TEST(Aggregator, IgnoresDuplicatesAndPreEpochSessions) {
  Aggregator agg(small_cfg(), T0);
  auto start = parse(ev("session_start", "s1", "A", T0, 0, R"("abr":"x")"));
  auto sw =
      parse(ev("bitrate_switch", "s1", "A", T0 + 10, 1, R"("fromKbps":1,"toKbps":2,"segment":1)"));
  agg.ingest(start, T0);
  agg.ingest(sw, T0);
  agg.ingest(sw, T0);  // redelivered (at-least-once)
  EXPECT_EQ(agg.counters().duplicates, 1);
  EXPECT_EQ(agg.arm("A")->switch_events, 1);

  agg.reset(T0 + 100);
  EXPECT_EQ(agg.arm("A"), nullptr);
  agg.ingest(
      parse(ev("bitrate_switch", "s1", "A", T0 + 200, 2, R"("fromKbps":1,"toKbps":2,"segment":2)")),
      T0);
  EXPECT_EQ(agg.counters().orphan, 1);  // session started before the reset
  agg.ingest(parse(ev("session_start", "old", "A", T0 + 50, 0, R"("abr":"x")")), T0);
  EXPECT_EQ(agg.counters().pre_epoch, 1);
  EXPECT_EQ(agg.arm("A"), nullptr);
}

TEST(Aggregator, ReconstructsStartFromStartupWhenStartEventMissing) {
  Aggregator agg(small_cfg(), T0);
  agg.ingest(parse(ev("startup", "s1", "B", T0 + 2000, 1, R"("startupMs":1500)")), T0);
  EXPECT_EQ(agg.arm("B")->sessions, 1);
  agg.ingest(parse(ev("session_start", "s9", "B", T0 + 20000, 0, R"("abr":"x")")), T0);
  EXPECT_EQ(agg.arm("B")->startup_ms.n(), 1);
  EXPECT_DOUBLE_EQ(agg.arm("B")->startup_ms.mean(), 1500);
}

TEST(Aggregator, WindowsBucketByEventTime) {
  AggregatorConfig c = small_cfg();
  c.window_ms = 10'000;
  Aggregator agg(c, T0);
  agg.ingest(parse(ev("session_start", "s1", "A", T0 + 1000, 0, R"("abr":"x")")), T0);
  agg.ingest(parse(ev("startup", "s1", "A", T0 + 1500, 1, R"("startupMs":500)")), T0);
  agg.ingest(parse(ev("session_start", "s2", "B", T0 + 12000, 0, R"("abr":"x")")), T0);
  agg.ingest(parse(ev("startup", "s2", "B", T0 + 13000, 1, R"("startupMs":1000)")), T0);
  auto j = agg.state_json(T0);
  ASSERT_EQ(j["windows"].size(), 2u);
  EXPECT_EQ(j["windows"][0]["start_ms"].get<std::int64_t>(), T0 - (T0 % 10000));
  EXPECT_EQ(j["windows"][0]["arms"]["A"]["startups"].get<int>(), 1);
  EXPECT_DOUBLE_EQ(j["windows"][0]["arms"]["A"]["startup_mean_ms"].get<double>(), 500);
  EXPECT_EQ(j["windows"][1]["arms"]["B"]["sessions"].get<int>(), 1);
  EXPECT_TRUE(j.contains("tests"));
  EXPECT_EQ(j["tests"]["startup_ms"]["decision"], "continue");
}

TEST(Aggregator, DetectsInjectedStartupRegressionAndRecordsWhen) {
  AggregatorConfig c = small_cfg();
  c.startup_test.min_n_per_arm = 50;
  c.startup_test.tau = 250;
  Aggregator agg(c, T0);
  std::mt19937_64 rng(5);
  std::lognormal_distribution<double> d(std::log(1000.0), 0.5);
  std::int64_t t = T0;
  std::int64_t wall = T0;
  int i = 0;
  while (agg.startup_snapshot().decision == avs::stats::Decision::kContinue && i < 20000) {
    std::string sid = "s";
    sid += std::to_string(i);
    std::string arm = (i % 2) ? "B" : "A";
    double x = d(rng) + (arm == "B" ? 600.0 : 0.0);
    agg.ingest(parse(ev("session_start", sid, arm, t, 0, R"("abr":"x")")), wall);
    std::string payload = "\"startupMs\":";
    payload += std::to_string(x);
    agg.ingest(parse(ev("startup", sid, arm, t + static_cast<std::int64_t>(x), 1, payload)), wall);
    t += 50;
    wall += 50;
    ++i;
  }
  const auto& s = agg.startup_snapshot();
  ASSERT_EQ(s.decision, avs::stats::Decision::kReject);
  EXPECT_GT(s.diff, 300);
  auto j = agg.state_json(wall);
  EXPECT_EQ(j["tests"]["startup_ms"]["decision"], "reject");
  EXPECT_GT(j["tests"]["startup_ms"]["decided_wall_ms"].get<std::int64_t>(), T0);
  EXPECT_GE(j["tests"]["startup_ms"]["decided_after_s"].get<double>(), 10.0);  // >= cohort delay
}

TEST(Aggregator, OtherArmsAreAggregatedButNotTested) {
  Aggregator agg(small_cfg(), T0);
  agg.ingest(parse(ev("session_start", "s1", "C", T0, 0, R"("abr":"x")")), T0);
  agg.ingest(parse(ev("session_start", "s2", "C", T0 + 20000, 0, R"("abr":"x")")), T0);
  EXPECT_EQ(agg.arm("C")->startup_ms.n(), 1);
  EXPECT_EQ(agg.counters().ignored_arm, 1);
  EXPECT_EQ(agg.startup_snapshot().n_a + agg.startup_snapshot().n_b, 0);
}

TEST(Aggregator, EvictsIdleSessions) {
  AggregatorConfig c = small_cfg();
  c.session_idle_ms = 60'000;
  Aggregator agg(c, T0);
  agg.ingest(parse(ev("session_start", "s1", "A", T0, 0, R"("abr":"x")")), T0);
  agg.ingest(parse(ev("session_start", "s2", "A", T0 + 120'000, 0, R"("abr":"x")")), T0);
  EXPECT_EQ(agg.counters().evicted_sessions, 1);
  EXPECT_EQ(agg.active_sessions(), 1u);
}
