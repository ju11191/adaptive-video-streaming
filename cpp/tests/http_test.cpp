#include <gtest/gtest.h>

#include "http/mime.h"
#include "http/path.h"
#include "http/range.h"
#include "http/request.h"

using namespace avs::http;

TEST(RequestParse, ParsesRequestLineHeadersAndQuery) {
  Request r;
  auto pr = parse_request_head(
      "GET /media/v0/seg%201.m4s?trace=a%2Fb&sid=x+y HTTP/1.1\r\nHost: h\r\nRange:  bytes=0-9 "
      "\r\n\r\nBODY",
      r);
  ASSERT_EQ(pr.status, ParseStatus::kOk);
  EXPECT_EQ(r.method, "GET");
  EXPECT_EQ(r.path, "/media/v0/seg 1.m4s");
  EXPECT_EQ(r.query_string, "trace=a%2Fb&sid=x+y");
  EXPECT_EQ(r.query().at("trace"), "a/b");
  EXPECT_EQ(r.query().at("sid"), "x y");
  EXPECT_EQ(*r.header("range"), "bytes=0-9");
  EXPECT_EQ(*r.header("host"), "h");
  EXPECT_EQ(pr.head_len,
            std::string_view("GET /media/v0/seg%201.m4s?trace=a%2Fb&sid=x+y HTTP/1.1\r\nHost: "
                             "h\r\nRange:  bytes=0-9 \r\n\r\n")
                .size());
  EXPECT_TRUE(r.keep_alive());
}

TEST(RequestParse, IncompleteUntilBlankLine) {
  Request r;
  EXPECT_EQ(parse_request_head("GET / HTTP/1.1\r\nHost: x\r\n", r).status,
            ParseStatus::kIncomplete);
}

TEST(RequestParse, RejectsMalformed) {
  Request r;
  EXPECT_EQ(parse_request_head("GET\r\n\r\n", r).status, ParseStatus::kBad);
  EXPECT_EQ(parse_request_head("GET / HTTP/2.0\r\n\r\n", r).status, ParseStatus::kBad);
  EXPECT_EQ(parse_request_head("GET http://x/ HTTP/1.1\r\n\r\n", r).status, ParseStatus::kBad);
  EXPECT_EQ(parse_request_head("GET / HTTP/1.1\r\nNoColon\r\n\r\n", r).status, ParseStatus::kBad);
  EXPECT_EQ(parse_request_head("GET / HTTP/1.1\r\n folded\r\n\r\n", r).status, ParseStatus::kBad);
  EXPECT_EQ(parse_request_head("GET /%zz HTTP/1.1\r\n\r\n", r).status, ParseStatus::kBad);
  EXPECT_EQ(parse_request_head("GET /%00 HTTP/1.1\r\n\r\n", r).status, ParseStatus::kBad);
  EXPECT_EQ(parse_request_head("GET /%4 HTTP/1.1\r\n\r\n", r).status, ParseStatus::kBad);
}

TEST(RequestParse, OversizedHeadIsBad) {
  Request r;
  std::string big = "GET / HTTP/1.1\r\nX: " + std::string(kMaxHeadBytes, 'a');
  EXPECT_EQ(parse_request_head(big, r).status, ParseStatus::kBad);
}

TEST(RequestParse, KeepAliveRules) {
  Request r;
  ASSERT_EQ(parse_request_head("GET / HTTP/1.1\r\nConnection: Close\r\n\r\n", r).status,
            ParseStatus::kOk);
  EXPECT_FALSE(r.keep_alive());
  ASSERT_EQ(parse_request_head("GET / HTTP/1.0\r\n\r\n", r).status, ParseStatus::kOk);
  EXPECT_FALSE(r.keep_alive());
  ASSERT_EQ(parse_request_head("GET / HTTP/1.0\r\nConnection: keep-alive\r\n\r\n", r).status,
            ParseStatus::kOk);
  EXPECT_TRUE(r.keep_alive());
}

TEST(Range, Forms) {
  auto r = parse_range("bytes=0-99", 1000);
  ASSERT_EQ(r.kind, ByteRange::Kind::kSatisfiable);
  EXPECT_EQ(r.first, 0u);
  EXPECT_EQ(r.last, 99u);
  EXPECT_EQ(r.length(), 100u);

  r = parse_range("bytes=900-", 1000);
  EXPECT_EQ(r.first, 900u);
  EXPECT_EQ(r.last, 999u);

  r = parse_range("bytes=-100", 1000);
  EXPECT_EQ(r.first, 900u);
  EXPECT_EQ(r.last, 999u);

  r = parse_range("bytes=-5000", 1000);  // suffix longer than file: whole file
  EXPECT_EQ(r.first, 0u);
  EXPECT_EQ(r.last, 999u);

  r = parse_range("bytes=500-5000", 1000);  // last clamped
  EXPECT_EQ(r.last, 999u);
}

TEST(Range, UnsatisfiableAndIgnored) {
  EXPECT_EQ(parse_range("bytes=1000-", 1000).kind, ByteRange::Kind::kUnsatisfiable);
  EXPECT_EQ(parse_range("bytes=-0", 1000).kind, ByteRange::Kind::kUnsatisfiable);
  EXPECT_EQ(parse_range("bytes=0-", 0).kind, ByteRange::Kind::kUnsatisfiable);
  EXPECT_EQ(parse_range("bytes=5-2", 1000).kind, ByteRange::Kind::kNone);
  EXPECT_EQ(parse_range("bytes=0-1,5-6", 1000).kind, ByteRange::Kind::kNone);
  EXPECT_EQ(parse_range("items=0-1", 1000).kind, ByteRange::Kind::kNone);
  EXPECT_EQ(parse_range("bytes=a-b", 1000).kind, ByteRange::Kind::kNone);
  EXPECT_EQ(parse_range("bytes=", 1000).kind, ByteRange::Kind::kNone);
}

TEST(Mime, KnownTypes) {
  EXPECT_EQ(mime_type_for("a/master.m3u8"), "application/vnd.apple.mpegurl");
  EXPECT_EQ(mime_type_for("init.mp4"), "video/mp4");
  EXPECT_EQ(mime_type_for("seg_1.m4s"), "video/iso.segment");
  EXPECT_EQ(mime_type_for("x.mpd"), "application/dash+xml");
  EXPECT_EQ(mime_type_for("ladder.json"), "application/json");
  EXPECT_EQ(mime_type_for("blob"), "application/octet-stream");
}

TEST(SafeJoin, RejectsTraversal) {
  EXPECT_EQ(*safe_join("/srv", "/a/b.m4s"), std::filesystem::path("/srv/a/b.m4s"));
  EXPECT_EQ(*safe_join("/srv", "/a//./b"), std::filesystem::path("/srv/a/b"));
  EXPECT_FALSE(safe_join("/srv", "/../etc/passwd"));
  EXPECT_FALSE(safe_join("/srv", "/a/../../x"));
  EXPECT_FALSE(safe_join("/srv", "/a\\..\\x"));
  EXPECT_FALSE(safe_join("/srv", "relative"));
  EXPECT_FALSE(safe_join("/srv", std::string_view("/a\0b", 4)));
}

TEST(QueryParse, DuplicatesKeepFirstAndEmptyValues) {
  auto q = parse_query("a=1&a=2&b&&c=");
  EXPECT_EQ(q.at("a"), "1");
  EXPECT_EQ(q.at("b"), "");
  EXPECT_EQ(q.at("c"), "");
}
