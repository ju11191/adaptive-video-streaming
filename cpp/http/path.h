#pragma once

#include <filesystem>
#include <optional>
#include <string_view>

namespace avs::http {

// Maps a decoded URL path onto a file under `root`. Returns nullopt for any path that
// could escape the root (".." segments, backslashes, NUL). Does not touch the filesystem.
std::optional<std::filesystem::path> safe_join(const std::filesystem::path& root,
                                               std::string_view url_path);

}  // namespace avs::http
