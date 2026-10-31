import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn } from 'node:child_process';
import { HelperError, startHelper, whisperHelperPath } from '../src/services/transcription/whisperHelper';
import { launchWorker } from '../src/services/transcription/engine';
import type { WorkerReply, WorkerRequest } from '../src/services/transcription/protocol';

async function tmp(t: { after: (fn: () => Promise<void> | void) => void }): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-helper-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * A stand-in for gtd-whisper that speaks its protocol: `mode` decides how it misbehaves. Its pid goes to `pid`, so a
 * test can tell it has really exited.
 */
async function fakeHelper(dir: string, mode: string): Promise<string> {
  const script = path.join(dir, `fake-${mode}.cjs`);
  await fsp.writeFile(script, `
const fs = require('fs');
fs.writeFileSync(${JSON.stringify(path.join(dir, 'pid'))}, String(process.pid));
const mode = ${JSON.stringify(mode)};
// Like the real one: it ends itself when the worker it was given is gone, and loads nothing before "start".
const parentArg = process.argv.indexOf('--parent');
const parent = parentArg > 0 ? Number(process.argv[parentArg + 1]) : process.ppid;
if (process.ppid !== parent) process.exit(3);
setInterval(() => { if (process.ppid !== parent) process.exit(3); }, 200);
let started = false;
function startUp() {
  fs.writeFileSync(${JSON.stringify(path.join(dir, 'loading'))}, '');
  if (mode === 'no-load') { process.stdout.write(JSON.stringify({ type: 'error', message: 'bad model' }) + '\\n'); process.exit(1); }
  if (mode === 'slow-load') return;
  if (mode === 'text-first') { process.stdout.write(JSON.stringify({ type: 'text', id: 1, text: 'x', language: 'en' }) + '\\n'); return; }
  if (mode === 'bad-ready') { process.stdout.write('hello\\n'); return; }
  console.error('whisper_backend_init_gpu: using MTL0 backend');
  process.stdout.write(JSON.stringify({ type: 'ready', version: 'fake', backend: 'MTL0', ms: 5 }) + '\\n');
  if (mode === 'chatty') for (let i = 0; i < 1000; i++) process.stdout.write(JSON.stringify({ type: 'text', id: 1, text: 'x', language: 'en' }) + '\\n');
}
let buffer = Buffer.alloc(0); let header = null; let parts = 0;
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  if (!started) {
    const nl = buffer.indexOf(10); if (nl < 0) return;
    if (buffer.subarray(0, nl).toString() !== 'start') process.exit(5);
    buffer = buffer.subarray(nl + 1); started = true; startUp();
  }
  for (;;) {
    if (!header) { const nl = buffer.indexOf(10); if (nl < 0) return; header = JSON.parse(buffer.subarray(0, nl).toString()); buffer = buffer.subarray(nl + 1); }
    if (buffer.length < header.samples * 4) return;
    const samples = new Float32Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + header.samples * 4));
    buffer = buffer.subarray(header.samples * 4); const id = header.id; header = null; parts++;
    if (mode === 'crash' && parts === 2) process.exit(9);
    if (mode === 'hang' && parts === 2) return;
    if (mode === 'wrong-id') { process.stdout.write(JSON.stringify({ type: 'text', id: id + 7, text: 'x', language: 'en' }) + '\\n'); continue; }
    if (mode === 'garbage') { process.stdout.write('not json\\n'); continue; }
    if (mode === 'endless' && parts === 2) { const junk = 'x'.repeat(65536); setInterval(() => process.stdout.write(junk), 1); return; }
    if (mode === 'long-line' && parts === 2) { process.stdout.write(JSON.stringify({ type: 'text', id, text: 'y'.repeat(2 << 20), language: 'en' }) + '\\n'); continue; }
    if (mode === 'trailing') { process.stdout.write(JSON.stringify({ type: 'text', id, text: ' fine', language: 'en' }) + '\\nnot json\\n'); continue; }
    if (mode === 'slow') { setTimeout(() => process.stdout.write(JSON.stringify({ type: 'text', id, text: ' slow part', language: 'en', ms: 1 }) + '\\n'), 1500); continue; }
    const text = ' ' + samples.length + ' samples, first ' + samples[0].toFixed(2);
    process.stdout.write(JSON.stringify({ type: 'text', id, text, language: 'en', ms: 1 }) + '\\n');
  }
});
process.stdin.on('end', () => process.exit(0));
`);
  // A program, as the real helper is: a small shell script that runs the stand-in with this Node.
  const program = path.join(dir, `fake-${mode}`);
  await fsp.writeFile(program, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`, { mode: 0o755 });
  return program;
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const pidOf = async (dir: string) => Number(await fsp.readFile(path.join(dir, 'pid'), 'utf-8'));
const posix = process.platform === 'win32' ? 'the helper is for macOS and Linux' : false;

test('GPU helper: parts go one at a time in order, with the device it reported, and close waits for the exit', { skip: posix }, async (t) => {
  const dir = await tmp(t);
  const helper = await startHelper(await fakeHelper(dir, 'ok'), 'model.bin', { threads: 2 });
  assert.equal(helper.backend, 'MTL0');
  const parts = await Promise.all([helper.decode(new Float32Array([0.5, 0, 0]), 'auto'), helper.decode(new Float32Array(16000).fill(-0.25), 'ja')]);
  assert.deepEqual(parts.map((p) => p.text), [' 3 samples, first 0.50', ' 16000 samples, first -0.25']);
  await assert.rejects(helper.decode(new Float32Array(3), 'en; rm'), (err: unknown) => err instanceof HelperError && err.failure === 'protocol');
  const pid = await pidOf(dir);
  await helper.close();
  assert.equal(alive(pid), false, 'the helper has exited when close resolves');
});

test('GPU helper: each way it can fail is told apart, and it never outlives the failure', { skip: posix }, async (t) => {
  const dir = await tmp(t);
  const failure = async (mode: string, options: { loadTimeoutMs?: number; partTimeoutMs?: number } = {}) => {
    const sub = path.join(dir, mode);
    await fsp.mkdir(sub);
    try {
      const helper = await startHelper(await fakeHelper(sub, mode), 'model.bin', { threads: 1, ...options });
      await helper.decode(new Float32Array(10), 'en');
      try { await helper.decode(new Float32Array(10), 'en'); } finally { await helper.close(); }
      return 'no failure';
    } catch (err) {
      assert.ok(err instanceof HelperError, `${mode}: ${String(err)}`);
      const pid = await pidOf(sub);
      for (let i = 0; i < 50 && alive(pid); i++) await new Promise((r) => setTimeout(r, 100));
      assert.equal(alive(pid), false, `${mode}: the helper is gone`);
      return err.failure;
    }
  };
  assert.equal(await failure('no-load'), 'load');
  assert.equal(await failure('slow-load', { loadTimeoutMs: 500 }), 'load');
  assert.equal(await failure('crash'), 'gpu');
  assert.equal(await failure('hang', { partTimeoutMs: 500 }), 'timeout');
  assert.equal(await failure('wrong-id'), 'protocol');
  assert.equal(await failure('garbage'), 'protocol');
  // Nothing it sends is held without limit: a line without end, a line too long, or replies nobody asked for.
  assert.equal(await failure('endless'), 'protocol');
  assert.equal(await failure('long-line'), 'protocol');
  assert.equal(await failure('chatty'), 'protocol');
  assert.equal(await failure('bad-ready'), 'protocol');
  assert.equal(await failure('text-first'), 'protocol', 'a reply that is not "ready" at start is a broken helper, not a model that failed to load');
  // A good reply with bad output right behind it in the same write: the part it answers fails too.
  const sub = path.join(dir, 'trailing-first');
  await fsp.mkdir(sub);
  const trailing = await startHelper(await fakeHelper(sub, 'trailing'), 'model.bin', { threads: 1 });
  await assert.rejects(trailing.decode(new Float32Array(10), 'en'), (err: unknown) => err instanceof HelperError && err.failure === 'protocol');
  await trailing.close();
  await assert.rejects(startHelper(path.join(dir, 'missing-program'), 'model.bin', { threads: 1 }), (err: unknown) => err instanceof HelperError && err.failure === 'missing');
});

test('GPU helper: only a helper that is there is offered', async (t) => {
  const dir = await tmp(t);
  assert.equal(whisperHelperPath({}), null);
  assert.equal(whisperHelperPath({ GTD_WHISPER_HELPER: path.join(dir, 'nothing') }), null);
  assert.equal(whisperHelperPath({ GTD_WHISPER_HELPER: dir }), null, 'a folder is not a program');
  await fsp.writeFile(path.join(dir, 'gtd-whisper'), '');
  assert.equal(whisperHelperPath({ GTD_WHISPER_HELPER: path.join(dir, 'gtd-whisper') }), path.join(dir, 'gtd-whisper'));
});

// The real helper and a GGML model: GTD_WHISPER_HELPER, STT_TEST_GGML (a Whisper .bin), STT_TEST_MODELS (for the VAD)
// and STT_TEST_AUDIO (en.wav).
const realHelper = whisperHelperPath();
const ggml = process.env['STT_TEST_GGML'];
const realModels = process.env['STT_TEST_MODELS'];
const realAudio = process.env['STT_TEST_AUDIO'];
const real = !realHelper || !ggml || !realModels || !realAudio ? 'set GTD_WHISPER_HELPER, STT_TEST_GGML, STT_TEST_MODELS and STT_TEST_AUDIO to run' : false;

test('real GPU helper: the worker transcribes with it part by part, on the device it reports', { skip: real }, async () => {
  const worker = launchWorker();
  const replies: WorkerReply[] = [];
  const done = new Promise<void>((resolve) => {
    worker.on('message', (m: WorkerReply) => {
      replies.push(m);
      // As the dashboard does: the helper loads once its owner has recorded it.
      if (m.type === 'helper') worker.send({ type: 'helper-known' });
      if (m.type === 'done' || m.type === 'error') resolve();
    });
    worker.once('exit', () => resolve());
  });
  const request: WorkerRequest = {
    type: 'transcribe', wav: path.join(realAudio!, 'en.wav'), language: 'auto',
    model: { kind: 'whisper-cpp', files: { model: ggml! }, helper: realHelper!, vad: path.join(realModels!, 'silero-vad', 'silero_vad.onnx'), threads: 4 },
  };
  worker.send(request);
  await done;
  const error = replies.find((r) => r.type === 'error');
  assert.equal(error, undefined, JSON.stringify(error));
  const loaded = replies.find((r): r is Extract<WorkerReply, { type: 'loaded' }> => r.type === 'loaded');
  if (process.platform === 'darwin' && process.arch === 'arm64') assert.match(loaded?.backend ?? '', /^MTL/, 'Metal, not a silent fallback to the CPU');
  const text = replies.filter((r): r is Extract<WorkerReply, { type: 'segment' }> => r.type === 'segment').map((s) => s.text).join(' ');
  assert.match(text, /tribal chieftain/i);
});

test('real GPU helper: it ends by itself when the process that started it is killed', { skip: real }, async (t) => {
  const dir = await tmp(t);
  // A parent that starts the helper, says its pid, and is then killed without any chance to clean up.
  const parent = spawn(process.execPath, ['-e', `
    const c = require('child_process').spawn(${JSON.stringify(realHelper)}, ['--model', ${JSON.stringify(ggml)}, '--threads', '1', '--parent', String(process.pid)], { stdio: ['pipe', 'pipe', 'ignore'] });
    c.stdin.write('start\\n');
    c.stdout.once('data', () => process.stdout.write(String(c.pid) + '\\n'));
    setInterval(() => {}, 1000);
  `], { stdio: ['ignore', 'pipe', 'ignore'] });
  const pid = await new Promise<number>((resolve) => parent.stdout.once('data', (d: Buffer) => resolve(Number(d.toString().trim()))));
  assert.equal(alive(pid), true);
  parent.kill('SIGKILL');
  let gone = false;
  for (let i = 0; i < 60 && !gone; i++) { await new Promise((r) => setTimeout(r, 100)); gone = !alive(pid); }
  assert.equal(gone, true, 'the helper ended within a few seconds');
  void dir;

  // Started for a worker that is already gone: it ends at once, before loading anything.
  const orphan = spawn(realHelper!, ['--model', ggml!, '--threads', '1', '--parent', '1'], { stdio: ['pipe', 'pipe', 'ignore'] });
  orphan.stdin.write('start\n');
  const code = await new Promise<number | null>((resolve) => orphan.once('exit', (c) => resolve(c)));
  assert.equal(code, 3);
});

// Through the engine: the job's slot and model are free only once the GPU engine is gone, however the job ended.
// Needs the VAD (STT_TEST_MODELS) and speech (STT_TEST_AUDIO); uses the real helper when there is one, else a stand-in.
const lifecycle = !realModels || !realAudio || process.platform === 'win32' ? 'set STT_TEST_MODELS and STT_TEST_AUDIO to run' : false;

test('GPU helper through the engine: a job that ends, is stopped or whose worker is killed frees its slot only after the helper is gone', { skip: lifecycle }, async (t) => {
  const dir = await tmp(t);
  const { TranscriptionEngine } = await import('../src/services/transcription/engine');
  const { TranscriptionModelService } = await import('../src/services/transcriptionModels');
  const program = realHelper ?? await fakeHelper(dir, 'slow');
  let worker: import('node:child_process').ChildProcess | null = null;
  const engine = new TranscriptionEngine(new TranscriptionModelService(), () => (worker = launchWorker()));
  const run = (engine as unknown as { run: (r: WorkerRequest, ms: number, on: (reply: WorkerReply) => void, s?: AbortSignal) => Promise<void> }).run.bind(engine);
  const request: WorkerRequest = {
    type: 'transcribe', wav: path.join(realAudio!, 'en.wav'), language: 'auto',
    model: { kind: 'whisper-cpp', files: { model: ggml ?? 'fake.bin' }, helper: program, vad: path.join(realModels!, 'silero-vad', 'silero_vad.onnx'), threads: 2 },
  };
  const job = async (during?: (helper: number) => void, signal?: AbortSignal) => {
    let helper = 0;
    const outcome = await run(request, 120_000, (reply) => {
      if (reply.type === 'helper') helper = reply.pid;
      if (reply.type === 'loaded') during?.(helper);
    }, signal).then(() => 'done', (err: Error) => err.message);
    return { outcome, helper };
  };

  const finished = await job();
  assert.equal(finished.outcome, 'done');
  assert.equal(alive(finished.helper), false, 'a finished job: the helper exited before the job was over');

  const stop = new AbortController();
  const stopped = await job(() => setTimeout(() => stop.abort(), 300), stop.signal);
  assert.match(stopped.outcome, /Cancelled/);
  assert.equal(alive(stopped.helper), false, 'a stopped job: the helper exited before the slot was free');

  const killed = await job(() => setTimeout(() => worker?.kill('SIGKILL'), 300));
  assert.match(killed.outcome, /stopped unexpectedly/);
  assert.equal(alive(killed.helper), false, 'a killed worker: the slot waited for the helper to end itself');
});

test('GPU helper through the engine: stopped or killed while the model loads, or failing to load, the slot waits for the helper', { skip: posix }, async (t) => {
  const dir = await tmp(t);
  const { TranscriptionEngine } = await import('../src/services/transcription/engine');
  const { TranscriptionModelService } = await import('../src/services/transcriptionModels');
  // One second of fictional silence: the job never gets past loading, so no VAD or speech is needed.
  const wav = path.join(dir, 'silence.wav');
  const data = Buffer.alloc(32000);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4); header.write('WAVEfmt ', 8); header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(data.length, 40);
  await fsp.writeFile(wav, Buffer.concat([header, data]));
  let worker: import('node:child_process').ChildProcess | null = null;
  const engine = new TranscriptionEngine(new TranscriptionModelService(), () => (worker = launchWorker()));
  const run = (engine as unknown as { run: (r: WorkerRequest, ms: number, on: (reply: WorkerReply) => void, s?: AbortSignal) => Promise<void> }).run.bind(engine);
  let jobs = 0;
  const job = async (mode: string, during: (helper: number) => void, signal?: AbortSignal) => {
    const sub = path.join(dir, `${mode}-${++jobs}`);
    await fsp.mkdir(sub);
    const request: WorkerRequest = { type: 'transcribe', wav, language: 'auto', model: { kind: 'whisper-cpp', files: { model: 'fake.bin' }, helper: await fakeHelper(sub, mode), vad: path.join(dir, 'no-vad.onnx'), threads: 1 } };
    let helper = 0;
    const outcome = await run(request, 120_000, (reply) => { if (reply.type === 'helper') { helper = reply.pid; during(helper); } }, signal).then(() => 'done', (err: Error) => err.message);
    return { outcome, helper };
  };
  const stop = new AbortController();
  const stopped = await job('slow-load', () => setTimeout(() => stop.abort(), 300), stop.signal);
  assert.match(stopped.outcome, /Cancelled/);
  assert.ok(stopped.helper > 0 && !alive(stopped.helper), 'stopped while loading: the helper is gone when the job is over');
  const killed = await job('slow-load', () => setTimeout(() => worker?.kill('SIGKILL'), 300));
  assert.match(killed.outcome, /stopped unexpectedly/);
  assert.ok(killed.helper > 0 && !alive(killed.helper), 'worker killed while loading: the slot waited for the helper');
  // Killed around the moment it reports the helper (the dashboard may already have confirmed it): nothing is left behind.
  const early = await job('ok', () => worker?.kill('SIGKILL'));
  assert.match(early.outcome, /stopped unexpectedly/);
  assert.ok(early.helper > 0 && !alive(early.helper), 'worker killed before the helper loaded: the helper is gone');
  const failed = await job('no-load', () => {});
  assert.match(failed.outcome, /could not load the model/);
  assert.ok(failed.helper > 0 && !alive(failed.helper), 'a model that does not load: the helper is gone');
});

test('GPU helper: until its owner confirms it, the helper loads nothing, and a worker killed before that leaves nothing', { skip: posix }, async (t) => {
  const dir = await tmp(t);
  const wav = path.join(dir, 'silence.wav');
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + 32000, 4); header.write('WAVEfmt ', 8); header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(32000, 40);
  await fsp.writeFile(wav, Buffer.concat([header, Buffer.alloc(32000)]));
  // The worker on its own, with no dashboard to confirm the helper: it reports it, and must then wait.
  const worker = launchWorker();
  const reported = new Promise<number>((resolve) => worker.on('message', (m: WorkerReply) => { if (m.type === 'helper') resolve(m.pid); }));
  worker.send({ type: 'transcribe', wav, language: 'auto', model: { kind: 'whisper-cpp', files: { model: 'fake.bin' }, helper: await fakeHelper(dir, 'ok'), vad: path.join(dir, 'no-vad.onnx'), threads: 1 } } satisfies WorkerRequest);
  const helper = await reported;
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(alive(helper), true);
  assert.equal(fs.existsSync(path.join(dir, 'loading')), false, 'nothing loaded before the confirmation');
  worker.kill('SIGKILL');
  for (let i = 0; i < 50 && alive(helper); i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(alive(helper), false, 'the helper ended without loading');
  assert.equal(fs.existsSync(path.join(dir, 'loading')), false);
});
