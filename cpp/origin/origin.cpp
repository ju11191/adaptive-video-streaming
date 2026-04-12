#include "origin/origin.h"

#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <thread>
#include <vector>

#include "http/mime.h"
#include "http/path.h"
#include "http/range.h"

namespace avs::origin {
namespace {

std::string_view cache_control_for(std::string_view path) {
  if (path.ends_with(".m3u8") || path.ends_with(".mpd") || path.ends_with(".html") ||
      path.ends_with(".json"))
    return "no-cache";
  return "public, max-age=3600";
}

double parse_double(const std::string& s, double fallback) {
  if (s.empty()) return fallback;
  char* end = nullptr;
  double v = std::strtod(s.c_str(), &end);
  if (end != s.c_str() + s.size() || !std::isfinite(v)) return fallback;
  return v;
}

class Fd {
 public:
  explicit Fd(int fd) : fd_(fd) {}
  ~Fd() {
    if (fd_ >= 0) ::close(fd_);
  }
  Fd(const Fd&) = delete;
  Fd& operator=(const Fd&) = delete;
  int get() const { return fd_; }

 private:
  int fd_;
};

}  // namespace

http::Headers cors_headers() {
  return {
      {"Access-Control-Allow-Origin", "*"},
      {"Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges, X-Shaped"}};
}

Origin::Origin(OriginConfig cfg) : cfg_(std::move(cfg)) {
  if (!cfg_.trace_dir.empty()) {
    shaper_ = std::make_unique<shaper::ShaperRegistry>(cfg_.trace_dir, std::chrono::minutes(5));
  }
}

void Origin::handle(const http::Request& req, http::ResponseWriter& w) {
  stats_.requests++;
  http::Headers h = cors_headers();
  if (req.method == "OPTIONS") {
    h.emplace_back("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
    h.emplace_back("Access-Control-Allow-Headers", "Range, Content-Type");
    h.emplace_back("Access-Control-Max-Age", "86400");
    w.send(204, h, "");
    return;
  }
  if (req.method != "GET" && req.method != "HEAD") {
    h.emplace_back("Allow", "GET, HEAD, OPTIONS");
    w.send(405, h, "method not allowed\n");
    return;
  }
  if (req.path == "/healthz") {
    h.emplace_back("Content-Type", "text/plain");
    w.send(200, h, "ok\n");
    return;
  }
  auto file = http::safe_join(cfg_.root, req.path);
  if (!file) {
    h.emplace_back("Content-Type", "text/plain");
    w.send(403, h, "forbidden\n");
    return;
  }
  std::error_code ec;
  if (std::filesystem::is_directory(*file, ec)) *file /= "index.html";
  if (!std::filesystem::is_regular_file(*file, ec) && cfg_.spa_fallback &&
      !std::filesystem::path(req.path).has_extension()) {
    *file = cfg_.root / "index.html";
  }
  serve_file(req, w, *file);
}

void Origin::serve_file(const http::Request& req, http::ResponseWriter& w,
                        const std::filesystem::path& file) {
  http::Headers h = cors_headers();
  Fd fd(::open(file.c_str(), O_RDONLY));
  struct stat st{};
  if (fd.get() < 0 || ::fstat(fd.get(), &st) != 0 || !S_ISREG(st.st_mode)) {
    h.emplace_back("Content-Type", "text/plain");
    w.send(404, h, "not found\n");
    return;
  }
  const auto size = static_cast<std::uint64_t>(st.st_size);
  std::string path_str = file.string();
  h.emplace_back("Content-Type", std::string(http::mime_type_for(path_str)));
  h.emplace_back("Accept-Ranges", "bytes");
  h.emplace_back("Cache-Control", std::string(cache_control_for(path_str)));

  http::ByteRange range;
  if (auto rh = req.header("range")) range = http::parse_range(*rh, size);
  int status = 200;
  std::uint64_t first = 0, length = size;
  if (range.kind == http::ByteRange::Kind::kUnsatisfiable) {
    h.emplace_back("Content-Range", "bytes */" + std::to_string(size));
    w.send(416, h, "");
    return;
  }
  if (range.kind == http::ByteRange::Kind::kSatisfiable) {
    status = 206;
    first = range.first;
    length = range.length();
    h.emplace_back("Content-Range", "bytes " + std::to_string(range.first) + "-" +
                                        std::to_string(range.last) + "/" + std::to_string(size));
  }

  // Optional shaping: ?trace=<name>&sid=<session>[&toffset=<s>][&rtt_ms=<ms>]
  std::optional<shaper::ShaperRegistry::Ticket> ticket;
  if (shaper_ && req.method == "GET") {
    auto q = req.query();
    auto tr = q.find("trace");
    auto sid = q.find("sid");
    if (tr != q.end() && sid != q.end() && !sid->second.empty()) {
      double offset = q.contains("toffset") ? parse_double(q["toffset"], 0) : 0;
      double rtt_s = q.contains("rtt_ms") ? parse_double(q["rtt_ms"], 0) / 1000.0 : 0;
      shaper::ShaperRegistry::Ticket t;
      std::string err;
      if (!shaper_->reserve(sid->second, tr->second, offset, rtt_s, length, &t, &err)) {
        http::Headers eh = cors_headers();
        eh.emplace_back("Content-Type", "text/plain");
        w.send(400, eh, "shaper: " + err + "\n");
        return;
      }
      ticket = t;
      stats_.shaped_requests++;
      h.emplace_back("X-Shaped", "trace=" + tr->second);
    }
  }

  if (cfg_.access_log) {
    std::fprintf(stderr, "%s %s %d %llu%s\n", req.method.c_str(), req.target.c_str(), status,
                 static_cast<unsigned long long>(length), ticket ? " shaped" : "");
  }
  if (!w.send_head(status, h, length) || req.method == "HEAD") return;

  std::vector<char> buf(cfg_.chunk_bytes);
  std::uint64_t sent = 0;
  while (sent < length) {
    std::size_t n = static_cast<std::size_t>(std::min<std::uint64_t>(buf.size(), length - sent));
    ssize_t r = ::pread(fd.get(), buf.data(), n, static_cast<off_t>(first + sent));
    if (r <= 0) {
      w.close_after();
      break;
    }
    if (ticket) std::this_thread::sleep_until(shaper_->deadline(*ticket, sent + r));
    if (!w.write(buf.data(), static_cast<std::size_t>(r))) break;
    sent += static_cast<std::uint64_t>(r);
    stats_.bytes += static_cast<std::uint64_t>(r);
  }
  if (ticket && sent < length) shaper_->release(*ticket);
}

}  // namespace avs::origin
