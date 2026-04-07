#pragma once

#include <string_view>

namespace avs::http {

// Content-Type for a file path based on its extension; application/octet-stream if unknown.
std::string_view mime_type_for(std::string_view path);

}  // namespace avs::http
