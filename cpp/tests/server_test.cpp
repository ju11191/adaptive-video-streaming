// Integration tests: a real Origin on an ephemeral port, driven over sockets.
#include <gtest/gtest.h>

#include <chrono>
#include <filesystem>
#include <fstream>
#include <random>

#include "origin/origin.h"
#include "test_client.h"

namespace fs = std::filesystem;
using avs::test::Conn;
using avs::test::get;
using avs::test::RawResponse;

class OriginTest : public ::testing::Test {
 protected:
  void SetUp() override {
    dir_ =
        fs::temp_directory_path() / ("avs_origin_test_" + std::to_string(std::random_device{}()));
    fs::create_directories(dir_ / "media" / "v0");
    fs::create_directories(dir_ / "traces");
    payload_.resize(100000);
    for (std::size_t i = 0; i < payload_.size(); ++i) payload_[i] = static_cast<char>(i * 31 + 7);
    write(dir_ / "media" / "v0" / "seg_1.m4s", payload_);
    write(dir_ / "media" / "master.m3u8", "#EXTM3U\n");
    write(dir_ / "media" / "index.html", "<html></html>");
    // 0.8 Mbit/s = 100 kB/s constant.
    write(dir_ / "traces" / "slow.txt", "0 0.8\n1 0.8\n");
    avs::origin::OriginConfig cfg;
    cfg.root = dir_ / "media";
    cfg.trace_dir = dir_ / "traces";
    origin_ = std::make_unique<avs::origin::Origin>(cfg);
    avs::http::ServerOptions opts;
    opts.host = "127.0.0.1";
    opts.port = 0;
    server_ = std::make_unique<avs::http::Server>(
        opts, [this](const avs::http::Request& r, avs::http::ResponseWriter& w) {
          origin_->handle(r, w);
        });
    std::string err;
    ASSERT_TRUE(server_->start(&err)) << err;
  }
  void TearDown() override {
    server_->stop();
    fs::remove_all(dir_);
  }
  static void write(const fs::path& p, const std::string& s) {
    std::ofstream f(p, std::ios::binary);
    f << s;
  }
  std::uint16_t port() const { return server_->port(); }

  fs::path dir_;
  std::string payload_;
  std::unique_ptr<avs::origin::Origin> origin_;
  std::unique_ptr<avs::http::Server> server_;
};

TEST_F(OriginTest, FullGetWithTypesAndCors) {
  auto r = get(port(), "/v0/seg_1.m4s");
  EXPECT_EQ(r.status, 200);
  EXPECT_EQ(r.body, payload_);
  EXPECT_EQ(r.headers["content-type"], "video/iso.segment");
  EXPECT_EQ(r.headers["access-control-allow-origin"], "*");
  EXPECT_EQ(r.headers["accept-ranges"], "bytes");
  auto m = get(port(), "/master.m3u8");
  EXPECT_EQ(m.headers["content-type"], "application/vnd.apple.mpegurl");
  EXPECT_EQ(m.headers["cache-control"], "no-cache");
}

TEST_F(OriginTest, RangeRequests) {
  auto r = get(port(), "/v0/seg_1.m4s", "Range: bytes=10-19\r\n");
  EXPECT_EQ(r.status, 206);
  EXPECT_EQ(r.body, payload_.substr(10, 10));
  EXPECT_EQ(r.headers["content-range"], "bytes 10-19/100000");
  auto s = get(port(), "/v0/seg_1.m4s", "Range: bytes=-5\r\n");
  EXPECT_EQ(s.status, 206);
  EXPECT_EQ(s.body, payload_.substr(99995));
  auto u = get(port(), "/v0/seg_1.m4s", "Range: bytes=100000-\r\n");
  EXPECT_EQ(u.status, 416);
  EXPECT_EQ(u.headers["content-range"], "bytes */100000");
  auto multi = get(port(), "/v0/seg_1.m4s", "Range: bytes=0-1,4-5\r\n");
  EXPECT_EQ(multi.status, 200);
  EXPECT_EQ(multi.body.size(), payload_.size());
}

TEST_F(OriginTest, HeadOptionsAndErrors) {
  auto h = get(port(), "/v0/seg_1.m4s", "", "HEAD");
  EXPECT_EQ(h.status, 200);
  EXPECT_EQ(h.headers["content-length"], "100000");
  EXPECT_TRUE(h.body.empty());
  auto o = get(port(), "/v0/seg_1.m4s", "Origin: http://x\r\n", "OPTIONS");
  EXPECT_EQ(o.status, 204);
  EXPECT_NE(o.headers["access-control-allow-headers"].find("Range"), std::string::npos);
  EXPECT_EQ(get(port(), "/nope.m4s").status, 404);
  EXPECT_EQ(get(port(), "/../traces/slow.txt").status, 403);
  EXPECT_EQ(get(port(), "/%2e%2e/traces/slow.txt").status, 403);
  EXPECT_EQ(get(port(), "/x", "", "POST").status, 405);
  EXPECT_EQ(get(port(), "/").status, 200);  // directory -> index.html
  EXPECT_EQ(get(port(), "/healthz").status, 200);
}

TEST_F(OriginTest, KeepAliveServesSequentialRequests) {
  Conn c(port());
  ASSERT_TRUE(c.ok());
  for (int i = 0; i < 3; ++i) {
    c.send_raw("GET /master.m3u8 HTTP/1.1\r\nHost: t\r\n\r\n");
    RawResponse r;
    ASSERT_TRUE(c.read_response(&r));
    EXPECT_EQ(r.status, 200);
    EXPECT_EQ(r.body, "#EXTM3U\n");
    EXPECT_EQ(r.headers["connection"], "keep-alive");
  }
  // Pipelined: two requests in one write.
  c.send_raw(
      "GET /master.m3u8 HTTP/1.1\r\n\r\nGET /v0/seg_1.m4s HTTP/1.1\r\nRange: bytes=0-3\r\n\r\n");
  RawResponse a, b;
  ASSERT_TRUE(c.read_response(&a));
  ASSERT_TRUE(c.read_response(&b));
  EXPECT_EQ(a.body, "#EXTM3U\n");
  EXPECT_EQ(b.body, payload_.substr(0, 4));
}

TEST_F(OriginTest, BadRequestClosesConnection) {
  Conn c(port());
  c.send_raw("BROKEN\r\n\r\n");
  RawResponse r;
  ASSERT_TRUE(c.read_response(&r));
  EXPECT_EQ(r.status, 400);
  EXPECT_TRUE(c.peer_closed());
}

TEST_F(OriginTest, ShapedDownloadFollowsTrace) {
  // 100 kB at 100 kB/s should take ~1 s; unshaped is near-instant.
  auto t0 = std::chrono::steady_clock::now();
  auto r = get(port(), "/v0/seg_1.m4s?trace=slow&sid=s1");
  double secs = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
  EXPECT_EQ(r.status, 200);
  EXPECT_EQ(r.body, payload_);
  EXPECT_EQ(r.headers["x-shaped"], "trace=slow");
  EXPECT_GT(secs, 0.85);
  EXPECT_LT(secs, 1.6);

  t0 = std::chrono::steady_clock::now();
  get(port(), "/v0/seg_1.m4s");
  secs = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
  EXPECT_LT(secs, 0.3);
}

TEST_F(OriginTest, ShapedRangeOnlyPaysForRequestedBytes) {
  auto t0 = std::chrono::steady_clock::now();
  auto r = get(port(), "/v0/seg_1.m4s?trace=slow&sid=s2", "Range: bytes=0-9999\r\n");
  double secs = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
  EXPECT_EQ(r.status, 206);
  EXPECT_EQ(r.body.size(), 10000u);
  EXPECT_GT(secs, 0.07);
  EXPECT_LT(secs, 0.5);
}

TEST_F(OriginTest, UnknownTraceIsBadRequest) {
  EXPECT_EQ(get(port(), "/v0/seg_1.m4s?trace=missing&sid=s").status, 400);
  EXPECT_EQ(get(port(), "/v0/seg_1.m4s?trace=../x&sid=s").status, 400);
}
