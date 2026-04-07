#include "http/path.h"

namespace avs::http {

std::optional<std::filesystem::path> safe_join(const std::filesystem::path& root,
                                               std::string_view url_path) {
  if (url_path.empty() || url_path.front() != '/') return std::nullopt;
  if (url_path.find('\0') != std::string_view::npos) return std::nullopt;
  if (url_path.find('\\') != std::string_view::npos) return std::nullopt;
  std::filesystem::path out = root;
  std::string_view rest = url_path.substr(1);
  while (!rest.empty()) {
    std::size_t slash = rest.find('/');
    std::string_view seg = rest.substr(0, slash);
    rest = slash == std::string_view::npos ? std::string_view() : rest.substr(slash + 1);
    if (seg.empty() || seg == ".") continue;
    if (seg == "..") return std::nullopt;
    out /= std::string(seg);
  }
  return out;
}

}  // namespace avs::http
