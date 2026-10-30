import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { MeetingDigestService, type QueuedMeeting, type RecordingState } from '../src/services/meetingDigestService';
import { MeetingRecordingService } from '../src/services/meetingRecording';
import { MeetingLiveTranscriptService } from '../src/services/meetingLiveTranscript';
import { MeetingTranscriptionService } from '../src/services/meetingTranscription';
import { ContextUpdateService } from '../src/services/contextUpdateService';
import type { FollowSession, Segment, TranscriptionEngine } from '../src/services/transcription/engine';
import type { TranscriptionModelService } from '../src/services/transcriptionModels';

const TOKEN = 'fictional-writer-token-refine';
const second = Buffer.alloc(32_000, 1);

async function workspace(t: { after: (fn: () => Promise<void> | void) => void }): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-refine-'));
  const previous = process.env.ESB_WORKSPACE_PATH;
  process.env.ESB_WORKSPACE_PATH = dir;
  t.after(async () => {
    await MeetingTranscriptionService.settled();
    MeetingLiveTranscriptService.reset();
    if (previous === undefined) delete process.env.ESB_WORKSPACE_PATH;
    else process.env.ESB_WORKSPACE_PATH = previous;
    await fsp.rm(dir, { recursive: true, force: true });
  });
  for (const d of ['tasks/active', 'context-updates', '.situation-board/routines']) await fsp.mkdir(path.join(dir, d), { recursive: true });
  return dir;
}

/** Settings that can change, and the models that are downloaded. */
function models(settings: { model: string; live_model: string | null; language?: string }, installed = ['fast', 'accurate']) {
  const current = { language: 'auto', keep_recordings: false, updated_at: null, ...settings };
  const service = {
    readSettings: async () => ({ ...current }),
    installedPath: async (id: string) => (installed.includes(id) ? '/fictional' : null),
  } as unknown as TranscriptionModelService;
  return { service, current, installed };
}

/** A live job that covers everything and says one stretch per second. */
function liveEngine(): TranscriptionEngine {
  return {
    follow: async (_wav: string, o: { onSegment: (s: Segment) => void }): Promise<FollowSession> => {
      let said = 0;
      let committed = 0;
      return {
        committed: (bytes: number) => { committed = Math.max(committed, bytes); while ((said + 1) * 32_000 <= committed) { o.onSegment({ start: said, end: said + 0.9, text: `Live words ${said}` }); said++; } },
        end: async (bytes: number) => ({ ok: true as const, bytes, seconds: bytes / 32_000, segments: said }),
        cancel: async () => {},
        failed: null,
      };
    },
  } as unknown as TranscriptionEngine;
}

type Transcribe = (wav: string, o: { model?: string; signal?: AbortSignal; onSegment?: (s: Segment) => void }) => Promise<{ segments: Segment[]; seconds: number; load_ms: number | null }>;
function queueEngine(work: Transcribe) {
  const calls: string[] = [];
  const engine = { transcribe: (wav: string, o: Parameters<Transcribe>[1]) => { calls.push(o.model ?? ''); return work(wav, o); } } as unknown as TranscriptionEngine;
  return { engine, calls };
}
const accurate: Transcribe = async (_w, o) => {
  const segments = [{ start: 0, end: 1.5, text: 'Accurate words.' }];
  for (const s of segments) o.onSegment?.(s);
  return { segments, seconds: 2, load_ms: 1 };
};

async function recordAndFinish(ws: string, m: ReturnType<typeof models>) {
  const queue = new MeetingDigestService();
  const live = new MeetingLiveTranscriptService(queue, m.service, liveEngine());
  const recording = new MeetingRecordingService(queue, live, m.service);
  const meeting = await queue.createMeeting({ title: 'Fictional refine', meeting_date: '2026-10-30' });
  const { generation } = await recording.start(meeting.id, TOKEN);
  await new Promise((r) => setTimeout(r, 20));
  let offset = 0;
  for (let i = 0; i < 2; i++) offset = (await recording.append(meeting.id, TOKEN, offset, second)).offset;
  await new Promise((r) => setTimeout(r, 20));
  const done = await recording.finish(meeting.id, { token: TOKEN, offset, generation, queue: true });
  const folder = path.join(ws, 'context-updates', 'meeting-queue', meeting.id);
  return { queue, id: meeting.id, done, folder };
}
const audio = (m: QueuedMeeting) => m.files.find((f) => f.recording)!;
const transcriptFiles = async (folder: string) => (await fsp.readdir(folder)).filter((n) => n.endsWith('.transcript.md')).sort();

test('a live transcript from a faster model is a draft; the chosen model, fixed at Finish, transcribes again and replaces it', async (t) => {
  const ws = await workspace(t);
  const m = models({ model: 'accurate', live_model: 'fast' });
  const { queue, id, done, folder } = await recordAndFinish(ws, m);
  const r = audio(done).recording!;
  assert.equal(r.status, 'pending');
  assert.deepEqual(r.target, { model: 'accurate', language: 'auto' });
  assert.equal(r.draft?.model, 'fast');
  assert.deepEqual(await transcriptFiles(folder), [r.draft!.transcript]);
  assert.match((await queue.runNow(new Date('2026-10-30T18:00:00'))).message, /waits for transcription/, 'a draft is not used by a digest');

  // Settings change after the meeting: the recording still goes to the model fixed at Finish.
  m.current.model = 'fast';
  const { engine, calls } = queueEngine(accurate);
  const job = new MeetingTranscriptionService(queue, m.service, engine);
  await job.tick();
  await MeetingTranscriptionService.settled();
  assert.deepEqual(calls, ['accurate']);
  const after = audio(await queue.loadMeeting(id)).recording!;
  assert.equal(after.status, 'done');
  assert.equal(after.draft, undefined);
  assert.deepEqual(await transcriptFiles(folder), [after.transcript], 'only one transcript: the draft is gone');
  assert.match(await fsp.readFile(path.join(folder, after.transcript!), 'utf-8'), /Accurate words/);
  assert.deepEqual((await queue.loadMeeting(id)).files.map((f) => f.name).filter((n) => n.endsWith('.transcript.md')), [after.transcript]);
});

test('the draft survives every step of the queue: busy, failure, stop, retry and a dashboard that went away', async (t) => {
  const ws = await workspace(t);
  const m = models({ model: 'accurate', live_model: 'fast' });
  const { queue, id } = await recordAndFinish(ws, m);
  const draft = audio(await queue.loadMeeting(id)).recording!.draft!;
  const state = async () => audio(await queue.loadMeeting(id)).recording!;
  const keeps = async (label: string, status: RecordingState['status']) => {
    const r = await state();
    assert.equal(r.status, status, label);
    assert.deepEqual(r.draft, draft, `${label}: the draft is kept`);
    assert.deepEqual(r.target, { model: 'accurate', language: 'auto' }, `${label}: the target is kept`);
  };

  const busy = queueEngine(async () => { throw Object.assign(new Error('busy'), { engineBusy: true }); });
  await new MeetingTranscriptionService(queue, m.service, busy.engine).tick();
  await MeetingTranscriptionService.settled();
  await keeps('engine busy', 'pending');

  const broken = queueEngine(async () => { throw new Error('The model could not be loaded.'); });
  const job = new MeetingTranscriptionService(queue, m.service, broken.engine);
  await job.tick();
  await MeetingTranscriptionService.settled();
  await keeps('failed', 'failed');
  await job.retry(id, audio(await queue.loadMeeting(id)).name);
  await MeetingTranscriptionService.settled();
  await keeps('retried, failed again', 'failed');

  await queue.withQueue(async () => {
    const meeting = await queue.loadMeeting(id);
    audio(meeting).recording = { ...audio(meeting).recording!, status: 'running', generation: 'gone', owner: { pid: 2 ** 22 + 1, token: 'gone' } };
    await queue.saveMeeting(meeting);
  });
  await new MeetingTranscriptionService(queue, m.service, busy.engine).tick();
  await MeetingTranscriptionService.settled();
  await keeps('recovered from a dashboard that went away', 'pending');
  await job.stop(id, audio(await queue.loadMeeting(id)).name);
  await keeps('stopped', 'stopped');
});

test('a partial accurate transcript leaves both to choose from; choosing one removes the other', async (t) => {
  const ws = await workspace(t);
  const m = models({ model: 'accurate', live_model: 'fast' });
  const partial: Transcribe = async (_w, o) => { o.onSegment?.({ start: 0, end: 1, text: 'Half.' }); throw new Error('The engine stopped (SIGKILL).'); };
  for (const choice of ['accept-partial', 'use-live'] as const) {
    const { queue, id, folder } = await recordAndFinish(ws, m);
    const job = new MeetingTranscriptionService(queue, m.service, queueEngine(partial).engine);
    await job.tick();
    await MeetingTranscriptionService.settled();
    const r = audio(await queue.loadMeeting(id)).recording!;
    assert.equal(r.status, 'partial');
    assert.equal((await transcriptFiles(folder)).length, 2, 'both candidates while undecided');
    const name = audio(await queue.loadMeeting(id)).name;
    if (choice === 'accept-partial') {
      const chosen = audio(await job.accept(id, name)).recording!;
      assert.deepEqual([chosen.accepted, chosen.draft], [true, undefined]);
      assert.deepEqual(await transcriptFiles(folder), [r.transcript]);
    } else {
      const chosen = audio(await job.useLive(id, name, r.draft!.transcript_sha256)).recording!;
      assert.deepEqual([chosen.status, chosen.accepted_live, chosen.transcript, chosen.model], ['done', true, r.draft!.transcript, 'fast']);
      assert.deepEqual(await transcriptFiles(folder), [r.draft!.transcript]);
    }
    // The digest takes the meeting with exactly one transcript.
    const run = await queue.runNow(new Date('2026-10-30T18:00:00'));
    assert.equal(run.status, 'ok', run.message);
    const update = await new ContextUpdateService().get(run.context_update!);
    assert.equal(update.material_files.filter((f) => f.name.endsWith('.transcript.md')).length, 1, choice);
    await new ContextUpdateService().remove(update.id);
  }
});

test('Use the live transcript is refused while the accurate one runs, for a stale draft, and for changed files', async (t) => {
  const ws = await workspace(t);
  const m = models({ model: 'accurate', live_model: 'fast' });
  const { queue, id, folder } = await recordAndFinish(ws, m);
  const r = audio(await queue.loadMeeting(id)).recording!;
  const name = audio(await queue.loadMeeting(id)).name;
  let started!: () => void;
  const running = new Promise<void>((s) => { started = s; });
  const slow: Transcribe = (_w, o) => new Promise((_ok, no) => { started(); o.signal!.addEventListener('abort', () => no(new Error('Cancelled.'))); });
  const job = new MeetingTranscriptionService(queue, m.service, queueEngine(slow).engine);
  await job.tick();
  await running;
  await assert.rejects(job.useLive(id, name, r.draft!.transcript_sha256), /being made; stop it first/);
  const generation = audio(await queue.loadMeeting(id)).recording!.generation!;
  await assert.rejects(job.stop(id, name, 'another-job'), /changed meanwhile/);
  await job.stop(id, name, generation);
  await MeetingTranscriptionService.settled();
  await assert.rejects(job.useLive(id, name, '0'.repeat(64)), /changed meanwhile/);
  await fsp.writeFile(path.join(folder, r.draft!.transcript), 'edited by hand');
  await assert.rejects(job.useLive(id, name, r.draft!.transcript_sha256), /changed or removed on disk/);
  assert.equal(audio(await queue.loadMeeting(id)).recording!.status, 'stopped', 'nothing changed');
});

test('a target model that is not downloaded keeps its recording waiting, and the others go on', async (t) => {
  const ws = await workspace(t);
  const m = models({ model: 'accurate', live_model: 'fast' });
  const first = await recordAndFinish(ws, m);
  m.installed.splice(m.installed.indexOf('accurate'), 1);
  const { engine, calls } = queueEngine(accurate);
  await new MeetingTranscriptionService(first.queue, m.service, engine).tick();
  await MeetingTranscriptionService.settled();
  assert.deepEqual(calls, []);
  assert.equal(audio(await first.queue.loadMeeting(first.id)).recording!.status, 'pending');
});

test('a damaged draft or target record makes the meeting unreadable: nothing transcribes or digests it, and every file stays', async (t) => {
  const ws = await workspace(t);
  const m = models({ model: 'accurate', live_model: 'fast' });
  for (const [label, edit] of [
    ['seconds is not a number', (text: string) => text.replace(/(draft:[\s\S]*?seconds: )[\d.]+/, '$1"two"')],
    ['the draft is not among the files', (text: string) => text.replace(/(draft:\s*\n\s*transcript: )\S+/, '$1other.transcript.md')],
    ['the target has no model', (text: string) => text.replace(/(target:\s*\n\s*model: )\S+/, '$1""')],
  ] as const) {
    const { queue, id, folder } = await recordAndFinish(ws, m);
    const manifest = path.join(folder, 'meeting.md');
    const before = await fsp.readFile(manifest, 'utf-8');
    const changed = edit(before);
    assert.notEqual(changed, before, `${label}: the test edit applies`);
    await fsp.writeFile(manifest, changed);
    await assert.rejects(queue.loadMeeting(id), /cannot be read/, label);
    const files = (await fsp.readdir(folder)).sort();
    const { engine, calls } = queueEngine(accurate);
    await new MeetingTranscriptionService(queue, m.service, engine).tick();
    await MeetingTranscriptionService.settled();
    assert.deepEqual(calls, [], `${label}: not transcribed`);
    assert.ok((await queue.readQueue()).problems.some((p) => p.id === id), `${label}: listed as a problem`);
    assert.deepEqual((await fsp.readdir(folder)).sort(), files, `${label}: every file kept`);
    await queue.removeMeeting(id);
  }
});

test('once the accurate transcript is saved, a failing clean-up never undoes it', async (t) => {
  const ws = await workspace(t);
  const m = models({ model: 'accurate', live_model: 'fast' });
  const { queue, id, folder } = await recordAndFinish(ws, m);
  const job = new MeetingTranscriptionService(queue, m.service, queueEngine(accurate).engine);
  (job as unknown as { removeUnnamed: () => Promise<void> }).removeUnnamed = async () => { throw new Error('the folder is busy'); };
  await job.tick();
  await MeetingTranscriptionService.settled();
  const r = audio(await queue.loadMeeting(id)).recording!;
  assert.equal(r.status, 'done');
  await fsp.access(path.join(folder, r.transcript!));
  // The old draft is left for recovery, which removes it as a file the manifest no longer names.
  await new MeetingTranscriptionService(queue, m.service, queueEngine(accurate).engine).tick();
  await MeetingTranscriptionService.settled();
  assert.deepEqual(await transcriptFiles(folder), [r.transcript]);
});

test('a recording waiting for a model that is not downloaded never holds up the next one', async (t) => {
  const ws = await workspace(t);
  const m = models({ model: 'gone', live_model: 'fast' }, ['fast', 'gone', 'accurate']);
  const first = await recordAndFinish(ws, m);
  m.current.model = 'accurate';
  MeetingLiveTranscriptService.reset();
  const second = await recordAndFinish(ws, m);
  m.installed.splice(m.installed.indexOf('gone'), 1);
  const { engine, calls } = queueEngine(accurate);
  await new MeetingTranscriptionService(first.queue, m.service, engine).tick();
  await MeetingTranscriptionService.settled();
  assert.deepEqual(calls, ['accurate']);
  assert.equal(audio(await first.queue.loadMeeting(first.id)).recording!.status, 'pending');
  assert.equal(audio(await second.queue.loadMeeting(second.id)).recording!.status, 'done');
});
