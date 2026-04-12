// Tiny blocking HTTP client for integration tests.
#pragma once

#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

#include <chrono>
#include <cstdint>
#include <map>
#include <string>

namespace avs::test {

struct RawResponse {
  int status = 0;
  std::map<std::string, std::string> headers;  // lower-case names
  std::string body;
};

class Conn {
 public:
  explicit Conn(std::uint16_t port) {
    fd_ = ::socket(AF_INET, SOCK_STREAM, 0);
    sockaddr_in a{};
    a.sin_family = AF_INET;
    a.sin_port = htons(port);
    inet_pton(AF_INET, "127.0.0.1", &a.sin_addr);
    ok_ = ::connect(fd_, reinterpret_cast<sockaddr*>(&a), sizeof(a)) == 0;
  }
  ~Conn() { ::close(fd_); }
  bool ok() const { return ok_; }

  void send_raw(const std::string& s) { (void)::send(fd_, s.data(), s.size(), 0); }

  // Reads one response. `head_only` for HEAD requests (no body despite Content-Length).
  bool read_response(RawResponse* out, bool head_only = false) {
    std::size_t end;
    while ((end = buf_.find("\r\n\r\n")) == std::string::npos) {
      if (!fill()) return false;
    }
    std::string head = buf_.substr(0, end);
    buf_.erase(0, end + 4);
    *out = RawResponse{};
    out->status = std::stoi(head.substr(9, 3));
    std::size_t pos = head.find("\r\n");
    while (pos != std::string::npos) {
      std::size_t next = head.find("\r\n", pos + 2);
      std::string line =
          head.substr(pos + 2, next == std::string::npos ? std::string::npos : next - pos - 2);
      auto colon = line.find(':');
      std::string k = line.substr(0, colon);
      for (auto& c : k) c = static_cast<char>(std::tolower(c));
      std::string v = line.substr(colon + 1);
      while (!v.empty() && v.front() == ' ') v.erase(0, 1);
      out->headers[k] = v;
      pos = next;
    }
    std::size_t len = head_only || !out->headers.contains("content-length")
                          ? 0
                          : std::stoul(out->headers["content-length"]);
    while (buf_.size() < len) {
      if (!fill()) return false;
    }
    out->body = buf_.substr(0, len);
    buf_.erase(0, len);
    return true;
  }

  // True if the peer closed the connection (recv returns 0).
  bool peer_closed() {
    char c;
    return ::recv(fd_, &c, 1, 0) == 0;
  }

 private:
  bool fill() {
    char tmp[65536];
    ssize_t n = ::recv(fd_, tmp, sizeof(tmp), 0);
    if (n <= 0) return false;
    buf_.append(tmp, static_cast<std::size_t>(n));
    return true;
  }
  int fd_;
  bool ok_ = false;
  std::string buf_;
};

inline RawResponse get(std::uint16_t port, const std::string& target,
                       const std::string& extra_headers = "", const std::string& method = "GET") {
  Conn c(port);
  c.send_raw(method + " " + target + " HTTP/1.1\r\nHost: t\r\n" + extra_headers +
             "Connection: close\r\n\r\n");
  RawResponse r;
  c.read_response(&r, method == "HEAD");
  return r;
}

}  // namespace avs::test
