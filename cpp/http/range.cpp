#include "http/range.h"

#include <charconv>
#include <optional>

namespace avs::http {
namespace {

std::optional<std::uint64_t> parse_u64(std::string_view s) {
  if (s.empty()) return std::nullopt;
  std::uint64_t v = 0;
  auto [p, ec] = std::from_chars(s.data(), s.data() + s.size(), v);
  if (ec != std::errc() || p != s.data() + s.size()) return std::nullopt;
  return v;
}

std::string_view trim(std::string_view s) {
  while (!s.empty() && s.front() == ' ') s.remove_prefix(1);
  while (!s.empty() && s.back() == ' ') s.remove_suffix(1);
  return s;
}

}  // namespace

ByteRange parse_range(std::string_view header, std::uint64_t size) {
  ByteRange none;
  header = trim(header);
  constexpr std::string_view kUnit = "bytes=";
  if (!header.starts_with(kUnit)) return none;
  std::string_view spec = trim(header.substr(kUnit.size()));
  if (spec.find(',') != std::string_view::npos) return none;  // multi-range: ignore
  std::size_t dash = spec.find('-');
  if (dash == std::string_view::npos) return none;
  std::string_view a = trim(spec.substr(0, dash));
  std::string_view b = trim(spec.substr(dash + 1));

  ByteRange r;
  if (a.empty()) {
    // suffix range: last N bytes
    auto n = parse_u64(b);
    if (!n) return none;
    if (*n == 0 || size == 0) {
      r.kind = ByteRange::Kind::kUnsatisfiable;
      return r;
    }
    std::uint64_t len = *n > size ? size : *n;
    r.kind = ByteRange::Kind::kSatisfiable;
    r.first = size - len;
    r.last = size - 1;
    return r;
  }
  auto first = parse_u64(a);
  if (!first) return none;
  std::uint64_t last = 0;
  if (b.empty()) {
    last = size == 0 ? 0 : size - 1;
  } else {
    auto l = parse_u64(b);
    if (!l || *l < *first) return none;  // invalid syntax -> ignore
    last = *l >= size ? (size == 0 ? 0 : size - 1) : *l;
  }
  if (*first >= size) {
    r.kind = ByteRange::Kind::kUnsatisfiable;
    return r;
  }
  r.kind = ByteRange::Kind::kSatisfiable;
  r.first = *first;
  r.last = last;
  return r;
}

}  // namespace avs::http
