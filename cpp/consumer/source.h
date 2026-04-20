// Message sources for the consumer: JSON lines on stdin, or a Kafka topic.
#pragma once

#include <memory>
#include <string>

namespace avs::consumer {

class Source {
 public:
  virtual ~Source() = default;
  enum class Status { kMessage, kTimeout, kEnd };
  // Waits up to timeout_ms for one message.
  virtual Status poll(std::string* msg, int timeout_ms) = 0;
};

std::unique_ptr<Source> make_stdin_source();

struct KafkaOptions {
  std::string brokers = "localhost:9092";
  std::string topic = "telemetry";
  std::string group = "avs-consumer";
  std::string offset_reset = "latest";
};
// Returns nullptr (with err) if built without librdkafka or on configuration failure.
std::unique_ptr<Source> make_kafka_source(const KafkaOptions& opts, std::string* err);

}  // namespace avs::consumer
