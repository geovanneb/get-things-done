import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { MeetingDigestService } from '../src/services/meetingDigestService';
import { MeetingTranscriptionService } from '../src/services/meetingTranscription';
import { ContextUpdateService } from '../src/services/contextUpdateService';
import type { Segment, TranscriptionEngine } from '../src/services/transcription/engine';
import type { TranscriptionModelService } from '../src/services/transcriptionModels';

/** A throwaway fictional workspace; services read its path from ESB_WORKSPACE_PATH. */
async function workspace(t: { after: (fn: () => Promise<void> | void) => void }): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-transcribe-'));
  const previous = process.env.ESB_WORKSPACE_PATH;
  process.env.ESB_WORKSPACE_PATH = dir;
  t.after(async () => {
    await MeetingTranscriptionService.settled();
    if (previous === undefined) delete process.env.ESB_WORKSPACE_PATH;
    else process.env.ESB_WORKSPACE_PATH = previous;
    await fsp.rm(dir, { recursive: true, force: true });
  });
  for (const d of ['tasks/active', 'context-updates', '.situation-board/routines']) await fsp.mkdir(path.join(dir, d), { recursive: true });
  return dir;
}

/** A short fictional WAV of 16 kHz mono silence. */
function silentWav(seconds = 1): Buffer {
  const data = Buffer.alloc(16000 * 2 * seconds);
  const head = Buffer.alloc(44);
  head.write('RIFF', 0, 'ascii'); head.writeUInt32LE(36 + data.length, 4); head.write('WAVE', 8, 'ascii');
  head.write('fmt ', 12, 'ascii'); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22);
  head.writeUInt32LE(16000, 24); head.writeUInt32LE(32000, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34);
  head.write('data', 36, 'ascii'); head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

/** Models as Settings has them: the chosen one installed, unless told otherwise. */
function fakeModels(installed = true): TranscriptionModelService {
  return {
    readSettings: async () => ({ model: 'whisper-large-v3-turbo', language: 'auto' }),
    installedPath: async () => (installed ? '/fictional/model' : null),
  } as unknown as TranscriptionModelService;
}

type Transcribe = (wav: string, o: { signal?: AbortSignal; onSegment?: (s: Segment) => void; onProgress?: (done: number, total: number) => void }) => Promise<{ segments: Segment[]; seconds: number; load_ms: number | null }>;

/** An engine that runs `work`, and counts its jobs. */
function fakeEngine(work: Transcribe): { engine: TranscriptionEngine; calls: string[] } {
  const calls: string[] = [];
  const engine = { transcribe: (wav: string, o: Parameters<Transcribe>[1]) => { calls.push(wav); return work(wav, o); } } as unknown as TranscriptionEngine;
  return { engine, calls };
}

/** Speech found in the recording, segment by segment, then the end. */
const speaks = (texts: string[], seconds = 10): Transcribe => async (_wav, o) => {
  const segments = texts.map((text, i) => ({ start: i * 2, end: i * 2 + 1.5, text }));
  for (const s of segments) { o.onSegment?.(s); o.onProgress?.(s.end, seconds); }
  return { segments, seconds, load_ms: 5 };
};

async function queueRecording(service: MeetingDigestService, title: string, files: [string, Buffer][] = [['workshop.wav', silentWav()]]): Promise<string> {
  const m = await service.createMeeting({ title, meeting_date: '2026-10-30' });
  for (const [name, data] of files) await service.addFile(m.id, name, data);
  await service.queue(m.id);
  return m.id;
}

const recording = async (service: MeetingDigestService, id: string, file = 'workshop.wav') =>
  (await service.loadMeeting(id)).files.find((f) => f.name === file)!.recording!;

test('a queued recording is transcribed, its transcript joins the meeting, and the digest takes it', async (t) => {
  const ws = await workspace(t);
  const queue = new MeetingDigestService();
  const { engine, calls } = fakeEngine(speaks(['Fictional budget review.', 'Pilot starts next week.']));
  const job = new MeetingTranscriptionService(queue, fakeModels(), engine);
  const id = await queueRecording(queue, 'Workshop');

  await job.tick();
  await MeetingTranscriptionService.settled();
  assert.equal(calls.length, 1);
  const r = await recording(queue, id);
  assert.equal(r.status, 'done');
  assert.equal(r.transcript, 'workshop.transcript.md');
  assert.equal(r.owner, undefined, 'a finished job leaves no owner');
  const text = await fsp.readFile(path.join(ws, 'context-updates', 'meeting-queue', id, 'workshop.transcript.md'), 'utf-8');
  assert.match(text, /\*\*Complete\.\*\*/);
  assert.match(text, /Fictional budget review\.\n\n\[00:00:02/);
  assert.ok((await queue.loadMeeting(id)).files.some((f) => f.name === 'workshop.transcript.md' && f.sha256 === r.transcript_sha256));
  assert.equal(job.progress(), null);
  await assert.rejects(fsp.access(path.join(ws, '.situation-board', 'routines', 'transcription.lock')), 'the job lock is released');

  // Nothing more to do: another tick starts nothing.
  await job.tick();
  await MeetingTranscriptionService.settled();
  assert.equal(calls.length, 1);

  const run = await queue.runNow(new Date('2026-10-30T18:00:00'));
  assert.equal(run.status, 'ok', run.message);
  const update = await new ContextUpdateService().get(run.context_update!);
  assert.ok(update.material_files.some((f) => f.name === `${id}-workshop.transcript.md`), 'the transcript goes into the digest');
});

test('no model installed: the recording waits and nothing runs', async (t) => {
  await workspace(t);
  const queue = new MeetingDigestService();
  const { engine, calls } = fakeEngine(speaks(['x']));
  const id = await queueRecording(queue, 'Workshop');
  await new MeetingTranscriptionService(queue, fakeModels(false), engine).tick();
  await MeetingTranscriptionService.settled();
  assert.equal(calls.length, 0);
  assert.equal((await recording(queue, id)).status, 'pending');
});

test('a job that ends part way leaves a partial transcript: "Use this transcript" lets the digest take it, "Try again" replaces it', async (t) => {
  const ws = await workspace(t);
  const queue = new MeetingDigestService();
  let fail = true;
  const { engine } = fakeEngine(async (wav, o) => {
    if (!fail) return speaks(['The whole meeting.'])(wav, o);
    o.onSegment?.({ start: 0, end: 1, text: 'The first part.' });
    throw new Error('The transcription engine stopped unexpectedly (SIGKILL).');
  });
  const job = new MeetingTranscriptionService(queue, fakeModels(), engine);
  const id = await queueRecording(queue, 'Workshop');
  const folder = path.join(ws, 'context-updates', 'meeting-queue', id);

  await job.tick();
  await MeetingTranscriptionService.settled();
  let r = await recording(queue, id);
  assert.equal(r.status, 'partial');
  assert.match(r.error!, /stopped unexpectedly/);
  assert.match(await fsp.readFile(path.join(folder, r.transcript!), 'utf-8'), /\*\*Partial\.\*\*[\s\S]*The first part\./);
  assert.match((await queue.runNow(new Date('2026-10-30T18:00:00'))).message, /1 meeting waits for transcription/, 'a partial transcript is not used on its own');

  // Try again: the partial transcript goes, and the new one takes its place.
  fail = false;
  await job.retry(id, 'workshop.wav');
  await MeetingTranscriptionService.settled();
  r = await recording(queue, id);
  assert.equal(r.status, 'done');
  const names = (await queue.loadMeeting(id)).files.map((f) => f.name);
  assert.deepEqual(names.filter((n) => n.endsWith('.transcript.md')), [r.transcript], 'only one transcript');
  assert.deepEqual((await fsp.readdir(folder)).filter((n) => n.endsWith('.transcript.md')), [r.transcript]);

  // A second meeting stops part way too; this time the partial transcript is used as it is.
  fail = true;
  const other = await queueRecording(queue, 'Other');
  await job.tick();
  await MeetingTranscriptionService.settled();
  await assert.rejects(job.accept(id, 'workshop.wav'), /Only a partial transcript/);
  const accepted = await job.accept(other, 'workshop.wav');
  assert.equal(accepted.files.find((f) => f.name === 'workshop.wav')!.recording!.accepted, true);
  const run = await queue.runNow(new Date('2026-10-30T18:00:00'));
  assert.equal(run.status, 'ok', run.message);
  assert.equal((await new ContextUpdateService().get(run.context_update!)).digest_meetings.length, 2);
});

test('a job that finds nothing fails, and no speech in more than a minute is only partial', async (t) => {
  await workspace(t);
  const queue = new MeetingDigestService();
  let mode: 'crash' | 'silent' = 'crash';
  const { engine } = fakeEngine(async () => {
    if (mode === 'crash') throw new Error('The model could not be loaded.');
    return { segments: [], seconds: 90, load_ms: 1 };
  });
  const job = new MeetingTranscriptionService(queue, fakeModels(), engine);
  const id = await queueRecording(queue, 'Workshop');

  await job.tick();
  await MeetingTranscriptionService.settled();
  let r = await recording(queue, id);
  assert.deepEqual([r.status, r.error, r.transcript], ['failed', 'The model could not be loaded.', undefined]);
  await assert.rejects(job.stop(id, 'workshop.wav'), /not being transcribed/);

  mode = 'silent';
  await job.retry(id, 'workshop.wav');
  await MeetingTranscriptionService.settled();
  r = await recording(queue, id);
  assert.equal(r.status, 'partial');
  assert.match(r.error!, /No speech was found/);
});

test('Stop ends the running job and keeps nothing of it; the meeting waits for "Try again"', async (t) => {
  await workspace(t);
  const queue = new MeetingDigestService();
  let started!: () => void;
  const running = new Promise<void>((r) => { started = r; });
  const { engine } = fakeEngine((_wav, o) => new Promise((_resolve, reject) => {
    o.onSegment?.({ start: 0, end: 1, text: 'Said before the stop.' });
    o.onProgress?.(1, 600);
    started();
    o.signal!.addEventListener('abort', () => reject(new Error('Cancelled.')));
  }));
  const job = new MeetingTranscriptionService(queue, fakeModels(), engine);
  const id = await queueRecording(queue, 'Workshop');
  t.after(() => job.forget(id));

  await job.tick();
  await running;
  assert.deepEqual(job.progress() && [job.progress()!.meeting, job.progress()!.done, job.progress()!.total], [id, 1, 600]);
  assert.equal((await recording(queue, id)).status, 'running');
  await assert.rejects(job.retry(id, 'workshop.wav'), /Only a stopped/);

  await job.stop(id, 'workshop.wav');
  await MeetingTranscriptionService.settled();
  const r = await recording(queue, id);
  assert.deepEqual([r.status, r.transcript, r.generation], ['stopped', undefined, undefined]);
  assert.deepEqual((await queue.loadMeeting(id)).files.map((f) => f.name), ['workshop.wav'], 'nothing of the stopped job is kept');
  assert.match((await queue.runNow(new Date('2026-10-30T18:00:00'))).message, /1 meeting waits for transcription/);
});

test('a result is dropped when the recording is no longer this job\'s, and removing the meeting ends the job', async (t) => {
  await workspace(t);
  const queue = new MeetingDigestService();
  let release!: () => void;
  let started!: () => void;
  const running = new Promise<void>((r) => { started = r; });
  const { engine } = fakeEngine((wav, o) => new Promise((resolve, reject) => {
    started();
    o.signal!.addEventListener('abort', () => reject(new Error('Cancelled.')));
    release = () => { void speaks(['Late result.'])(wav, o).then(resolve); };
  }));
  const job = new MeetingTranscriptionService(queue, fakeModels(), engine);
  const id = await queueRecording(queue, 'Workshop');

  await job.tick();
  await running;
  // Another dashboard stopped it and queued it again: the generation changed.
  await queue.withQueue(async () => {
    const m = await queue.loadMeeting(id);
    m.files[0]!.recording = { status: 'pending' };
    await queue.saveMeeting(m);
  });
  release();
  await MeetingTranscriptionService.settled();
  assert.equal((await recording(queue, id)).status, 'pending', 'the late result is not published');
  assert.deepEqual((await queue.loadMeeting(id)).files.map((f) => f.name), ['workshop.wav']);

  // It is picked up again; removing the meeting ends that job.
  const again = new Promise<void>((r) => { started = r; });
  await job.tick();
  await again;
  await queue.removeMeeting(id);
  job.forget(id);
  await MeetingTranscriptionService.settled();
  assert.equal(job.progress(), null);
});

test('a recording left running by a dashboard that is gone goes back in line, and its work files are removed', async (t) => {
  const ws = await workspace(t);
  const queue = new MeetingDigestService();
  const { engine, calls } = fakeEngine(speaks(['Recovered.']));
  const id = await queueRecording(queue, 'Workshop');
  const folder = path.join(ws, 'context-updates', 'meeting-queue', id);
  await queue.withQueue(async () => {
    const m = await queue.loadMeeting(id);
    // A pid no process has: the dashboard that ran it is gone.
    m.files[0]!.recording = { status: 'running', generation: 'gone-gen', owner: { pid: 2 ** 22 + 1, token: 'gone' }, started_at: '2026-10-30T09:00:00Z' };
    await queue.saveMeeting(m);
  });
  await fsp.mkdir(path.join(folder, '.transcribing'), { recursive: true });
  await fsp.writeFile(path.join(folder, '.transcribing', 'gone-gen.wav'), 'leftover');

  await new MeetingTranscriptionService(queue, fakeModels(), engine).tick();
  await MeetingTranscriptionService.settled();
  assert.equal(calls.length, 1);
  assert.equal((await recording(queue, id)).status, 'done');
  assert.deepEqual(await fsp.readdir(path.join(folder, '.transcribing')), []);
});

test('one job at a time across dashboards: a held transcription lock starts nothing', async (t) => {
  const ws = await workspace(t);
  const queue = new MeetingDigestService();
  const { engine, calls } = fakeEngine(speaks(['x']));
  const id = await queueRecording(queue, 'Workshop');
  // Another live process holds the lock (this test's parent stands in for it).
  await fsp.writeFile(path.join(ws, '.situation-board', 'routines', 'transcription.lock'), JSON.stringify({ pid: process.ppid, token: 'other' }));
  await new MeetingTranscriptionService(queue, fakeModels(), engine).tick();
  await MeetingTranscriptionService.settled();
  assert.equal(calls.length, 0);
  assert.equal((await recording(queue, id)).status, 'pending');
});
