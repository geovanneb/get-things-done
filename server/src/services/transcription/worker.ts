/**
 * The transcription worker: a child process the dashboard starts for one job and ends afterwards, so the model's
 * memory (up to about 4 GB) and any crash of the native engine stay out of the dashboard.
 *
 * Messages in (one per process): { type: 'version' } | { type: 'check', model } | { type: 'transcribe', model, wav, language }
 * Messages out: { type: 'version', version } | { type: 'loaded', ms } | { type: 'progress', done, total }
 *               | { type: 'segment', start, end, text } | { type: 'done', seconds, segments } | { type: 'error', message }
 */
import type { EngineModel, WorkerRequest, WorkerReply } from './protocol';
import { readWavFormat, wavChunks, WavError } from './wav';

const SAMPLE_RATE = 16000;

interface SherpaStream { acceptWaveform(input: { samples: Float32Array; sampleRate: number }): void }
interface SherpaRecognizer { createStream(): SherpaStream; decodeAsync(stream: SherpaStream): Promise<{ text: string }> }
interface SherpaVad { acceptWaveform(samples: Float32Array): void; isEmpty(): boolean; front(): { samples: Float32Array; start: number }; pop(): void; flush(): void }
interface SherpaResampler { resample(samples: Float32Array): Float32Array; flush(samples: Float32Array): Float32Array }
interface Sherpa {
  version?: string | (() => string);
  OfflineRecognizer: { createAsync(config: unknown): Promise<SherpaRecognizer> };
  Vad: new (config: unknown, bufferSeconds: number) => SherpaVad;
  LinearResampler: new (from: number, to: number) => SherpaResampler;
}

function send(reply: WorkerReply): void {
  if (process.connected) process.send?.(reply);
}

// The dashboard went away (it quit, crashed or ended this job): nothing is waiting for the result.
process.on('disconnect', () => process.exit(0));

function loadSherpa(): Sherpa {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- native addon, loaded only inside the worker
  return require('sherpa-onnx-node') as Sherpa;
}

/** The engine's settings for a model. Auto language is an empty string: each segment is detected on its own. */
function recognizerConfig(model: EngineModel, language: string): unknown {
  const lang = language === 'auto' ? '' : language;
  const modelConfig = model.kind === 'whisper'
    ? { whisper: { encoder: model.files.encoder, decoder: model.files.decoder, language: lang, task: 'transcribe', tailPaddings: -1 }, tokens: model.files.tokens }
    : { senseVoice: { model: model.files.model, language: lang, useInverseTextNormalization: 1 }, tokens: model.files.tokens };
  return { featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 }, modelConfig: { ...modelConfig, numThreads: model.threads, provider: 'cpu', debug: 0 } };
}

async function load(sherpa: Sherpa, model: EngineModel, language: string): Promise<SherpaRecognizer> {
  const started = performance.now();
  const recognizer = await sherpa.OfflineRecognizer.createAsync(recognizerConfig(model, language));
  send({ type: 'loaded', ms: Math.round(performance.now() - started) });
  return recognizer;
}

async function transcribe(sherpa: Sherpa, request: Extract<WorkerRequest, { type: 'transcribe' }>): Promise<void> {
  const format = await readWavFormat(request.wav);
  const recognizer = await load(sherpa, request.model, request.language);
  // Speech segments of at most 20 seconds (Whisper reads at most 30); silence between them is skipped.
  const vad = new sherpa.Vad({
    sileroVad: { model: request.model.vad, threshold: 0.5, minSilenceDuration: 0.5, minSpeechDuration: 0.25, windowSize: 512, maxSpeechDuration: 20 },
    sampleRate: SAMPLE_RATE, numThreads: 1, debug: 0,
  }, 60);
  const resampler = format.sampleRate === SAMPLE_RATE ? null : new sherpa.LinearResampler(format.sampleRate, SAMPLE_RATE);
  let segments = 0;
  let fed = 0;
  let pending = new Float32Array(0);
  const decode = async () => {
    while (!vad.isEmpty()) {
      const segment = vad.front();
      vad.pop();
      const stream = recognizer.createStream();
      stream.acceptWaveform({ samples: segment.samples, sampleRate: SAMPLE_RATE });
      const result = await recognizer.decodeAsync(stream);
      const text = result.text.trim();
      if (text) {
        segments++;
        send({ type: 'segment', start: segment.start / SAMPLE_RATE, end: (segment.start + segment.samples.length) / SAMPLE_RATE, text });
      }
    }
  };
  // The VAD takes 512 samples at a time; what is left over waits for the next chunk.
  const feed = async (samples: Float32Array) => {
    const all = new Float32Array(pending.length + samples.length);
    all.set(pending);
    all.set(samples, pending.length);
    let i = 0;
    for (; i + 512 <= all.length; i += 512) vad.acceptWaveform(all.subarray(i, i + 512));
    pending = all.slice(i);
    fed += samples.length;
    await decode();
  };
  let lastProgress = 0;
  for await (const chunk of wavChunks(request.wav, format, 1)) {
    await feed(resampler ? resampler.resample(chunk) : chunk);
    const done = fed / SAMPLE_RATE;
    if (done - lastProgress >= 5) {
      lastProgress = done;
      send({ type: 'progress', done, total: format.duration });
    }
  }
  if (resampler) await feed(resampler.flush(new Float32Array(0)));
  if (pending.length) vad.acceptWaveform(pending);
  vad.flush();
  await decode();
  send({ type: 'done', seconds: format.duration, segments });
}

async function handle(request: WorkerRequest): Promise<void> {
  const sherpa = loadSherpa();
  if (request.type === 'version') {
    send({ type: 'version', version: typeof sherpa.version === 'function' ? sherpa.version() : String(sherpa.version ?? 'unknown') });
    return;
  }
  if (request.type === 'check') {
    await load(sherpa, request.model, 'auto');
    send({ type: 'done', seconds: 0, segments: 0 });
    return;
  }
  await transcribe(sherpa, request);
}

process.once('message', (request: WorkerRequest) => {
  handle(request)
    .catch((err: unknown) => send({ type: 'error', message: err instanceof WavError ? err.message : `The transcription engine failed: ${(err as Error)?.message ?? String(err)}` }))
    .finally(() => {
      // Let the last message reach the dashboard, then end: one job per process.
      if (process.connected) process.disconnect();
      else process.exit(0);
    });
});
