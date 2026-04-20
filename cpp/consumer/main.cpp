// avs_consumer: Kafka (or stdin) telemetry -> per-arm aggregation + mSPRT -> JSON API.
//
//   avs_consumer --brokers kafka:9092 [--topic telemetry] [--group avs-consumer] [--port 8082]
//   avs_consumer --stdin [--exit-on-eof]          (JSON lines; prints final state at EOF)
// Test options: --control A --treatment B --cap-ms 10000 --tau-ms 250 --burn-in 200
//               --alpha 0.05 --window-ms 10000 --lateness-ms 2000
#include <unistd.h>

#include <atomic>
#include <chrono>
#include <csignal>
#include <cstdio>
#include <iostream>
#include <mutex>
#include <string>
#include <thread>

#include "consumer/aggregator.h"
#include "consumer/source.h"
#include "http/server.h"

namespace {

std::int64_t now_ms() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(
             std::chrono::system_clock::now().time_since_epoch())
      .count();
}

avs::http::Headers json_headers() {
  return {{"Content-Type", "application/json"},
          {"Access-Control-Allow-Origin", "*"},
          {"Cache-Control", "no-store"}};
}

}  // namespace

int main(int argc, char** argv) {
  using namespace avs;
  consumer::AggregatorConfig cfg;
  consumer::KafkaOptions kopts;
  http::ServerOptions sopts;
  sopts.port = 8082;
  bool use_stdin = false, exit_on_eof = false;
  for (int i = 1; i < argc; ++i) {
    std::string a = argv[i];
    auto next = [&]() -> std::string {
      if (i + 1 >= argc) {
        std::fprintf(stderr, "missing value for %s\n", a.c_str());
        std::exit(2);
      }
      return argv[++i];
    };
    if (a == "--stdin")
      use_stdin = true;
    else if (a == "--exit-on-eof")
      exit_on_eof = true;
    else if (a == "--brokers")
      kopts.brokers = next();
    else if (a == "--topic")
      kopts.topic = next();
    else if (a == "--group")
      kopts.group = next();
    else if (a == "--offset-reset")
      kopts.offset_reset = next();
    else if (a == "--port")
      sopts.port = static_cast<std::uint16_t>(std::stoi(next()));
    else if (a == "--host")
      sopts.host = next();
    else if (a == "--control")
      cfg.control_arm = next();
    else if (a == "--treatment")
      cfg.treatment_arm = next();
    else if (a == "--cap-ms")
      cfg.startup_cap_ms = std::stod(next());
    else if (a == "--tau-ms")
      cfg.startup_test.tau = std::stod(next());
    else if (a == "--alpha")
      cfg.startup_test.alpha = cfg.rebuffer_test.alpha = std::stod(next());
    else if (a == "--burn-in")
      cfg.startup_test.min_n_per_arm = cfg.rebuffer_test.min_n_per_arm = std::stoll(next());
    else if (a == "--window-ms")
      cfg.window_ms = std::stoll(next());
    else if (a == "--lateness-ms")
      cfg.lateness_ms = std::stoll(next());
    else {
      std::fprintf(stderr, "unknown argument %s\n", a.c_str());
      return 2;
    }
  }

  std::string err;
  std::unique_ptr<consumer::Source> source =
      use_stdin ? consumer::make_stdin_source() : consumer::make_kafka_source(kopts, &err);
  if (!source) {
    std::fprintf(stderr, "avs_consumer: %s\n", err.c_str());
    return 1;
  }

  sigset_t set;
  sigemptyset(&set);
  sigaddset(&set, SIGINT);
  sigaddset(&set, SIGTERM);
  pthread_sigmask(SIG_BLOCK, &set, nullptr);
  std::signal(SIGPIPE, SIG_IGN);

  std::mutex mu;
  consumer::Aggregator agg(cfg, now_ms());
  std::atomic<std::int64_t> invalid{0};
  std::atomic<bool> running{true};

  http::Server server(sopts, [&](const http::Request& req, http::ResponseWriter& w) {
    if (req.method == "OPTIONS") {
      w.send(204,
             {{"Access-Control-Allow-Origin", "*"},
              {"Access-Control-Allow-Methods", "GET, POST, OPTIONS"},
              {"Access-Control-Allow-Headers", "Content-Type"}},
             "");
    } else if (req.path == "/api/state" && req.method == "GET") {
      nlohmann::json j;
      {
        std::lock_guard lock(mu);
        j = agg.state_json(now_ms());
      }
      j["counters"]["invalid"] = invalid.load();
      w.send(200, json_headers(), j.dump());
    } else if (req.path == "/api/reset" && req.method == "POST") {
      std::int64_t t = now_ms();
      {
        std::lock_guard lock(mu);
        agg.reset(t);
      }
      w.send(200, json_headers(), nlohmann::json{{"epoch_started_ms", t}}.dump());
    } else if (req.path == "/healthz") {
      w.send(200, {{"Content-Type", "text/plain"}}, "ok\n");
    } else {
      w.send(404, json_headers(), R"({"error":"not found"})");
    }
  });
  if (!server.start(&err)) {
    std::fprintf(stderr, "avs_consumer: %s\n", err.c_str());
    return 1;
  }
  std::fprintf(stderr, "avs_consumer: API on %s:%u, source=%s\n", sopts.host.c_str(), server.port(),
               use_stdin ? "stdin" : kopts.brokers.c_str());

  std::thread ingest([&] {
    std::string msg, perr;
    while (running) {
      auto st = source->poll(&msg, 200);
      if (st == consumer::Source::Status::kEnd) break;
      if (st != consumer::Source::Status::kMessage) continue;
      auto ev = consumer::parse_event(msg, &perr);
      if (!ev) {
        invalid++;
        continue;
      }
      std::lock_guard lock(mu);
      agg.ingest(*ev, now_ms());
    }
    if (exit_on_eof) {
      {
        std::lock_guard lock(mu);
        nlohmann::json j = agg.state_json(now_ms());
        j["counters"]["invalid"] = invalid.load();
        std::cout << j.dump(1) << std::endl;
      }
      kill(getpid(), SIGTERM);
    }
  });

  int sig = 0;
  sigwait(&set, &sig);
  running = false;
  ingest.join();
  server.stop();
  return 0;
}
