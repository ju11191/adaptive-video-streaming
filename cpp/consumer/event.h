// Telemetry event as produced by packages/abr/src/telemetry/events.ts.
#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <string_view>

namespace avs::consumer {

enum class EventType {
  kSessionStart,
  kStartup,
  kBitrateSwitch,
  kRebufferStart,
  kRebufferEnd,
  kError,
  kSessionEnd,
};

struct Event {
  EventType type{};
  std::string sid, exp, arm;
  std::int64_t ts = 0;   // ms since epoch
  std::int64_t seq = 0;  // per-session sequence number
  // type-specific payload (unused fields stay 0)
  double startup_ms = 0;
  double from_kbps = 0, to_kbps = 0;
  double duration_ms = 0;
  double play_ms = 0, rebuffer_ms = 0, avg_kbps = 0;
  std::int64_t rebuffer_count = 0, switches = 0;
  std::string abr, code;
};

// Parses and validates one JSON event. Returns nullopt and sets `err` if invalid.
std::optional<Event> parse_event(std::string_view json, std::string* err);

std::string_view to_string(EventType t);

}  // namespace avs::consumer
