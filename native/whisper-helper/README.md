# gtd-whisper

Whisper on the GPU for the desktop app on Apple Silicon Macs (Metal), item 20 of #123. A small program on top of
[whisper.cpp](https://github.com/ggml-org/whisper.cpp) (MIT), built from the commit pinned in `CMakeLists.txt`.

The transcription worker starts it for one job with a GGML model, sends it each speech part (the same parts, with the
same context, as the CPU engine gets) and ends it with the job. It talks over its own stdin and stdout only; the
protocol is at the top of `main.cpp`, the client is `server/src/services/transcription/whisperHelper.ts`. It ends by
itself when the worker is gone.

It is one executable with the Metal code inside and only macOS frameworks as dependencies, so the app signs it like
the rest of its files. The Intel and Windows builds do not have it, and the app works without it.

## Build

```bash
npm run helper --prefix desktop   # needs CMake and Xcode's command line tools; writes native/whisper-helper/build/gtd-whisper
```

`WHISPER_SOURCE_DIR` builds from a local copy of the pinned commit instead of downloading it; `CMAKE` picks a CMake.
`npm run stage --prefix desktop` then puts it into the app, and CI fails the Apple Silicon build without it.

## Measured

Apple M5, Whisper Turbo q5_0, fictional clips with reference texts, through the worker: English 0.9% and 1.2% word
errors (CPU engine 1.9% and 1.8%), Japanese 1.5% character errors (the same), 12.7 to 18.4 times real time (CPU
engine 4.5 to 6.3), about 1 GB of memory (CPU engine 3 to 4 GB).
