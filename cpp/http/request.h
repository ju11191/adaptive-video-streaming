// HTTP/1.1 request model and head parser.
#pragma once

#include <cstddef>
#include <map>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace avs::http {

using Headers = std::vector<std::pair<std::string, std::string>>;

struct Request {
  std::string method;
  std::string target;        // raw request-target, e.g. "/a/b.m4s?x=1"
  std::string path;          // percent-decoded path component
  std::string query_string;  // raw query (without '?')
  std::string version;       // "HTTP/1.1"
  Headers headers;           // names lower-cased, values trimmed
  std::string body;

  // First header value with this (lower-case) name.
  std::optional<std::string_view> header(std::string_view name) const;
  std::map<std::string, std::string> query() const;
  // HTTP/1.1 defaults to keep-alive unless "Connection: close"; 1.0 the reverse.
  bool keep_alive() const;
};

enum class ParseStatus { kOk, kIncomplete, kBad };

struct ParseResult {
  ParseStatus status = ParseStatus::kIncomplete;
  std::size_t head_len = 0;  // bytes consumed by request line + headers + CRLFCRLF
  std::string error;
};

inline constexpr std::size_t kMaxHeadBytes = 16 * 1024;

// Parses the request line and headers at the start of `buf`.
// kIncomplete: need more bytes. kBad: malformed or head larger than kMaxHeadBytes.
ParseResult parse_request_head(std::string_view buf, Request& out);

// Decodes %XX escapes; with plus_as_space also '+' -> ' '. nullopt on bad escape.
std::optional<std::string> percent_decode(std::string_view s, bool plus_as_space);

std::map<std::string, std::string> parse_query(std::string_view qs);

std::string to_lower(std::string_view s);

}  // namespace avs::http
