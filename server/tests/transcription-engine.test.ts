import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as fs from 'node:fs';
import { contextRange, cutsAround, RecentAudio, SHORTEST_TURN, speakerCuts, speakerOf, speakerTurns, splitAtChanges, splitLong } from '../src/services/transcription/parts';
import { markRepeats } from '../src/services/transcription/repeats';
import * as path from 'node:path';
import * as os from 'node:os';
import { EventEmitter } from 'node:events';
import { fork, type ChildProcess } from 'node:child_process';
import { readWavFormat, wavChunks, WavError } from '../src/services/transcription/wav';
import { TranscriptionEngine, launchWorker, type WorkerLauncher } from '../src/services/transcription/engine';
import { TranscriptionModelService } from '../src/services/transcriptionModels';
import type { WorkerReply, WorkerRequest } from '../src/services/transcription/protocol';

async function tmp(t: { after: (fn: () => Promise<void> | void) => void }): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-stt-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  return dir;
}

/** A WAV file of fictional samples: PCM 16, 24 or 32 bits, or 32-bit float; optional extra chunks before the data. */
function wav(samples: number[][], options: { rate?: number; bits?: 16 | 24 | 32; float?: boolean; extra?: boolean; dataLength?: number } = {}): Buffer {
  const rate = options.rate ?? 16000;
  const bits = options.bits ?? 16;
  const channels = samples.length;
  const frames = samples[0]!.length;
  const bytes = bits / 8;
  const data = Buffer.alloc(frames * channels * bytes);
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const v = samples[c]![i]!;
      const at = (i * channels + c) * bytes;
      if (options.float) data.writeFloatLE(v, at);
      else if (bits === 16) data.writeInt16LE(Math.round(v * 32767), at);
      else if (bits === 24) data.writeIntLE(Math.round(v * 8388607), at, 3);
      else data.writeInt32LE(Math.round(v * 2147483647), at);
    }
  }
  const fmt = Buffer.alloc(24);
  fmt.write('fmt ', 0, 'ascii'); fmt.writeUInt32LE(16, 4); fmt.writeUInt16LE(options.float ? 3 : 1, 8); fmt.writeUInt16LE(channels, 10);
  fmt.writeUInt32LE(rate, 12); fmt.writeUInt32LE(rate * channels * bytes, 16); fmt.writeUInt16LE(channels * bytes, 20); fmt.writeUInt16LE(bits, 22);
  const list = options.extra ? Buffer.concat([Buffer.from('LIST', 'ascii'), Buffer.from([5, 0, 0, 0]), Buffer.from('INFOx\0', 'ascii')]) : Buffer.alloc(0);
  const dataHeader = Buffer.alloc(8);
  dataHeader.write('data', 0, 'ascii'); dataHeader.writeUInt32LE(options.dataLength ?? data.length, 4);
  const body = Buffer.concat([Buffer.from('WAVE', 'ascii'), fmt, list, dataHeader, data]);
  const riff = Buffer.alloc(8);
  riff.write('RIFF', 0, 'ascii'); riff.writeUInt32LE(body.length, 4);
  return Buffer.concat([riff, body]);
}

test('WAV: PCM and float, any channel count, read in chunks as mono, with odd chunks and lengths handled', async (t) => {
  const dir = await tmp(t);
  const tone = Array.from({ length: 48000 }, (_, i) => Math.sin(i / 10) * 0.5);
  const cases: [string, Buffer, number][] = [
    ['mono16.wav', wav([tone]), 16000],
    ['stereo24.wav', wav([tone, tone.map((v) => -v)], { rate: 48000, bits: 24, extra: true }), 48000],
    ['float.wav', wav([tone], { rate: 44100, bits: 32, float: true }), 44100],
    ['pcm32.wav', wav([tone], { bits: 32 }), 16000],
  ];
  for (const [name, data, rate] of cases) {
    const file = path.join(dir, name);
    await fsp.writeFile(file, data);
    const format = await readWavFormat(file);
    assert.equal(format.sampleRate, rate, name);
    assert.ok(Math.abs(format.duration - 48000 / rate) < 1e-6, name);
    let frames = 0;
    let first: Float32Array | null = null;
    for await (const chunk of wavChunks(file, format, 0.25)) { frames += chunk.length; first ??= chunk; }
    assert.equal(frames, 48000, `${name}: every frame read`);
    if (name.startsWith('stereo')) assert.ok(Math.abs(first![100]!) < 1e-4, 'two opposite channels average to silence');
    else assert.ok(Math.abs(first![100]! - tone[100]!) < 1e-3, `${name}: samples kept`);
  }

  // A recorder that stopped early leaves the length unset: the data runs to the end of the file.
  const open = path.join(dir, 'open.wav');
  await fsp.writeFile(open, wav([tone], { dataLength: 0xffffffff }));
  assert.equal((await readWavFormat(open)).duration, 3);

  for (const [name, data, message] of [
    ['notwav.wav', Buffer.from('fictional text, not audio'), /Not a WAV file/],
    ['adpcm.wav', (() => { const b = wav([tone]); b.writeUInt16LE(2, 20); return b; })(), /encoding \(2\) is not supported/],
    ['nodata.wav', wav([tone]).subarray(0, 36), /no audio data/],
  ] as [string, Buffer, RegExp][]) {
    const file = path.join(dir, name);
    await fsp.writeFile(file, data);
    await assert.rejects(readWavFormat(file), (err: Error) => err instanceof WavError && message.test(err.message), name);
  }
});

/** A worker that answers like the real one, chosen per test; it records what it was asked and whether it was ended. */
function fakeWorker(answer: (request: WorkerRequest, reply: (r: WorkerReply) => void, child: EventEmitter & { exitCode: number | null }) => void) {
  const runs: { request: WorkerRequest | null; killed: boolean }[] = [];
  const launcher: WorkerLauncher = () => {
    const child = Object.assign(new EventEmitter(), { exitCode: null as number | null, signalCode: null as string | null, stderr: new EventEmitter(), connected: true });
    const run = { request: null as WorkerRequest | null, killed: false };
    runs.push(run);
    Object.assign(child, {
      send: (request: WorkerRequest) => {
        run.request = request;
        setImmediate(() => answer(request, (r) => child.emit('message', r), child));
        return true;
      },
      kill: () => {
        if (!run.killed) setImmediate(() => { child.signalCode = 'SIGTERM'; child.emit('exit', null, 'SIGTERM'); });
        run.killed = true;
        return true;
      },
      disconnect: () => { child.connected = false; },
    });
    return child as unknown as ChildProcess;
  };
  return { launcher, runs };
}

/** Fictional installed models: files of the right names and sizes (sparse) and the record the downloader writes. */
async function fakeInstall(dir: string, ids: string[]): Promise<void> {
  const { CATALOG, VAD } = await import('../src/services/transcriptionModels');
  for (const entry of [...CATALOG, VAD].filter((m) => ids.includes(m.id))) {
    await fsp.mkdir(path.join(dir, entry.id), { recursive: true });
    for (const f of entry.files) { const h = await fsp.open(path.join(dir, entry.id, f.name), 'w'); await h.truncate(f.size); await h.close(); }
    await fsp.writeFile(path.join(dir, entry.id, 'installed.json'), JSON.stringify({ id: entry.id, files: entry.files.map((f) => ({ name: f.name, sha256: f.sha256 })) }));
  }
}

async function installedModels(t: { after: (fn: () => Promise<void> | void) => void }): Promise<string> {
  const dir = await tmp(t);
  const previous = process.env.ESB_MODELS_PATH;
  process.env.ESB_MODELS_PATH = dir;
  t.after(() => { if (previous === undefined) delete process.env.ESB_MODELS_PATH; else process.env.ESB_MODELS_PATH = previous; });
  return dir;
}

test('engine: status, a model that is not downloaded, errors and crashes, one job at a time, cancel and the worker is always ended', async (t) => {
  await installedModels(t);
  const ok = fakeWorker((request, reply) => {
    if (request.type === 'version') reply({ type: 'version', version: '9.9.9' });
  });
  const engine = new TranscriptionEngine(new TranscriptionModelService(), ok.launcher);
  assert.deepEqual(await engine.status(), { available: true, version: '9.9.9', error: null });

  // Nothing downloaded: a plain reason, and no worker started.
  const before = ok.runs.length;
  await assert.rejects(engine.check('sensevoice-2024-07-17'), /not downloaded yet/);
  assert.equal(ok.runs.length, before);

  // The engine fails to load, or the worker dies: reported, never thrown at the dashboard as a crash.
  const broken = fakeWorker((_request, reply) => reply({ type: 'error', message: 'The transcription engine failed: fictional' }));
  assert.deepEqual(await new TranscriptionEngine(new TranscriptionModelService(), broken.launcher).status(), { available: false, version: null, error: 'The transcription engine failed: fictional' });
  const dying = fakeWorker((_request, _reply, child) => { child.exitCode = 134; child.emit('exit', 134, null); });
  assert.match((await new TranscriptionEngine(new TranscriptionModelService(), dying.launcher).status()).error!, /stopped unexpectedly \(exit code 134\)/);

  // A job that never answers: a second one is refused while it runs; cancelling ends the worker.
  const silent = fakeWorker(() => {});
  const slow = new TranscriptionEngine(new TranscriptionModelService(), silent.launcher);
  const controller = new AbortController();
  const first = (slow as unknown as { run: (r: WorkerRequest, ms: number, on: () => void, s?: AbortSignal) => Promise<void> }).run({ type: 'version' }, 60_000, () => {}, controller.signal);
  await assert.rejects(slow.status().then((s) => { if (!s.available) throw new Error(s.error!); }), /already running/);
  controller.abort();
  await assert.rejects(first, /Cancelled/);
  assert.equal(silent.runs[0]!.killed, true, 'the worker is ended');

  // A timeout ends it too.
  const late = fakeWorker(() => {});
  await assert.rejects((new TranscriptionEngine(new TranscriptionModelService(), late.launcher) as unknown as { run: (r: WorkerRequest, ms: number, on: () => void) => Promise<void> }).run({ type: 'version' }, 50, () => {}), /took too long/);
  assert.equal(late.runs[0]!.killed, true);
});

// A real model, when one is provided (the CI job "Transcription (real model)" downloads SenseVoice and its samples).
const realModels = process.env['STT_TEST_MODELS'];
const realAudio = process.env['STT_TEST_AUDIO'];
test('real model: the worker transcribes English and Japanese samples with SenseVoice', { skip: !realModels || !realAudio ? 'set STT_TEST_MODELS and STT_TEST_AUDIO to run' : false }, async (t) => {
  const previous = process.env.ESB_MODELS_PATH;
  process.env.ESB_MODELS_PATH = realModels;
  t.after(() => { if (previous === undefined) delete process.env.ESB_MODELS_PATH; else process.env.ESB_MODELS_PATH = previous; });
  const engine = new TranscriptionEngine();
  assert.equal((await engine.status()).available, true);
  assert.equal((await engine.check('sensevoice-2024-07-17')).ok, true);
  const en = await engine.transcribe(path.join(realAudio!, 'en.wav'), { model: 'sensevoice-2024-07-17', language: 'auto' });
  assert.match(en.segments.map((s) => s.text).join(' '), /tribal chieftain/i);
  const ja = await engine.transcribe(path.join(realAudio!, 'ja.wav'), { model: 'sensevoice-2024-07-17', language: 'ja' });
  assert.match(ja.segments.map((s) => s.text).join(''), /中学/);
  assert.ok(en.segments.every((s) => s.end > s.start && s.start >= 0));
  // SenseVoice takes a language as a hint: a change must only leave it working.
  const changed = await engine.transcribe(path.join(realAudio!, 'ja.wav'), { model: 'sensevoice-2024-07-17', language: 'auto', changes: [{ at: 0, language: 'en' }] });
  assert.match(changed.segments.map((s) => s.text).join(''), /中学/);
});

test('real model: a change of language gives Whisper exactly what that language gives', { skip: !realModels || !realAudio || !fs.existsSync(path.join(realModels, 'whisper-large-v3-turbo')) ? 'set STT_TEST_MODELS, with Whisper, and STT_TEST_AUDIO to run' : false }, async (t) => {
  const previous = process.env.ESB_MODELS_PATH;
  process.env.ESB_MODELS_PATH = realModels;
  t.after(() => { if (previous === undefined) delete process.env.ESB_MODELS_PATH; else process.env.ESB_MODELS_PATH = previous; });
  const engine = new TranscriptionEngine();
  const options = { model: 'whisper-large-v3-turbo' };
  const text = (r: { segments: { text: string }[] }) => r.segments.map((s) => s.text).join('');
  const wav = path.join(realAudio!, 'en.wav');
  const switched = await engine.transcribe(wav, { ...options, language: 'en', changes: [{ at: 0, language: 'ja' }] });
  assert.equal(text(switched), text(await engine.transcribe(wav, { ...options, language: 'ja' })));
  assert.notEqual(text(switched), text(await engine.transcribe(wav, { ...options, language: 'en' })));

  // Following a recording: a change sent before its audio, as the dashboard does.
  const segments: { text: string }[] = [];
  const session = await engine.follow(wav, { ...options, language: 'en', onSegment: (s) => segments.push(s) });
  const bytes = (await fsp.stat(wav)).size - 44;
  session.language(0, 'ja');
  session.committed(bytes);
  const result = await session.end(bytes, 120_000);
  assert.ok(result.ok && !result.lateLanguage);
  assert.match(text({ segments }), /\p{Script=Katakana}|\p{Script=Hiragana}/u, 'the change reached the job that follows a recording');
});

test('a worker that ignores the stop signal is killed before the next job may start; the real worker exits when the dashboard goes away', async (t) => {
  const dir = await tmp(t);
  // A real child that ignores SIGTERM and never answers the job. It says when it ignores SIGTERM, and only then is
  // the job stopped: however slowly the child starts on a busy machine, the stop finds it ignoring the signal.
  const stubborn = path.join(dir, 'stubborn.cjs');
  await fsp.writeFile(stubborn, "process.on('SIGTERM', () => {}); process.on('disconnect', () => {}); process.send({ type: 'ready' }); setInterval(() => {}, 1000);");
  let child: ChildProcess | null = null;
  let readyAt = 0;
  const stop = new AbortController();
  const launcher: WorkerLauncher = () => {
    child = fork(stubborn, [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    child.on('message', (m: { type?: string }) => { if (m.type === 'ready') { readyAt = Date.now(); stop.abort(); } });
    return child;
  };
  const engine = new TranscriptionEngine(new TranscriptionModelService(), launcher);
  const run = (engine as unknown as { run: (r: WorkerRequest, ms: number, on: () => void, s?: AbortSignal) => Promise<void> }).run.bind(engine);
  await assert.rejects(run({ type: 'version' }, 120_000, () => {}, stop.signal), /Cancelled/);
  assert.ok(readyAt > 0, 'stopped once the worker ignored SIGTERM');
  assert.ok(child!.exitCode !== null || child!.signalCode !== null, 'the worker has really exited before the job is over');
  assert.equal(child!.signalCode, 'SIGKILL', 'killed outright after ignoring the polite signal');
  assert.ok(Date.now() - readyAt >= 3000, 'it was given its grace period first');

  // The real worker, with nothing to do: when the dashboard disconnects, it exits.
  const worker = launchWorker();
  const exited = new Promise<number | null>((resolve) => worker.once('exit', (code) => resolve(code)));
  await new Promise((r) => setTimeout(r, 300));
  worker.disconnect();
  const code = await Promise.race([exited, new Promise<'alive'>((r) => setTimeout(() => r('alive'), 5000))]);
  assert.notEqual(code, 'alive', 'the worker exits on its own');
});

test('messages a worker sends after its job ended are ignored', async (t) => {
  await installedModels(t);
  let late: (() => void) | null = null;
  const chatty = fakeWorker((_request, reply) => {
    late = () => { reply({ type: 'progress', done: 5, total: 10 }); reply({ type: 'segment', start: 0, end: 1, text: 'too late' }); };
  });
  const engine = new TranscriptionEngine(new TranscriptionModelService(), chatty.launcher);
  const run = (engine as unknown as { run: (r: WorkerRequest, ms: number, on: (reply: WorkerReply) => void, s?: AbortSignal) => Promise<void> }).run.bind(engine);
  const controller = new AbortController();
  const seen: WorkerReply[] = [];
  const job = run({ type: 'version' }, 60_000, (reply) => seen.push(reply), controller.signal);
  await new Promise((r) => setTimeout(r, 20));
  controller.abort();
  await assert.rejects(job, /Cancelled/);
  late!();
  assert.deepEqual(seen, [], 'nothing reaches the cancelled job');
});

test('a model in use cannot be removed, from this dashboard or another one; a lease left by a process that is gone does not count', async (t) => {
  const dir = await installedModels(t);
  // A fictional installed model: files and the record the downloader writes.
  const service = new TranscriptionModelService();
  const model = 'sensevoice-2024-07-17';
  await fsp.mkdir(path.join(dir, model), { recursive: true });
  const { CATALOG } = await import('../src/services/transcriptionModels');
  const entry = CATALOG.find((m) => m.id === model)!;
  // installed() checks names, recorded hashes and sizes: sparse files of the right size are enough here.
  for (const f of entry.files) { const h = await fsp.open(path.join(dir, model, f.name), 'w'); await h.truncate(f.size); await h.close(); }
  await fsp.writeFile(path.join(dir, model, 'installed.json'), JSON.stringify({ id: model, files: entry.files.map((f) => ({ name: f.name, sha256: f.sha256 })) }));
  assert.equal(await service.installed(model), true);

  const release = await service.lease(model);
  await assert.rejects(service.remove(model), /in use/);
  await release();
  // Another dashboard's lease (a live process) blocks too; a lease from a process that is gone does not.
  await fsp.writeFile(path.join(dir, model, `.lease-${process.ppid}-other`), '{}');
  await assert.rejects(service.remove(model), /in use/);
  await fsp.rename(path.join(dir, model, `.lease-${process.ppid}-other`), path.join(dir, model, `.lease-${2 ** 22 + 777}-gone`));
  await service.remove(model);
  assert.equal(await service.installed(model), false);
});

test('a worker that will not exit keeps the job slot and the model lease until it really does; shutdown stops jobs still preparing', async (t) => {
  await fakeInstall(await installedModels(t), ['sensevoice-2024-07-17', 'silero-vad']);
  // A child that never answers and ignores every signal until the test lets it go.
  let child: (EventEmitter & { exitCode: number | null; signalCode: string | null }) | null = null;
  const launches: number[] = [];
  const launcher: WorkerLauncher = () => {
    launches.push(Date.now());
    const c = Object.assign(new EventEmitter(), { exitCode: null as number | null, signalCode: null as string | null, connected: true, stderr: new EventEmitter() });
    Object.assign(c, { send: () => true, kill: () => true, disconnect: () => { c.connected = false; } });
    child = c;
    return c as unknown as ChildProcess;
  };
  let released = 0;
  const models = Object.assign(new TranscriptionModelService(), { lease: async () => async () => { released++; } });
  const engine = new TranscriptionEngine(models, launcher);
  const run = (engine as unknown as { run: (r: WorkerRequest, ms: number, on: () => void, s?: AbortSignal, after?: () => Promise<void>) => Promise<void> }).run.bind(engine);
  await assert.rejects(run({ type: 'version' }, 50, () => {}, undefined, async () => { released++; }), /took too long/);
  assert.equal(released, 0, 'the lease is kept while the worker lives');
  assert.match((await engine.status()).error!, /already running/, 'and so is the job slot');
  child!.signalCode = 'SIGKILL';
  child!.emit('exit', null, 'SIGKILL');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(released, 1, 'given back once it exited');

  // A check still taking its lease when the shutdown starts never launches a worker.
  let letGo!: () => void;
  const slowLease = Object.assign(new TranscriptionModelService(), { lease: () => new Promise<() => Promise<void>>((resolve) => { letGo = () => resolve(async () => { released++; }); }) });
  const preparing = new TranscriptionEngine(slowLease, launcher).check('sensevoice-2024-07-17');
  await new Promise((r) => setTimeout(r, 10));
  const before = launches.length;
  await TranscriptionEngine.stopAll();
  t.after(() => TranscriptionEngine.reopen());
  letGo();
  const outcome = await preparing.catch((err: Error) => ({ ok: false, message: err.message }));
  assert.equal(launches.length, before, 'no worker started after the shutdown began');
  assert.match(outcome.message, /shutting down/);
  assert.equal(released, 2, 'its lease was given back');
});

test('a follow job whose worker never starts gives back the slot and the lease, and its end does not hang', async (t) => {
  const dir = await installedModels(t);
  void dir;
  const launcher: WorkerLauncher = () => fork(path.join(os.tmpdir(), 'gtd-no-such-worker.js'), [], { execPath: '/nonexistent/node', stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const engine = new TranscriptionEngine(new TranscriptionModelService(), launcher);
  const session = await engine.follow('/fictional.wav', { model: 'sensevoice-2024-07-17', language: 'auto', onSegment: () => {} }).catch((err: Error) => err);
  if (!(session instanceof Error)) {
    const started = Date.now();
    const result = await session.end(0, 5000);
    assert.equal(result.ok, false);
    assert.ok(Date.now() - started < 10_000, 'end returned');
  }
  // The slot is free again: a check can run.
  for (let i = 0; i < 50 && TranscriptionEngine.isBusy(); i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(TranscriptionEngine.isBusy(), false);
});

test('a model stuck in a loop is marked; numbers, words and people repeating themselves stay', () => {
  const loop = 'non mi sa di metà, '.repeat(6);
  assert.equal(markRepeats(`ma sai che ${loop}`), 'ma sai che non mi sa di metà [repeated 6 times]');
  assert.equal(markRepeats('私は'.repeat(8)), '私は [repeated 8 times]');
  for (const kept of ['10000 people', 'The code is 1111.', '1000 1000 1000 1000 1000 1000 1000', 'no, no, no, no, stop', 'ha ha ha ha', 'Mississippi, Tennessee', 'Hello, how are you doing?', 'hahahahaha', 'ありがとうございます']) {
    assert.equal(markRepeats(kept), kept);
  }
  const started = performance.now();
  markRepeats('ab '.repeat(5000) + 'x y z, '.repeat(5000));
  assert.ok(performance.now() - started < 2000, 'quick on long text');
});

test('context stays out of a part\'s neighbours, and a part always keeps its own speech', () => {
  const around = { previousEnd: 0, next: null, heard: 100_000, ending: false };
  assert.deepEqual(contextRange(16_000, 24_000, around), { from: 11_200, to: 30_400 }, '0.3 s before, 0.4 s after');
  assert.deepEqual(contextRange(1_000, 9_000, around), { from: 0, to: 15_400 }, 'not before the recording');
  assert.deepEqual(contextRange(16_000, 24_000, { ...around, previousEnd: 15_000 }), { from: 15_000, to: 30_400 }, 'not into the part before');
  assert.deepEqual(contextRange(16_000, 24_000, { ...around, previousEnd: 16_000, next: 26_000 }), { from: 16_000, to: 26_000 }, 'not into the part after');
  assert.deepEqual(contextRange(16_000, 24_000, { ...around, heard: 26_000 }), { from: 11_200, to: 26_000 }, 'only what was heard');
  assert.deepEqual(contextRange(16_000, 24_000, { ...around, heard: 20_000 }), { from: 11_200, to: 24_000 }, 'a part is never shortened');
  assert.deepEqual(contextRange(16_000, 216_000, { ...around, heard: 300_000 }), { from: 11_200, to: 216_000 }, 'a long stretch may end in a short pause: speech can go on');
  assert.deepEqual(contextRange(16_000, 216_000, { ...around, heard: 216_100, ending: true }), { from: 11_200, to: 216_100 }, 'the end of a recording counts, whatever its length');
});

test('speech too long for the model is split at its quietest moment, and nothing is lost', () => {
  const samples = new Float32Array(100_000).fill(0.5);
  samples.fill(0, 36_000, 37_600);
  const parts = splitLong({ start: 500, samples }, 40_000, 8_000);
  assert.ok(parts.length >= 2);
  assert.equal(parts[0]!.start, 500);
  assert.ok(parts[0]!.samples.length > 35_000 && parts[0]!.samples.length < 38_000, 'at the pause');
  let at = 500;
  for (const part of parts) {
    assert.equal(part.start, at, 'each part starts where the one before ended');
    assert.ok(part.samples.length <= 40_000);
    at += part.samples.length;
  }
  assert.equal(at, 100_500, 'every sample in exactly one part');
  assert.deepEqual(splitLong({ start: 7, samples: new Float32Array(10) }, 40_000, 8_000).map((p) => [p.start, p.samples.length]), [[7, 10]]);
});

test('recent audio keeps the last stretch, also across the end of its buffer', () => {
  const audio = new RecentAudio(10);
  audio.add(Float32Array.from([0, 1, 2, 3, 4, 5, 6, 7]));
  audio.add(Float32Array.from([8, 9, 10, 11]));
  assert.equal(audio.seen, 12);
  assert.deepEqual([...audio.slice(5, 12)!], [5, 6, 7, 8, 9, 10, 11]);
  assert.equal(audio.slice(1, 5), null, 'gone');
  assert.equal(audio.slice(5, 13), null, 'not heard yet');
  assert.equal(audio.slice(6, 5), null);
  audio.add(new Float32Array(25).map((_, i) => i));
  assert.deepEqual([...audio.slice(34, 37)!], [22, 23, 24], 'more than it holds at once');
});

test('a part ends where the language changes, unless that leaves almost nothing', () => {
  const part = { start: 16_000, samples: new Float32Array(160_000) };
  const pieces = (at: number[]) => splitAtChanges(part, at).map((p) => [p.start, p.samples.length]);
  assert.deepEqual(pieces([]), [[16_000, 160_000]]);
  assert.deepEqual(pieces([5]), [[16_000, 64_000], [80_000, 96_000]]);
  assert.deepEqual(pieces([3, 7]), [[16_000, 32_000], [48_000, 64_000], [112_000, 64_000]]);
  assert.deepEqual(pieces([0.5, 1.1, 11.9, 20]), [[16_000, 160_000]], 'outside it, or within a moment of its ends');
});

test('speaker turns: numbered by who speaks first, a short sound is no speaker, and a guess stays unassigned', () => {
  const turns = speakerTurns([{ start: 9, end: 12, speaker: 0 }, { start: 1, end: 4, speaker: 7 }, { start: 4, end: 8, speaker: 7 }, { start: 20, end: 15, speaker: 3 }, { start: NaN, end: 2, speaker: 3 }, { start: 11, end: 99, speaker: 2 }, { start: 8.5, end: 9, speaker: 5 }], 13);
  assert.deepEqual(turns, [{ start: 1, end: 4, speaker: 1 }, { start: 4, end: 8, speaker: 1 }, { start: 8.5, end: 9, speaker: 0 }, { start: 9, end: 12, speaker: 2 }, { start: 11, end: 13, speaker: 3 }], 'half a second of a fifth voice gets no number');
  assert.deepEqual(speakerCuts(turns), [8.5, 9, 11], 'but it still marks where the voice changes');
  // A short reply between two turns of another voice: its own part, under no name.
  const reply = speakerTurns([{ start: 0, end: 3, speaker: 4 }, { start: 3, end: 4.5, speaker: 9 }, { start: 4.5, end: 7.5, speaker: 4 }], 8);
  assert.deepEqual(speakerCuts(reply), [3, 4.5]);
  assert.equal(speakerOf(3, 4.5, reply), undefined);
  assert.equal(speakerOf(0, 3, reply), 1);
  assert.equal(speakerOf(1, 8, turns), 1);
  assert.equal(speakerOf(0, 10, turns), 1, 'pauses in a part do not count against its voice');
  assert.equal(speakerOf(7, 10, turns), undefined, 'half one voice, half another');
  assert.equal(speakerOf(30, 31, turns), undefined, 'nobody known there');
  assert.equal(speakerOf(0, 10, [{ start: 4, end: 4.1, speaker: 1 }]), undefined, 'one known moment says nothing about ten seconds');
  assert.equal(speakerOf(0, 10, [{ start: 0, end: 9, speaker: 1 }, { start: 3, end: 7, speaker: 2 }]), undefined, 'two voices at once');
  assert.deepEqual(cutsAround([2, 5, 9], 5, 8), { before: 5, after: 9 });
  assert.deepEqual(cutsAround([2, 5, 9], 0.5, 1), { before: 0, after: 2 });
  assert.deepEqual(cutsAround([], 1, 2), { before: 0, after: null });
  // A short remark between two turns of another voice keeps a part of its own.
  const part = { start: 0, samples: new Float32Array(32_000) };
  assert.deepEqual(splitAtChanges(part, [1, 1.2], SHORTEST_TURN).map((p) => [p.start, p.samples.length]), [[0, 16_000], [16_000, 3200], [19_200, 12_800]]);
});

test('real model: two voices are told apart and each part says whose it is', { skip: !realModels || !realAudio || !fs.existsSync(path.join(realModels, 'speaker-detection')) ? 'set STT_TEST_MODELS, with the speaker model, and STT_TEST_AUDIO to run' : false }, async (t) => {
  const previous = process.env.ESB_MODELS_PATH;
  process.env.ESB_MODELS_PATH = realModels;
  t.after(() => { if (previous === undefined) delete process.env.ESB_MODELS_PATH; else process.env.ESB_MODELS_PATH = previous; });
  // Two different voices, one after the other.
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-speakers-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const [en, ja] = await Promise.all(['en.wav', 'ja.wav'].map((n) => fsp.readFile(path.join(realAudio!, n))));
  const body = Buffer.concat([en!.subarray(44), ja!.subarray(44), en!.subarray(44), ja!.subarray(44)]);
  const head = Buffer.from(en!.subarray(0, 44));
  head.writeUInt32LE(36 + body.length, 4);
  head.writeUInt32LE(body.length, 40);
  const wav = path.join(dir, 'two.wav');
  await fsp.writeFile(wav, Buffer.concat([head, body]));
  const engine = new TranscriptionEngine();
  const { segments, speaker_note } = await engine.transcribeWithSpeakers(wav, { model: 'sensevoice-2024-07-17', language: 'auto' });
  assert.equal(speaker_note, null);
  assert.equal(TranscriptionEngine.isBusy(), false, 'the slot is free afterwards');
  const of = (text: RegExp) => segments.filter((s) => text.test(s.text)).map((s) => s.speaker);
  assert.equal(new Set(of(/tribal/i)).size, 1, 'the English voice is one speaker');
  assert.equal(new Set(of(/中学/)).size, 1, 'the Japanese voice is one speaker');
  assert.notEqual(of(/tribal/i)[0], of(/中学/)[0]);
});

test('finding speakers failing leaves the transcript, the slot is kept between the two jobs, and a Stop ends both', async (t) => {
  const dir = await tmp(t);
  const replies: Record<string, string> = {
    speakers: "process.exit(9)",
    transcribe: "process.send({ type: 'segment', start: 0, end: 1, text: 'Fictional words.' }); process.send({ type: 'done', seconds: 1, segments: 1 })",
  };
  const script = path.join(dir, 'worker.cjs');
  await fsp.writeFile(script, `process.on('message', (m) => { ({ ${Object.entries(replies).map(([k, v]) => `${k}: () => { ${v} }`).join(', ')} })[m.type](); });`);
  const seen: boolean[] = [];
  const launcher: WorkerLauncher = () => { seen.push(TranscriptionEngine.isBusy()); return fork(script, [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }); };
  const models = {
    readSettings: async () => ({ model: 'whisper-large-v3-turbo', language: 'auto' }),
    lease: async () => async () => {},
    installedPath: async () => dir,
  } as unknown as TranscriptionModelService;
  const engine = new TranscriptionEngine(models, launcher);
  (engine as unknown as { engineModel: () => Promise<unknown> }).engineModel = async () => ({ kind: 'whisper', files: {}, vad: '', threads: 1 });
  const wav = path.join(dir, 'a.wav');
  const data = Buffer.alloc(32_000);
  const head = Buffer.alloc(44);
  head.write('RIFF', 0, 'ascii'); head.writeUInt32LE(36 + data.length, 4); head.write('WAVE', 8, 'ascii');
  head.write('fmt ', 12, 'ascii'); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22);
  head.writeUInt32LE(16000, 24); head.writeUInt32LE(32000, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34);
  head.write('data', 36, 'ascii'); head.writeUInt32LE(data.length, 40);
  await fsp.writeFile(wav, Buffer.concat([head, data]));

  const result = await engine.transcribeWithSpeakers(wav);
  assert.equal(result.speaker_note, 'speaker detection failed');
  assert.deepEqual(result.segments.map((s) => s.text), ['Fictional words.']);
  assert.deepEqual(seen, [true, true], 'nothing else could take the slot before either worker');
  assert.equal(TranscriptionEngine.isBusy(), false);

  const stop = new AbortController();
  stop.abort();
  await assert.rejects(engine.transcribeWithSpeakers(wav, { signal: stop.signal }), /Cancelled/);
  assert.equal(TranscriptionEngine.isBusy(), false);
});
