/**
 * The transcription worker: a child process the dashboard starts for one job and ends afterwards, so the model's
 * memory (up to about 4 GB) and any crash of the native engine stay out of the dashboard.
 *
 * Messages in (one request per process): { type: 'version' } | { type: 'check', model } | { type: 'transcribe', model, wav, language }
 *               | { type: 'follow', model, wav, language }, then for a follow job { type: 'committed' | 'end', bytes }
 *                 and { type: 'language', at, language }
 * Messages out: { type: 'version', version } | { type: 'loaded', ms } | { type: 'progress', done, total }
 *               | { type: 'segment', start, end, text } | { type: 'done', seconds, segments } | { type: 'error', message }
 */
import * as fsp from 'fs/promises';
import type { EngineModel, WorkerControl, WorkerRequest, WorkerReply } from './protocol';
import { languageAt, type LanguageChange } from './languages';
import { readWavFormat, wavChunks, WavError } from './wav';

const SAMPLE_RATE = 16000;

interface SherpaStream { acceptWaveform(input: { samples: Float32Array; sampleRate: number }): void }
interface SherpaRecognizer { createStream(): SherpaStream; decodeAsync(stream: SherpaStream): Promise<{ text: string }>; setConfig(config: unknown): void }
interface SherpaVad { acceptWaveform(samples: Float32Array): void; isEmpty(): boolean; front(enableExternalBuffer: boolean): { samples: Float32Array; start: number }; pop(): void; flush(): void }
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

/** Speech segments of at most 20 seconds (Whisper reads at most 30), cut at half a second of silence. */
function newVad(sherpa: Sherpa, model: EngineModel): SherpaVad {
  return new sherpa.Vad({
    sileroVad: { model: model.vad, threshold: 0.5, minSilenceDuration: 0.5, minSpeechDuration: 0.25, windowSize: 512, maxSpeechDuration: 20 },
    sampleRate: SAMPLE_RATE, numThreads: 1, debug: 0,
  }, 60);
}

/** The languages of a job: the one the recognizer holds now, and when it should change. */
interface Languages { model: EngineModel; start: string; changes: LanguageChange[]; current: string; lastPart: number }
const languages = (model: EngineModel, start: string, changes: LanguageChange[]): Languages => ({ model, start, changes, current: start, lastPart: -1 });

/** Recognizes each finished speech segment and sends it; returns how many had text. A segment's start decides its language. */
async function decodeAll(recognizer: SherpaRecognizer, vad: SherpaVad, job: Languages): Promise<number> {
  let found = 0;
  while (!vad.isEmpty()) {
    // A copy: Electron, where this worker runs in the desktop app, refuses buffers that live in native memory.
    const segment = vad.front(false);
    vad.pop();
    // Here, between two decodes: a change arriving during a decode only joins the list.
    const seconds = segment.start / SAMPLE_RATE;
    job.lastPart = seconds;
    const language = languageAt(job.start, job.changes, seconds);
    if (language !== job.current) {
      recognizer.setConfig(recognizerConfig(job.model, language));
      job.current = language;
    }
    const stream = recognizer.createStream();
    stream.acceptWaveform({ samples: segment.samples, sampleRate: SAMPLE_RATE });
    const result = await recognizer.decodeAsync(stream);
    const text = result.text.trim();
    if (text) {
      found++;
      send({ type: 'segment', start: segment.start / SAMPLE_RATE, end: (segment.start + segment.samples.length) / SAMPLE_RATE, text });
    }
  }
  return found;
}

/** What the dashboard said about a recording being followed: saved so far, and sealed at. */
const control = { committed: 0, end: null as number | null, wake: null as (() => void) | null, changes: [] as LanguageChange[], lateLanguage: null as ((at: number) => boolean) | null, late: false };
function onControl(message: WorkerControl): void {
  if (message?.type === 'language') {
    control.changes.push({ at: message.at, language: message.language });
    if (control.lateLanguage?.(message.at)) control.late = true;
  }
  if (message?.type === 'committed' && Number.isSafeInteger(message.bytes)) control.committed = Math.max(control.committed, message.bytes);
  if (message?.type === 'end' && Number.isSafeInteger(message.bytes)) control.end = message.bytes;
  control.wake?.();
}

/**
 * Follows a recording as it is made. Reads only saved audio, waits when it has caught up, and once the recording is
 * sealed reads up to the sealed size, flushes the last speech and says exactly how much audio it covered.
 */
async function follow(sherpa: Sherpa, request: Extract<WorkerRequest, { type: 'follow' }>): Promise<void> {
  const recognizer = await load(sherpa, request.model, request.language);
  const vad = newVad(sherpa, request.model);
  const job = languages(request.model, request.language, control.changes);
  control.lateLanguage = (at) => job.lastPart >= at;
  const file = await fsp.open(request.wav, 'r');
  const HEADER = 44;
  const STEP = 2 * SAMPLE_RATE * 2; // two seconds of audio per read
  let read = 0;
  let segments = 0;
  let pending = new Float32Array(0);
  let lastProgress = 0;
  try {
    for (;;) {
      const limit = control.end ?? control.committed;
      if (control.end !== null && (control.end < read || control.end % 2 !== 0)) throw new Error('The recording was sealed before what was already transcribed');
      if (read < limit) {
        const size = Math.min(limit - read, STEP) & ~1;
        const buffer = Buffer.alloc(size);
        for (let got = 0; got < size;) {
          const { bytesRead } = await file.read(buffer, got, size - got, HEADER + read + got);
          if (bytesRead === 0) throw new Error('The recording is shorter than what was saved');
          got += bytesRead;
        }
        const samples = new Float32Array(size / 2);
        for (let i = 0; i < samples.length; i++) samples[i] = buffer.readInt16LE(i * 2) / 32768;
        const all = new Float32Array(pending.length + samples.length);
        all.set(pending);
        all.set(samples, pending.length);
        let i = 0;
        for (; i + 512 <= all.length; i += 512) vad.acceptWaveform(all.subarray(i, i + 512));
        pending = all.slice(i);
        read += size;
        segments += await decodeAll(recognizer, vad, job);
        const done = read / (SAMPLE_RATE * 2);
        if (done - lastProgress >= 5) {
          lastProgress = done;
          send({ type: 'progress', done, total: (control.end ?? control.committed) / (SAMPLE_RATE * 2) });
        }
        continue;
      }
      if (control.end !== null) break;
      await new Promise<void>((resolve) => { control.wake = resolve; setTimeout(resolve, 1000); });
      control.wake = null;
    }
  } finally {
    await file.close();
  }
  if (pending.length) vad.acceptWaveform(pending);
  vad.flush();
  segments += await decodeAll(recognizer, vad, job);
  send({ type: 'done', seconds: read / (SAMPLE_RATE * 2), segments, bytes: read, ...(control.late ? { late_language: true } : {}) });
}

async function transcribe(sherpa: Sherpa, request: Extract<WorkerRequest, { type: 'transcribe' }>): Promise<void> {
  const format = await readWavFormat(request.wav);
  const recognizer = await load(sherpa, request.model, request.language);
  const vad = newVad(sherpa, request.model);
  const resampler = format.sampleRate === SAMPLE_RATE ? null : new sherpa.LinearResampler(format.sampleRate, SAMPLE_RATE);
  let segments = 0;
  let fed = 0;
  let pending = new Float32Array(0);
  const job = languages(request.model, request.language, request.changes ?? []);
  const decode = async () => { segments += await decodeAll(recognizer, vad, job); };
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
  if (request.type === 'follow') {
    await follow(sherpa, request);
    return;
  }
  await transcribe(sherpa, request);
}

process.once('message', (request: WorkerRequest) => {
  // Whatever comes after the request is a control for a follow job; it may arrive while the model loads.
  process.on('message', onControl);
  handle(request)
    .catch((err: unknown) => send({ type: 'error', message: err instanceof WavError ? err.message : `The transcription engine failed: ${(err as Error)?.message ?? String(err)}` }))
    .finally(() => {
      // Let the last message reach the dashboard, then end: one job per process.
      if (process.connected) process.disconnect();
      else process.exit(0);
    });
});
