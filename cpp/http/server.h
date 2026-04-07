// Minimal thread-per-connection HTTP/1.1 server with keep-alive.
#pragma once

#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <functional>
#include <mutex>
#include <optional>
#include <set>
#include <string>
#include <string_view>
#include <thread>

#include "http/request.h"

namespace avs::http {

std::string_view reason_phrase(int status);

// Writes one response onto a connection. The handler must call either send() once, or
// send_head() followed by write() calls totalling exactly the announced content length.
class ResponseWriter {
 public:
  ResponseWriter(int fd, bool head_only, bool keep_alive)
      : fd_(fd), head_only_(head_only), keep_alive_(keep_alive) {}

  bool send_head(int status, const Headers& headers, std::uint64_t content_length);
  bool write(const char* data, std::size_t n);
  bool send(int status, const Headers& headers, std::string_view body);

  bool head_sent() const { return head_sent_; }
  bool ok() const { return ok_; }
  bool keep_alive() const { return keep_alive_; }
  void close_after() { keep_alive_ = false; }
  int status() const { return status_; }
  std::uint64_t bytes_written() const { return body_written_; }
  bool complete() const { return body_written_ == body_expected_; }

 private:
  bool write_all(const char* data, std::size_t n);

  int fd_;
  bool head_only_;
  bool keep_alive_;
  bool head_sent_ = false;
  bool ok_ = true;
  int status_ = 0;
  std::uint64_t body_expected_ = 0;
  std::uint64_t body_written_ = 0;
};

using Handler = std::function<void(const Request&, ResponseWriter&)>;

struct ServerOptions {
  std::string host = "0.0.0.0";
  std::uint16_t port = 8080;  // 0 = ephemeral
  int max_connections = 512;
  std::size_t max_body_bytes = 1 << 20;
  int idle_timeout_s = 30;
};

class Server {
 public:
  Server(ServerOptions opts, Handler handler);
  ~Server();
  Server(const Server&) = delete;
  Server& operator=(const Server&) = delete;

  // Binds and starts the accept thread. Returns false and fills `err` on failure.
  bool start(std::string* err);
  // Stops accepting, shuts down open connections and waits for their threads.
  void stop();
  std::uint16_t port() const { return port_; }

 private:
  void accept_loop();
  void serve_connection(int fd);

  ServerOptions opts_;
  Handler handler_;
  int listen_fd_ = -1;
  std::uint16_t port_ = 0;
  std::atomic<bool> running_{false};
  std::thread accept_thread_;
  std::mutex mu_;
  std::condition_variable cv_;
  std::set<int> conns_;
};

}  // namespace avs::http
