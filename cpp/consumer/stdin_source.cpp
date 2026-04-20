#include <iostream>

#include "consumer/source.h"

namespace avs::consumer {
namespace {

class StdinSource : public Source {
 public:
  Status poll(std::string* msg, int /*timeout_ms*/) override {
    while (std::getline(std::cin, *msg)) {
      if (!msg->empty()) return Status::kMessage;
    }
    return Status::kEnd;
  }
};

}  // namespace

std::unique_ptr<Source> make_stdin_source() {
  return std::make_unique<StdinSource>();
}

}  // namespace avs::consumer
