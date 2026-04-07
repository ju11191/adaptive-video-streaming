#include "http/mime.h"

#include <array>
#include <utility>

namespace avs::http {

std::string_view mime_type_for(std::string_view path) {
  static constexpr std::array<std::pair<std::string_view, std::string_view>, 16> kTypes{{
      {".m3u8", "application/vnd.apple.mpegurl"},
      {".mpd", "application/dash+xml"},
      {".m4s", "video/iso.segment"},
      {".mp4", "video/mp4"},
      {".m4v", "video/mp4"},
      {".ts", "video/mp2t"},
      {".json", "application/json"},
      {".html", "text/html; charset=utf-8"},
      {".js", "text/javascript; charset=utf-8"},
      {".mjs", "text/javascript; charset=utf-8"},
      {".css", "text/css; charset=utf-8"},
      {".svg", "image/svg+xml"},
      {".png", "image/png"},
      {".ico", "image/x-icon"},
      {".txt", "text/plain; charset=utf-8"},
      {".map", "application/json"},
  }};
  for (const auto& [ext, type] : kTypes) {
    if (path.size() >= ext.size() && path.substr(path.size() - ext.size()) == ext) return type;
  }
  return "application/octet-stream";
}

}  // namespace avs::http
