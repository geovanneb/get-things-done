# gtd-whisper: Whisper on the GPU for the transcription worker (see main.cpp).
# whisper.cpp is built from a pinned upstream commit; set FETCHCONTENT_SOURCE_DIR_WHISPER to build from a local copy
# of that same commit instead of downloading it.
cmake_minimum_required(VERSION 3.21)
project(gtd_whisper C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
if (APPLE)
  # Metal in whisper.cpp needs macOS 13.3.
  set(CMAKE_OSX_DEPLOYMENT_TARGET "13.3" CACHE STRING "" FORCE)
endif()

# One self-contained executable: no shared libraries to sign and find, the Metal shaders inside it, and code that
# runs on every Apple Silicon Mac rather than only on the build machine's chip.
set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_SERVER OFF CACHE BOOL "" FORCE)
set(GGML_NATIVE OFF CACHE BOOL "" FORCE)
set(GGML_METAL_EMBED_LIBRARY ON CACHE BOOL "" FORCE)

include(FetchContent)
FetchContent_Declare(whisper
  GIT_REPOSITORY https://github.com/ggml-org/whisper.cpp.git
  GIT_TAG d1be6fde11ac6e0407606b4e42fe72d34add8037 # v1.9.5
)
FetchContent_MakeAvailable(whisper)

add_executable(gtd-whisper main.cpp)
target_link_libraries(gtd-whisper PRIVATE whisper)
