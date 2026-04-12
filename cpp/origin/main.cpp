// avs_origin: serves HLS manifests/segments (and static apps) with optional trace shaping.
#include <csignal>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>

#include "origin/origin.h"

namespace {

void usage() {
  std::fprintf(stderr,
               "usage: avs_origin --root DIR [--port N] [--host ADDR] [--trace-dir DIR]\n"
               "                  [--spa] [--log]\n");
}

}  // namespace

int main(int argc, char** argv) {
  avs::origin::OriginConfig cfg;
  avs::http::ServerOptions opts;
  for (int i = 1; i < argc; ++i) {
    std::string a = argv[i];
    auto next = [&]() -> std::string {
      if (i + 1 >= argc) {
        usage();
        std::exit(2);
      }
      return argv[++i];
    };
    if (a == "--root")
      cfg.root = next();
    else if (a == "--port")
      opts.port = static_cast<std::uint16_t>(std::stoi(next()));
    else if (a == "--host")
      opts.host = next();
    else if (a == "--trace-dir")
      cfg.trace_dir = next();
    else if (a == "--spa")
      cfg.spa_fallback = true;
    else if (a == "--log")
      cfg.access_log = true;
    else {
      usage();
      return 2;
    }
  }
  if (cfg.root.empty()) {
    usage();
    return 2;
  }
  // Block termination signals in all threads; the main thread waits for them.
  sigset_t set;
  sigemptyset(&set);
  sigaddset(&set, SIGINT);
  sigaddset(&set, SIGTERM);
  pthread_sigmask(SIG_BLOCK, &set, nullptr);
  std::signal(SIGPIPE, SIG_IGN);

  avs::origin::Origin origin(cfg);
  avs::http::Server server(opts, [&](const avs::http::Request& r, avs::http::ResponseWriter& w) {
    origin.handle(r, w);
  });
  std::string err;
  if (!server.start(&err)) {
    std::fprintf(stderr, "avs_origin: %s\n", err.c_str());
    return 1;
  }
  std::fprintf(stderr, "avs_origin listening on %s:%u root=%s shaping=%s\n", opts.host.c_str(),
               server.port(), cfg.root.c_str(), cfg.trace_dir.empty() ? "off" : "on");
  int sig = 0;
  sigwait(&set, &sig);
  std::fprintf(stderr, "avs_origin: signal %d, shutting down\n", sig);
  server.stop();
  return 0;
}
