#include "http/request.h"

#include <algorithm>
#include <cctype>

namespace avs::http {
namespace {

std::string_view trim(std::string_view s) {
  while (!s.empty() && (s.front() == ' ' || s.front() == '\t')) s.remove_prefix(1);
  while (!s.empty() && (s.back() == ' ' || s.back() == '\t')) s.remove_suffix(1);
  return s;
}

bool is_token_char(char c) {
  // RFC 9110 tchar
  return std::isalnum(static_cast<unsigned char>(c)) ||
         std::string_view("!#$%&'*+-.^_`|~").find(c) != std::string_view::npos;
}

int hex_value(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

}  // namespace

std::string to_lower(std::string_view s) {
  std::string out(s);
  std::transform(out.begin(), out.end(), out.begin(),
                 [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
  return out;
}

std::optional<std::string_view> Request::header(std::string_view name) const {
  for (const auto& [k, v] : headers) {
    if (k == name) return std::string_view(v);
  }
  return std::nullopt;
}

std::map<std::string, std::string> Request::query() const {
  return parse_query(query_string);
}

bool Request::keep_alive() const {
  auto conn = header("connection");
  std::string c = conn ? to_lower(*conn) : "";
  if (version == "HTTP/1.0") return c.find("keep-alive") != std::string::npos;
  return c.find("close") == std::string::npos;
}

std::optional<std::string> percent_decode(std::string_view s, bool plus_as_space) {
  std::string out;
  out.reserve(s.size());
  for (std::size_t i = 0; i < s.size(); ++i) {
    char c = s[i];
    if (c == '%') {
      if (i + 2 >= s.size()) return std::nullopt;
      int hi = hex_value(s[i + 1]);
      int lo = hex_value(s[i + 2]);
      if (hi < 0 || lo < 0) return std::nullopt;
      out.push_back(static_cast<char>(hi * 16 + lo));
      i += 2;
    } else if (c == '+' && plus_as_space) {
      out.push_back(' ');
    } else {
      out.push_back(c);
    }
  }
  return out;
}

std::map<std::string, std::string> parse_query(std::string_view qs) {
  std::map<std::string, std::string> out;
  while (!qs.empty()) {
    std::size_t amp = qs.find('&');
    std::string_view pair = qs.substr(0, amp);
    qs = amp == std::string_view::npos ? std::string_view() : qs.substr(amp + 1);
    if (pair.empty()) continue;
    std::size_t eq = pair.find('=');
    auto key = percent_decode(pair.substr(0, eq), true);
    auto val = eq == std::string_view::npos ? std::optional<std::string>("")
                                            : percent_decode(pair.substr(eq + 1), true);
    if (key && val && !out.contains(*key)) out.emplace(std::move(*key), std::move(*val));
  }
  return out;
}

ParseResult parse_request_head(std::string_view buf, Request& out) {
  ParseResult r;
  std::size_t end = buf.find("\r\n\r\n");
  if (end == std::string_view::npos) {
    if (buf.size() >= kMaxHeadBytes) {
      r.status = ParseStatus::kBad;
      r.error = "header section too large";
    }
    return r;
  }
  if (end + 4 > kMaxHeadBytes) {
    r.status = ParseStatus::kBad;
    r.error = "header section too large";
    return r;
  }
  r.head_len = end + 4;
  std::string_view head = buf.substr(0, end);
  auto bad = [&](std::string msg) {
    r.status = ParseStatus::kBad;
    r.error = std::move(msg);
    return r;
  };

  std::size_t eol = head.find("\r\n");
  std::string_view line = head.substr(0, eol);
  std::string_view rest = eol == std::string_view::npos ? std::string_view() : head.substr(eol + 2);

  // request-line = method SP request-target SP HTTP-version
  std::size_t sp1 = line.find(' ');
  if (sp1 == std::string_view::npos || sp1 == 0) return bad("bad request line");
  std::size_t sp2 = line.find(' ', sp1 + 1);
  if (sp2 == std::string_view::npos || sp2 == sp1 + 1) return bad("bad request line");
  std::string_view method = line.substr(0, sp1);
  std::string_view target = line.substr(sp1 + 1, sp2 - sp1 - 1);
  std::string_view version = line.substr(sp2 + 1);
  if (!std::all_of(method.begin(), method.end(), is_token_char)) return bad("bad method");
  if (version != "HTTP/1.1" && version != "HTTP/1.0") return bad("unsupported version");
  if (target.front() != '/' && target != "*") return bad("unsupported request-target form");
  if (target.find(' ') != std::string_view::npos) return bad("bad request-target");

  out = Request{};
  out.method = std::string(method);
  out.target = std::string(target);
  out.version = std::string(version);
  std::size_t q = target.find('?');
  auto decoded = percent_decode(target.substr(0, q), false);
  if (!decoded) return bad("bad percent-encoding in path");
  if (decoded->find('\0') != std::string::npos) return bad("NUL in path");
  out.path = std::move(*decoded);
  if (q != std::string_view::npos) out.query_string = std::string(target.substr(q + 1));

  while (!rest.empty()) {
    std::size_t e = rest.find("\r\n");
    std::string_view h = rest.substr(0, e);
    rest = e == std::string_view::npos ? std::string_view() : rest.substr(e + 2);
    if (h.empty()) continue;
    if (h.front() == ' ' || h.front() == '\t') return bad("obsolete line folding");
    std::size_t colon = h.find(':');
    if (colon == std::string_view::npos || colon == 0) return bad("bad header line");
    std::string_view name = h.substr(0, colon);
    if (!std::all_of(name.begin(), name.end(), is_token_char)) return bad("bad header name");
    out.headers.emplace_back(to_lower(name), std::string(trim(h.substr(colon + 1))));
  }
  r.status = ParseStatus::kOk;
  return r;
}

}  // namespace avs::http
