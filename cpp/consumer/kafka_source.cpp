// Kafka source using the librdkafka C API (high-level balanced consumer).
#include <librdkafka/rdkafka.h>

#include <cstdio>

#include "consumer/source.h"

namespace avs::consumer {
namespace {

class KafkaSource : public Source {
 public:
  explicit KafkaSource(rd_kafka_t* rk) : rk_(rk) {}
  ~KafkaSource() override {
    rd_kafka_consumer_close(rk_);
    rd_kafka_destroy(rk_);
  }

  Status poll(std::string* msg, int timeout_ms) override {
    rd_kafka_message_t* m = rd_kafka_consumer_poll(rk_, timeout_ms);
    if (!m) return Status::kTimeout;
    Status st = Status::kTimeout;
    if (m->err == RD_KAFKA_RESP_ERR_NO_ERROR) {
      msg->assign(static_cast<const char*>(m->payload), m->len);
      st = Status::kMessage;
    } else if (m->err != RD_KAFKA_RESP_ERR__PARTITION_EOF) {
      std::fprintf(stderr, "kafka: %s\n", rd_kafka_message_errstr(m));
    }
    rd_kafka_message_destroy(m);
    return st;
  }

 private:
  rd_kafka_t* rk_;
};

bool set(rd_kafka_conf_t* conf, const char* k, const std::string& v, std::string* err) {
  char buf[512];
  if (rd_kafka_conf_set(conf, k, v.c_str(), buf, sizeof buf) != RD_KAFKA_CONF_OK) {
    if (err) *err = buf;
    return false;
  }
  return true;
}

}  // namespace

std::unique_ptr<Source> make_kafka_source(const KafkaOptions& o, std::string* err) {
  rd_kafka_conf_t* conf = rd_kafka_conf_new();
  if (!set(conf, "bootstrap.servers", o.brokers, err) || !set(conf, "group.id", o.group, err) ||
      !set(conf, "auto.offset.reset", o.offset_reset, err) ||
      !set(conf, "enable.auto.commit", "true", err) ||
      !set(conf, "enable.partition.eof", "false", err)) {
    rd_kafka_conf_destroy(conf);
    return nullptr;
  }
  char buf[512];
  rd_kafka_t* rk = rd_kafka_new(RD_KAFKA_CONSUMER, conf, buf, sizeof buf);
  if (!rk) {
    if (err) *err = buf;
    return nullptr;
  }
  rd_kafka_poll_set_consumer(rk);
  rd_kafka_topic_partition_list_t* topics = rd_kafka_topic_partition_list_new(1);
  rd_kafka_topic_partition_list_add(topics, o.topic.c_str(), RD_KAFKA_PARTITION_UA);
  rd_kafka_resp_err_t e = rd_kafka_subscribe(rk, topics);
  rd_kafka_topic_partition_list_destroy(topics);
  if (e) {
    if (err) *err = rd_kafka_err2str(e);
    rd_kafka_destroy(rk);
    return nullptr;
  }
  return std::make_unique<KafkaSource>(rk);
}

}  // namespace avs::consumer
