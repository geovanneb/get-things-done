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
import * as path from 'path';
import { Worker } from 'worker_threads';
import type { EngineModel, WorkerControl, WorkerRequest, WorkerReply } from './protocol';
import { languageAt, type LanguageChange } from './languages';
import { contextRange, cutsAround, RecentAudio, SHORTEST_TURN, speakerCuts, speakerOf, speakerTurns, splitAtChanges, splitLong, type Part, type SpeakerTurn } from './parts';
import { markRepeats } from './repeats';
import { readWavFormat, wavChunks, WavError } from './wav';

const SAMPLE_RATE = 16000;
/** Enough for the context around any part: a stretch is cut well before this. */
const RECENT_SAMPLES = 30 * SAMPLE_RATE;
/** Voice detection tries to end a stretch of speech by this length; see `splitLong` for the real limit. */
const VAD_LONGEST_SECONDS = 20;
/**
 * Silence that ends a part. Short clips give Whisper little to go on, so after a meeting parts run until 2 seconds of
 * silence, keeping sentences whole. While recording they end at half a second, or the text would wait for a long pause.
 * Meetily makes the same choice.
 */
const SILENCE_SECONDS = { after: 2, live: 0.5 };

interface SherpaStream { acceptWaveform(input: { samples: Float32Array; sampleRate: number }): void }
interface SherpaRecognizer { createStream(): SherpaStream; decodeAsync(stream: SherpaStream): Promise<{ text: string }>; setConfig(config: unknown): void }
interface SherpaVad { acceptWaveform(samples: Float32Array): void; isEmpty(): boolean; front(enableExternalBuffer: boolean): { samples: Float32Array; start: number }; pop(): void; flush(): void }
interface SherpaResampler { resample(samples: Float32Array): Float32Array; flush(samples: Float32Array): Float32Array }
interface Sherpa {
  version?: string | (() => string);
  OfflineRecognizer: { createAsync(config: unknown): Promise<SherpaRecognizer> };
  Vad: new (config: unknown, bufferSeconds: number) => SherpaVad;
  LinearResampler: new (from: number, to: number) => SherpaResampler;
  OfflineSpeakerDiarization: new (config: unknown) => { process(samples: Float32Array): { start: number; end: number; speaker: number }[] };
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

/** The engine reads this option from a file. By name, from the model's folder: the engine cannot open every path on Windows. */
const NO_ARENA_FILE = 'no-arena.config';
async function prepareNoArena(model: EngineModel): Promise<void> {
  const folder = path.dirname(model.files['encoder']!);
  await fsp.writeFile(path.join(folder, NO_ARENA_FILE), 'EnableCpuMemArena=0\n');
  process.chdir(folder);
}

/** The engine's settings for a model. Auto language is an empty string: each segment is detected on its own. */
function recognizerConfig(model: EngineModel, language: string): unknown {
  const lang = language === 'auto' ? '' : language;
  const modelConfig = model.kind === 'whisper'
    ? { whisper: { encoder: model.files.encoder, decoder: model.files.decoder, language: lang, task: 'transcribe', tailPaddings: -1 }, tokens: model.files.tokens }
    : { senseVoice: { model: model.files.model, language: lang, useInverseTextNormalization: 1 }, tokens: model.files.tokens };
  const provider = model.noArena ? `cpu:${NO_ARENA_FILE}` : 'cpu';
  return { featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 }, modelConfig: { ...modelConfig, numThreads: model.threads, provider, debug: 0 } };
}

async function load(sherpa: Sherpa, model: EngineModel, language: string): Promise<SherpaRecognizer> {
  if (model.noArena) await prepareNoArena(model);
  const started = performance.now();
  const recognizer = await sherpa.OfflineRecognizer.createAsync(recognizerConfig(model, language));
  send({ type: 'loaded', ms: Math.round(performance.now() - started) });
  return recognizer;
}

/** Speech segments of limited length, cut at `silence` seconds of silence. */
function newVad(sherpa: Sherpa, model: EngineModel, silence: number): SherpaVad {
  return new sherpa.Vad({
    sileroVad: { model: model.vad, threshold: 0.5, minSilenceDuration: silence, minSpeechDuration: 0.25, windowSize: 512, maxSpeechDuration: VAD_LONGEST_SECONDS },
    sampleRate: SAMPLE_RATE, numThreads: 1, debug: 0,
  }, 60);
}

/** The language of a job, and what is known of the audio around its parts. */
interface Job { model: EngineModel; start: string; changes: LanguageChange[]; turns: SpeakerTurn[]; voiceCuts: number[]; shown: Map<number, number>; current: string; lastPart: number; audio: RecentAudio; previousEnd: number; ending: boolean }
const newJob = (model: EngineModel, start: string, changes: LanguageChange[], turns: SpeakerTurn[] = []): Job => ({ model, start, changes, turns, voiceCuts: speakerCuts(turns), shown: new Map(), current: start, lastPart: -1, audio: new RecentAudio(RECENT_SAMPLES), previousEnd: 0, ending: false });

/** The part with what can be had of its context, and where that starts and ends. */
function withContext(part: Part, next: number | null, job: Job): { samples: Float32Array; from: number; to: number } {
  const end = part.start + part.samples.length;
  // Context stays inside the voice of the part.
  const voice = cutsAround(job.voiceCuts, part.start / SAMPLE_RATE, end / SAMPLE_RATE);
  const nextCut = voice.after === null ? null : Math.round(voice.after * SAMPLE_RATE);
  const range = contextRange(part.start, end, {
    previousEnd: Math.max(job.previousEnd, Math.round(voice.before * SAMPLE_RATE)),
    next: next === null ? nextCut : nextCut === null ? next : Math.min(next, nextCut),
    heard: job.audio.seen, ending: job.ending,
  });
  // The part itself is always whole: context that is gone is only missed.
  const before = job.audio.slice(range.from, part.start) ?? new Float32Array(0);
  const after = job.audio.slice(end, range.to) ?? new Float32Array(0);
  const samples = new Float32Array(before.length + part.samples.length + after.length);
  samples.set(before);
  samples.set(part.samples, before.length);
  samples.set(after, before.length + part.samples.length);
  return { samples, from: part.start - before.length, to: end + after.length };
}

/** Recognizes each finished speech segment and sends it; returns how many had text. A part ends at a change of language. */
async function decodeAll(recognizer: SherpaRecognizer, vad: SherpaVad, job: Job): Promise<number> {
  let found = 0;
  while (!vad.isEmpty()) {
    // A copy: Electron, where this worker runs in the desktop app, refuses buffers that live in native memory.
    const segment = vad.front(false);
    vad.pop();
    const nextSegment = vad.isEmpty() ? null : vad.front(false).start;
    const parts = splitAtChanges(segment, job.changes.map((c) => c.at))
      .flatMap((part) => splitAtChanges(part, job.voiceCuts, SHORTEST_TURN))
      .flatMap((part) => splitLong(part));
    for (const [i, part] of parts.entries()) {
      // Here, between two decodes: a change arriving during a decode only joins the list.
      job.lastPart = (part.start + part.samples.length) / SAMPLE_RATE;
      const language = languageAt(job.start, job.changes, part.start / SAMPLE_RATE);
      if (language !== job.current) {
        recognizer.setConfig(recognizerConfig(job.model, language));
        job.current = language;
      }
      const input = withContext(part, parts[i + 1]?.start ?? nextSegment, job);
      job.previousEnd = part.start + part.samples.length;
      const stream = recognizer.createStream();
      stream.acceptWaveform({ samples: input.samples, sampleRate: SAMPLE_RATE });
      const result = await recognizer.decodeAsync(stream);
      const text = markRepeats(result.text.trim());
      if (text) {
        found++;
        const voice = speakerOf(part.start / SAMPLE_RATE, (part.start + part.samples.length) / SAMPLE_RATE, job.turns);
        // Numbered as the transcript meets them, so it always begins with Speaker 1.
        if (voice && !job.shown.has(voice)) job.shown.set(voice, job.shown.size + 1);
        const speaker = voice ? job.shown.get(voice) : undefined;
        send({ type: 'segment', start: input.from / SAMPLE_RATE, end: input.to / SAMPLE_RATE, text, ...(speaker ? { speaker } : {}) });
      }
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
  const vad = newVad(sherpa, request.model, SILENCE_SECONDS.live);
  const job = newJob(request.model, request.language, control.changes);
  control.lateLanguage = (at) => job.lastPart > at;
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
        job.audio.add(samples);
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
  job.ending = true;
  segments += await decodeAll(recognizer, vad, job);
  send({ type: 'done', seconds: read / (SAMPLE_RATE * 2), segments, bytes: read, ...(control.late ? { late_language: true } : {}) });
}

async function transcribe(sherpa: Sherpa, request: Extract<WorkerRequest, { type: 'transcribe' }>): Promise<void> {
  const format = await readWavFormat(request.wav);
  const recognizer = await load(sherpa, request.model, request.language);
  const vad = newVad(sherpa, request.model, SILENCE_SECONDS.after);
  const resampler = format.sampleRate === SAMPLE_RATE ? null : new sherpa.LinearResampler(format.sampleRate, SAMPLE_RATE);
  let segments = 0;
  let fed = 0;
  let pending = new Float32Array(0);
  const job = newJob(request.model, request.language, request.changes ?? [], request.turns ?? []);
  const decode = async () => { segments += await decodeAll(recognizer, vad, job); };
  // The VAD takes 512 samples at a time; what is left over waits for the next chunk.
  const feed = async (samples: Float32Array) => {
    job.audio.add(samples);
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
  job.ending = true;
  await decode();
  send({ type: 'done', seconds: format.duration, segments });
}

/** Where two stretches count as one voice. Measured on real recordings: lower splits one person, 1.05 joins two. */
const SAME_SPEAKER = 0.95;

/** Who spoke when. Everything about voices stays in this process, which ends with the job; only the times leave it. */
async function findSpeakers(sherpa: Sherpa, request: Extract<WorkerRequest, { type: 'speakers' }>): Promise<void> {
  // The work below blocks this thread, so a dashboard that went away would go unnoticed: a thread of its own watches.
  new Worker("const { workerData } = require('worker_threads'); setInterval(() => { if (process.ppid !== workerData) process.kill(process.pid, 'SIGKILL'); }, 2000);", { eval: true, workerData: process.ppid }).unref();
  const format = await readWavFormat(request.wav);
  const resampler = format.sampleRate === SAMPLE_RATE ? null : new sherpa.LinearResampler(format.sampleRate, SAMPLE_RATE);
  const samples = new Float32Array(Math.ceil(format.duration * SAMPLE_RATE) + SAMPLE_RATE);
  let filled = 0;
  const add = (block: Float32Array) => {
    const fits = block.subarray(0, samples.length - filled);
    samples.set(fits, filled);
    filled += fits.length;
  };
  for await (const chunk of wavChunks(request.wav, format, 1)) add(resampler ? resampler.resample(chunk) : chunk);
  if (resampler) add(resampler.flush(new Float32Array(0)));
  const diarization = new sherpa.OfflineSpeakerDiarization({
    segmentation: { pyannote: { model: request.segmentation }, numThreads: request.threads, debug: 0 },
    embedding: { model: request.embedding, numThreads: request.threads, debug: 0 },
    clustering: { numClusters: -1, threshold: SAME_SPEAKER },
    minDurationOn: 0.3, minDurationOff: 0.5,
  });
  send({ type: 'turns', turns: speakerTurns(diarization.process(samples.subarray(0, filled)), format.duration) });
  send({ type: 'done', seconds: format.duration, segments: 0 });
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
  if (request.type === 'speakers') {
    await findSpeakers(sherpa, request);
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
