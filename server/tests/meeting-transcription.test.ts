import { test } from 'node:test';

// A background job that fails must be caught by the service, never left to crash the dashboard.
const unhandled: unknown[] = [];
process.on('unhandledRejection', (reason) => { unhandled.push(reason); });
import assert from 'node:assert/strict';
import { transcriptParts } from '../../ui/src/utils/transcriptReading';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { MeetingDigestService, parseSpeakerNames, transcriptSpeakers } from '../src/services/meetingDigestService';
import { audioTranscriptMarkdown, MeetingTranscriptionService, transcriptionTimings } from '../src/services/meetingTranscription';
import { ContextUpdateService } from '../src/services/contextUpdateService';
import { TranscriptionModelService } from '../src/services/transcriptionModels';
import type { Segment, TranscriptionEngine } from '../src/services/transcription/engine';
import type { TranscriptionModelService } from '../src/services/transcriptionModels';

/** A throwaway fictional workspace; services read its path from ESB_WORKSPACE_PATH. */
async function workspace(t: { after: (fn: () => Promise<void> | void) => void }): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-transcribe-'));
  const previous = process.env.ESB_WORKSPACE_PATH;
  process.env.ESB_WORKSPACE_PATH = dir;
  // The digest reads "Keep recordings" from the models folder: never this computer's own.
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
  // The late result is dropped, and the recording, back in line, is picked up again at once.
  const again = new Promise<void>((r) => { started = r; });
  release();
  await again;
  assert.deepEqual((await queue.loadMeeting(id)).files.map((f) => f.name), ['workshop.wav'], 'the late result is not published');
  assert.equal((await recording(queue, id)).status, 'running');

  // Removing the meeting ends that job.
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

test('a manifest never points outside the meeting: a traversal name is ignored and a linked work folder is refused', async (t) => {
  const ws = await workspace(t);
  const queue = new MeetingDigestService();
  const { engine, calls } = fakeEngine(speaks(['x']));
  const job = new MeetingTranscriptionService(queue, fakeModels(), engine);
  const id = await queueRecording(queue, 'Workshop');
  const folder = path.join(ws, 'context-updates', 'meeting-queue', id);
  const victim = path.join(ws, 'context-updates', 'victim.md');
  await fsp.writeFile(victim, 'keep me');

  // A hand-edited manifest: a partial recording whose transcript is "../../victim.md", and a file outside the folder.
  const manifest = path.join(folder, 'meeting.md');
  const text = await fsp.readFile(manifest, 'utf-8');
  await fsp.writeFile(manifest, text.replace('status: pending', 'status: partial\n      transcript: ../../victim.md'));
  assert.equal((await recording(queue, id)).status, 'partial', 'the edited manifest is read');
  assert.equal((await recording(queue, id)).transcript, undefined, 'the traversal name is not read');
  await job.retry(id, 'workshop.wav');
  await MeetingTranscriptionService.settled();
  assert.equal(await fsp.readFile(victim, 'utf-8'), 'keep me');

  // A work folder that is a link to somewhere else: nothing there is touched, and the other meetings carry on.
  const elsewhere = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-elsewhere-'));
  t.after(() => fsp.rm(elsewhere, { recursive: true, force: true }));
  await fsp.writeFile(path.join(elsewhere, 'precious.wav'), 'x');
  await fsp.rm(path.join(folder, '.transcribing'), { recursive: true, force: true });
  await fsp.symlink(elsewhere, path.join(folder, '.transcribing'));
  const other = await queueRecording(queue, 'Other');
  await job.tick();
  await MeetingTranscriptionService.settled();
  assert.deepEqual(await fsp.readdir(elsewhere), ['precious.wav']);
  assert.equal((await recording(queue, other)).status, 'done', 'one broken meeting does not hold up the next');
  assert.ok(calls.length >= 1);
});

test('one recording that cannot be read fails on its own and the next meeting is transcribed', async (t) => {
  const ws = await workspace(t);
  const queue = new MeetingDigestService();
  const { engine } = fakeEngine(speaks(['Second meeting.']));
  const job = new MeetingTranscriptionService(queue, fakeModels(), engine);
  const first = await queueRecording(queue, 'First');
  const second = await queueRecording(queue, 'Second');
  await fsp.rm(path.join(ws, 'context-updates', 'meeting-queue', first, 'workshop.wav'));

  await job.tick();
  await MeetingTranscriptionService.settled();
  const r = await recording(queue, first);
  assert.equal(r.status, 'failed');
  assert.match(r.error!, /cannot be read/);
  assert.equal((await recording(queue, second)).status, 'done');
});

test('a transcript written but never recorded is removed, so the next one keeps its name', async (t) => {
  const ws = await workspace(t);
  const queue = new MeetingDigestService();
  const { engine } = fakeEngine(speaks(['Again.']));
  const id = await queueRecording(queue, 'Workshop');
  const folder = path.join(ws, 'context-updates', 'meeting-queue', id);
  // A dashboard wrote the transcript and stopped before the manifest named it.
  await fsp.writeFile(path.join(folder, 'workshop.transcript.md'), 'orphan');
  await new MeetingTranscriptionService(queue, fakeModels(), engine).tick();
  await MeetingTranscriptionService.settled();
  assert.equal((await recording(queue, id)).transcript, 'workshop.transcript.md');
  assert.match(await fsp.readFile(path.join(folder, 'workshop.transcript.md'), 'utf-8'), /Again\./);
  assert.deepEqual((await fsp.readdir(folder)).filter((n) => n.endsWith('.md')).sort(), ['meeting.md', 'workshop.transcript.md']);
});

test('a Stop from another dashboard ends a job that reports no progress, and work files of a live dashboard are kept', async (t) => {
  const ws = await workspace(t);
  const queue = new MeetingDigestService();
  const before = transcriptionTimings.ownerCheckMs;
  transcriptionTimings.ownerCheckMs = 50;
  t.after(() => { transcriptionTimings.ownerCheckMs = before; });
  let started!: () => void;
  const running = new Promise<void>((r) => { started = r; });
  // Loading a model: no progress at all until it is told to stop.
  const { engine } = fakeEngine((_wav, o) => new Promise((_resolve, reject) => {
    started();
    o.signal!.addEventListener('abort', () => reject(new Error('Cancelled.')));
  }));
  const job = new MeetingTranscriptionService(queue, fakeModels(), engine);
  const id = await queueRecording(queue, 'Workshop');
  const work = path.join(ws, 'context-updates', 'meeting-queue', id, '.transcribing');
  await fsp.mkdir(work, { recursive: true });
  const live = `${'a'.repeat(8)}-aaaa-aaaa-aaaa-${'a'.repeat(12)}-${process.ppid}.wav`;
  const gone = `${'b'.repeat(8)}-bbbb-bbbb-bbbb-${'b'.repeat(12)}-${2 ** 22 + 1}.wav`;
  await fsp.writeFile(path.join(work, live), 'converting in another dashboard');
  await fsp.writeFile(path.join(work, gone), 'left by a crash');

  await job.tick();
  await running;
  assert.deepEqual((await fsp.readdir(work)).sort(), [live], 'only the work file of a dashboard that is gone was removed');
  // Another dashboard stops it: only the manifest changes.
  await queue.withQueue(async () => {
    const m = await queue.loadMeeting(id);
    m.files[0]!.recording = { status: 'stopped' };
    await queue.saveMeeting(m);
  });
  await MeetingTranscriptionService.settled();
  assert.equal(job.progress(), null, 'the job ended without any progress report');
  assert.equal((await recording(queue, id)).status, 'stopped');
});

test('a complete transcript goes into the digest and the recording goes with the queue; "Keep recordings" and a partial keep it', async (t) => {
  const ws = await workspace(t);
  const queue = new MeetingDigestService();
  const updates = new ContextUpdateService();
  let fail = false;
  const { engine } = fakeEngine(async (wav, o) => {
    if (!fail) return speaks(['Fictional budget review.'])(wav, o);
    o.onSegment?.({ start: 0, end: 1, text: 'Only the start.' });
    throw new Error('The transcription engine stopped unexpectedly (SIGKILL).');
  });
  const job = new MeetingTranscriptionService(queue, fakeModels(), engine);
  const dirOf = (id: string) => path.join(ws, 'context-updates', 'meeting-queue', id);
  const digest = async () => {
    const run = await queue.runNow(new Date('2026-10-30T18:00:00'));
    assert.equal(run.status, 'ok', run.message);
    return updates.get(run.context_update!);
  };

  // Complete, with the default setting: the transcript is in the digest, the audio nowhere.
  const first = await queueRecording(queue, 'Workshop');
  const wavHash = (await queue.loadMeeting(first)).files[0]!.sha256;
  await job.tick();
  await MeetingTranscriptionService.settled();
  const transcriptHash = (await recording(queue, first)).transcript_sha256;
  const done = await digest();
  assert.deepEqual(done.material_files.map((f) => f.name).sort(), [`${first}-workshop.transcript.md`, 'meetings.md']);
  assert.deepEqual(done.transcripts.map((c) => [c.file, c.source, c.source_sha256, c.kind, c.complete, c.source_removed, c.current]),
    [[`${first}-workshop.transcript.md`, 'workshop.wav', wavHash, 'audio', true, true, true]]);
  assert.deepEqual(done.digest_meetings[0]!.recordings, [{
    source: 'workshop.wav', source_sha256: wavHash, transcript: `${first}-workshop.transcript.md`, transcript_sha256: transcriptHash, complete: true, file: null,
  }]);
  assert.match(await fsp.readFile(path.join(ws, 'context-updates', done.id, 'materials', 'meetings.md'), 'utf-8'), /workshop\.wav: complete transcript in .*audio not kept/);
  await assert.rejects(fsp.access(dirOf(first)), 'the queue folder went, with the recording');
  const receipts = await fsp.readFile(path.join(ws, '.situation-board', 'routines', 'meeting-digest-receipts.jsonl'), 'utf-8');
  assert.equal(JSON.parse(receipts.trim().split('\n')[0]!).recordings[0].source_sha256, wavHash);
  await updates.remove(done.id);

  // "Keep recordings" on: the audio stays with the digest, and its materials are kept after review.
  await new TranscriptionModelService().updateSettings({ keep_recordings: true });
  const second = await queueRecording(queue, 'Kept', [['kept.wav', silentWav(2)]]);
  await job.tick();
  await MeetingTranscriptionService.settled();
  const kept = await digest();
  assert.ok(kept.material_files.some((f) => f.name === `${second}-kept.wav`));
  assert.equal(kept.keep_materials, true);
  assert.deepEqual(kept.transcripts.map((c) => [c.source, c.source_removed, c.current]), [[`${second}-kept.wav`, undefined, true]]);
  await updates.remove(kept.id);

  // A partial transcript used as it is keeps its recording, whatever the setting says.
  await new TranscriptionModelService().updateSettings({ keep_recordings: false });
  fail = true;
  const third = await queueRecording(queue, 'Partial', [['cut.wav', silentWav(3)]]);
  await job.tick();
  await MeetingTranscriptionService.settled();
  await job.accept(third, 'cut.wav');
  const partial = await digest();
  assert.ok(partial.material_files.some((f) => f.name === `${third}-cut.wav`));
  assert.equal(partial.keep_materials, false);
  assert.deepEqual(partial.transcripts.map((c) => [c.complete, c.source_removed]), [[false, undefined]]);
});

test('settings that cannot be read keep recordings; only a clear "not kept" lets one go', async (t) => {
  await workspace(t);
  const service = new TranscriptionModelService();
  const file = path.join(process.env.ESB_MODELS_PATH!, 'settings.json');
  assert.equal(await service.keepRecordings(), false, 'no settings yet: the default');
  await service.updateSettings({ keep_recordings: true });
  assert.equal(await service.keepRecordings(), true);
  await fsp.writeFile(file, '{ damaged');
  assert.equal(await service.keepRecordings(), true);
  await fsp.writeFile(file, JSON.stringify({ language: 'nonsense' }));
  assert.equal(await service.keepRecordings(), true);

  const queue = new MeetingDigestService();
  const { engine } = fakeEngine(speaks(['Fictional budget review.']));
  const id = await queueRecording(queue, 'Workshop');
  await new MeetingTranscriptionService(queue, fakeModels(), engine).tick();
  await MeetingTranscriptionService.settled();
  const run = await queue.runNow(new Date('2026-10-30T18:00:00'));
  const update = await new ContextUpdateService().get(run.context_update!);
  assert.ok(update.material_files.some((f) => f.name === `${id}-workshop.wav`), 'the audio was kept');
});

test('a change to the digest\'s record of a recording stops the handoff, and a hand-set flag is not believed', async (t) => {
  const ws = await workspace(t);
  const queue = new MeetingDigestService();
  const updates = new ContextUpdateService();
  let fail = true;
  const { engine } = fakeEngine(async (wav, o) => {
    if (!fail) return speaks(['Complete.'])(wav, o);
    o.onSegment?.({ start: 0, end: 1, text: 'Only the start.' });
    throw new Error('The transcription engine stopped unexpectedly (SIGKILL).');
  });
  const job = new MeetingTranscriptionService(queue, fakeModels(), engine);
  const id = await queueRecording(queue, 'Workshop');
  await job.tick();
  await MeetingTranscriptionService.settled();
  await job.accept(id, 'workshop.wav');

  const internals = queue as unknown as { release: (b: unknown) => Promise<string[]> };
  const release = internals.release;
  internals.release = async () => { throw new Error('stopped here'); };
  assert.equal((await queue.runNow(new Date('2026-10-30T18:00:00'))).status, 'error');
  internals.release = release;
  const update = (await updates.list()).find((u) => u.origin === 'meetings')!;
  // A partial transcript made to look complete, in both records.
  const file = path.join(ws, 'context-updates', update.id, 'update.md');
  const text = await fsp.readFile(file, 'utf-8');
  assert.match(text, /complete: false/);
  await fsp.writeFile(file, text.replace(/complete: false/g, 'complete: true'));
  const again = await queue.runNow(new Date('2026-10-30T18:05:00'));
  assert.equal(again.status, 'error');
  await fsp.access(path.join(ws, 'context-updates', 'meeting-queue', id, 'workshop.wav'));

  // A readable copy of any other kind does not get to skip its source with the flag.
  fail = false;
  const plain = await updates.create({ title: 'Fictional notes', notes: '', source_date: '2026-10-30' } as never);
  const vtt = Buffer.from('WEBVTT\n\n00:00:01.000 --> 00:00:04.000\n<v Jane Doe>Fictional words.</v>\n');
  await updates.addMaterial(plain.id, 'talk.vtt', vtt);
  const plainFile = path.join(ws, 'context-updates', plain.id, 'update.md');
  const plainText = await fsp.readFile(plainFile, 'utf-8');
  await fsp.writeFile(plainFile, plainText.replace(/kind: webvtt/, 'kind: webvtt\n    source_removed: true'));
  await fsp.rm(path.join(ws, 'context-updates', plain.id, 'materials', 'talk.vtt'));
  assert.equal((await updates.get(plain.id)).transcripts[0]!.current, false);
});

test('a recording stays in the queue when the digest does not hold its transcript as recorded', async (t) => {
  const ws = await workspace(t);
  const queue = new MeetingDigestService();
  const { engine } = fakeEngine(speaks(['Fictional budget review.']));
  const id = await queueRecording(queue, 'Workshop');
  await new MeetingTranscriptionService(queue, fakeModels(), engine).tick();
  await MeetingTranscriptionService.settled();

  // The dashboard stops right after publishing, before it hands the meeting over...
  const internals = queue as unknown as { release: (b: unknown) => Promise<string[]> };
  const release = internals.release;
  internals.release = async () => { throw new Error('stopped here'); };
  const run = await queue.runNow(new Date('2026-10-30T18:00:00'));
  assert.equal(run.status, 'error');
  internals.release = release;
  const update = (await new ContextUpdateService().list()).find((u) => u.origin === 'meetings')!;

  // ...and the transcript in the digest changes before recovery: the audio is the only good copy left.
  await fsp.writeFile(path.join(ws, 'context-updates', update.id, 'materials', `${id}-workshop.transcript.md`), 'changed');
  const again = await queue.runNow(new Date('2026-10-30T18:05:00'));
  assert.equal(again.status, 'error');
  assert.match(again.message, new RegExp(id));
  await fsp.access(path.join(ws, 'context-updates', 'meeting-queue', id, 'workshop.wav'));
});

test('an engine busy with something else, such as a speed test, leaves the recording waiting, not failed', async (t) => {
  await workspace(t);
  const queue = new MeetingDigestService();
  let busy = true;
  const { engine } = fakeEngine(async (wav, o) => {
    if (busy) throw Object.assign(new Error('A transcription is already running; wait for it to finish'), { statusCode: 409, engineBusy: true });
    return speaks(['Later.'])(wav, o);
  });
  const job = new MeetingTranscriptionService(queue, fakeModels(), engine);
  const id = await queueRecording(queue, 'Workshop');
  await job.tick();
  await MeetingTranscriptionService.settled();
  assert.equal((await recording(queue, id)).status, 'pending');
  busy = false;
  await job.tick();
  await MeetingTranscriptionService.settled();
  assert.equal((await recording(queue, id)).status, 'done');
});

test('no background job left an unhandled rejection', async () => {
  await MeetingTranscriptionService.settled();
  assert.deepEqual(unhandled, []);
});

test('the page can read the transcript the server writes', () => {
  const segments = [{ start: 28_800, end: 28_802, text: '<b>Fictional</b> ``` words' }, { start: 28_803, end: 28_804, text: 'line one\nline two' }];
  assert.deepEqual(transcriptParts(audioTranscriptMarkdown('a.wav', 'hash', 'fast', 'auto', 28_804, segments, true)), [
    { time: '08:00:00', text: '<b>Fictional</b> ``` words' }, { time: '08:00:03', text: 'line one line two' },
  ]);
  assert.deepEqual(transcriptParts(audioTranscriptMarkdown('a.wav', 'hash', 'fast', 'auto', 10, [], true)), []);
  const voices = [{ start: 1, end: 2, text: 'Fictional words.', speaker: 2 }, { start: 3, end: 4, text: 'Not clear whose.' }];
  assert.deepEqual(transcriptParts(audioTranscriptMarkdown('a.wav', 'hash', 'fast', 'auto', 4, voices, true)), [
    { time: '00:00:01', speaker: 'Speaker 2', text: 'Fictional words.' }, { time: '00:00:03', text: 'Not clear whose.' },
  ], 'speakers too');
});

test('speakers are marked in the transcript, and when finding them fails the transcript is still made', async (t) => {
  const ws = await workspace(t);
  const queue = new MeetingDigestService();
  const models = { readSettings: async () => ({ model: 'whisper-large-v3-turbo', language: 'auto', speakers: true }), installedPath: async () => '/fictional/model' } as unknown as TranscriptionModelService;
  const read = async (id: string) => fsp.readFile(path.join(ws, 'context-updates', 'meeting-queue', id, 'workshop.transcript.md'), 'utf-8');
  const run = async (note: string | null, transcribe: Transcribe) => {
    const engine = { transcribeWithSpeakers: async (wav: string, o: Parameters<Transcribe>[1]) => ({ ...await transcribe(wav, o), speaker_note: note }) } as unknown as TranscriptionEngine;
    const id = await queueRecording(queue, 'Workshop');
    await new MeetingTranscriptionService(queue, models, engine).tick();
    await MeetingTranscriptionService.settled();
    return id;
  };

  const told = await run(null, async (_wav, o) => {
    o.onSegment?.({ start: 0, end: 1, text: 'Fictional words.', speaker: 1 } as Segment);
    return { segments: [], seconds: 1, load_ms: 1 };
  });
  assert.equal((await recording(queue, told)).status, 'done');
  assert.match(await read(told), /\[00:00:00 → 00:00:01\] Speaker 1\n {2}Fictional words\./);
  assert.match(await read(told), /1 voice told apart\. Speaker 1 and so on are labels for this recording, not names/);

  // Named on the Meetings page: for this transcript only, and only labels it has.
  const job = new MeetingTranscriptionService(queue, models, { } as unknown as TranscriptionEngine);
  const sha = (await recording(queue, told)).transcript_sha256!;
  await assert.rejects(job.nameSpeakers(told, 'workshop.wav', { transcript_sha256: 'old', names: { 'Speaker 1': { name: 'Kim Park' } } }), /changed meanwhile/);
  await assert.rejects(job.nameSpeakers(told, 'workshop.wav', { transcript_sha256: sha, names: { 'Speaker 7': { name: 'Kim Park' } } }), /no Speaker 7/);
  await assert.rejects(job.nameSpeakers(told, 'workshop.wav', { transcript_sha256: sha, names: { 'Speaker 1': { name: '  ' } } }), /Invalid name/);
  assert.deepEqual([...transcriptSpeakers('[00:00:01 → 00:00:02] Speaker 1\n  Quoted text ] Speaker 7\n')], ['Speaker 1'], 'a label someone said is no speaker');
  await job.nameSpeakers(told, 'workshop.wav', { transcript_sha256: sha, names: { 'Speaker 1': { name: 'Kim Park', ref: 'STK-0002' } } });
  assert.deepEqual((await recording(queue, told)).speaker_names, { transcript_sha256: sha, names: [{ label: 'Speaker 1', name: 'Kim Park', ref: 'STK-0002' }] });
  await job.nameSpeakers(told, 'workshop.wav', { transcript_sha256: sha, names: { 'Speaker 1': { name: 'Odd', ref: '../x' } } });
  assert.deepEqual((await recording(queue, told)).speaker_names?.names, [{ label: 'Speaker 1', name: 'Odd' }], 'a ref that is not a stakeholder id is dropped');
  await job.nameSpeakers(told, 'workshop.wav', { transcript_sha256: sha, names: { 'Speaker 1': null } });
  assert.equal((await recording(queue, told)).speaker_names, undefined);

  // A transcript with 201 voices: all of them can be named but one, and nothing is dropped quietly.
  const many = audioTranscriptMarkdown('a.wav', 'h', 'fast', 'auto', 300, Array.from({ length: 201 }, (_, i) => ({ start: i, end: i + 1, text: 'x', speaker: i + 1 })), true);
  assert.equal(transcriptSpeakers(many).size, 201);
  assert.equal(parseSpeakerNames(Array.from({ length: 201 }, (_, i) => ({ label: `Speaker ${i + 1}`, name: 'P' }))).length, 200);

  // The digest tells the agent who they are, as the user named them.
  await job.nameSpeakers(told, 'workshop.wav', { transcript_sha256: sha, names: { 'Speaker 1': { name: 'Kim Park', ref: 'STK-0002' } } });
  const digest = await queue.runNow(new Date('2026-10-30T18:00:00'));
  assert.equal(digest.status, 'ok', digest.message);
  const list = await fsp.readFile(path.join(ws, 'context-updates', digest.context_update!, 'materials', 'meetings.md'), 'utf-8');
  assert.match(list, /speakers_named_by_user: \[".*workshop\.transcript\.md: Speaker 1 = Kim Park \(STK-0002\)"\]/);
  await assert.rejects(job.nameSpeakers(told, 'workshop.wav', { transcript_sha256: sha, names: { 'Speaker 1': null } }), /digest|No recording|not found/i, 'not once a digest has it');

  const failed = await run('speaker detection failed', speaks(['Fictional words.']));
  assert.equal((await recording(queue, failed)).status, 'done', 'the transcript does not depend on it');
  assert.match(await read(failed), /Speakers are not told apart \(speaker detection failed\)/);
  assert.match(await read(failed), /Fictional words\./);
});

test('parts with no words in more than a minute (a language the model does not know) are partial, not complete', async (t) => {
  await workspace(t);
  const queue = new MeetingDigestService();
  // A fictional Portuguese meeting read by a model without Portuguese: parts of only punctuation.
  const { engine } = fakeEngine(speaks([',', '.', '。', ', .'], 134));
  const id = await queueRecording(queue, 'Fictional Orion meeting');
  await new MeetingTranscriptionService(queue, fakeModels(), engine).tick();
  await MeetingTranscriptionService.settled();
  const r = await recording(queue, id);
  assert.equal(r.status, 'partial');
  assert.match(r.error ?? '', /No words were found .* may not know the meeting's language/);
  assert.match((await queue.runNow(new Date('2026-10-30T18:00:00'))).message, /1 meeting waits for transcription/, 'the digest does not take it');
});

test('a recording fixed to a model that is not downloaded can switch to the model the page offered', async (t) => {
  await workspace(t);
  const queue = new MeetingDigestService();
  const { engine, calls } = fakeEngine(speaks(['Fictional switch test']));
  // Only SenseVoice is downloaded, and chosen; the recording was finished for Turbo.
  const models = {
    readSettings: async () => ({ model: 'whisper-large-v3-turbo', language: 'auto' }),
    installedPath: async (id: string) => (id === 'sensevoice-2024-07-17' ? '/fictional/model' : null),
  } as unknown as TranscriptionModelService;
  const id = await queueRecording(queue, 'Switch');
  await queue.withQueue(async () => {
    const m = await queue.loadMeeting(id);
    m.files[0]!.recording = { ...m.files[0]!.recording!, target: { model: 'whisper-large-v3-turbo', language: 'auto' } };
    await queue.saveMeeting(m);
  });
  const job = new MeetingTranscriptionService(queue, models, engine);
  await job.tick();
  await MeetingTranscriptionService.settled();
  assert.equal(calls.length, 0, 'it waits for its model');
  await assert.rejects(job.retry(id, 'workshop.wav'), /chosen in Settings .* is not downloaded/, 'switching to a model that is not there either is refused');
  await assert.rejects(job.retry(id, 'workshop.wav', 'not-a-model'), /Not a transcription model/);
  // "Use SenseVoice" names the model the page showed, even if Settings changed meanwhile in another dashboard.
  await job.retry(id, 'workshop.wav', 'sensevoice-2024-07-17');
  await MeetingTranscriptionService.settled();
  const r = await recording(queue, id);
  assert.equal(r.status, 'done');
  assert.equal(r.model, 'sensevoice-2024-07-17');
  assert.equal(r.target?.model, 'sensevoice-2024-07-17');
  assert.equal(r.target?.language, 'auto', 'the spoken language stays');
  // A recording that is only waiting its turn is not touched by "Try again".
  const other = await queueRecording(queue, 'Waiting');
  await queue.withQueue(async () => {
    const m = await queue.loadMeeting(other);
    m.held = true;
    await queue.saveMeeting(m);
  });
  await assert.rejects(job.retry(other, 'workshop.wav', 'sensevoice-2024-07-17'), /Only a stopped/);
});

test('the next recording starts as soon as one is done, not at the next check', async (t) => {
  await workspace(t);
  const queue = new MeetingDigestService();
  const { engine, calls } = fakeEngine(speaks(['Fictional queue test']));
  const first = await queueRecording(queue, 'First');
  const second = await queueRecording(queue, 'Second');
  await new MeetingTranscriptionService(queue, fakeModels(), engine).tick();
  for (let i = 0; i < 50 && calls.length < 2; i++) await new Promise((r) => setTimeout(r, 20));
  await MeetingTranscriptionService.settled();
  assert.equal(calls.length, 2, 'one tick did both');
  assert.equal((await recording(queue, first)).status, 'done');
  assert.equal((await recording(queue, second)).status, 'done');
});

test('a job that found the engine busy starts again by itself when the engine came free while it was ending', async (t) => {
  await workspace(t);
  const queue = new MeetingDigestService();
  const { engineEvents } = await import('../src/services/transcription/engine');
  let first = true;
  const { engine, calls } = fakeEngine(async (wav, o) => {
    if (first) {
      first = false;
      // The other job (a speed test, a live transcript) lets go just as this one gives up.
      engineEvents.emit('free');
      throw Object.assign(new Error('A transcription is already running; wait for it to finish'), { statusCode: 409, engineBusy: true });
    }
    return speaks(['Fictional retry after free'])(wav, o);
  });
  const id = await queueRecording(queue, 'Busy then free');
  await new MeetingTranscriptionService(queue, fakeModels(), engine).tick();
  for (let i = 0; i < 50 && calls.length < 2; i++) await new Promise((r) => setTimeout(r, 20));
  await MeetingTranscriptionService.settled();
  assert.equal(calls.length, 2);
  assert.equal((await recording(queue, id)).status, 'done', 'no routine check was needed');
});

test('a result that cannot be saved is not transcribed again and again, and the meetings after it get their turn', async (t) => {
  await workspace(t);
  const queue = new MeetingDigestService();
  const transcribed: string[] = [];
  const { engine } = fakeEngine(async (wav, o) => { transcribed.push(path.basename(path.dirname(wav))); return speaks(['Fictional result'])(wav, o); });
  const first = await queueRecording(queue, 'Unsaved');
  const second = await queueRecording(queue, 'Healthy');
  // Saving the first meeting's transcript fails every time; everything else can be written.
  const original = queue.saveMeeting.bind(queue);
  queue.saveMeeting = async (m) => {
    if (m.id === first && m.files.some((f) => f.recording?.status === 'done' || f.recording?.status === 'partial')) throw new Error('Fictional disk refusal');
    return original(m);
  };
  t.after(() => { queue.saveMeeting = original; });
  const job = new MeetingTranscriptionService(queue, fakeModels(), engine);
  // Routine checks, one after another.
  for (let i = 0; i < 3; i++) {
    await job.tick();
    await MeetingTranscriptionService.settled();
  }
  assert.equal((await recording(queue, second)).status, 'done', 'the next meeting was not held up');
  assert.equal(transcribed.filter((d) => d === first).length, 1, 'the unsaved one waits before it is tried again');
});
