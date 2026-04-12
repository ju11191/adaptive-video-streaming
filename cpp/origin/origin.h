// Origin request handler: static files with Range/CORS, optionally paced by a trace.
#pragma once

#include <atomic>
#include <cstdint>
#include <filesystem>
#include <memory>

#include "http/server.h"
#include "shaper/shaper.h"

namespace avs::origin {

struct OriginConfig {
  std::filesystem::path root;
  std::filesystem::path trace_dir;  // empty disables shaping
  bool spa_fallback = false;        // serve /index.html for unknown extension-less paths
  bool access_log = false;
  std::size_t chunk_bytes = 16 * 1024;
};

struct OriginStats {
  std::atomic<std::uint64_t> requests{0};
  std::atomic<std::uint64_t> bytes{0};
  std::atomic<std::uint64_t> shaped_requests{0};
};

class Origin {
 public:
  explicit Origin(OriginConfig cfg);
  void handle(const http::Request& req, http::ResponseWriter& w);
  const OriginStats& stats() const { return stats_; }
  shaper::ShaperRegistry* shaper() { return shaper_.get(); }

 private:
  void serve_file(const http::Request& req, http::ResponseWriter& w,
                  const std::filesystem::path& file);

  OriginConfig cfg_;
  std::unique_ptr<shaper::ShaperRegistry> shaper_;
  OriginStats stats_;
};

// CORS headers attached to every response.
http::Headers cors_headers();

}  // namespace avs::origin
