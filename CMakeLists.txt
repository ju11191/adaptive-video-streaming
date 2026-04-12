cmake_minimum_required(VERSION 3.24)
project(avs LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

option(AVS_BUILD_TESTS "Build unit tests" ON)
option(AVS_SANITIZE "Enable ASan + UBSan" OFF)

if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()
if(CMAKE_BUILD_TYPE STREQUAL "Debug")
  set(AVS_SANITIZE ON)
endif()

add_compile_options(-Wall -Wextra -Werror)
if(AVS_SANITIZE)
  add_compile_options(-fsanitize=address,undefined -fno-omit-frame-pointer -fno-sanitize-recover=all)
  add_link_options(-fsanitize=address,undefined)
endif()

include(FetchContent)
FetchContent_Declare(json
  URL https://github.com/nlohmann/json/releases/download/v3.11.3/json.tar.xz
  URL_HASH SHA256=d6c65aca6b1ed68e7a182f4757257b107ae403032760ed6ef121c9d55e81757d
  DOWNLOAD_EXTRACT_TIMESTAMP TRUE)
FetchContent_MakeAvailable(json)

find_package(Threads REQUIRED)

# --- libraries -------------------------------------------------------------
add_library(avs_http
  cpp/http/request.cpp cpp/http/range.cpp cpp/http/mime.cpp cpp/http/path.cpp
  cpp/http/server.cpp)
target_include_directories(avs_http PUBLIC cpp)
target_link_libraries(avs_http PUBLIC Threads::Threads)

add_library(avs_shaper cpp/shaper/trace.cpp cpp/shaper/shaper.cpp)
target_include_directories(avs_shaper PUBLIC cpp)

add_library(avs_origin_lib cpp/origin/origin.cpp)
target_link_libraries(avs_origin_lib PUBLIC avs_http avs_shaper)

add_executable(avs_origin cpp/origin/main.cpp)
target_link_libraries(avs_origin PRIVATE avs_origin_lib)

# --- tests -----------------------------------------------------------------
if(AVS_BUILD_TESTS)
  FetchContent_Declare(googletest
    URL https://github.com/google/googletest/archive/refs/tags/v1.15.2.tar.gz
    URL_HASH SHA256=7b42b4d6ed48810c5362c265a17faebe90dc2373c885e5216439d37927f02926
    DOWNLOAD_EXTRACT_TIMESTAMP TRUE)
  set(INSTALL_GTEST OFF CACHE BOOL "" FORCE)
  FetchContent_MakeAvailable(googletest)
  enable_testing()
  include(GoogleTest)
  add_executable(avs_tests
    cpp/tests/http_test.cpp cpp/tests/server_test.cpp cpp/tests/shaper_test.cpp)
  target_link_libraries(avs_tests PRIVATE avs_origin_lib GTest::gtest_main)
  gtest_discover_tests(avs_tests DISCOVERY_TIMEOUT 30)
endif()
