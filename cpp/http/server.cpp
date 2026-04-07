#include "http/server.h"

#include <arpa/inet.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <unistd.h>

#include <cerrno>
#include <charconv>
#include <cstring>

namespace avs::http {
namespace {

#ifdef MSG_NOSIGNAL
constexpr int kSendFlags = MSG_NOSIGNAL;
#else
constexpr int kSendFlags = 0;
#endif

void set_socket_options(int fd, int idle_timeout_s) {
  int one = 1;
#ifdef SO_NOSIGPIPE
  setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, sizeof(one));
#endif
  setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof(one));
  timeval tv{};
  tv.tv_sec = idle_timeout_s;
  setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
}

void send_simple(int fd, int status, bool head_only = false) {
  ResponseWriter w(fd, head_only, false);
  std::string body = std::string(reason_phrase(status)) + "\n";
  w.send(status, {{"Content-Type", "text/plain; charset=utf-8"}}, body);
}

}  // namespace

std::string_view reason_phrase(int status) {
  switch (status) {
    case 200:
      return "OK";
    case 202:
      return "Accepted";
    case 204:
      return "No Content";
    case 206:
      return "Partial Content";
    case 304:
      return "Not Modified";
    case 400:
      return "Bad Request";
    case 403:
      return "Forbidden";
    case 404:
      return "Not Found";
    case 405:
      return "Method Not Allowed";
    case 411:
      return "Length Required";
    case 413:
      return "Content Too Large";
    case 416:
      return "Range Not Satisfiable";
    case 431:
      return "Request Header Fields Too Large";
    case 500:
      return "Internal Server Error";
    case 501:
      return "Not Implemented";
    case 503:
      return "Service Unavailable";
    default:
      return "Unknown";
  }
}

bool ResponseWriter::write_all(const char* data, std::size_t n) {
  while (n > 0 && ok_) {
    ssize_t k = ::send(fd_, data, n, kSendFlags);
    if (k < 0) {
      if (errno == EINTR) continue;
      ok_ = false;
      break;
    }
    data += k;
    n -= static_cast<std::size_t>(k);
  }
  return ok_;
}

bool ResponseWriter::send_head(int status, const Headers& headers, std::uint64_t content_length) {
  if (head_sent_) return false;
  head_sent_ = true;
  status_ = status;
  body_expected_ = head_only_ ? 0 : content_length;
  std::string head =
      "HTTP/1.1 " + std::to_string(status) + " " + std::string(reason_phrase(status)) + "\r\n";
  for (const auto& [k, v] : headers) head += k + ": " + v + "\r\n";
  head += "Content-Length: " + std::to_string(content_length) + "\r\n";
  head += keep_alive_ ? "Connection: keep-alive\r\n" : "Connection: close\r\n";
  head += "\r\n";
  return write_all(head.data(), head.size());
}

bool ResponseWriter::write(const char* data, std::size_t n) {
  if (!head_sent_ || head_only_) return ok_;
  if (body_written_ + n > body_expected_) {
    ok_ = false;  // handler bug: would corrupt framing
    return false;
  }
  body_written_ += n;
  return write_all(data, n);
}

bool ResponseWriter::send(int status, const Headers& headers, std::string_view body) {
  if (!send_head(status, headers, body.size())) return false;
  return write(body.data(), body.size());
}

Server::Server(ServerOptions opts, Handler handler)
    : opts_(std::move(opts)), handler_(std::move(handler)) {}

Server::~Server() {
  stop();
}

bool Server::start(std::string* err) {
  listen_fd_ = ::socket(AF_INET, SOCK_STREAM, 0);
  if (listen_fd_ < 0) {
    if (err) *err = std::string("socket: ") + std::strerror(errno);
    return false;
  }
  int one = 1;
  setsockopt(listen_fd_, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
  sockaddr_in addr{};
  addr.sin_family = AF_INET;
  addr.sin_port = htons(opts_.port);
  if (inet_pton(AF_INET, opts_.host.c_str(), &addr.sin_addr) != 1) {
    if (err) *err = "bad host address: " + opts_.host;
    ::close(listen_fd_);
    listen_fd_ = -1;
    return false;
  }
  if (::bind(listen_fd_, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) < 0 ||
      ::listen(listen_fd_, 256) < 0) {
    if (err) *err = std::string("bind/listen: ") + std::strerror(errno);
    ::close(listen_fd_);
    listen_fd_ = -1;
    return false;
  }
  socklen_t len = sizeof(addr);
  getsockname(listen_fd_, reinterpret_cast<sockaddr*>(&addr), &len);
  port_ = ntohs(addr.sin_port);
  running_ = true;
  accept_thread_ = std::thread([this] { accept_loop(); });
  return true;
}

void Server::stop() {
  if (!running_.exchange(false)) return;
  ::shutdown(listen_fd_, SHUT_RDWR);
  ::close(listen_fd_);
  if (accept_thread_.joinable()) accept_thread_.join();
  std::unique_lock lock(mu_);
  for (int fd : conns_) ::shutdown(fd, SHUT_RDWR);
  cv_.wait(lock, [this] { return conns_.empty(); });
}

void Server::accept_loop() {
  while (running_) {
    int fd = ::accept(listen_fd_, nullptr, nullptr);
    if (fd < 0) {
      if (!running_) break;
      if (errno == EINTR || errno == ECONNABORTED || errno == EMFILE || errno == ENFILE) {
        if (errno == EMFILE || errno == ENFILE)
          std::this_thread::sleep_for(std::chrono::milliseconds(10));
        continue;
      }
      break;
    }
    set_socket_options(fd, opts_.idle_timeout_s);
    {
      std::lock_guard lock(mu_);
      if (static_cast<int>(conns_.size()) >= opts_.max_connections || !running_) {
        send_simple(fd, 503);
        ::close(fd);
        continue;
      }
      conns_.insert(fd);
    }
    std::thread([this, fd] {
      serve_connection(fd);
      ::close(fd);
      std::lock_guard lock(mu_);
      conns_.erase(fd);
      cv_.notify_all();
    }).detach();
  }
}

void Server::serve_connection(int fd) {
  std::string buf;
  char tmp[16 * 1024];
  while (running_) {
    // Read until a full head is buffered.
    Request req;
    ParseResult pr = parse_request_head(buf, req);
    while (pr.status == ParseStatus::kIncomplete) {
      ssize_t n = ::recv(fd, tmp, sizeof(tmp), 0);
      if (n < 0 && errno == EINTR) continue;
      if (n <= 0) return;  // closed, timed out, or shut down
      buf.append(tmp, static_cast<std::size_t>(n));
      pr = parse_request_head(buf, req);
    }
    if (pr.status == ParseStatus::kBad) {
      send_simple(fd, buf.size() >= kMaxHeadBytes ? 431 : 400);
      return;
    }
    buf.erase(0, pr.head_len);

    if (req.header("transfer-encoding")) {
      send_simple(fd, 501);
      return;
    }
    std::size_t body_len = 0;
    if (auto cl = req.header("content-length")) {
      auto [p, ec] = std::from_chars(cl->data(), cl->data() + cl->size(), body_len);
      if (ec != std::errc() || p != cl->data() + cl->size()) {
        send_simple(fd, 400);
        return;
      }
      if (body_len > opts_.max_body_bytes) {
        send_simple(fd, 413);
        return;
      }
    }
    while (buf.size() < body_len) {
      ssize_t n = ::recv(fd, tmp, sizeof(tmp), 0);
      if (n < 0 && errno == EINTR) continue;
      if (n <= 0) return;
      buf.append(tmp, static_cast<std::size_t>(n));
    }
    req.body = buf.substr(0, body_len);
    buf.erase(0, body_len);

    ResponseWriter w(fd, req.method == "HEAD", req.keep_alive());
    try {
      handler_(req, w);
    } catch (const std::exception&) {
      if (!w.head_sent()) w.send(500, {{"Content-Type", "text/plain"}}, "internal error\n");
      w.close_after();
    }
    if (!w.head_sent()) {
      w.send(500, {{"Content-Type", "text/plain"}}, "handler sent no response\n");
    }
    // A body shorter than the announced Content-Length would desync framing: close.
    if (!w.ok() || !w.keep_alive() || !w.complete()) return;
  }
}

}  // namespace avs::http
