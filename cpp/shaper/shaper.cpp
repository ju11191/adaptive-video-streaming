#include "shaper/shaper.h"

#include <algorithm>
#include <cctype>
#include <cmath>

namespace avs::shaper {

LinkModel::Reservation LinkModel::reserve(double now, std::uint64_t bytes) {
  Reservation r;
  r.bytes = bytes;
  r.start = std::max(now + rtt_s_, free_at_);
  r.end = trace_->finish_time(r.start, static_cast<double>(bytes));
  free_at_ = r.end;
  return r;
}

double LinkModel::deadline(const Reservation& r, std::uint64_t sent) const {
  return trace_->finish_time(r.start, static_cast<double>(std::min(sent, r.bytes)));
}

void LinkModel::release(const Reservation& r, double now) {
  // Only the most recent reservation can be shortened without reordering others.
  if (free_at_ == r.end) free_at_ = std::max(now, r.start);
}

bool ShaperRegistry::valid_trace_name(const std::string& name) {
  if (name.empty() || name.size() > 200 || name.front() == '.') return false;
  for (char c : name) {
    if (!(std::isalnum(static_cast<unsigned char>(c)) || c == '_' || c == '-' || c == '.' ||
          c == '/'))
      return false;
  }
  return name.find("..") == std::string::npos && name.find("//") == std::string::npos;
}

std::shared_ptr<const Trace> ShaperRegistry::get_trace(const std::string& name, std::string* err) {
  if (!valid_trace_name(name)) {
    if (err) *err = "invalid trace name";
    return nullptr;
  }
  auto it = traces_.find(name);
  if (it != traces_.end()) return it->second;
  std::filesystem::path p = trace_dir_ / name;
  if (p.extension() != ".txt") p += ".txt";
  auto tr = Trace::load(p, err);
  if (!tr) return nullptr;
  auto ptr = std::make_shared<const Trace>(std::move(*tr));
  traces_.emplace(name, ptr);
  return ptr;
}

double ShaperRegistry::trace_now(const Session& s, Clock::time_point now) const {
  return s.offset_s + std::chrono::duration<double>(now - s.epoch).count();
}

void ShaperRegistry::evict_idle(Clock::time_point now) {
  for (auto it = sessions_.begin(); it != sessions_.end();) {
    if (now - it->second.last_used > idle_ttl_)
      it = sessions_.erase(it);
    else
      ++it;
  }
}

bool ShaperRegistry::reserve(const std::string& sid, const std::string& trace_name, double offset_s,
                             double rtt_s, std::uint64_t bytes, Ticket* out, std::string* err) {
  std::lock_guard lock(mu_);
  auto now = Clock::now();
  evict_idle(now);
  auto trace = get_trace(trace_name, err);
  if (!trace) return false;
  std::string key = sid + "\n" + trace_name;
  auto it = sessions_.find(key);
  if (it == sessions_.end()) {
    Session s;
    s.link = std::make_unique<LinkModel>(trace, rtt_s);
    s.epoch = now;
    s.offset_s = std::max(0.0, offset_s);
    it = sessions_.emplace(key, std::move(s)).first;
  }
  Session& s = it->second;
  s.last_used = now;
  out->res = s.link->reserve(trace_now(s, now), bytes);
  out->epoch = s.epoch;
  out->offset_s = s.offset_s;
  out->key = key;
  return true;
}

ShaperRegistry::Clock::time_point ShaperRegistry::deadline(const Ticket& t, std::uint64_t sent) {
  std::lock_guard lock(mu_);
  auto it = sessions_.find(t.key);
  if (it == sessions_.end()) return Clock::now();  // evicted: stop shaping
  it->second.last_used = Clock::now();
  double tt = it->second.link->deadline(t.res, sent);
  if (!std::isfinite(tt)) tt = t.offset_s + 1e6;
  auto rel = std::chrono::duration<double>(tt - t.offset_s);
  return t.epoch + std::chrono::duration_cast<Clock::duration>(rel);
}

void ShaperRegistry::release(const Ticket& t) {
  std::lock_guard lock(mu_);
  auto it = sessions_.find(t.key);
  if (it == sessions_.end()) return;
  it->second.link->release(t.res, trace_now(it->second, Clock::now()));
}

std::size_t ShaperRegistry::session_count() {
  std::lock_guard lock(mu_);
  return sessions_.size();
}

}  // namespace avs::shaper
