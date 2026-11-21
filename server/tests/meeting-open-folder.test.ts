import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import express from 'express';
import { ContextUpdateService } from '../src/services/contextUpdateService';
import { MeetingDigestService } from '../src/services/meetingDigestService';
import { MeetingHistoryService } from '../src/services/meetingHistoryService';
import { SystemCleanupService } from '../src/services/systemCleanupService';
import { stringifyMarkdown } from '../src/utils/markdown';

/** A throwaway fictional workspace; services read its path from ESB_WORKSPACE_PATH. */
async function workspace(t: { after: (fn: () => Promise<void> | void) => void }): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-meeting-open-folder-'));
  const previous = process.env.ESB_WORKSPACE_PATH;
  process.env.ESB_WORKSPACE_PATH = dir;
  t.after(async () => {
    if (previous === undefined) delete process.env.ESB_WORKSPACE_PATH;
    else process.env.ESB_WORKSPACE_PATH = previous;
    await fsp.rm(dir, { recursive: true, force: true });
  });
  for (const d of ['tasks/active', 'tasks/archive', 'context-updates', '.situation-board/routines', '.situation-board/trash']) {
    await fsp.mkdir(path.join(dir, d), { recursive: true });
  }
  return dir;
}

async function outsideFolder(t: { after: (fn: () => Promise<void> | void) => void }): Promise<string> {
  const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-outside-'));
  t.after(() => fsp.rm(outside, { recursive: true, force: true }));
  await fsp.writeFile(path.join(outside, 'MQ-2026-0001-a.vtt'), 'FICTIONAL OUTSIDE MARKER');
  return outside;
}

const updates = new ContextUpdateService();
const history = new MeetingHistoryService();
const cleanup = new SystemCleanupService();
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const vtt = (who: string, words: string) => `WEBVTT\n\n00:00:01.000 --> 00:00:04.000\n<v ${who}>${words}</v>\n`;
const A = vtt('Jane Doe', 'Budget next week.');
const B = vtt('Taro Yamada', 'Pilot on track.');
const WAV = 'RIFF fictional audio';
const CALL = '# Fictional call\n\nSpeaker 1: Pilot on track.\n';
const status = (code: number) => (err: { statusCode?: number }) => err.statusCode === code;

/** A digest of two queued meetings and, with `recorded`, a recording of the first (kept with Keep recordings). */
async function digest(ws: string, id: string, extra: Record<string, unknown> = {}, recorded = false): Promise<void> {
  const dir = path.join(ws, 'context-updates', id);
  const files: Record<string, string> = {
    'meetings.md': '# Meetings in this digest', 'MQ-2026-0001-a.vtt': A, 'MQ-2026-0001-a.transcript.md': 'copy a budget', 'MQ-2026-0002-b.vtt': B,
    ...(recorded ? { 'MQ-2026-0001-call.wav': WAV, 'MQ-2026-0001-call.transcript.md': CALL } : {}),
  };
  await fsp.mkdir(path.join(dir, 'materials'), { recursive: true });
  for (const [name, content] of Object.entries(files)) await fsp.writeFile(path.join(dir, 'materials', name), content);
  const first = [{ source: 'a.vtt', file: 'MQ-2026-0001-a.vtt', sha256: sha(A) }, ...(recorded ? [{ source: 'call.wav', file: 'MQ-2026-0001-call.wav', sha256: sha(WAV) }] : [])];
  await fsp.writeFile(path.join(dir, 'update.md'), stringifyMarkdown('', {
    schema_version: '1.0', id, type: 'context-update', title: `Fictional ${id}`, status: 'in_review', source_date: '2026-10-27',
    created_at: '2026-10-27T18:00:00.000Z', updated_at: '2026-10-28T09:00:00.000Z', origin: 'meetings', kind: 'daily-digest',
    materials: Object.keys(files).map((name) => ({ name, size: 1, type: 'text/plain' })),
    digest_meetings: [
      { id: 'MQ-2026-0001', title: 'Weekly sync', meeting_date: '2026-10-27', files: first,
        ...(recorded ? { recordings: [{ source: 'call.wav', source_sha256: sha(WAV), transcript: 'MQ-2026-0001-call.transcript.md', transcript_sha256: sha(CALL), complete: true, file: 'MQ-2026-0001-call.wav' }] } : {}) },
      { id: 'MQ-2026-0002', title: 'Pilot review', meeting_date: '2026-10-27', files: [{ source: 'b.vtt', file: 'MQ-2026-0002-b.vtt', sha256: sha(B) }] },
    ],
    transcripts: [
      { file: 'MQ-2026-0001-a.transcript.md', source: 'MQ-2026-0001-a.vtt', source_sha256: sha(A), sha256: sha('copy a budget'), complete: true, kind: 'webvtt' },
      ...(recorded ? [{ file: 'MQ-2026-0001-call.transcript.md', source: 'MQ-2026-0001-call.wav', source_sha256: sha(WAV), sha256: sha(CALL), complete: true, kind: 'audio' }] : []),
    ],
    meeting_records: [
      { id: 'M-01', title: 'Weekly sync', meeting_date: '2026-10-27', meeting: 'MQ-2026-0001', source: 'MQ-2026-0001-a.vtt', attendees: [{ name: 'Jane Doe' }], decisions: [] },
      { id: 'M-02', title: 'Pilot review', meeting_date: '2026-10-27', meeting: 'MQ-2026-0002', source: 'MQ-2026-0002-b.vtt', attendees: [{ name: 'Taro Yamada' }], decisions: [] },
    ],
    ...extra,
  }));
}

test('a queued meeting opens its own queue folder, with what it holds', async (t) => {
  await workspace(t);
  const queue = new MeetingDigestService();
  const m = await queue.createMeeting({ title: 'Fictional weekly sync', meeting_date: '2026-10-28' });
  assert.deepEqual(await history.folder(m.id), { stage: 'queued', path: `context-updates/meeting-queue/${m.id}`, shared: false, first_file: null, has_audio: false, has_text: false, recorded: false });
  await queue.addFile(m.id, 'call.vtt', Buffer.from(A));
  const folder = await history.folder(m.id);
  assert.deepEqual([folder.has_text, folder.has_audio], [true, false]);
});

test('a meeting held by an unfinished digest shows its first file in the shared materials folder', async (t) => {
  await workspace(t);
  await digest(path.resolve(process.env.ESB_WORKSPACE_PATH!), 'CU-2026-0001');
  assert.deepEqual(await history.folder('MQ-2026-0002'), {
    stage: 'update', path: 'context-updates/CU-2026-0001/materials', shared: true, first_file: 'context-updates/CU-2026-0001/materials/MQ-2026-0002-b.vtt',
    has_audio: false, has_text: true, recorded: false,
  });
});

test('a reviewed meeting opens its own folder, saying whether its recording was kept', async (t) => {
  const ws = await workspace(t);
  await cleanup.update({ meetings: { keep_text: true } });
  await digest(ws, 'CU-2026-0001', { keep_recordings: true }, true);
  await updates.close('CU-2026-0001');
  assert.deepEqual(await history.folder('MQ-2026-0001'), { stage: 'reviewed', path: 'meetings/MQ-2026-0001', shared: false, first_file: null, has_audio: true, has_text: true, recorded: true });
  // Without a recording: text only, and nothing to say about one.
  assert.deepEqual(await history.folder('MQ-2026-0002'), { stage: 'reviewed', path: 'meetings/MQ-2026-0002', shared: false, first_file: null, has_audio: false, has_text: true, recorded: false });
});

test('a recording not kept after review: the text folder still opens, and it says the recording is gone', async (t) => {
  const ws = await workspace(t);
  await cleanup.update({ meetings: { keep_text: true } });
  await digest(ws, 'CU-2026-0001', { keep_recordings: false }, true);
  await updates.close('CU-2026-0001');
  const folder = await history.folder('MQ-2026-0001');
  assert.deepEqual([folder.stage, folder.path, folder.has_audio, folder.has_text, folder.recorded], ['reviewed', 'meetings/MQ-2026-0001', false, true, true]);
});

test('a meeting kept from before meeting folders opens in its done update\'s materials', async (t) => {
  const ws = await workspace(t);
  await digest(ws, 'CU-2026-0001', { status: 'done', applied_at: '2026-10-28T09:00:00.000Z', keep_meeting_text: true });
  const folder = await history.folder('MQ-2026-0001');
  assert.deepEqual([folder.stage, folder.path, folder.shared, folder.first_file], ['kept', 'context-updates/CU-2026-0001/materials', true, 'context-updates/CU-2026-0001/materials/MQ-2026-0001-a.vtt']);
});

test('a meeting in the trash or deleted for good answers 404 with the reason', async (t) => {
  const ws = await workspace(t);
  await cleanup.update({ meetings: { keep_text: true } });
  await digest(ws, 'CU-2026-0001');
  await updates.close('CU-2026-0001');
  await history.remove('MQ-2026-0002');
  await assert.rejects(history.folder('MQ-2026-0002'), (err: Error & { statusCode?: number }) => err.statusCode === 404 && /in the trash: restore it first/.test(err.message));
  await history.purge('MQ-2026-0002');
  await assert.rejects(history.folder('MQ-2026-0002'), (err: Error & { statusCode?: number }) => err.statusCode === 404 && /deleted for good/.test(err.message));
  assert.equal((await history.folder('MQ-2026-0001')).path, 'meetings/MQ-2026-0001', 'the other meeting still opens');
});

test('a meeting with nothing left on disk, or unknown, answers 404', async (t) => {
  const ws = await workspace(t);
  // Done before meetings kept text: nothing of it is left.
  await digest(ws, 'CU-2026-0001', { status: 'done', applied_at: '2026-10-28T09:00:00.000Z' });
  await fsp.rm(path.join(ws, 'context-updates', 'CU-2026-0001', 'materials'), { recursive: true, force: true });
  await assert.rejects(history.folder('MQ-2026-0001'), (err: Error & { statusCode?: number }) => err.statusCode === 404 && /no longer kept/.test(err.message));
  await assert.rejects(history.folder('MQ-2026-0099'), status(404), 'an unknown meeting');
  await assert.rejects(history.folder('../../etc'), status(400), 'never looked up');
});

test('a folder that leads outside the workspace through a link is never given out', async (t) => {
  const ws = await workspace(t);
  const outside = await outsideFolder(t);
  await digest(ws, 'CU-2026-0001');
  // The update's materials swapped for a link to a folder outside the workspace.
  const materials = path.join(ws, 'context-updates', 'CU-2026-0001', 'materials');
  await fsp.rename(materials, path.join(ws, 'saved-materials'));
  await fsp.symlink(outside, materials, 'junction');
  await assert.rejects(history.folder('MQ-2026-0001'), (err: Error & { statusCode?: number }) => err.statusCode === 409 && /link or lies outside/.test(err.message));

  // A reviewed meeting's folder swapped for a link: its text is not read from there, so no folder is given.
  await fsp.unlink(materials);
  await fsp.rename(path.join(ws, 'saved-materials'), materials);
  await cleanup.update({ meetings: { keep_text: true } });
  await updates.close('CU-2026-0001');
  const own = path.join(ws, 'meetings', 'MQ-2026-0001');
  await fsp.rename(own, path.join(ws, 'saved-folder'));
  await fsp.symlink(outside, own, 'junction');
  await assert.rejects(history.folder('MQ-2026-0001'), (err: Error & { statusCode?: number }) => err.statusCode === 404 && !err.message.includes(outside));
});

test('a queued meeting whose folder became a link to outside the workspace is never given out', async (t) => {
  const ws = await workspace(t);
  const outside = await outsideFolder(t);
  const queue = new MeetingDigestService();
  const m = await queue.createMeeting({ title: 'Fictional weekly sync', meeting_date: '2026-10-28' });
  await queue.addFile(m.id, 'call.vtt', Buffer.from(A));
  const dir = path.join(ws, 'context-updates', 'meeting-queue', m.id);
  for (const name of await fsp.readdir(dir)) await fsp.copyFile(path.join(dir, name), path.join(outside, name));
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.symlink(outside, dir, 'junction');
  await assert.rejects(history.folder(m.id), (err: Error & { statusCode?: number }) => (err.statusCode === 404 || err.statusCode === 409) && !err.message.includes(outside));
});

test('the route checks the id and answers with the folder', async (t) => {
  const ws = await workspace(t);
  await digest(ws, 'CU-2026-0001');
  const { default: meetingsRouter } = await import('../src/routes/meetings');
  const { errorHandler } = await import('../src/middleware/errorHandler');
  const app = express();
  app.use(express.json());
  app.use('/api/meetings', meetingsRouter);
  app.use(errorHandler);
  const listener = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => listener.once('listening', resolve));
  t.after(() => listener.close());
  const base = `http://127.0.0.1:${(listener.address() as AddressInfo).port}/api/meetings`;
  const ok = await fetch(`${base}/MQ-2026-0001/folder`);
  assert.equal(ok.status, 200);
  assert.equal(((await ok.json()) as { path: string }).path, 'context-updates/CU-2026-0001/materials');
  for (const bad of ['..%2F..%2Fetc', 'MQ-2026-1', 'TASK-2026-0001']) assert.equal((await fetch(`${base}/${bad}/folder`)).status, 400, bad);
  assert.equal((await fetch(`${base}/MQ-2026-0042/folder`)).status, 404);
});
