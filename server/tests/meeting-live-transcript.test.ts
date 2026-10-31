import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { MeetingDigestService } from '../src/services/meetingDigestService';
import { MeetingRecordingService } from '../src/services/meetingRecording';
import { MeetingLiveTranscriptService, liveTranscriptFile } from '../src/services/meetingLiveTranscript';
import type { FollowSession, Segment, TranscriptionEngine } from '../src/services/transcription/engine';
import type { TranscriptionModelService } from '../src/services/transcriptionModels';

const TOKEN = 'fictional-writer-token-live';

async function workspace(t: { after: (fn: () => Promise<void> | void) => void }): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-live-'));
  const previous = process.env.ESB_WORKSPACE_PATH;
  process.env.ESB_WORKSPACE_PATH = dir;
  t.after(async () => {
    MeetingLiveTranscriptService.reset();
    if (previous === undefined) delete process.env.ESB_WORKSPACE_PATH;
    else process.env.ESB_WORKSPACE_PATH = previous;
    await fsp.rm(dir, { recursive: true, force: true });
  });
  for (const d of ['tasks/active', 'context-updates', '.situation-board/routines']) await fsp.mkdir(path.join(dir, d), { recursive: true });
  return dir;
}

function fakeModels(live: string | null = 'fast', main = 'fast'): TranscriptionModelService {
  return {
    readSettings: async () => ({ model: main, language: 'auto', keep_recordings: false, live_model: live, updated_at: null }),
    installedPath: async () => '/fictional/model',
  } as unknown as TranscriptionModelService;
}

interface FakeOptions { busy?: boolean; cover?: (sealed: number) => number; failWith?: string; progress?: (committed: number) => number; lateLanguage?: boolean }

/** A follow job that says one stretch of speech per second of committed audio, and covers what it is told to. */
function fakeEngine(o: FakeOptions = {}) {
  const state = { committed: 0, cancelled: false, sessions: 0, languages: [] as { at: number; language: string; afterAudio: number }[] };
  const engine = {
    follow: async (_wav: string, opts: { onSegment: (s: Segment) => void; onProgress?: (done: number, total: number) => void }): Promise<FollowSession> => {
      if (o.busy) throw Object.assign(new Error('A transcription is already running'), { engineBusy: true });
      state.sessions++;
      let said = 0;
      let failed: string | null = null;
      return {
        committed: (bytes: number) => {
          state.committed = Math.max(state.committed, bytes);
          while ((said + 1) * 32_000 <= state.committed) { opts.onSegment({ start: said, end: said + 0.9, text: `Fictional words ${said}` }); said++; }
          opts.onProgress?.(o.progress ? o.progress(state.committed) : state.committed / 32_000, state.committed / 32_000);
          if (o.failWith) failed = o.failWith;
        },
        language: (at: number, language: string) => { state.languages.push({ at, language, afterAudio: state.committed }); },
        end: async (bytes: number) => (o.failWith ? { ok: false as const, message: o.failWith } : { ok: true as const, bytes: o.cover ? o.cover(bytes) : bytes, seconds: bytes / 32_000, segments: said, lateLanguage: o.lateLanguage === true }),
        cancel: async () => { state.cancelled = true; },
        get failed() { return failed; },
      };
    },
  } as unknown as TranscriptionEngine;
  return { engine, state };
}

function services(ws: string, models: TranscriptionModelService, engine: TranscriptionEngine) {
  const queue = new MeetingDigestService();
  const live = new MeetingLiveTranscriptService(queue, models, engine);
  // The fake Settings for the target too: a test never reads this computer's own settings.
  const recording = new MeetingRecordingService(queue, live, models);
  const folder = (id: string) => path.join(ws, 'context-updates', 'meeting-queue', id);
  return { queue, live, recording, folder };
}

const second = Buffer.alloc(32_000, 1);
const settle = () => new Promise((r) => setTimeout(r, 30));

async function record(s: ReturnType<typeof services>, seconds: number) {
  const m = await s.queue.createMeeting({ title: 'Fictional live meeting', meeting_date: '2026-10-30' });
  const { generation } = await s.recording.start(m.id, TOKEN);
  await settle();
  let offset = 0;
  for (let i = 0; i < seconds; i++) offset = (await s.recording.append(m.id, TOKEN, offset, second)).offset;
  await settle();
  return { id: m.id, generation, offset };
}

test('a live transcript that covered everything is the transcript at Stop, and its files go', async (t) => {
  const ws = await workspace(t);
  const s = services(ws, fakeModels(), fakeEngine().engine);
  const { id, generation, offset } = await record(s, 3);

  const part = await s.live.read(id, 1);
  assert.deepEqual([part.status, part.next, part.segments.map((x) => x.i)], ['live', 3, [1, 2]], 'read on from a number');
  assert.equal((await fsp.readFile(path.join(s.folder(id), liveTranscriptFile(generation)), 'utf-8')).trim().split('\n').length, 3, 'each stretch saved before the page hears of it');

  const done = await s.recording.finish(id, { token: TOKEN, offset, generation, queue: true });
  const audio = done.files.find((f) => f.recording)!;
  assert.equal(audio.recording?.status, 'done');
  const transcript = await fsp.readFile(path.join(s.folder(id), audio.recording!.transcript!), 'utf-8');
  assert.match(transcript, /\*\*Complete\.\*\*[\s\S]*Fictional words 2/);
  assert.equal(done.status, 'queued');
  assert.deepEqual((await fsp.readdir(s.folder(id))).filter((n) => n.startsWith('.')), [], 'no live files left');
});

test('anything short of full coverage leaves the recording to the queue, untouched', async (t) => {
  const ws = await workspace(t);
  for (const [label, o, models] of [
    ['the worker read less than was sealed', { cover: (b: number) => b - 2 }, fakeModels()],
    ['the worker failed', { failWith: 'The engine stopped' }, fakeModels()],
    ['the engine was busy at the start', { busy: true }, fakeModels()],
    ['no live transcript in Settings', {}, fakeModels(null)],
  ] as const) {
    const s = services(ws, models, fakeEngine(o).engine);
    const { id, generation, offset } = await record(s, 2);
    const done = await s.recording.finish(id, { token: TOKEN, offset, generation, queue: true });
    const audio = done.files.find((f) => f.recording)!;
    assert.equal(audio.recording?.status, 'pending', label);
    assert.equal(done.files.length, 1, `${label}: no transcript file`);
    assert.equal(audio.size, 44 + 64_000, `${label}: the recording is whole`);
    assert.deepEqual((await fsp.readdir(s.folder(id))).filter((n) => n.startsWith('.')), [], `${label}: no live files left`);
    await s.queue.removeMeeting(id);
  }
});

test('a live transcript from another model than the chosen one is kept as a draft, and the recording waits for the chosen one', async (t) => {
  const ws = await workspace(t);
  const s = services(ws, fakeModels('fast', 'accurate'), fakeEngine().engine);
  const { id, generation, offset } = await record(s, 2);
  const done = await s.recording.finish(id, { token: TOKEN, offset, generation, queue: true });
  const r = done.files.find((f) => f.recording)!.recording!;
  assert.deepEqual([r.status, r.draft?.model, r.target?.model], ['pending', 'fast', 'accurate']);
  assert.equal(done.files.length, 2, 'the recording and its draft');
});

test('a Finish in a dashboard without the live job uses the queue, and a recovery cleans the old live file', async (t) => {
  const ws = await workspace(t);
  const a = services(ws, fakeModels(), fakeEngine().engine);
  const { id, generation } = await record(a, 2);
  // Another dashboard (or this one after a restart) finishes it: no job here.
  MeetingLiveTranscriptService.reset();
  const b = services(ws, fakeModels(), fakeEngine().engine);
  const done = await b.recording.finish(id, { recover: true, generation, queue: true });
  assert.equal(done.files.find((f) => f.recording)!.recording?.status, 'pending');
  assert.equal(await fsp.access(path.join(b.folder(id), liveTranscriptFile(generation))).then(() => true, () => false), true, 'left for the cleanup');
  const { MeetingTranscriptionService } = await import('../src/services/meetingTranscription');
  const job = new MeetingTranscriptionService(b.queue, { readSettings: async () => ({ model: 'x', language: 'auto' }), installedPath: async () => null } as unknown as TranscriptionModelService);
  await job.tick();
  await MeetingTranscriptionService.settled();
  assert.deepEqual((await fsp.readdir(b.folder(id))).filter((n) => n.startsWith('.live-')), []);
});

test('a computer that falls behind stops the live transcript, and the recording goes on', async (t) => {
  const ws = await workspace(t);
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  t.after(() => { Date.now = realNow; });
  const { engine, state } = fakeEngine({ progress: () => 0 });
  const s = services(ws, fakeModels(), engine);
  const m = await s.queue.createMeeting({ title: 'Fictional', meeting_date: '2026-10-30' });
  await s.recording.start(m.id, TOKEN);
  await settle();
  let offset = 0;
  for (let i = 0; i < 62; i++) offset = (await s.recording.append(m.id, TOKEN, offset, second)).offset;
  now += 31_000;
  offset = (await s.recording.append(m.id, TOKEN, offset, second)).offset;
  const status = await s.live.read(m.id, 0);
  assert.equal(status.status, 'stopped');
  assert.match(status.reason ?? '', /could not keep up/);
  assert.equal(state.cancelled, true);
  assert.deepEqual(await s.recording.append(m.id, TOKEN, offset, second), { offset: offset + 32_000 }, 'recording goes on');
});

test('discarding a meeting ends its live transcript; a page asking about another recording learns there is none', async (t) => {
  const ws = await workspace(t);
  const { engine, state } = fakeEngine();
  const s = services(ws, fakeModels(), engine);
  const { id } = await record(s, 1);
  await s.queue.removeMeeting(id);
  s.live.forget(id);
  await settle();
  assert.equal(state.cancelled, true);
  const other = await s.queue.createMeeting({ title: 'Other', meeting_date: '2026-10-30' });
  const none = await s.live.read(other.id, 0);
  assert.deepEqual([none.generation, none.status, none.segments.length], [null, 'unavailable', 0]);
});

test('a transcript that cannot be written leaves the recording to the queue, and never stuck', async (t) => {
  const ws = await workspace(t);
  const s = services(ws, fakeModels(), fakeEngine().engine);
  const { id, generation, offset } = await record(s, 2);
  const { atomicWrite } = await import('../src/utils/atomicWrite');
  void atomicWrite;
  const fsMod = (await import('node:module')).createRequire(__filename)('fs/promises') as typeof fsp;
  const rename = fsMod.rename;
  const { mock } = await import('node:test');
  const fail = mock.method(fsMod, 'rename', async (from: string, to: string) => {
    if (to.endsWith('.transcript.md')) throw Object.assign(new Error('no space left'), { code: 'ENOSPC' });
    return rename(from, to);
  });
  t.after(() => fail.mock.restore());
  const done = await s.recording.finish(id, { token: TOKEN, offset, generation, queue: true });
  fail.mock.restore();
  const audio = done.files.find((f) => f.recording)!;
  assert.deepEqual([audio.recording?.status, audio.size, done.files.length, done.status], ['pending', 44 + 64_000, 1, 'queued']);
});

test('Finish or discard while the live job is still starting: the late worker is ended, never left running', async (t) => {
  const ws = await workspace(t);
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const { engine, state } = fakeEngine();
  const slow = { follow: async (...args: Parameters<TranscriptionEngine['follow']>) => { await gate; return (engine as unknown as TranscriptionEngine).follow(...args); } } as unknown as TranscriptionEngine;
  const s = services(ws, fakeModels(), slow);
  const m = await s.queue.createMeeting({ title: 'Fictional', meeting_date: '2026-10-30' });
  const { generation } = await s.recording.start(m.id, TOKEN);
  const offset = (await s.recording.append(m.id, TOKEN, 0, second)).offset;
  // A second start while the first is still loading never makes a second job.
  void s.live.start(m.id, generation, ws, offset);
  const finishing = s.recording.finish(m.id, { token: TOKEN, offset, generation, queue: true });
  await settle();
  release();
  const done = await finishing;
  // Finish waited for the start, then used what it could: here the whole recording was covered.
  assert.equal(done.files.find((f) => f.recording)!.recording?.status, 'done');
  assert.equal(state.sessions, 1);

  let open!: () => void;
  const late = new Promise<void>((r) => { open = r; });
  const second2 = fakeEngine();
  const later = { follow: async (...args: Parameters<TranscriptionEngine['follow']>) => { await late; return (second2.engine as unknown as TranscriptionEngine).follow(...args); } } as unknown as TranscriptionEngine;
  const s2 = services(ws, fakeModels(), later);
  const m2 = await s2.queue.createMeeting({ title: 'Discarded', meeting_date: '2026-10-30' });
  await s2.recording.start(m2.id, 'fictional-writer-token-two');
  await s2.queue.removeMeeting(m2.id);
  s2.live.forget(m2.id);
  open();
  await settle();
  assert.equal(second2.state.cancelled, true, 'the worker that came too late is ended');
});

test('a recording finished or removed elsewhere ends the owner\'s live job, which no longer holds the engine', async (t) => {
  const ws = await workspace(t);
  const { engine, state } = fakeEngine();
  const s = services(ws, fakeModels(), engine);
  const { id, generation } = await record(s, 2);
  const job = MeetingLiveTranscriptService.job(generation)!;
  // Sealed by a Finish this dashboard is not running: it waits as long as a Finish would take, then lets go.
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  t.after(() => { Date.now = realNow; });
  await s.queue.withQueue(async () => {
    const m = await s.queue.loadMeeting(id);
    m.live = { ...m.live!, state: 'finalizing', sealed_bytes: 64_000 };
    await s.queue.saveMeeting(m);
  });
  await s.live.watch(job);
  now += 60_000;
  await s.live.watch(job);
  assert.equal(state.cancelled, false, 'still within the time a Finish takes');
  now += 2 * 60_000;
  await s.live.watch(job);
  await settle();
  assert.equal(state.cancelled, true, 'the other Finish failed or stopped: the engine is free');
  Date.now = realNow;

  // And a recording published elsewhere ends it at the next check.
  const again = await record(s, 1);
  const job2 = MeetingLiveTranscriptService.job(again.generation)!;
  state.cancelled = false;
  await s.queue.withQueue(async () => {
    const m = await s.queue.loadMeeting(again.id);
    delete m.live;
    await s.queue.saveMeeting(m);
  });
  await s.live.watch(job2);
  await settle();
  assert.equal(state.cancelled, true);
  assert.equal(MeetingLiveTranscriptService.job(again.generation), undefined);
  assert.equal(MeetingLiveTranscriptService.job(generation), undefined);
});

test('a stretch that could not be saved is never shown or announced', async (t) => {
  const ws = await workspace(t);
  const s = services(ws, fakeModels(), fakeEngine().engine);
  const m = await s.queue.createMeeting({ title: 'Fictional', meeting_date: '2026-10-30' });
  const { generation } = await s.recording.start(m.id, TOKEN);
  await settle();
  let offset = (await s.recording.append(m.id, TOKEN, 0, second)).offset;
  await settle();
  // The live file is replaced by a folder: the next append of a stretch fails.
  const file = path.join(s.folder(m.id), liveTranscriptFile(generation));
  await fsp.rm(file);
  await fsp.mkdir(file);
  offset = (await s.recording.append(m.id, TOKEN, offset, second)).offset;
  await settle();
  const read = await s.live.read(m.id, 0);
  assert.deepEqual([read.status, read.next, read.segments.length], ['stopped', 1, 1]);
  assert.deepEqual(await s.recording.append(m.id, TOKEN, offset, second), { offset: offset + 32_000 }, 'the recording goes on');
});

test('the spoken language changes during a recording: saved, told to the live job, and in the transcript', async (t) => {
  const ws = await workspace(t);
  const fake = fakeEngine();
  const s = services(ws, fakeModels(), fake.engine);
  const { id, generation, offset } = await record(s, 2);

  assert.deepEqual(await s.recording.setLanguage(id, TOKEN, 'ja'), { language: 'ja', language_changes: [{ at: 2, language: 'ja' }], at: 2 });
  assert.deepEqual(fake.state.languages, [{ at: 2, language: 'ja', afterAudio: 64_000 }]);
  assert.deepEqual((await s.queue.loadMeeting(id)).live?.language_changes, [{ at: 2, language: 'ja' }], 'kept with the recording, so a crash does not lose it');
  await assert.rejects(s.recording.setLanguage(id, 'fictional-other-token', 'en'), /no longer holds/);
  await assert.rejects(s.recording.setLanguage(id, TOKEN, 'klingon'), /Invalid language/);

  const done = await s.recording.finish(id, { token: TOKEN, offset, generation, queue: true });
  assert.equal(done.files.find((f) => f.recording)!.recording?.status, 'done', 'made with what the recording asked for, so it is the transcript');
  await assert.rejects(s.recording.setLanguage(id, TOKEN, 'en'), /no longer holds/, 'nothing changes after the seal');
});

test('two changes at one moment are one, and going back to the same language is none', async (t) => {
  const ws = await workspace(t);
  const s = services(ws, fakeModels(), fakeEngine().engine);
  const { id } = await record(s, 1);
  await s.recording.setLanguage(id, TOKEN, 'ja');
  assert.deepEqual((await s.recording.setLanguage(id, TOKEN, 'en')).language_changes, [{ at: 1, language: 'en' }]);
  assert.deepEqual((await s.recording.setLanguage(id, TOKEN, 'auto')).language_changes, [], 'back where it started');
  assert.equal((await s.queue.loadMeeting(id)).live?.language_changes, undefined);
});

test('a change the live job did not follow sends the recording to the queue, with the changes', async (t) => {
  const ws = await workspace(t);
  for (const [label, o] of [['it came too late', { lateLanguage: true }], ['it was not told', {}], ['a later change hides one it was not told', {}]] as const) {
    const s = services(ws, fakeModels(), fakeEngine(o).engine);
    const { id, generation, offset } = await record(s, 2);
    await s.recording.setLanguage(id, TOKEN, 'ja');
    if (label !== 'it came too late') MeetingLiveTranscriptService.job(generation)!.changes = [];
    let last = offset;
    if (label === 'a later change hides one it was not told') {
      last = (await s.recording.append(id, TOKEN, offset, second)).offset;
      await s.recording.setLanguage(id, TOKEN, 'en');
    }
    const done = await s.recording.finish(id, { token: TOKEN, offset: last, generation, queue: true });
    const r = done.files.find((f) => f.recording)!.recording!;
    assert.equal(r.status, 'pending', label);
    assert.deepEqual(r.target?.changes?.[0], { at: 2, language: 'ja' }, label);
    assert.ok(r.draft, `${label}: the live text stays readable`);
    if (label !== 'it was not told') assert.match(await fsp.readFile(path.join(s.folder(id), r.draft!.transcript), 'utf-8'), /parts around a change may be in the language before it/, `${label}: the header does not overstate it`);
    await s.queue.removeMeeting(id);
  }
});

test('the language of a recording is fixed at its start, and changes made while the model loads reach the worker first', async (t) => {
  const ws = await workspace(t);
  let language = 'ja';
  const models = { ...fakeModels(), readSettings: async () => ({ model: 'fast', language, keep_recordings: false, live_model: 'fast', updated_at: null }), installedPath: async () => '/fictional/model' } as unknown as TranscriptionModelService;
  const fake = fakeEngine();
  let load: () => void = () => {};
  const loading = new Promise<void>((r) => { load = r; });
  const engine = { follow: async (...args: Parameters<TranscriptionEngine['follow']>) => { await loading; return fake.engine.follow(...args); } } as unknown as TranscriptionEngine;
  const s = services(ws, models, engine);
  const m = await s.queue.createMeeting({ title: 'Fictional live meeting', meeting_date: '2026-10-30' });
  const { generation, language: started } = await s.recording.start(m.id, TOKEN);
  assert.equal(started, 'ja');
  language = 'en';
  await s.recording.setLanguage(m.id, TOKEN, 'auto');
  load();
  await settle();
  const offset = (await s.recording.append(m.id, TOKEN, 0, second)).offset;
  await settle();
  assert.deepEqual(fake.state.languages, [{ at: 0, language: 'auto', afterAudio: 0 }]);
  const done = await s.recording.finish(m.id, { token: TOKEN, offset, generation, queue: true });
  assert.equal(done.files.find((f) => f.recording)!.recording?.status, 'done', 'Settings changing meanwhile does not matter');
});

test('language changes that cannot be read leave Auto, never a forced language', async (t) => {
  const ws = await workspace(t);
  const s = services(ws, fakeModels(), fakeEngine().engine);
  const { id } = await record(s, 1);
  await s.recording.setLanguage(id, TOKEN, 'ja');
  const manifest = path.join(s.folder(id), 'meeting.md');
  const text = await fsp.readFile(manifest, 'utf-8');
  await fsp.writeFile(manifest, text.replace(/(language_changes:\s*\n\s*- at: )\S+/, '$1 -5'));
  const live = (await s.queue.loadMeeting(id)).live!;
  assert.equal(live.language, 'auto');
  assert.equal(live.language_changes, undefined);
  assert.equal(live.state, 'recording', 'the recording itself is safe');

  // From an older version, with no language of its own: damaged changes still leave Auto, not what Settings say.
  await fsp.writeFile(manifest, text.replace(/^(\s*)language: auto\n/m, '').replace(/(language_changes:\s*\n\s*- at: )\S+/, '$1 -5'));
  assert.equal((await s.queue.loadMeeting(id)).live?.language, 'auto');
});

test('with speakers wanted, a live transcript of the chosen model stays a draft: speakers come from the transcript after the meeting', async (t) => {
  const ws = await workspace(t);
  const models = { ...fakeModels(), readSettings: async () => ({ model: 'fast', language: 'auto', keep_recordings: false, live_model: 'fast', speakers: true, updated_at: null }), installedPath: async () => '/fictional/model' } as unknown as TranscriptionModelService;
  const s = services(ws, models, fakeEngine().engine);
  const { id, generation, offset } = await record(s, 2);
  const done = await s.recording.finish(id, { token: TOKEN, offset, generation, queue: true });
  const r = done.files.find((f) => f.recording)!.recording!;
  assert.equal(r.status, 'pending');
  assert.ok(r.draft);
  assert.deepEqual(r.target, { model: 'fast', language: 'auto', speakers: true });
});

test('no audio for a minute (the recording page is gone): the live job lets go of the engine, and the recording stays', async (t) => {
  const ws = await workspace(t);
  const { engine, state } = fakeEngine();
  const s = services(ws, fakeModels(), engine);
  const { id, generation } = await record(s, 2);
  const job = MeetingLiveTranscriptService.job(generation)!;
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  t.after(() => { Date.now = realNow; });
  now += 45_000;
  await s.live.watch(job);
  assert.equal(state.cancelled, false, 'a pause is not a page that is gone');
  now += 20_000;
  await s.live.watch(job);
  await settle();
  assert.equal(state.cancelled, true, 'the engine is free for the other meetings');
  assert.equal(job.status, 'stopped');
  assert.match(job.reason ?? '', /No audio arrived for a minute/);
  assert.equal((await s.queue.loadMeeting(id)).live?.generation, generation, 'the recording is still there, to finish');
});

test('with the live transcript off, the recording page says it is off, not that it runs elsewhere', async (t) => {
  const ws = await workspace(t);
  const { engine } = fakeEngine();
  const s = services(ws, fakeModels(null), engine);
  const { id } = await record(s, 1);
  const read = await s.live.read(id, 0);
  assert.equal(read.status, 'unavailable');
  assert.match(read.reason ?? '', /live transcript is off/);
});
