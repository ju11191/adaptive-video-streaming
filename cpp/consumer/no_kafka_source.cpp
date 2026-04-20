// Fallback when built without librdkafka.
#include "consumer/source.h"

namespace avs::consumer {

std::unique_ptr<Source> make_kafka_source(const KafkaOptions&, std::string* err) {
  if (err) *err = "built without librdkafka (AVS_WITH_KAFKA=OFF); use --stdin";
  return nullptr;
}

}  // namespace avs::consumer
