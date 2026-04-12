#include "shaper/shaper.h"

#include <gtest/gtest.h>

#include <cmath>
#include <memory>

#include "shaper/trace.h"

using avs::shaper::LinkModel;
using avs::shaper::ShaperRegistry;
using avs::shaper::Trace;

namespace {
Trace parse(const char* s) {
  std::string err;
  auto t = Trace::parse(s, &err);
  EXPECT_TRUE(t) << err;
  return *t;
}
constexpr double kMB = 1e6;
}  // namespace

TEST(Trace, ParseRebasesAndComputesDuration) {
  auto t = parse("# comment\n10 8\n11 16\n13 0\n");
  EXPECT_EQ(t.samples(), 3u);
  EXPECT_DOUBLE_EQ(t.duration(), 5.0);  // 0..3, plus last gap of 2
  EXPECT_DOUBLE_EQ(t.mbps_at(0.5), 8);
  EXPECT_DOUBLE_EQ(t.mbps_at(1.5), 16);
  EXPECT_DOUBLE_EQ(t.mbps_at(4.0), 0);
  EXPECT_DOUBLE_EQ(t.mbps_at(5.5), 8);  // wraps
  // bytes per period = 1 MB + 4 MB + 0
  EXPECT_DOUBLE_EQ(t.mean_mbps(), 5 * 8.0 / 5.0);
}

TEST(Trace, ParseErrors) {
  std::string err;
  EXPECT_FALSE(Trace::parse("0 1\n", &err));
  EXPECT_FALSE(Trace::parse("0 1\n0 2\n", &err));
  EXPECT_FALSE(Trace::parse("0 1\n1 -2\n", &err));
  EXPECT_FALSE(Trace::parse("0 1\n1 x\n", &err));
}

TEST(Trace, ConstantFinishTime) {
  auto t = Trace::constant(8.0);  // 1 MB/s
  EXPECT_DOUBLE_EQ(t.finish_time(0, kMB), 1.0);
  EXPECT_DOUBLE_EQ(t.finish_time(2.5, 0.5 * kMB), 3.0);
  EXPECT_DOUBLE_EQ(t.finish_time(3, 0), 3.0);
  EXPECT_NEAR(t.finish_time(0.3, 10 * kMB), 10.3, 1e-9);
}

TEST(Trace, PiecewiseFinishTimeSkipsZeroSegmentsAndWraps) {
  // 0-1 s: 1 MB/s, 1-3 s: 0, 3-5 s: 2 MB/s (last sample holds for the previous 2 s gap)
  // -> period 5 s carrying 5 MB.
  auto t = parse("0 8\n1 0\n3 16\n");
  EXPECT_DOUBLE_EQ(t.duration(), 5.0);
  EXPECT_NEAR(t.finish_time(0, 0.5 * kMB), 0.5, 1e-9);
  EXPECT_NEAR(t.finish_time(0, 1.0 * kMB), 1.0, 1e-9);
  EXPECT_NEAR(t.finish_time(0, 1.5 * kMB), 3.25, 1e-9);  // waits out the outage
  EXPECT_NEAR(t.finish_time(1.5, 0.1 * kMB), 3.05, 1e-9);
  EXPECT_NEAR(t.finish_time(0, 3.0 * kMB), 4.0, 1e-9);
  EXPECT_NEAR(t.finish_time(0, 5.0 * kMB), 5.0, 1e-9);
  EXPECT_NEAR(t.finish_time(0, 5.5 * kMB), 5.5, 1e-9);                     // wraps
  EXPECT_NEAR(t.finish_time(0, 5.0 * kMB * 10 + 1.5 * kMB), 53.25, 1e-6);  // many periods
  EXPECT_NEAR(t.finish_time(3.5, 2.0 * kMB), 4.5, 1e-9);
  EXPECT_NEAR(t.finish_time(3.5, 4.0 * kMB), 6.0, 1e-9);  // 3 MB by 5.0, 1 MB more by 6.0
}

TEST(Trace, BytesBetweenIsInverseOfFinishTime) {
  auto t = parse("0 3\n0.7 0\n1.9 11\n2.2 0.5\n4 7\n");
  for (double start : {0.0, 0.31, 1.0, 2.0, 5.5, 13.7}) {
    for (double bytes : {1.0, 1000.0, 2e5, 3e6, 1.234e7}) {
      double end = t.finish_time(start, bytes);
      EXPECT_GE(end, start);
      EXPECT_NEAR(t.bytes_between(start, end), bytes, 1e-6 * bytes + 1e-6);
    }
  }
}

TEST(Trace, AllZeroTraceNeverFinishes) {
  auto t = parse("0 0\n1 0\n");
  EXPECT_TRUE(std::isinf(t.finish_time(0, 1)));
}

TEST(LinkModel, ConcurrentRequestsShareTheLinkFifo) {
  auto tr = std::make_shared<Trace>(Trace::constant(8.0));  // 1 MB/s
  LinkModel link(tr, /*rtt_s=*/0.1);
  auto a = link.reserve(0.0, 1'000'000);
  EXPECT_NEAR(a.start, 0.1, 1e-12);
  EXPECT_NEAR(a.end, 1.1, 1e-12);
  auto b = link.reserve(0.2, 500'000);  // arrives while a is transmitting
  EXPECT_NEAR(b.start, 1.1, 1e-12);
  EXPECT_NEAR(b.end, 1.6, 1e-12);
  EXPECT_NEAR(link.deadline(b, 250'000), 1.35, 1e-12);
  auto c = link.reserve(5.0, 0);  // idle link: starts after RTT
  EXPECT_NEAR(c.start, 5.1, 1e-12);
  EXPECT_NEAR(c.end, 5.1, 1e-12);
}

TEST(LinkModel, ReleaseReturnsUnusedTail) {
  auto tr = std::make_shared<Trace>(Trace::constant(8.0));
  LinkModel link(tr, 0);
  auto a = link.reserve(0, 1'000'000);
  link.release(a, 0.25);  // client gave up after 0.25 s
  EXPECT_NEAR(link.free_at(), 0.25, 1e-12);
  auto b = link.reserve(0.3, 1'000'000);
  EXPECT_NEAR(b.start, 0.3, 1e-12);
  // Releasing an older reservation does not disturb a newer one.
  auto c = link.reserve(0.3, 1'000'000);
  link.release(b, 0.5);
  EXPECT_NEAR(link.free_at(), c.end, 1e-12);
}

TEST(ShaperRegistry, TraceNameValidation) {
  EXPECT_TRUE(ShaperRegistry::valid_trace_name("norway/bus_1"));
  EXPECT_TRUE(ShaperRegistry::valid_trace_name("step.txt"));
  EXPECT_FALSE(ShaperRegistry::valid_trace_name("../etc/passwd"));
  EXPECT_FALSE(ShaperRegistry::valid_trace_name(".hidden"));
  EXPECT_FALSE(ShaperRegistry::valid_trace_name("a b"));
  EXPECT_FALSE(ShaperRegistry::valid_trace_name(""));
}
