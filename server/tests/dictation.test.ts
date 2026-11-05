import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import express from 'express';
import { TranscriptionEngine, type WorkerLauncher } from '../src/services/transcription/engine';
import { CATALOG, TranscriptionModelService, VAD } from '../src/services/transcriptionModels';
import { dictate, MAX_DICTATION_BYTES, MAX_DICTATION_SECONDS } from '../src/services/transcription/dictation';
import type { WorkerReply, WorkerRequest } from '../src/services/transcription/protocol';
import transcriptionRoutes from '../src/routes/transcription';
import { errorHandler } from '../src/middleware/errorHandler';

type After = { after: (fn: () => Promise<void> | void) => void };

/** An empty models folder for this test, as ESB_MODELS_PATH. */
async function modelsFolder(t: After): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-dictation-test-'));
  const previous = process.env.ESB_MODELS_PATH;
  process.env.ESB_MODELS_PATH = dir;
  t.after(async () => {
    if (previous === undefined) delete process.env.ESB_MODELS_PATH; else process.env.ESB_MODELS_PATH = previous;
    await fsp.rm(dir, { recursive: true, force: true });
  });
  return dir;
}

/** Fictional installed models: files of the right names and sizes (sparse) and the record the downloader writes. */
async function fakeInstall(dir: string, ids: string[]): Promise<void> {
  for (const entry of [...CATALOG, VAD].filter((m) => ids.includes(m.id))) {
    await fsp.mkdir(path.join(dir, entry.id), { recursive: true });
    for (const f of entry.files) { const h = await fsp.open(path.join(dir, entry.id, f.name), 'w'); await h.truncate(f.size); await h.close(); }
    await fsp.writeFile(path.join(dir, entry.id, 'installed.json'), JSON.stringify({ id: entry.id, files: entry.files.map((f) => ({ name: f.name, sha256: f.sha256 })) }));
  }
}

/** A 16-bit WAV clip of silence, `seconds` long. */
function clip(seconds: number, rate = 16_000): Buffer {
  const data = Buffer.alloc(Math.round(seconds * rate) * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii'); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii'); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii'); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** A worker that answers like the real one; it records each request and whether the clip was there while it ran. */
function fakeWorker(segments: string[]) {
  const requests: WorkerRequest[] = [];
  const clipThere: boolean[] = [];
  const launcher: WorkerLauncher = () => {
    const child = Object.assign(new EventEmitter(), { exitCode: null as number | null, signalCode: null as string | null, stderr: new EventEmitter(), connected: true });
    Object.assign(child, {
      send: (request: WorkerRequest) => {
        requests.push(request);
        setImmediate(async () => {
          const reply = (r: WorkerReply) => child.emit('message', r);
          if (request.type !== 'transcribe') return;
          clipThere.push(await fsp.access(request.wav).then(() => true, () => false));
          reply({ type: 'loaded', ms: 5 });
          segments.forEach((text, i) => reply({ type: 'segment', start: i, end: i + 1, text }));
          reply({ type: 'done', seconds: 2, segments: segments.length });
        });
        return true;
      },
      kill: () => { setImmediate(() => { child.signalCode = 'SIGTERM'; child.emit('exit', null, 'SIGTERM'); }); return true; },
      disconnect: () => { child.connected = false; },
    });
    return child as unknown as ChildProcess;
  };
  return { launcher, requests, clipThere };
}

test('dictation: a clip becomes text with the chosen model, and the clip is not kept', async (t) => {
  const dir = await modelsFolder(t);
  await fakeInstall(dir, ['whisper-large-v3-turbo', 'whisper-large-v3', VAD.id]);
  const models = new TranscriptionModelService();
  const worker = fakeWorker([' Fictional first sentence, ', '', 'and a second one. ']);
  const engine = new TranscriptionEngine(models, worker.launcher);

  // No model asked for: the one chosen in Settings (the default here).
  const result = await dictate(engine, models, clip(2), undefined);
  assert.deepEqual(result, { text: 'Fictional first sentence, and a second one.', model: 'whisper-large-v3-turbo', seconds: 2 });
  const request = worker.requests[0] as Extract<WorkerRequest, { type: 'transcribe' }>;
  assert.equal(request.language, 'auto', 'the language set in Settings');
  assert.equal(worker.clipThere[0], true, 'the engine read the clip');
  await assert.rejects(fsp.access(request.wav), 'the clip is removed once transcribed');
  await assert.rejects(fsp.access(path.dirname(request.wav)), 'and its temporary folder');

  // Any other downloaded model can be asked for.
  assert.equal((await dictate(engine, models, clip(1), 'whisper-large-v3')).model, 'whisper-large-v3');
  assert.match(JSON.stringify(worker.requests[1]), /[\\/]whisper-large-v3[\\/]/, 'with that model\'s files');

  // A GPU model not verified on this computer runs as its CPU counterpart, as a meeting transcription does.
  assert.equal((await dictate(engine, models, clip(1), 'whisper-large-v3-turbo-gpu')).model, 'whisper-large-v3-turbo');
});

test('dictation: refused before the engine starts, with a reason, and nothing left behind', async (t) => {
  const dir = await modelsFolder(t);
  const models = new TranscriptionModelService();
  const worker = fakeWorker(['never']);
  const engine = new TranscriptionEngine(models, worker.launcher);
  const status = (err: unknown) => (err as { statusCode?: number }).statusCode;
  const before = new Set((await fsp.readdir(os.tmpdir())).filter((n) => n.startsWith('gtd-dictation-') && !n.startsWith('gtd-dictation-test-')));

  for (const [body, model, code, message] of [
    [undefined, undefined, 400, /WAV file/],
    [{}, undefined, 400, /WAV file/],
    [Buffer.alloc(0), undefined, 400, /WAV file/],
    [clip(1), 'not-a-model', 400, /Unknown model/],
    [clip(1), ['whisper-large-v3'], 400, /Unknown model/],
    [clip(1), '../../etc', 400, /Unknown model/],
    [Buffer.from('fictional text, not audio'), undefined, 400, /Not a WAV file/],
    // Under the size limit, but longer than a dictation: a clip at a low rate.
    [clip(MAX_DICTATION_SECONDS + 1, 4000), undefined, 413, /at most 5 minutes/],
    [clip(1), undefined, 409, /not downloaded yet/],
  ] as [unknown, unknown, number, RegExp][]) {
    await assert.rejects(dictate(engine, models, body, model), (err: Error) => status(err) === code && message.test(err.message), `${code} ${message}`);
  }
  assert.equal(worker.requests.length, 0, 'no worker was started');
  const after = (await fsp.readdir(os.tmpdir())).filter((n) => n.startsWith('gtd-dictation-') && !n.startsWith('gtd-dictation-test-') && !before.has(n));
  assert.deepEqual(after, [], 'no clip left in the temporary folder');

  // One job at a time: while a transcription runs, a dictation is refused instead of waiting behind a meeting.
  await fakeInstall(dir, ['whisper-large-v3-turbo', VAD.id]);
  const silent = fakeWorker([]);
  let launched = false;
  const busy = new TranscriptionEngine(models, () => { launched = true; return Object.assign(silent.launcher(), { send: () => true }); });
  const meeting = path.join(dir, 'fictional-meeting.wav');
  await fsp.writeFile(meeting, clip(1));
  const controller = new AbortController();
  const running = busy.transcribe(meeting, { signal: controller.signal }).catch(() => undefined);
  while (!launched) await new Promise((r) => setTimeout(r, 5));
  await assert.rejects(dictate(busy, models, clip(1), undefined), (err: Error) => status(err) === 409 && /already running/.test(err.message));
  controller.abort();
  await running;
});

test('dictation over HTTP: only WAV bytes, with a size limit', async (t) => {
  await modelsFolder(t);
  const app = express();
  app.use(express.json());
  app.use('/api/transcription', transcriptionRoutes);
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  t.after(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/transcription/dictation`;
  const post = (body: Buffer | string, type: string, query = '') => fetch(url + query, { method: 'POST', headers: { 'Content-Type': type }, body });

  assert.equal((await post(JSON.stringify({ audio: 'x' }), 'application/json')).status, 400, 'JSON is not a clip');
  assert.equal((await post(clip(1), 'application/octet-stream')).status, 400, 'only audio/wav');
  assert.equal((await post(clip(1), 'audio/wav', '?model=nope')).status, 400);
  assert.equal((await post(Buffer.alloc(MAX_DICTATION_BYTES + 1), 'audio/wav')).status, 413, 'the size limit');
  // Nothing downloaded in this models folder: a plain reason, and the real engine is never started.
  const missing = await post(clip(1), 'audio/wav');
  assert.equal(missing.status, 409);
  assert.match(((await missing.json()) as { message: string }).message, /not downloaded yet/);
});
