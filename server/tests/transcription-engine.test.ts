import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { readWavFormat, wavChunks, WavError } from '../src/services/transcription/wav';
import { TranscriptionEngine, type WorkerLauncher } from '../src/services/transcription/engine';
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
    const child = Object.assign(new EventEmitter(), { exitCode: null as number | null, signalCode: null as string | null, stderr: new EventEmitter() });
    const run = { request: null as WorkerRequest | null, killed: false };
    runs.push(run);
    Object.assign(child, {
      send: (request: WorkerRequest) => {
        run.request = request;
        setImmediate(() => answer(request, (r) => child.emit('message', r), child));
        return true;
      },
      kill: () => { run.killed = true; child.signalCode = 'SIGTERM'; return true; },
    });
    return child as unknown as ChildProcess;
  };
  return { launcher, runs };
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
});
