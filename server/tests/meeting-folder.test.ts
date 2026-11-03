import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import { ContextUpdateService } from '../src/services/contextUpdateService';
import { MeetingHistoryService } from '../src/services/meetingHistoryService';
import { SystemCleanupService, parseSettings, MEETING_TRASH_DAYS } from '../src/services/systemCleanupService';
import { resolveMeeting } from '../src/services/meetingSources';
import { startCorrection } from '../src/services/meetingCorrectionService';
import { readFolder } from '../src/services/meetingFolder';
import { parseMarkdown, stringifyMarkdown } from '../src/utils/markdown';
import { trashDir } from '../src/services/trash';

/** A throwaway fictional workspace; services read its path from ESB_WORKSPACE_PATH. */
async function workspace(t: { after: (fn: () => Promise<void> | void) => void }): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-meeting-folder-'));
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

const updates = new ContextUpdateService();
const history = new MeetingHistoryService();
const cleanup = new SystemCleanupService();
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const vtt = (who: string, words: string) => `WEBVTT\n\n00:00:01.000 --> 00:00:04.000\n<v ${who}>${words}</v>\n`;
const A = vtt('Jane Doe', 'Budget next week.');
const B = vtt('Taro Yamada', 'Pilot on track.');

/** A digest of two queued meetings, as an analysis leaves it: MQ-2026-0001 (a transcript), MQ-2026-0002 (a transcript and a photo). */
async function digest(ws: string, id: string, extra: Record<string, unknown> = {}): Promise<void> {
  const dir = path.join(ws, 'context-updates', id);
  const files: Record<string, string> = {
    'meetings.md': '# Meetings in this digest', 'MQ-2026-0001-a.vtt': A, 'MQ-2026-0001-a.transcript.md': 'copy a budget',
    'MQ-2026-0002-b.vtt': B, 'MQ-2026-0002-b.transcript.md': 'copy b pilot', 'MQ-2026-0002-board.png': 'png',
  };
  await fsp.mkdir(path.join(dir, 'materials'), { recursive: true });
  for (const [name, content] of Object.entries(files)) await fsp.writeFile(path.join(dir, 'materials', name), content);
  await fsp.writeFile(path.join(dir, 'update.md'), stringifyMarkdown('', {
    schema_version: '1.0', id, type: 'context-update', title: `Fictional ${id}`, status: 'in_review', source_date: '2026-10-27',
    created_at: '2026-10-27T18:00:00.000Z', updated_at: '2026-10-28T09:00:00.000Z', origin: 'meetings', kind: 'daily-digest',
    materials: Object.keys(files).map((name) => ({ name, size: 1, type: 'text/plain' })),
    digest_meetings: [
      { id: 'MQ-2026-0001', title: 'Weekly sync', meeting_date: '2026-10-27', files: [{ source: 'a.vtt', file: 'MQ-2026-0001-a.vtt', sha256: sha(A) }] },
      { id: 'MQ-2026-0002', title: 'Pilot review', meeting_date: '2026-10-27', files: [{ source: 'b.vtt', file: 'MQ-2026-0002-b.vtt', sha256: sha(B) }, { source: 'board.png', file: 'MQ-2026-0002-board.png', sha256: sha('png') }] },
    ],
    transcripts: [
      { file: 'MQ-2026-0001-a.transcript.md', source: 'MQ-2026-0001-a.vtt', source_sha256: sha(A), sha256: sha('copy a budget'), complete: true, kind: 'webvtt' },
      { file: 'MQ-2026-0002-b.transcript.md', source: 'MQ-2026-0002-b.vtt', source_sha256: sha(B), sha256: sha('copy b pilot'), complete: true, kind: 'webvtt' },
    ],
    meeting_records: [
      { id: 'M-01', title: 'Weekly sync', meeting_date: '2026-10-27', meeting: 'MQ-2026-0001', source: 'MQ-2026-0001-a.vtt', attendees: [{ name: 'Jane Doe' }], decisions: ['Fictional decision'] },
      { id: 'M-02', title: 'Pilot review', meeting_date: '2026-10-27', meeting: 'MQ-2026-0002', source: 'MQ-2026-0002-b.vtt', attendees: [{ name: 'Taro Yamada' }], decisions: [] },
    ],
    ...extra,
  }));
}

async function change(ws: string, id: string, fn: (d: Record<string, unknown>) => void): Promise<void> {
  const file = path.join(ws, 'context-updates', id, 'update.md');
  const parsed = parseMarkdown(await fsp.readFile(file, 'utf-8'));
  fn(parsed.data as Record<string, unknown>);
  await fsp.writeFile(file, stringifyMarkdown(parsed.content, parsed.data));
}

const exists = (p: string) => fsp.lstat(p).then(() => true, () => false);
const v1 = (ws: string, id: string) => path.join(ws, 'meetings', id, 'v1');

test('once its review is done, each meeting\'s kept text moves to its own folder, listed with its hashes', async (t) => {
  const ws = await workspace(t);
  await cleanup.update({ meetings: { keep_text: true } });
  await digest(ws, 'CU-2026-0001');
  const done = await updates.close('CU-2026-0001');
  assert.equal(done.meeting_folders, true, 'said in update.md, so a later read knows where the text went');

  assert.equal(await exists(path.join(ws, 'context-updates', 'CU-2026-0001', 'materials')), false, 'nothing of it is left in context-updates/');
  assert.deepEqual((await fsp.readdir(v1(ws, 'MQ-2026-0001'))).sort(), ['MQ-2026-0001-a.transcript.md', 'MQ-2026-0001-a.vtt']);
  assert.deepEqual((await fsp.readdir(v1(ws, 'MQ-2026-0002'))).sort(), ['MQ-2026-0002-b.transcript.md', 'MQ-2026-0002-b.vtt'], 'text only: no photo');
  const folder = await readFolder(ws, 'MQ-2026-0001');
  assert.equal(folder.state, 'ok');
  if (folder.state !== 'ok') return;
  assert.deepEqual([folder.manifest.update_id, folder.manifest.current, folder.version.made_from], ['CU-2026-0001', 'v1', 'review']);
  assert.deepEqual(folder.version.files.map((f) => [f.name, f.sha256]).sort(), [['MQ-2026-0001-a.transcript.md', sha('copy a budget')], ['MQ-2026-0001-a.vtt', sha(A)]]);
  assert.deepEqual((await fsp.readdir(path.join(ws, 'meetings'))).sort(), ['MQ-2026-0001', 'MQ-2026-0002'], 'no draft left behind');

  // Read where it is now; the history and its files look as they did.
  const detail = await history.detail('MQ-2026-0002');
  assert.deepEqual(detail.sources.map((s) => [s.name, s.state, s.sha256]), [['b.vtt', 'present', sha(B)], ['board.png', 'missing', sha('png')]]);
  assert.equal(await history.text('MQ-2026-0001', 'MQ-2026-0001-a.vtt'), 'copy a budget', 'through its readable copy');
  assert.match(await history.file('MQ-2026-0001', 'MQ-2026-0001-a.vtt'), /meetings[/\\]MQ-2026-0001[/\\]v1[/\\]MQ-2026-0001-a\.vtt$/);
  await assert.rejects(history.file('MQ-2026-0001', 'MQ-2026-0002-b.vtt'), (err: { statusCode?: number }) => err.statusCode === 404, 'never another meeting\'s file');
  await assert.rejects(history.file('MQ-2026-0001', '../meeting.json'), /Invalid file name/);
  const found = await history.search('pilot');
  assert.deepEqual(found.results.map((r) => r.id), ['MQ-2026-0002']);
});

test('a meeting kept before meeting folders stays in its update and is read there', async (t) => {
  const ws = await workspace(t);
  // Done by an earlier version: meeting text kept, but no meeting_folders.
  await digest(ws, 'CU-2026-0001', { status: 'done', applied_at: '2026-10-28T09:00:00.000Z', keep_meeting_text: true });
  await updates.get('CU-2026-0001');
  assert.equal(await exists(path.join(ws, 'meetings')), false, 'nothing is moved by reading it');
  assert.ok(await exists(path.join(ws, 'context-updates', 'CU-2026-0001', 'materials', 'MQ-2026-0001-a.vtt')));
  assert.equal(await history.text('MQ-2026-0001', 'MQ-2026-0001-a.vtt'), 'copy a budget');
  assert.match((await resolveMeeting('MQ-2026-0001')).sources[0]!.path, /^context-updates\/CU-2026-0001\/materials\//);
});

test('a move that stopped half way is finished by the next read, and a draft is never read as a meeting', async (t) => {
  const ws = await workspace(t);
  await cleanup.update({ meetings: { keep_text: true } });
  await digest(ws, 'CU-2026-0001');
  await updates.close('CU-2026-0001');
  // As if the dashboard stopped after the folder was renamed into place, before materials/ was cleaned up.
  const materials = path.join(ws, 'context-updates', 'CU-2026-0001', 'materials');
  await fsp.mkdir(materials, { recursive: true });
  await fsp.writeFile(path.join(materials, 'MQ-2026-0001-a.vtt'), A);
  // And a draft of another move that never finished.
  await fsp.mkdir(path.join(ws, 'meetings', '.MQ-2026-0001.0000.draft', 'v1'), { recursive: true });
  await fsp.writeFile(path.join(ws, 'meetings', '.MQ-2026-0001.0000.draft', 'v1', 'MQ-2026-0001-a.vtt'), 'not this');

  await updates.get('CU-2026-0001');
  assert.equal(await exists(path.join(materials, 'MQ-2026-0001-a.vtt')), false, 'the folder already holds it, so the copy here goes');
  assert.equal(await history.text('MQ-2026-0001', 'MQ-2026-0001-a.vtt'), 'copy a budget');
  assert.deepEqual((await history.list()).map((m) => m.id).sort(), ['MQ-2026-0001', 'MQ-2026-0002']);
});

test('a folder of another update, or a damaged one, is never used: the text stays in the update', async (t) => {
  const ws = await workspace(t);
  await cleanup.update({ meetings: { keep_text: true } });
  await digest(ws, 'CU-2026-0001');
  // Someone else's folder under the first meeting's id, and a damaged one under the second's.
  await fsp.mkdir(v1(ws, 'MQ-2026-0001'), { recursive: true });
  await fsp.writeFile(v1(ws, 'MQ-2026-0001') + '/MQ-2026-0001-a.vtt', 'other text');
  const other = { schema: 1, id: 'MQ-2026-0001', update_id: 'CU-2026-0009', current: 'v1', versions: [{ id: 'v1', at: '2026-10-01T00:00:00.000Z', made_from: 'review', files: [{ name: 'MQ-2026-0001-a.vtt', sha256: sha('other text') }] }] };
  await fsp.writeFile(path.join(ws, 'meetings', 'MQ-2026-0001', 'meeting.json'), JSON.stringify(other));
  await fsp.mkdir(path.join(ws, 'meetings', 'MQ-2026-0002'), { recursive: true });
  await fsp.writeFile(path.join(ws, 'meetings', 'MQ-2026-0002', 'meeting.json'), '{ not json');

  await updates.close('CU-2026-0001');
  const materials = path.join(ws, 'context-updates', 'CU-2026-0001', 'materials');
  assert.deepEqual((await fsp.readdir(materials)).sort(), ['MQ-2026-0001-a.transcript.md', 'MQ-2026-0001-a.vtt', 'MQ-2026-0002-b.transcript.md', 'MQ-2026-0002-b.vtt'], 'kept as before');
  assert.equal(await fsp.readFile(v1(ws, 'MQ-2026-0001') + '/MQ-2026-0001-a.vtt', 'utf-8'), 'other text', 'the other folder is left as it is');
  assert.equal(await history.text('MQ-2026-0001', 'MQ-2026-0001-a.vtt'), 'copy a budget', 'read from the update, never from the other folder');
  assert.equal(await history.text('MQ-2026-0002', 'MQ-2026-0002-b.vtt'), 'copy b pilot');
});

test('a task pinned before the review follows its meeting\'s text into the folder by its bytes', async (t) => {
  const ws = await workspace(t);
  await cleanup.update({ meetings: { keep_text: true } });
  await digest(ws, 'CU-2026-0001');
  const before = await resolveMeeting('MQ-2026-0001');
  await updates.close('CU-2026-0001');
  const after = await resolveMeeting('MQ-2026-0001');
  assert.deepEqual(before.sources.map((s) => s.sha256), after.sources.map((s) => s.sha256), 'the same bytes');
  assert.match(before.sources[0]!.path, /^context-updates\/CU-2026-0001\/materials\//);
  assert.match(after.sources[0]!.path, /^meetings\/MQ-2026-0001\/v1\//);
});

test('a correction started after the move pins the meeting\'s folder, and its speakers can still be corrected', async (t) => {
  const ws = await workspace(t);
  await cleanup.update({ meetings: { keep_text: true } });
  await digest(ws, 'CU-2026-0001');
  await change(ws, 'CU-2026-0001', (d) => {
    const r = (d['meeting_records'] as Record<string, unknown>[])[0]!;
    r['speakers'] = [{ label: 'Speaker 1', source: 'MQ-2026-0001-a.vtt', person: { name: 'Jane Doe' }, reason: 'Named in the call.' }];
  });
  const revision = (await updates.get('CU-2026-0001')).meeting_records[0]!.revision;
  await updates.saveMeetingRecords('CU-2026-0001', { 'M-01': { confirmation: 'confirmed', revision } });
  await updates.close('CU-2026-0001');
  assert.ok(await exists(v1(ws, 'MQ-2026-0001')));

  const started = await startCorrection('MQ-2026-0001');
  const env = started.correction!;
  assert.deepEqual(env.sources.map((s) => s.path).sort(), ['meetings/MQ-2026-0001/v1/MQ-2026-0001-a.transcript.md']);
  // The analysis renames the speaker: the review checks the original transcript where it is kept now.
  const base = (await updates.get('CU-2026-0001')).meeting_records[0]!;
  await change(ws, started.id, (d) => {
    d['status'] = 'in_review';
    d['analyzed_at'] = new Date().toISOString();
    d['meeting_records'] = [{
      id: base.id, title: base.title, meeting_date: base.meeting_date, meeting: env.meeting, source: base.source, amends: env.base,
      attendees: base.attendees, decisions: base.decisions, open_questions: base.open_questions, action_items: [],
      speakers: [{ label: 'Speaker 1', source: 'MQ-2026-0001-a.vtt', person: { name: 'Jane Do' }, reason: 'Spelled as in the call.' }],
      corrections: [{ field: 'speakers', before: 'Jane Doe', after: 'Jane Do', reason: 'Spelled as in the call.', sure: true }],
    }];
  });
  const review = (await updates.get(started.id)).correction_review!;
  assert.ok(!review.blocked.some((b) => /not one of this meeting's files/.test(b)), review.blocked.join('; '));
});

test('deleting one meeting empties its folder into the trash; restoring puts it back; deleting the update takes the folders too', async (t) => {
  const ws = await workspace(t);
  await cleanup.update({ meetings: { keep_text: true } });
  await digest(ws, 'CU-2026-0001');
  await updates.close('CU-2026-0001');

  await history.remove('MQ-2026-0001');
  assert.deepEqual(await fsp.readdir(v1(ws, 'MQ-2026-0001')), []);
  const [entry] = await fsp.readdir(trashDir(ws));
  assert.deepEqual((await fsp.readdir(path.join(trashDir(ws), entry!))).sort(), ['MQ-2026-0001-a.transcript.md', 'MQ-2026-0001-a.vtt']);
  assert.equal((await history.detail('MQ-2026-0001')).sources[0]!.state, 'unavailable');
  await history.restore('MQ-2026-0001');
  assert.equal(await history.text('MQ-2026-0001', 'MQ-2026-0001-a.vtt'), 'copy a budget');

  await updates.remove('CU-2026-0001');
  assert.equal(await exists(path.join(ws, 'meetings', 'MQ-2026-0001')), false);
  assert.equal(await exists(path.join(ws, 'meetings', 'MQ-2026-0002')), false);
  const trashed = await fsp.readdir(trashDir(ws));
  assert.ok(trashed.some((n) => n.endsWith('-MQ-2026-0001')) && trashed.some((n) => n.endsWith('-MQ-2026-0002')) && trashed.some((n) => n.endsWith('-CU-2026-0001')));
});

test('System cleanup removes old meeting text from its folder, and the update only once its folders are empty', async (t) => {
  const ws = await workspace(t);
  await cleanup.update({ meetings: { keep_text: true } });
  await digest(ws, 'CU-2026-0001', { created_at: '2026-01-05T00:00:00.000Z' });
  await updates.close('CU-2026-0001');
  // Only the first one's record was confirmed? No: neither is, so the update can go once its meetings have.
  const now = new Date('2027-05-01T12:00:00');
  const settings = parseSettings({ rules: { context_updates: { enabled: true, older_than_days: 1 } } }, await cleanup.readSettings());
  const plan = await cleanup.plan(settings, now);
  assert.deepEqual(plan.items.filter((i) => i.type === 'meetings').map((i) => i.id).sort(), ['MQ-2026-0001', 'MQ-2026-0002']);
  assert.ok(!plan.items.some((i) => i.type === 'context_updates'), 'it waits while its meetings keep text in their folders');

  await cleanup.update({ rules: { context_updates: { enabled: true, older_than_days: 1 } } });
  assert.equal((await cleanup.runNow(now)).status, 'ok');
  assert.deepEqual(await fsp.readdir(v1(ws, 'MQ-2026-0001')), [], 'moved to the trash');
  const later = new Date(now.getTime() + (MEETING_TRASH_DAYS + 1) * 86_400_000);
  await cleanup.runNow(later);
  await cleanup.runNow(later);
  assert.equal(await exists(path.join(ws, 'context-updates', 'CU-2026-0001')), false, 'then the update goes');
  assert.equal(await exists(path.join(ws, 'meetings', 'MQ-2026-0001')), false, 'and its empty folders with it');
  assert.equal(await exists(path.join(ws, 'meetings', 'MQ-2026-0002')), false);
});
