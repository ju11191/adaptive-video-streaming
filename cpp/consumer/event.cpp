#include "consumer/event.h"

#include <cmath>
#include <nlohmann/json.hpp>

namespace avs::consumer {
namespace {

using nlohmann::json;

bool valid_id(const std::string& s) {
  if (s.empty() || s.size() > 128) return false;
  for (char c : s) {
    if (!(std::isalnum(static_cast<unsigned char>(c)) || c == '.' || c == '_' || c == ':' ||
          c == '-'))
      return false;
  }
  return true;
}

bool get_num(const json& j, const char* key, double* out, double min = 0) {
  auto it = j.find(key);
  if (it == j.end() || !it->is_number()) return false;
  double v = it->get<double>();
  if (!std::isfinite(v) || v < min) return false;
  *out = v;
  return true;
}

}  // namespace

std::string_view to_string(EventType t) {
  switch (t) {
    case EventType::kSessionStart:
      return "session_start";
    case EventType::kStartup:
      return "startup";
    case EventType::kBitrateSwitch:
      return "bitrate_switch";
    case EventType::kRebufferStart:
      return "rebuffer_start";
    case EventType::kRebufferEnd:
      return "rebuffer_end";
    case EventType::kError:
      return "error";
    case EventType::kSessionEnd:
      return "session_end";
  }
  return "?";
}

std::optional<Event> parse_event(std::string_view text, std::string* err) {
  auto fail = [&](const char* why) -> std::optional<Event> {
    if (err) *err = why;
    return std::nullopt;
  };
  json j = json::parse(text, nullptr, /*allow_exceptions=*/false);
  if (j.is_discarded() || !j.is_object()) return fail("not a JSON object");
  if (!j.contains("v") || !j["v"].is_number_integer() || j["v"].get<int>() != 1)
    return fail("unsupported version");
  Event e;
  for (auto [key, dst] :
       {std::pair<const char*, std::string*>{"sid", &e.sid}, {"exp", &e.exp}, {"arm", &e.arm}}) {
    auto it = j.find(key);
    if (it == j.end() || !it->is_string()) return fail("missing id field");
    *dst = it->get<std::string>();
    if (!valid_id(*dst)) return fail("bad id field");
  }
  double ts, seq;
  if (!get_num(j, "ts", &ts, 1) || !get_num(j, "seq", &seq)) return fail("bad ts/seq");
  e.ts = static_cast<std::int64_t>(ts);
  e.seq = static_cast<std::int64_t>(seq);
  auto t = j.find("type");
  if (t == j.end() || !t->is_string()) return fail("missing type");
  const std::string type = t->get<std::string>();
  double a = 0, b = 0, c = 0, d = 0, f = 0;
  if (type == "session_start") {
    e.type = EventType::kSessionStart;
    if (auto abr = j.find("abr"); abr != j.end() && abr->is_string())
      e.abr = abr->get<std::string>();
    else
      return fail("bad abr");
  } else if (type == "startup") {
    e.type = EventType::kStartup;
    if (!get_num(j, "startupMs", &e.startup_ms)) return fail("bad startupMs");
  } else if (type == "bitrate_switch") {
    e.type = EventType::kBitrateSwitch;
    if (!get_num(j, "fromKbps", &e.from_kbps) || !get_num(j, "toKbps", &e.to_kbps))
      return fail("bad switch");
  } else if (type == "rebuffer_start") {
    e.type = EventType::kRebufferStart;
  } else if (type == "rebuffer_end") {
    e.type = EventType::kRebufferEnd;
    if (!get_num(j, "durationMs", &e.duration_ms)) return fail("bad durationMs");
  } else if (type == "error") {
    e.type = EventType::kError;
    if (auto code = j.find("code"); code != j.end() && code->is_string())
      e.code = code->get<std::string>();
    else
      return fail("bad code");
  } else if (type == "session_end") {
    e.type = EventType::kSessionEnd;
    if (!get_num(j, "playMs", &a) || !get_num(j, "rebufferMs", &b) ||
        !get_num(j, "rebufferCount", &c) || !get_num(j, "avgKbps", &d) ||
        !get_num(j, "switches", &f))
      return fail("bad session_end");
    e.play_ms = a;
    e.rebuffer_ms = b;
    e.rebuffer_count = static_cast<std::int64_t>(c);
    e.avg_kbps = d;
    e.switches = static_cast<std::int64_t>(f);
  } else {
    return fail("unknown type");
  }
  return e;
}

}  // namespace avs::consumer
