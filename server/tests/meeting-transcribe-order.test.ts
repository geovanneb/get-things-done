import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import express from 'express';
import { MeetingDigestService } from '../src/services/meetingDigestService';
import { MeetingTranscriptionService, inTranscriptionOrder } from '../src/services/meetingTranscription';
import meetingQueueRoutes from '../src/routes/meetingQueue';
import { errorHandler } from '../src/middleware/errorHandler';
import type { Segment, TranscriptionEngine } from '../src/services/transcription/engine';
import type { TranscriptionModelService } from '../src/services/transcriptionModels';

// "Transcribe next", "Move back" and "Transcribe now" for meetings waiting in the queue (PUT /api/meeting-queue/:id/priority).

async function workspace(t: { after: (fn: () => Promise<void> | void) => void }): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-transcribe-order-'));
  const previous = process.env.ESB_WORKSPACE_PATH;
  process.env.ESB_WORKSPACE_PATH = dir;
  const models = process.env.ESB_MODELS_PATH;
  process.env.ESB_MODELS_PATH = path.join(dir, '.models');
  t.after(async () => {
    await MeetingTranscriptionService.settled();
    if (previous === undefined) delete process.env.ESB_WORKSPACE_PATH;
    else process.env.ESB_WORKSPACE_PATH = previous;
    if (models === undefined) delete process.env.ESB_MODELS_PATH;
    else process.env.ESB_MODELS_PATH = models;
    await fsp.rm(dir, { recursive: true, force: true });
  });
  for (const d of ['tasks/active', 'context-updates', '.situation-board/routines']) await fsp.mkdir(path.join(dir, d), { recursive: true });
  return dir;
}

function silentWav(): Buffer {
  const data = Buffer.alloc(16000 * 2);
  const head = Buffer.alloc(44);
  head.write('RIFF', 0, 'ascii'); head.writeUInt32LE(36 + data.length, 4); head.write('WAVE', 8, 'ascii');
  head.write('fmt ', 12, 'ascii'); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22);
  head.writeUInt32LE(16000, 24); head.writeUInt32LE(32000, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34);
  head.write('data', 36, 'ascii'); head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

/** The chosen model installed; `missing` is a model that is not downloaded. */
function fakeModels(missing = 'fictional-missing-model'): TranscriptionModelService {
  return {
    readSettings: async () => ({ model: 'whisper-large-v3-turbo', language: 'auto' }),
    installedPath: async (id: string) => (id === missing ? null : '/fictional/model'),
  } as unknown as TranscriptionModelService;
}

type Options = { signal?: AbortSignal; onSegment?: (s: Segment) => void; onProgress?: (done: number, total: number) => void };
type Work = (meeting: string, o: Options, call: number) => Promise<{ segments: Segment[]; seconds: number; load_ms: number | null }>;

/** An engine that runs `work` for each job, with the meeting it transcribes (a WAV is read from the meeting's folder). */
function fakeEngine(work: Work): { engine: TranscriptionEngine; calls: string[]; reached: (n: number) => Promise<void> } {
  const calls: string[] = [];
  const waiting: { n: number; resolve: () => void }[] = [];
  const engine = {
    transcribe: (wav: string, o: Options) => {
      const meeting = path.basename(path.dirname(wav));
      calls.push(meeting);
      for (const w of waiting.filter((x) => x.n <= calls.length)) w.resolve();
      return work(meeting, o, calls.length);
    },
  } as unknown as TranscriptionEngine;
  /** Resolves once the engine was called `n` times. */
  const reached = (n: number) => new Promise<void>((resolve) => { if (calls.length >= n) resolve(); else waiting.push({ n, resolve }); });
  return { engine, calls, reached };
}

const speaks = async (meeting: string, o: Options) => {
  const segments = [{ start: 0, end: 1.5, text: `Fictional words of ${meeting}.` }];
  for (const s of segments) { o.onSegment?.(s); o.onProgress?.(s.end, 10); }
  return { segments, seconds: 10, load_ms: 5 };
};

/** Runs until stopped: what it heard so far, then a rejection when the job is aborted. */
const untilStopped = (o: Options) => new Promise<never>((_resolve, reject) => {
  o.onSegment?.({ start: 0, end: 1, text: 'Said before the switch.' });
  o.onProgress?.(34, 100);
  o.signal!.addEventListener('abort', () => reject(new Error('Cancelled.')));
});

let day = 0;
async function queueRecording(service: MeetingDigestService, title: string): Promise<string> {
  // One day apart, so the queue's own order (oldest first) is the order they were added in.
  const m = await service.createMeeting({ title, meeting_date: new Date(Date.UTC(2026, 8, 1 + day++)).toISOString().slice(0, 10) });
  await service.addFile(m.id, 'workshop.wav', silentWav());
  await service.queue(m.id);
  return m.id;
}

const recording = async (service: MeetingDigestService, id: string) => (await service.loadMeeting(id)).files.find((f) => f.name === 'workshop.wav')!.recording!;

test('the order: meetings chosen with Transcribe next first, the latest choice first, then oldest first', () => {
  const order = inTranscriptionOrder([
    { id: 'MQ-1' }, { id: 'MQ-2', transcribe_first_at: '2026-11-01T10:00:00.000Z' }, { id: 'MQ-3' },
    { id: 'MQ-4', transcribe_first_at: '2026-11-01T11:00:00.000Z' },
  ]);
  assert.deepEqual(order.map((m) => m.id), ['MQ-4', 'MQ-2', 'MQ-1', 'MQ-3']);
});

test('several meetings moved to the front are transcribed latest choice first; one that cannot run holds up nothing', async (t) => {
  await workspace(t);
  const queue = new MeetingDigestService();
  const { engine, calls, reached } = fakeEngine((m, o) => speaks(m, o));
  const job = new MeetingTranscriptionService(queue, fakeModels(), engine);
  const a = await queueRecording(queue, 'A');
  const b = await queueRecording(queue, 'B');
  const c = await queueRecording(queue, 'C');
  const d = await queueRecording(queue, 'D');
  const e = await queueRecording(queue, 'E waits for a model');
  // E is fixed to a model that is not downloaded: chosen first, but it cannot run.
  await queue.withQueue(async () => {
    const m = await queue.loadMeeting(e);
    m.files[0]!.recording = { status: 'pending', target: { model: 'fictional-missing-model', language: 'auto' } };
    await queue.saveMeeting(m);
  });

  await job.prioritize(c, { first: true });
  await job.prioritize(b, { first: true });
  await job.prioritize(e, { first: true });
  // Asked again: the last click wins, so D is now ahead of C and B.
  await job.prioritize(d, { first: true });
  await job.prioritize(d, { first: true });

  await job.tick();
  await reached(4);
  await MeetingTranscriptionService.settled();
  assert.deepEqual(calls, [d, b, c, a]);
  for (const id of [a, b, c, d]) {
    assert.equal((await recording(queue, id)).status, 'done');
    assert.equal((await queue.loadMeeting(id)).transcribe_first_at, undefined, 'cleared once nothing waits any more');
  }
  assert.equal((await recording(queue, e)).status, 'pending');
  assert.ok((await queue.loadMeeting(e)).transcribe_first_at, 'the meeting that still waits keeps its place');
});

test('the order survives a restart: it is in the meeting\'s manifest, not in this dashboard', async (t) => {
  const ws = await workspace(t);
  const first = new MeetingDigestService();
  const a = await queueRecording(first, 'A');
  const b = await queueRecording(first, 'B');
  const { engine: unused } = fakeEngine((m, o) => speaks(m, o));
  await new MeetingTranscriptionService(first, fakeModels(), unused).prioritize(b, { first: true });
  assert.match(await fsp.readFile(path.join(ws, 'context-updates', 'meeting-queue', b, 'meeting.md'), 'utf-8'), /transcribe_first_at: /);

  // A new dashboard: new services, nothing kept in memory.
  const queue = new MeetingDigestService();
  const { engine, calls, reached } = fakeEngine((m, o) => speaks(m, o));
  await new MeetingTranscriptionService(queue, fakeModels(), engine).tick();
  await reached(2);
  await MeetingTranscriptionService.settled();
  assert.deepEqual(calls, [b, a]);
});

test('the choice is cleared when no recording waits any more, by Move back, and read strictly from the manifest', async (t) => {
  const ws = await workspace(t);
  const queue = new MeetingDigestService();
  const { engine } = fakeEngine(async () => { throw new Error('The model could not be loaded.'); });
  const job = new MeetingTranscriptionService(queue, fakeModels(), engine);
  const stopped = await queueRecording(queue, 'Stopped');
  const failed = await queueRecording(queue, 'Failed');
  const moved = await queueRecording(queue, 'Moved back');

  // Stopped while it waits.
  await job.prioritize(stopped, { first: true });
  await job.stop(stopped, 'workshop.wav');
  assert.equal((await queue.loadMeeting(stopped)).transcribe_first_at, undefined);
  await assert.rejects(job.prioritize(stopped, { first: true }), (err: { statusCode?: number }) => err.statusCode === 409, 'no recording waits');

  // Move back, twice: the second changes nothing and is not an error.
  await job.prioritize(moved, { first: true });
  assert.ok((await queue.loadMeeting(moved)).transcribe_first_at);
  assert.equal((await job.prioritize(moved, { first: false })).transcribe_first_at, undefined);
  assert.equal((await job.prioritize(moved, { first: false })).transcribe_first_at, undefined);

  // A hand-edited value that is not a full UTC timestamp is ignored, never guessed at.
  const manifest = path.join(ws, 'context-updates', 'meeting-queue', moved, 'meeting.md');
  const text = await fsp.readFile(manifest, 'utf-8');
  for (const bad of ['tomorrow', '2026-02-30T10:00:00Z', '2026-11-01']) {
    await fsp.writeFile(manifest, text.replace(/^files:/m, `transcribe_first_at: '${bad}'\nfiles:`));
    assert.equal((await queue.loadMeeting(moved)).transcribe_first_at, undefined, bad);
  }
  await fsp.writeFile(manifest, text.replace(/^files:/m, `transcribe_first_at: '2026-11-01T10:00:00Z'\nfiles:`));
  assert.equal((await queue.loadMeeting(moved)).transcribe_first_at, '2026-11-01T10:00:00.000Z');
  await assert.rejects(job.prioritize(moved, {}), (err: { statusCode?: number }) => err.statusCode === 400);
  await assert.rejects(job.prioritize(moved, { first: false, now: true }), (err: { statusCode?: number }) => err.statusCode === 400);

  // Failed.
  await job.prioritize(failed, { first: true });
  await job.tick();
  await MeetingTranscriptionService.settled();
  assert.equal((await recording(queue, failed)).status, 'failed');
  assert.equal((await queue.loadMeeting(failed)).transcribe_first_at, undefined);
});

test('Transcribe now gives the running job back with nothing published, starts the chosen meeting, then the stopped one from the beginning', async (t) => {
  const ws = await workspace(t);
  const queue = new MeetingDigestService();
  let openB!: () => void;
  const gateB = new Promise<void>((r) => { openB = r; });
  const { engine, calls, reached } = fakeEngine(async (m, o, call) => {
    if (call === 1) return untilStopped(o);
    if (call === 2) await gateB;
    return speaks(m, o);
  });
  const job = new MeetingTranscriptionService(queue, fakeModels(), engine);
  const a = await queueRecording(queue, 'Running');
  const b = await queueRecording(queue, 'Needed now');
  const c = await queueRecording(queue, 'Chosen earlier');
  await job.prioritize(c, { first: true });
  // A was chosen earlier still, so it runs first; C waits behind it.
  await job.prioritize(a, { first: true });
  await job.tick();
  await reached(1);
  const running = await recording(queue, a);
  assert.equal(running.status, 'running');
  assert.equal(job.progress()!.done, 34);

  const chosen = await job.prioritize(b, { first: true, now: true, generation: running.generation });
  assert.ok(chosen.transcribe_first_at);
  await reached(2);
  assert.deepEqual(calls, [a, b], 'the chosen meeting starts');
  const back = await recording(queue, a);
  assert.deepEqual([back.status, back.generation, back.owner, back.transcript], ['pending', undefined, undefined, undefined], 'back in line, not stopped');
  assert.deepEqual((await queue.loadMeeting(a)).files.map((f) => f.name), ['workshop.wav'], 'nothing of the stopped job is published');
  const firstAt = (await queue.loadMeeting(a)).transcribe_first_at!;
  assert.ok(firstAt < chosen.transcribe_first_at! && firstAt > (await queue.loadMeeting(c)).transcribe_first_at!, 'right after the chosen one, ahead of earlier choices');

  openB();
  await reached(4);
  await MeetingTranscriptionService.settled();
  assert.deepEqual(calls, [a, b, a, c], 'the stopped one starts again right after');
  const text = await fsp.readFile(path.join(ws, 'context-updates', 'meeting-queue', a, (await recording(queue, a)).transcript!), 'utf-8');
  assert.match(text, /Fictional words of/);
  assert.doesNotMatch(text, /Said before the switch/, 'made again from the beginning');
});

test('a stale or duplicate Transcribe now from two dashboards stops nothing it did not see, and stops the job once', async (t) => {
  await workspace(t);
  const queue = new MeetingDigestService();
  let openB!: () => void;
  const gateB = new Promise<void>((r) => { openB = r; });
  const { engine, calls, reached } = fakeEngine(async (m, o, call) => {
    if (call === 1) return untilStopped(o);
    if (call === 2) await gateB;
    return speaks(m, o);
  });
  const job = new MeetingTranscriptionService(queue, fakeModels(), engine);
  const a = await queueRecording(queue, 'Running');
  const b = await queueRecording(queue, 'Needed now');
  await job.tick();
  await reached(1);
  const seen = (await recording(queue, a)).generation!;

  // The page saw another job: refused, and nothing changes.
  await assert.rejects(job.prioritize(b, { first: true, now: true, generation: 'another-generation' }), (err: { statusCode?: number }) => err.statusCode === 409);
  assert.equal((await recording(queue, a)).generation, seen, 'the running job goes on');
  assert.equal((await queue.loadMeeting(b)).transcribe_first_at, undefined);

  // No generation: the page must name the job it showed, so nothing is stopped.
  await assert.rejects(job.prioritize(b, { first: true, now: true }), (err: { statusCode?: number }) => err.statusCode === 409);
  assert.equal((await recording(queue, a)).generation, seen);

  // Two dashboards ask at once, for the job they both saw: the first stops it; the second finds it stopped (409) or the
  // chosen meeting already running (no change). Either way it is stopped once.
  const both = await Promise.allSettled([
    job.prioritize(b, { first: true, now: true, generation: seen }),
    job.prioritize(b, { first: true, now: true, generation: seen }),
  ]);
  assert.equal(both[0]!.status, 'fulfilled');
  assert.ok(both[1]!.status === 'fulfilled' || (both[1]!.reason as { statusCode?: number }).statusCode === 409);
  await reached(2);
  assert.deepEqual(calls, [a, b]);
  // A request arriving late, once the chosen meeting runs: nothing more to do, and nothing is stopped.
  const late = await job.prioritize(b, { first: true, now: true, generation: seen });
  assert.equal(late.files[0]!.recording!.status, 'running');
  assert.equal((await recording(queue, b)).status, 'running');

  openB();
  await reached(3);
  await MeetingTranscriptionService.settled();
  assert.deepEqual(calls, [a, b, a], 'the stopped job was stopped once and ran again once');
  assert.equal((await recording(queue, a)).status, 'done');
  assert.equal((await recording(queue, b)).status, 'done');
});

test('Transcribe now for a meeting that cannot start puts it first but leaves the running job alone', async (t) => {
  await workspace(t);
  const queue = new MeetingDigestService();
  let finishA!: () => void;
  const gateA = new Promise<void>((r) => { finishA = r; });
  const { engine, calls, reached } = fakeEngine(async (m, o, call) => {
    if (call === 1) { o.onProgress?.(95, 100); await gateA; }
    return speaks(m, o);
  });
  const job = new MeetingTranscriptionService(queue, fakeModels(), engine);
  const a = await queueRecording(queue, 'Running at 95%');
  const b = await queueRecording(queue, 'Fixed to a model not downloaded');
  await queue.withQueue(async () => {
    const m = await queue.loadMeeting(b);
    m.files[0]!.recording = { status: 'pending', target: { model: 'fictional-missing-model', language: 'auto' } };
    await queue.saveMeeting(m);
  });
  await job.tick();
  await reached(1);
  const seen = (await recording(queue, a)).generation!;

  await assert.rejects(job.prioritize(b, { first: true, now: true, generation: seen }),
    (err: { statusCode?: number; message: string }) => err.statusCode === 409 && /model is not downloaded/.test(err.message));
  assert.equal((await recording(queue, a)).generation, seen, 'the running job is not stopped');
  assert.ok((await queue.loadMeeting(b)).transcribe_first_at, 'still put first, for when its model is there');

  finishA();
  await MeetingTranscriptionService.settled();
  assert.deepEqual(calls, [a], 'A ran once, to the end');
  assert.equal((await recording(queue, a)).status, 'done');
  assert.equal((await recording(queue, b)).status, 'pending');
});

test('Transcribe now for a meeting whose recording changed on disk leaves the running job alone', async (t) => {
  const ws = await workspace(t);
  const queue = new MeetingDigestService();
  let finishA!: () => void;
  const gateA = new Promise<void>((r) => { finishA = r; });
  const { engine, calls, reached } = fakeEngine(async (m, o, call) => {
    if (call === 1) { o.onProgress?.(95, 100); await gateA; }
    return speaks(m, o);
  });
  const job = new MeetingTranscriptionService(queue, fakeModels(), engine);
  const a = await queueRecording(queue, 'Running at 95%');
  const b = await queueRecording(queue, 'Changed on disk');
  await job.tick();
  await reached(1);
  const seen = (await recording(queue, a)).generation!;
  await fsp.appendFile(path.join(ws, 'context-updates', 'meeting-queue', b, 'workshop.wav'), 'changed');

  await assert.rejects(job.prioritize(b, { first: true, now: true, generation: seen }),
    (err: { statusCode?: number; message: string }) => err.statusCode === 409 && /changed since it was added/.test(err.message));
  assert.equal((await recording(queue, a)).generation, seen, 'the running job is not stopped');
  assert.ok((await queue.loadMeeting(b)).transcribe_first_at);

  finishA();
  await MeetingTranscriptionService.settled();
  assert.deepEqual(calls, [a], 'A ran once, to the end');
  assert.equal((await recording(queue, a)).status, 'done');
  assert.equal((await recording(queue, b)).status, 'failed', 'the scheduler then fails it on its own, as before');
});

test('Transcribe now for a job of another dashboard gives it back through the manifest; that dashboard drops its result', async (t) => {
  await workspace(t);
  const queue = new MeetingDigestService();
  const { engine } = fakeEngine((m, o) => speaks(m, o));
  const job = new MeetingTranscriptionService(queue, fakeModels(), engine);
  const a = await queueRecording(queue, 'Running elsewhere');
  const b = await queueRecording(queue, 'Needed now');
  // Another live dashboard (this test's parent process stands in for it) runs A, and holds the transcription lock.
  await queue.withQueue(async () => {
    const m = await queue.loadMeeting(a);
    m.files[0]!.recording = { status: 'running', generation: 'elsewhere-gen', owner: { pid: process.ppid, token: 'elsewhere' }, started_at: '2026-11-01T09:00:00Z' };
    await queue.saveMeeting(m);
  });
  const lock = path.join(process.env.ESB_WORKSPACE_PATH!, '.situation-board', 'routines', 'transcription.lock');
  await fsp.writeFile(lock, JSON.stringify({ pid: process.ppid, token: 'elsewhere' }));

  await job.prioritize(b, { first: true, now: true, generation: 'elsewhere-gen' });
  await MeetingTranscriptionService.settled();
  const back = await recording(queue, a);
  assert.deepEqual([back.status, back.generation], ['pending', undefined], 'its generation is revoked: its owner check ends it, and publish drops it');
  assert.equal((await recording(queue, b)).status, 'pending', 'it starts once that dashboard lets go of the engine');
  assert.ok((await queue.loadMeeting(a)).transcribe_first_at! < (await queue.loadMeeting(b)).transcribe_first_at!);
});

test('over HTTP: PUT /api/meeting-queue/:id/priority', async (t) => {
  await workspace(t);
  const queue = new MeetingDigestService();
  const app = express();
  app.use(express.json());
  app.use('/api/meeting-queue', meetingQueueRoutes);
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  t.after(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/meeting-queue`;
  const put = (id: string, body: unknown) => fetch(`${base}/${id}/priority`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const waiting = await queueRecording(queue, 'Waiting');
  const finished = await queueRecording(queue, 'Finished');
  await queue.withQueue(async () => {
    const m = await queue.loadMeeting(finished);
    m.files[0]!.recording = { status: 'stopped' };
    await queue.saveMeeting(m);
  });

  assert.equal((await put(waiting, {})).status, 400);
  assert.equal((await put(waiting, { first: 'yes' })).status, 400);
  assert.equal((await put(waiting, { first: false, now: true })).status, 400);
  assert.equal((await put('MQ-2026-9999', { first: true })).status, 404);
  assert.equal((await put(finished, { first: true })).status, 409, 'no recording waits');
  const first = await put(waiting, { first: true });
  assert.equal(first.status, 200);
  assert.ok(((await first.json()) as { transcribe_first_at?: string }).transcribe_first_at);
  const back = await put(waiting, { first: false });
  assert.equal(back.status, 200);
  assert.equal(((await back.json()) as { transcribe_first_at?: string }).transcribe_first_at, undefined);
});
