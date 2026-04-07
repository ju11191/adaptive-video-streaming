// Parsing of the HTTP Range request header (RFC 9110 §14), single byte range only.
#pragma once

#include <cstdint>
#include <string_view>

namespace avs::http {

struct ByteRange {
  enum class Kind {
    kNone,           // no/ignored Range header -> send full 200
    kSatisfiable,    // send 206 with [first, last]
    kUnsatisfiable,  // send 416
  };
  Kind kind = Kind::kNone;
  std::uint64_t first = 0;
  std::uint64_t last = 0;  // inclusive
  std::uint64_t length() const { return last - first + 1; }
};

// `size` is the full representation length. Syntactically invalid headers and
// multi-range requests are ignored (kNone), which RFC 9110 permits.
ByteRange parse_range(std::string_view header, std::uint64_t size);

}  // namespace avs::http
