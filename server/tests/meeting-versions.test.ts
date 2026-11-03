import { test } from 'node:test';
// A background job that fails must be caught by the service, never left to crash the dashboard.
const unhandled: unknown[] = [];
process.on('unhandledRejection', (reason) => { unhandled.push(reason); });
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import { ContextUpdateService } from '../src/services/contextUpdateService';
import { MeetingHistoryService } from '../src/services/meetingHistoryService';
import { MeetingDigestService } from '../src/services/meetingDigestService';
import { MeetingTranscriptionService } from '../src/services/meetingTranscription';
import { readFolder } from '../src/services/meetingFolder';
import { cancelTranscription, chooseVersion, recoverTranscriptions, requestTranscription } from '../src/services/meetingVersions';
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
async function reviewed(ws: string): Promise<void> {
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
    meeting_records: [{ id: 'M-01', title: 'Recorded call', meeting_date: '2026-10-27', meeting: 'MQ-2026-0003', source: 'MQ-2026-0003-call.transcript.md', attendees: [{ name: 'Jane Doe' }], decisions: [] }],
  }));
  await updates.close(id);
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

test('a transcription with no words is not kept, and a stopped one leaves nothing', async (t) => {
  const ws = await workspace(t);
  await reviewed(ws);
  await ask(ws);
  await new MeetingTranscriptionService(new MeetingDigestService(), models, engine(speaks([])).engine).tick();
  await MeetingTranscriptionService.settled();
  const failed = await manifest(ws);
  assert.deepEqual([failed.transcribe?.status, failed.versions.length], ['failed', 1]);
  assert.match(failed.transcribe!.error!, /^Not kept:/);
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

  await recoverTranscriptions(ws, null);
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
