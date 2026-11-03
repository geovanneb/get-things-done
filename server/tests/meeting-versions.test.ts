import { test } from 'node:test';
// A background job that fails must be caught by the service, never left to crash the dashboard.
const unhandled: unknown[] = [];
process.on('unhandledRejection', (reason) => { unhandled.push(reason); });
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { ContextUpdateService } from '../src/services/contextUpdateService';
import { MeetingHistoryService } from '../src/services/meetingHistoryService';
import { MeetingDigestService } from '../src/services/meetingDigestService';
import { MeetingTranscriptionService } from '../src/services/meetingTranscription';
import { readFolder } from '../src/services/meetingFolder';
import { cancelTranscription, chooseVersion, claimTranscription, endTranscriptionJob, failTranscription, giveBackTranscription, recoverTranscriptions, requestIdentity, requestTranscription, speakerNamesHold, speakerNamesHoldForPin, waitingTranscriptions } from '../src/services/meetingVersions';
import { TranscriptionEngine as Engine } from '../src/services/transcription/engine';
import type { FolderManifest } from '../src/services/meetingFolder';
import { renderSheet, syncTaskMeetings, checkTaskMeetings } from '../src/services/meetingSources';
import { TaskService } from '../src/services/taskService';
import { stringifyMarkdown } from '../src/utils/markdown';
import type { Segment, TranscriptionEngine } from '../src/services/transcription/engine';
import type { TranscriptionModelService } from '../src/services/transcriptionModels';

async function workspace(t: { after: (fn: () => Promise<void> | void) => void }): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-versions-'));
  const previous = process.env.ESB_WORKSPACE_PATH;
  process.env.ESB_WORKSPACE_PATH = dir;
  const models = process.env.ESB_MODELS_PATH;
  process.env.ESB_MODELS_PATH = path.join(dir, '.models');
  t.after(async () => {
    await MeetingTranscriptionService.settled();
    if (previous === undefined) delete process.env.ESB_WORKSPACE_PATH; else process.env.ESB_WORKSPACE_PATH = previous;
    if (models === undefined) delete process.env.ESB_MODELS_PATH; else process.env.ESB_MODELS_PATH = models;
    await fsp.rm(dir, { recursive: true, force: true });
  });
  for (const d of ['tasks/active', 'tasks/archive', 'context-updates', '.situation-board/routines', '.situation-board/trash']) await fsp.mkdir(path.join(dir, d), { recursive: true });
  return dir;
}

const updates = new ContextUpdateService();
const history = new MeetingHistoryService();
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const WAV = 'RIFF fictional audio';
const FIRST = '# Fictional recorded call\n\nSpeaker 1: Ask Dual Line for a quote.\n';

/** Models as Settings has them: every model installed. */
const models = { readSettings: async () => ({ model: 'whisper-large-v3-turbo', language: 'auto' }), installedPath: async () => '/fictional/model' } as unknown as TranscriptionModelService;
type Transcribe = (wav: string, o: { signal?: AbortSignal; onSegment?: (s: Segment) => void; onProgress?: (done: number, total: number) => void }) => Promise<{ segments: Segment[]; seconds: number; load_ms: number | null }>;
function engine(work: Transcribe): { engine: TranscriptionEngine; calls: string[] } {
  const calls: string[] = [];
  return { engine: { transcribe: (wav: string, o: Parameters<Transcribe>[1]) => { calls.push(wav); return work(wav, o); } } as unknown as TranscriptionEngine, calls };
}
const speaks = (texts: string[]): Transcribe => async (_wav, o) => {
  const segments = texts.map((text, i) => ({ start: i * 2, end: i * 2 + 1.5, text }));
  for (const s of segments) o.onSegment?.(s);
  return { segments, seconds: 10, load_ms: 5 };
};

/** A recorded meeting reviewed with Keep recordings on: its recording and its transcript in its own folder. */
async function reviewed(ws: string, speakers = false, close = true): Promise<void> {
  const id = 'CU-2026-0001';
  const dir = path.join(ws, 'context-updates', id);
  const files: Record<string, string> = { 'MQ-2026-0003-call.wav': WAV, 'MQ-2026-0003-call.transcript.md': FIRST, 'MQ-2026-0003-notes.md': 'Fictional notes' };
  await fsp.mkdir(path.join(dir, 'materials'), { recursive: true });
  for (const [name, content] of Object.entries(files)) await fsp.writeFile(path.join(dir, 'materials', name), content);
  await fsp.writeFile(path.join(dir, 'update.md'), stringifyMarkdown('', {
    schema_version: '1.0', id, type: 'context-update', title: 'Fictional digest', status: 'in_review', source_date: '2026-10-27',
    created_at: '2026-10-27T18:00:00.000Z', updated_at: '2026-10-28T09:00:00.000Z', origin: 'meetings', kind: 'daily-digest', keep_recordings: true,
    materials: Object.keys(files).map((name) => ({ name, size: 1, type: 'text/plain' })),
    digest_meetings: [{
      id: 'MQ-2026-0003', title: 'Recorded call', meeting_date: '2026-10-27',
      files: [{ source: 'call.wav', file: 'MQ-2026-0003-call.wav', sha256: sha(WAV) }, { source: 'notes.md', file: 'MQ-2026-0003-notes.md', sha256: sha('Fictional notes') }],
      recordings: [{ source: 'call.wav', source_sha256: sha(WAV), transcript: 'MQ-2026-0003-call.transcript.md', transcript_sha256: sha(FIRST), complete: true, file: 'MQ-2026-0003-call.wav' }],
    }],
    transcripts: [{ file: 'MQ-2026-0003-call.transcript.md', source: 'MQ-2026-0003-call.wav', source_sha256: sha(WAV), sha256: sha(FIRST), complete: true, kind: 'audio' }],
    meeting_records: [{
      id: 'M-01', title: 'Recorded call', meeting_date: '2026-10-27', meeting: 'MQ-2026-0003', source: 'MQ-2026-0003-call.transcript.md', attendees: [{ name: 'Jane Doe' }], decisions: [],
      ...(speakers ? { speakers: [{ label: 'Speaker 1', source: 'MQ-2026-0003-call.transcript.md', person: { name: 'Jane Doe' }, reason: 'Named in the call.' }], confirmation: 'confirmed' } : {}),
    }],
  }));
  if (close) await updates.close(id);
}

const ask = (ws: string, model = 'whisper-large-v3-turbo') => requestTranscription(ws, 'MQ-2026-0003', { file: 'MQ-2026-0003-call.wav', transcript: 'MQ-2026-0003-call.transcript.md', model, language: 'auto', speakers: false });
const manifest = async (ws: string) => { const f = await readFolder(ws, 'MQ-2026-0003'); assert.equal(f.state, 'ok'); return (f as Extract<typeof f, { state: 'ok' }>).manifest; };

test('Transcribe again adds a new version; the reviewed one stays current until the user chooses', async (t) => {
  const ws = await workspace(t);
  await reviewed(ws);
  await ask(ws);
  await assert.rejects(ask(ws), (err: { statusCode?: number }) => err.statusCode === 409, 'one at a time');
  const run = engine(speaks(['Ask Dual Lane for a quote.']));
  await new MeetingTranscriptionService(new MeetingDigestService(), models, run.engine).tick();
  await MeetingTranscriptionService.settled();
  assert.match(run.calls[0]!, /meetings[/\\]MQ-2026-0003[/\\]audio[/\\]MQ-2026-0003-call\.wav$/);

  const m = await manifest(ws);
  assert.equal(m.transcribe, undefined, 'done: nothing waits any more');
  assert.deepEqual(m.versions.map((v) => [v.id, v.made_from, v.model ?? null]), [['v1', 'review', null], ['v2', 'transcription', 'whisper-large-v3-turbo']]);
  assert.equal(m.current, 'v1', 'nothing switches by itself');
  assert.deepEqual((await fsp.readdir(path.join(ws, 'meetings', 'MQ-2026-0003', 'v2'))).sort(), ['MQ-2026-0003-call.transcript.md', 'MQ-2026-0003-notes.md'], 'the other files carried over');
  const v2 = m.versions[1]!;
  assert.deepEqual(v2.from, { name: 'MQ-2026-0003-call.wav', sha256: sha(WAV) });
  assert.equal(v2.files.find((f) => f.name === 'MQ-2026-0003-notes.md')!.sha256, sha('Fictional notes'));

  assert.equal(await history.text('MQ-2026-0003', 'MQ-2026-0003-call.wav'), FIRST, 'the reviewed text is still what is shown');
  const detail = await history.detail('MQ-2026-0003');
  assert.deepEqual(detail.versions.map((v) => [v.id, v.current]), [['v1', true], ['v2', false]]);

  await history.chooseVersion('MQ-2026-0003', 'v2');
  assert.match(await history.text('MQ-2026-0003', 'MQ-2026-0003-call.wav'), /Dual Lane/);
  await assert.rejects(history.chooseVersion('MQ-2026-0003', 'v9'), (err: { statusCode?: number }) => err.statusCode === 404);
  await chooseVersion(ws, 'MQ-2026-0003', 'v1');
  assert.equal(await history.text('MQ-2026-0003', 'MQ-2026-0003-call.wav'), FIRST, 'and back');
  assert.deepEqual(unhandled, []);
});

test('versions never share a file: editing one version\'s file in place leaves the others as they were', async (t) => {
  const ws = await workspace(t);
  await reviewed(ws);
  await ask(ws);
  await new MeetingTranscriptionService(new MeetingDigestService(), models, engine(speaks(['New words.'])).engine).tick();
  await MeetingTranscriptionService.settled();
  const dir = path.join(ws, 'meetings', 'MQ-2026-0003');
  const notes = (v: string) => path.join(dir, v, 'MQ-2026-0003-notes.md');
  assert.notEqual((await fsp.stat(notes('v1'))).ino, (await fsp.stat(notes('v2'))).ino);
  // An ordinary editor writing in place, not the app's atomic replacement.
  const handle = await fsp.open(notes('v2'), 'r+');
  await handle.write('Edited fictional notes', 0);
  await handle.close();
  assert.equal(await fsp.readFile(notes('v1'), 'utf-8'), 'Fictional notes', 'v1 keeps the bytes it lists');
  assert.equal((await manifest(ws)).versions[0]!.files.find((f) => f.name === 'MQ-2026-0003-notes.md')!.sha256, sha('Fictional notes'));
});

test('a task pinned to the reviewed text keeps it when another version becomes current, and says so', async (t) => {
  const ws = await workspace(t);
  await reviewed(ws);
  const tasks = new TaskService();
  const task = await tasks.getTask((await tasks.createTask({ title: 'Fictional summary', body: 'From [@Recorded call](/meetings/MQ-2026-0003).' })).id);
  const mentioned = async () => ['MQ-2026-0003'];
  const pinned = (await syncTaskMeetings(task.path!, mentioned))!.selection!;
  const transcript = pinned.meetings[0]!.sources.find((s) => s.path.endsWith('call.transcript.md'))!;
  assert.match(transcript.path, /^meetings\/MQ-2026-0003\/v1\//);

  await ask(ws);
  await new MeetingTranscriptionService(new MeetingDigestService(), models, engine(speaks(['New words.'])).engine).tick();
  await MeetingTranscriptionService.settled();
  await chooseVersion(ws, 'MQ-2026-0003', 'v2');
  const check = await checkTaskMeetings(task.path!, ['MQ-2026-0003']);
  const state = check.sources.find((s) => s.path === transcript.path)!;
  assert.deepEqual([state.state, state.older_version], ['ok', true], 'still valid, never swapped for the newer text');
  assert.match(renderSheet(check.selection, check), /from an older version of the meeting's text/);
});

test('a task pinned while the meeting was under review keeps its text after the move and a new version, at its new place', async (t) => {
  const ws = await workspace(t);
  await reviewed(ws, false, false);
  const tasks = new TaskService();
  const task = await tasks.getTask((await tasks.createTask({ title: 'Fictional summary', body: 'From [@Recorded call](/meetings/MQ-2026-0003).' })).id);
  const pinned = (await syncTaskMeetings(task.path!, async () => ['MQ-2026-0003']))!.selection!;
  const transcript = pinned.meetings[0]!.sources.find((s) => s.path.endsWith('call.transcript.md'))!;
  assert.match(transcript.path, /^context-updates\/CU-2026-0001\/materials\//, 'pinned in the update under review');

  await updates.close('CU-2026-0001');
  const moved = (await checkTaskMeetings(task.path!, ['MQ-2026-0003'])).sources.find((s) => s.path === transcript.path)!;
  assert.deepEqual([moved.state, moved.current_path], ['ok', 'meetings/MQ-2026-0003/v1/MQ-2026-0003-call.transcript.md'], 'followed into the folder');

  await ask(ws);
  await new MeetingTranscriptionService(new MeetingDigestService(), models, engine(speaks(['New words.'])).engine).tick();
  await MeetingTranscriptionService.settled();
  await chooseVersion(ws, 'MQ-2026-0003', 'v2');
  const check = await checkTaskMeetings(task.path!, ['MQ-2026-0003']);
  const state = check.sources.find((s) => s.path === transcript.path)!;
  assert.deepEqual([state.state, state.older_version, state.current_path], ['ok', true, 'meetings/MQ-2026-0003/v1/MQ-2026-0003-call.transcript.md'], 'still the reviewed bytes, where v1 keeps them');
  assert.equal(await fsp.readFile(path.join(ws, state.current_path!), 'utf-8'), FIRST);
  const sheet = renderSheet(check.selection, check);
  assert.ok(sheet.includes('`meetings/MQ-2026-0003/v1/MQ-2026-0003-call.transcript.md` (SHA-256'), 'the agent is sent where the bytes are');
  assert.ok(!sheet.includes('`context-updates/CU-2026-0001/materials/MQ-2026-0003-call.transcript.md`'), 'never to where they were');

  // Changed in v1 since: the pinned bytes are nowhere any more.
  await fsp.writeFile(path.join(ws, state.current_path!), 'Changed by hand');
  const after = (await checkTaskMeetings(task.path!, ['MQ-2026-0003'])).sources.find((s) => s.path === transcript.path)!;
  assert.equal(after.state, 'missing');
});

test('a transcription with no words is not kept, and a stopped one leaves nothing', async (t) => {
  const ws = await workspace(t);
  await reviewed(ws);
  await ask(ws);
  await new MeetingTranscriptionService(new MeetingDigestService(), models, engine(speaks([])).engine).tick();
  await MeetingTranscriptionService.settled();
  const failed = await manifest(ws);
  assert.deepEqual([failed.transcribe?.status, failed.versions.length], ['failed', 1]);
  assert.match(failed.transcribe!.error!, /speech/);
  assert.equal((await history.detail('MQ-2026-0003')).transcription?.status, 'failed');

  // Asked again after a failure, then stopped while it waits.
  await ask(ws);
  await cancelTranscription(ws, 'MQ-2026-0003');
  assert.equal((await manifest(ws)).transcribe, undefined);
  await assert.rejects(cancelTranscription(ws, 'MQ-2026-0003'), (err: { statusCode?: number }) => err.statusCode === 409);
});

test('a transcription left running by a dashboard that is gone goes back in line, and an unlisted version never counts', async (t) => {
  const ws = await workspace(t);
  await reviewed(ws);
  await ask(ws);
  const file = path.join(ws, 'meetings', 'MQ-2026-0003', 'meeting.json');
  const data = JSON.parse(await fsp.readFile(file, 'utf-8'));
  data.transcribe = { ...data.transcribe, status: 'running', generation: 'g', owner: { pid: 999_999_999, token: 't' }, started_at: '2026-10-28T00:00:00.000Z' };
  await fsp.writeFile(file, JSON.stringify(data));
  // A crash after the new version's folder was renamed into place, before meeting.json listed it.
  await fsp.mkdir(path.join(ws, 'meetings', 'MQ-2026-0003', 'v2'));
  await fsp.writeFile(path.join(ws, 'meetings', 'MQ-2026-0003', 'v2', 'MQ-2026-0003-call.transcript.md'), 'half');

  await recoverTranscriptions(ws);
  const m = await manifest(ws);
  assert.deepEqual([m.transcribe?.status, m.transcribe?.owner], ['pending', undefined]);
  assert.equal(await fsp.access(path.join(ws, 'meetings', 'MQ-2026-0003', 'v2')).then(() => true, () => false), false);
});

test('a recording in the queue is transcribed before a reviewed meeting is transcribed again', async (t) => {
  const ws = await workspace(t);
  await reviewed(ws);
  await ask(ws);
  const queue = new MeetingDigestService();
  const q = await queue.createMeeting({ title: 'Fictional standup', meeting_date: '2026-10-30' });
  const data = Buffer.alloc(32000);
  const head = Buffer.alloc(44);
  head.write('RIFF', 0, 'ascii'); head.writeUInt32LE(36 + data.length, 4); head.write('WAVE', 8, 'ascii');
  head.write('fmt ', 12, 'ascii'); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22);
  head.writeUInt32LE(16000, 24); head.writeUInt32LE(32000, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34);
  head.write('data', 36, 'ascii'); head.writeUInt32LE(data.length, 40);
  const silent = Buffer.concat([head, data]);
  await queue.addFile(q.id, 'standup.wav', silent);
  await queue.queue(q.id);
  const run = engine(speaks(['Hello.']));
  await new MeetingTranscriptionService(queue, models, run.engine).tick();
  await MeetingTranscriptionService.settled();
  assert.match(run.calls[0]!, /meeting-queue/, 'the queue first');
  assert.equal(run.calls.length, 2, 'then the folder, right after');
  assert.match(run.calls[1]!, /meetings[/\\]MQ-2026-0003/);
});

test('Transcribe again is refused for a model that is not a transcription model, and for a meeting without a folder', async (t) => {
  const ws = await workspace(t);
  await reviewed(ws);
  await assert.rejects(history.transcribeAgain('MQ-2026-0003', { file: 'MQ-2026-0003-call.wav', model: 'not-a-model' }), (err: { statusCode?: number }) => err.statusCode === 400);
  await assert.rejects(history.transcribeAgain('MQ-2026-0003', { file: '../meeting.json', model: 'whisper-large-v3-turbo' }), /Invalid file name/);
  await assert.rejects(requestTranscription(ws, 'MQ-2026-0009', { file: 'x.wav', transcript: 'x.transcript.md', model: 'whisper-large-v3-turbo', language: 'auto', speakers: false }), (err: { statusCode?: number }) => err.statusCode === 404);
  // A hand-edited request naming a file the folder does not keep is never read as one.
  const file = path.join(ws, 'meetings', 'MQ-2026-0003', 'meeting.json');
  const data = JSON.parse(await fsp.readFile(file, 'utf-8'));
  await fsp.writeFile(file, JSON.stringify({ ...data, transcribe: { file: '../../update.md', transcript: 'x.md', model: 'm', language: 'auto', speakers: false, status: 'pending', requested_at: 'x' } }));
  assert.equal((await manifest(ws)).transcribe, undefined);
});

test('a claim takes only the very request it chose: one stopped and asked for again meanwhile is left alone', async (t) => {
  const ws = await workspace(t);
  await reviewed(ws);
  await ask(ws);
  const [listed] = await waitingTranscriptions(ws);
  // Another dashboard stops it and asks again, with another model, while this one checks its models.
  await cancelTranscription(ws, 'MQ-2026-0003');
  await ask(ws, 'sense-voice');
  const job = { generation: randomUUID(), token: 't', model: 'whisper-large-v3-turbo', language: 'auto' };
  assert.equal(await claimTranscription(ws, 'MQ-2026-0003', requestIdentity(listed!.request), job), null);
  assert.deepEqual([(await manifest(ws)).transcribe?.status, (await manifest(ws)).transcribe?.model], ['pending', 'sense-voice'], 'the new request untouched');
  const [now] = await waitingTranscriptions(ws);
  const claimed = await claimTranscription(ws, 'MQ-2026-0003', requestIdentity(now!.request), job);
  assert.equal(claimed?.status, 'running');
  endTranscriptionJob(job.generation);
});

test('recovery never takes a job of this dashboard that runs for an orphan, and cleans up converted audio of jobs gone', async (t) => {
  const ws = await workspace(t);
  await reviewed(ws);
  await ask(ws);
  const [listed] = await waitingTranscriptions(ws);
  const job = { generation: randomUUID(), token: 't', model: 'whisper-large-v3-turbo', language: 'auto' };
  assert.ok(await claimTranscription(ws, 'MQ-2026-0003', requestIdentity(listed!.request), job));
  const work = path.join(ws, 'meetings', 'MQ-2026-0003', '.transcribing');
  await fsp.mkdir(work);
  const mine = `${job.generation}-${process.pid}.wav`;
  const dead = `${randomUUID()}-999999999.wav`;
  const ended = `${randomUUID()}-${process.pid}.wav`;
  for (const n of [mine, dead, ended]) await fsp.writeFile(path.join(work, n), 'wav');

  // A recovery that began before the job: it still sees it running, here and now.
  await recoverTranscriptions(ws);
  assert.equal((await manifest(ws)).transcribe?.status, 'running');
  assert.deepEqual((await fsp.readdir(work)).sort(), [mine], 'only the running job keeps its converted audio');

  // Once the job has ended in this dashboard, a running request left on disk is an orphan.
  endTranscriptionJob(job.generation);
  await recoverTranscriptions(ws);
  assert.equal((await manifest(ws)).transcribe?.status, 'pending');
  assert.deepEqual(await fsp.readdir(work), []);
});

test('a failure or give-back that cannot be saved is an error, never taken as done; one no longer ours is not', async (t) => {
  const ws = await workspace(t);
  await reviewed(ws);
  await ask(ws);
  const [listed] = await waitingTranscriptions(ws);
  const job = { generation: randomUUID(), token: 't', model: 'whisper-large-v3-turbo', language: 'auto' };
  await claimTranscription(ws, 'MQ-2026-0003', requestIdentity(listed!.request), job);
  const dir = path.join(ws, 'meetings', 'MQ-2026-0003');
  await fsp.chmod(dir, 0o555);
  try {
    await assert.rejects(failTranscription(ws, 'MQ-2026-0003', job, 'Something failed.'));
    await assert.rejects(giveBackTranscription(ws, 'MQ-2026-0003', job));
  } finally { await fsp.chmod(dir, 0o755); }
  assert.equal(await failTranscription(ws, 'MQ-2026-0003', { generation: 'other', token: 't' }, 'x'), false);
  assert.equal(await giveBackTranscription(ws, 'MQ-2026-0003', job), true);
  endTranscriptionJob(job.generation);
});

test('a Transcribe again stopped for a live recording goes back in line, never fails', async (t) => {
  const ws = await workspace(t);
  await reviewed(ws);
  await ask(ws);
  let started!: () => void;
  const running = new Promise<void>((r) => { started = r; });
  const waits: Transcribe = (_wav, o) => new Promise((_resolve, reject) => {
    started();
    o.signal?.addEventListener('abort', () => reject(new Error('Cancelled.')));
  });
  await new MeetingTranscriptionService(new MeetingDigestService(), models, engine(waits).engine).tick();
  await running;
  const release = await Engine.roomForLive();
  await MeetingTranscriptionService.settled();
  release();
  const m = await manifest(ws);
  assert.deepEqual([m.transcribe?.status, m.transcribe?.error, m.versions.length], ['pending', undefined, 1]);
});

test("a record's speaker names hold for the text they were confirmed on and corrections of its words, judged on the pinned text", () => {
  const v = (id: string, made_from: 'review' | 'transcription' | 'correction', sha256: string, base?: string) => ({ id, at: '', made_from, files: [{ name: 'call.wav', sha256: `wav` }, { name: 'call.transcript.md', sha256 }], ...(base ? { base, correction: 'CU-2026-0009' } : {}) });
  const m = (current: string, versions: ReturnType<typeof v>[]) => ({ current, versions } as unknown as FolderManifest);
  const holds = (manifest: FolderManifest | null, pinned: string, confirmedOn?: string) => speakerNamesHold(manifest, 'call.transcript.md', pinned, confirmedOn);
  const two = m('v1', [v('v1', 'review', 'a'), v('v2', 'transcription', 'b')]);
  assert.equal(holds(null, 'a'), true, 'no folder: the reviewed text is the only one');
  assert.equal(holds(two, 'a', 'a'), true, 'the text they were confirmed on');
  assert.equal(holds(two, 'b', 'a'), false, 'a new transcription, numbered anew');
  // Pinned v2 while another window chose v1 back: judged on the pinned text, never on which version is current.
  assert.equal(holds(m('v1', [v('v1', 'review', 'a'), v('v2', 'transcription', 'b')]), 'b', 'a'), false);
  // Words corrected: the labels stay, so the names hold; a correction of the new transcription does not bring them.
  assert.equal(holds(m('v2', [v('v1', 'review', 'a'), v('v2', 'correction', 'c', 'v1')]), 'c', 'a'), true);
  assert.equal(holds(m('v3', [v('v1', 'review', 'a'), v('v2', 'transcription', 'b'), v('v3', 'correction', 'c', 'v2')]), 'c', 'a'), false);
  // Names confirmed again on v2 (a correction of the speakers): they hold for v2, and no longer for v1.
  assert.equal(holds(two, 'b', 'b'), true);
  assert.equal(holds(two, 'a', 'b'), false);
  // A record confirmed before evidence was kept: taken at the reviewed text.
  assert.equal(holds(two, 'a', undefined), true);
  assert.equal(holds(two, 'b', undefined), false);
  // A pin names its version; a WebVTT's readable copy is judged by the original in that version.
  const vtt = m('v2', [{ id: 'v1', at: '', made_from: 'review', files: [{ name: 'call.vtt', sha256: 'x' }, { name: 'call.transcript.md', sha256: 'y' }] }, { id: 'v2', at: '', made_from: 'correction', base: 'v1', correction: 'CU-2026-0009', files: [{ name: 'call.vtt', sha256: 'x2' }, { name: 'call.transcript.md', sha256: 'y2' }] }] as unknown as FolderManifest['versions']);
  assert.equal(speakerNamesHoldForPin(vtt, 'meetings/MQ-2026-0003/v2/call.transcript.md', 'call.vtt', 'x'), true);
  assert.equal(speakerNamesHoldForPin(vtt, undefined, 'call.vtt', 'x'), false, 'nothing pinned: no text to pair names with');
  // A folder that cannot be read after pinning: a pin in it is never judged as if the meeting had no folder.
  assert.equal(speakerNamesHoldForPin(null, 'meetings/MQ-2026-0003/v2/call.transcript.md', 'call.vtt', 'x'), false);
  assert.equal(speakerNamesHoldForPin(null, 'context-updates/CU-2026-0001/materials/call.transcript.md', 'call.vtt', 'x'), true, 'kept before folders: one text only');
});

test("a task pinned to a new transcription gets its speakers unnamed; one pinned to the reviewed text keeps the names", async (t) => {
  const ws = await workspace(t);
  await reviewed(ws, true);
  const tasks = new TaskService();
  const speakersOf = (sel: Awaited<ReturnType<typeof syncTaskMeetings>>) => sel!.selection!.meetings[0]!.record?.speakers;
  const first = await tasks.getTask((await tasks.createTask({ title: 'Fictional summary', body: 'From [@Recorded call](/meetings/MQ-2026-0003).' })).id);
  assert.deepEqual(speakersOf(await syncTaskMeetings(first.path!, async () => ['MQ-2026-0003'])), [{ label: 'Speaker 1', name: 'Jane Doe' }]);

  await ask(ws);
  await new MeetingTranscriptionService(new MeetingDigestService(), models, engine(speaks(['New words.'])).engine).tick();
  await MeetingTranscriptionService.settled();
  await chooseVersion(ws, 'MQ-2026-0003', 'v2');
  const later = await tasks.getTask((await tasks.createTask({ title: 'Another summary', body: 'From [@Recorded call](/meetings/MQ-2026-0003).' })).id);
  assert.deepEqual(speakersOf(await syncTaskMeetings(later.path!, async () => ['MQ-2026-0003'])), [{ label: 'Speaker 1', name: null }], 'numbered anew: not her any more');
  // A record that cannot be read is never taken for one without evidence.
  await assert.rejects(updates.confirmedSpeakerEvidence('CU-2026-0001', 'M-09'), /not in CU-2026-0001/);
  await assert.rejects(updates.confirmedSpeakerEvidence('CU-2026-0099', 'M-01'));
});
