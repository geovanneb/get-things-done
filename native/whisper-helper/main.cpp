// gtd-whisper: keeps one Whisper model loaded on the GPU and transcribes the speech parts the worker sends it.
//
// Started by the transcription worker with: gtd-whisper --model <file.bin> --threads <n> --parent <pid> [--no-gpu]
// Talks only over its own stdin and stdout, never a port.
//
// In, first:   a line "start", once the dashboard knows this process: nothing is loaded before it.
// Out, then:   {"type":"ready","version":"1.9.5","backend":"MTL0","ms":812}   or {"type":"error","message":"..."}
// In, per part: one line {"id":1,"language":"auto","samples":N}, then N little-endian float32 samples at 16 kHz.
// Out, per part: {"type":"text","id":1,"language":"en","text":"...","ms":123}  or {"type":"error","id":1,"message":"..."}
//
// It ends when stdin closes, and on its own when the worker that started it (`--parent`) is gone, even before it
// started or in the middle of a part.
#include "whisper.h"

#include <algorithm>
#include <atomic>
#include <cctype>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <string>
#include <thread>
#include <vector>
#include <unistd.h>

namespace {

// A part is at most 25 seconds plus its context; anything near a minute is a broken request.
constexpr std::size_t MAX_SAMPLES = 16000 * 60;
constexpr std::size_t MAX_HEADER = 256;

std::atomic<bool> stopping{false};
std::string backend = "CPU";

std::string json_string(const std::string & s) {
  std::string out = "\"";
  for (unsigned char c : s) {
    switch (c) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      default:
        if (c < 0x20) { char b[8]; std::snprintf(b, sizeof b, "\\u%04x", c); out += b; }
        else out += static_cast<char>(c);
    }
  }
  return out + "\"";
}

void reply(const std::string & line) {
  std::fwrite(line.data(), 1, line.size(), stdout);
  std::fputc('\n', stdout);
  std::fflush(stdout);
}

// whisper.cpp says at load which device it uses: that line, not a guess, is what we report.
void on_log(ggml_log_level, const char * text, void *) {
  static const char * marker = "whisper_backend_init_gpu: using ";
  if (const char * at = std::strstr(text, marker)) {
    std::string name = at + std::strlen(marker);
    const auto end = name.find(" backend");
    if (end != std::string::npos) backend = name.substr(0, end);
  }
}

// Values in the one-line header; the worker writes it, so a small reader is enough.
bool field(const std::string & header, const std::string & key, std::string & value) {
  const auto at = header.find("\"" + key + "\":");
  if (at == std::string::npos) return false;
  auto i = at + key.size() + 3;
  if (i < header.size() && header[i] == '"') {
    const auto end = header.find('"', i + 1);
    if (end == std::string::npos) return false;
    value = header.substr(i + 1, end - i - 1);
  } else {
    auto end = i;
    while (end < header.size() && (std::isdigit(static_cast<unsigned char>(header[end])))) end++;
    value = header.substr(i, end - i);
  }
  return !value.empty();
}

bool read_exact(void * buffer, std::size_t size) {
  auto * p = static_cast<char *>(buffer);
  while (size > 0) {
    const ssize_t n = ::read(STDIN_FILENO, p, size);
    if (n <= 0) return false;
    p += n;
    size -= static_cast<std::size_t>(n);
  }
  return true;
}

bool read_line(std::string & line) {
  line.clear();
  char c;
  while (line.size() <= MAX_HEADER) {
    const ssize_t n = ::read(STDIN_FILENO, &c, 1);
    if (n <= 0) return false;
    if (c == '\n') return true;
    line += c;
  }
  return false;
}

// Frees the model, then ends at once: the parent watch thread is still running, and nothing else is left to clean.
[[noreturn]] void finish(whisper_context * ctx, int code) {
  whisper_free(ctx);
  std::fflush(stdout);
  _exit(code);
}

}  // namespace

int main(int argc, char ** argv) {
  std::string model;
  pid_t expected_parent = 0;
  int threads = 4;
  bool gpu = true;
  for (int i = 1; i < argc; i++) {
    const std::string arg = argv[i];
    if (arg == "--model" && i + 1 < argc) model = argv[++i];
    else if (arg == "--threads" && i + 1 < argc) threads = std::max(1, std::atoi(argv[++i]));
    else if (arg == "--no-gpu") gpu = false;
    else if (arg == "--parent" && i + 1 < argc) expected_parent = static_cast<pid_t>(std::atoi(argv[++i]));
  }
  if (model.empty()) {
    reply("{\"type\":\"error\",\"message\":\"No model given\"}");
    return 2;
  }

  // The worker that started us is gone: stop the part being decoded, then end, so no helper is left behind. Its pid is
  // given, so a worker that died before this line is noticed too.
  const pid_t parent = expected_parent > 0 ? expected_parent : getppid();
  if (getppid() != parent) _exit(3);
  std::thread([parent] {
    while (true) {
      std::this_thread::sleep_for(std::chrono::milliseconds(500));
      if (getppid() != parent) {
        stopping = true;
        std::this_thread::sleep_for(std::chrono::seconds(2));
        _exit(3);
      }
    }
  }).detach();

  // Nothing is loaded until the worker says the dashboard knows this process; a closed stdin ends it here.
  {
    std::string first;
    if (!read_line(first) || first != "start") _exit(0);
  }

  whisper_log_set(on_log, nullptr);
  const auto started = std::chrono::steady_clock::now();
  whisper_context_params cparams = whisper_context_default_params();
  cparams.use_gpu = gpu;
  cparams.flash_attn = true;
  whisper_context * ctx = whisper_init_from_file_with_params(model.c_str(), cparams);
  if (!ctx) {
    reply("{\"type\":\"error\",\"message\":\"The model could not be loaded\"}");
    _exit(1);
  }
  const auto load_ms = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - started).count();
  reply("{\"type\":\"ready\",\"version\":" + json_string(whisper_version()) + ",\"backend\":" + json_string(backend) + ",\"ms\":" + std::to_string(load_ms) + "}");

  std::vector<float> samples;
  std::string header;
  while (read_line(header)) {
    std::string id, language, count;
    if (!field(header, "id", id) || !field(header, "samples", count) || !field(header, "language", language)) {
      reply("{\"type\":\"error\",\"message\":\"A request could not be read\"}");
      finish(ctx, 4);
    }
    const std::size_t n = std::strtoull(count.c_str(), nullptr, 10);
    if (n == 0 || n > MAX_SAMPLES || language.size() > 8) {
      reply("{\"type\":\"error\",\"id\":" + id + ",\"message\":\"A part is empty or too long\"}");
      finish(ctx, 4);
    }
    samples.resize(n);
    if (!read_exact(samples.data(), n * sizeof(float))) finish(ctx, 0);

    // The same decoding as the reference tools: beam search of 5, falling back to sampling on a doubtful result.
    // Each part on its own: the context around it comes as audio, never as earlier text.
    whisper_full_params params = whisper_full_default_params(WHISPER_SAMPLING_BEAM_SEARCH);
    params.n_threads = threads;
    params.language = language.c_str();
    params.translate = false;
    params.no_context = true;
    params.no_timestamps = true;
    params.print_progress = false;
    params.print_realtime = false;
    params.print_timestamps = false;
    params.print_special = false;
    params.beam_search.beam_size = 5;
    params.greedy.best_of = 5;
    params.abort_callback = [](void *) { return stopping.load(); };

    const auto t0 = std::chrono::steady_clock::now();
    if (whisper_full(ctx, params, samples.data(), static_cast<int>(n)) != 0) {
      reply("{\"type\":\"error\",\"id\":" + id + ",\"message\":\"The part could not be transcribed\"}");
      continue;
    }
    std::string text;
    for (int i = 0; i < whisper_full_n_segments(ctx); i++) text += whisper_full_get_segment_text(ctx, i);
    const char * detected = whisper_lang_str(whisper_full_lang_id(ctx));
    const auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - t0).count();
    reply("{\"type\":\"text\",\"id\":" + id + ",\"language\":" + json_string(detected ? detected : "") + ",\"text\":" + json_string(text) + ",\"ms\":" + std::to_string(ms) + "}");
  }
  finish(ctx, 0);
}
