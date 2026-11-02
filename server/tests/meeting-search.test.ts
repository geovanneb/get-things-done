import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { MeetingHistoryService } from '../src/services/meetingHistoryService';
import { MeetingDigestService } from '../src/services/meetingDigestService';
import { fold, queryWords, searchMeeting, textUnits } from '../src/services/meetingSearch';
import { stringifyMarkdown } from '../src/utils/markdown';

/** A throwaway fictional workspace; services read its path from ESB_WORKSPACE_PATH. */
async function workspace(t: { after: (fn: () => Promise<void> | void) => void }): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-meeting-search-'));
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

const history = new MeetingHistoryService();

/** A transcript copy as the dashboard writes it: a text fence of `[start → end] speaker` turns with indented text. */
const turns = (...parts: [string, string, string][]) => ['# Transcript', '', '```text', ...parts.flatMap(([time, who, words]) => [`[${time} → ${time}] ${who}`, `  ${words}`]), '```', ''].join('\n');

/** Writes a context update by hand, as an analysis and review leave it, with its material files. */
async function update(ws: string, id: string, data: Record<string, unknown>, files: Record<string, string>): Promise<void> {
  const dir = path.join(ws, 'context-updates', id);
  await fsp.mkdir(path.join(dir, 'materials'), { recursive: true });
  for (const [name, content] of Object.entries(files)) await fsp.writeFile(path.join(dir, 'materials', name), content);
  await fsp.writeFile(path.join(dir, 'update.md'), stringifyMarkdown('', {
    schema_version: '1.0', id, type: 'context-update', title: `Fictional ${id}`, status: 'in_review', source_date: '2026-10-27',
    created_at: '2026-10-27T18:00:00.000Z', updated_at: '2026-10-28T09:00:00.000Z',
    materials: Object.keys(files).map((name) => ({ name, size: 1, type: 'text/plain' })), ...data,
  }));
}

const record = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: `Meeting ${id}`, meeting_date: '2026-10-27', attendees: [{ name: 'Jane Doe' }], decisions: ['Fictional decision'], source: '', ...extra });

/** A digest of two meetings: MQ-2026-0001 recorded (its audio kept), MQ-2026-0002 a transcript and a photo. */
async function digest(ws: string, id: string, extra: Record<string, unknown> = {}): Promise<void> {
  await update(ws, id, {
    origin: 'meetings', kind: 'daily-digest',
    digest_meetings: [
      {
        id: 'MQ-2026-0001', title: 'Weekly sync', meeting_date: '2026-10-27',
        files: [{ source: 'call.webm', file: 'MQ-2026-0001-call.webm', sha256: 'a1' }, { source: 'call.transcript.md', file: 'MQ-2026-0001-call.transcript.md', sha256: 't1' }],
        recordings: [{ source: 'call.webm', source_sha256: 'a1', transcript: 'MQ-2026-0001-call.transcript.md', transcript_sha256: 't1', complete: true, file: 'MQ-2026-0001-call.webm' }],
      },
      { id: 'MQ-2026-0002', title: 'Pilot review', meeting_date: '2026-10-27', files: [{ source: 'b.vtt', file: 'MQ-2026-0002-b.vtt', sha256: '2' }, { source: 'board.png', file: 'MQ-2026-0002-board.png', sha256: '3' }] },
    ],
    transcripts: [
      { file: 'MQ-2026-0001-call.transcript.md', source: 'MQ-2026-0001-call.webm', source_sha256: 'a1', sha256: 't1', complete: true, kind: 'audio' },
      { file: 'MQ-2026-0002-b.transcript.md', source: 'MQ-2026-0002-b.vtt', source_sha256: 'x', sha256: 'y', complete: true, kind: 'webvtt' },
    ],
    meeting_records: [record('M-01', { meeting: 'MQ-2026-0001' }), record('M-02', { meeting: 'MQ-2026-0002' })], ...extra,
  }, {
    'meetings.md': '# Meetings in this digest: the budget is listed here too',
    'MQ-2026-0001-call.webm': 'fictional audio that says budget',
    'MQ-2026-0001-call.transcript.md': turns(['00:00:05', 'Speaker 1', 'The carrier volumes are up nine percent.'], ['00:01:10', 'Speaker 2', 'Then the budget review moves to Friday.']),
    'MQ-2026-0002-b.vtt': 'WEBVTT\n\n00:00:01.000 --> 00:00:04.000\n<v Taro Yamada>Pilot on track.</v>\n',
    'MQ-2026-0002-b.transcript.md': turns(['00:00:01', 'Taro Yamada', 'The pilot is on track for November.']),
    'MQ-2026-0002-board.png': 'png with the word budget',
  });
}

test('a meeting matches only when its texts hold every word, and the places with most words come first', () => {
  const words = queryWords('Budget  FRIDAY budget');
  assert.deepEqual(words, ['budget', 'friday'], 'folded, and each word once');
  const texts = [{ file: 'a.vtt', text: turns(['00:00:05', 'Speaker 1', 'The budget is tight.'], ['00:01:10', 'Speaker 2', 'Then the budget review moves to Friday.']) }, { file: 'notes.md', text: 'Budget\n\nnothing else' }];
  const hit = searchMeeting('MQ-2026-0001', texts, words)!;
  assert.equal(hit.places, 3);
  assert.deepEqual(hit.snippets.map((s) => [s.file, s.time, s.speaker]), [['a.vtt', '00:01:10', 'Speaker 2'], ['a.vtt', '00:00:05', 'Speaker 1'], ['notes.md', null, null]]);
  assert.equal(hit.snippets[0]!.text, 'Then the budget review moves to Friday.');
  assert.ok(searchMeeting('x', texts, queryWords('budget monday')) === null, 'every word, not any word');
  assert.ok(searchMeeting('x', [{ file: 'a.md', text: 'the budget' }, { file: 'b.md', text: 'on friday' }], words), 'the words may be in different files of the meeting');
});

test('full-width and half-width forms, Japanese, a long turn cut around the word, and a match on the speaker', () => {
  assert.equal(fold('ＢＵＤＧＥＴ　予算'), 'budget 予算');
  const hit = searchMeeting('m', [{ file: 'a.vtt', text: turns(['00:00:01', '佐藤', '来週の予算会議は金曜日に移ります。']) }], queryWords('予算'))!;
  assert.equal(hit.snippets[0]!.text, '来週の予算会議は金曜日に移ります。');
  const long = `${'word '.repeat(60)}budget${' word'.repeat(60)}`;
  const cut = searchMeeting('m', [{ file: 'n.md', text: long }], ['budget'])!.snippets[0]!.text;
  assert.ok(cut.startsWith('…') && cut.endsWith('…') && cut.includes('budget') && cut.length < 200, cut);
  const bySpeaker = searchMeeting('m', [{ file: 'a.vtt', text: turns(['00:00:09', 'Kim Park', 'Agreed.']) }], ['kim'])!;
  assert.deepEqual([bySpeaker.snippets[0]!.speaker, bySpeaker.snippets[0]!.text], ['Kim Park', 'Agreed.']);
  assert.deepEqual(textUnits('one\n\n two \n').map((u) => u.text), ['one', 'two'], 'notes are read line by line');
});

test('search reads each meeting\'s own transcripts and notes, never audio, photos or the digest\'s other files', async (t) => {
  const ws = await workspace(t);
  await digest(ws, 'CU-2026-0001');
  await update(ws, 'CU-2026-0002', { meeting_records: [record('M-01', { source: 'steering.md' })] }, { 'steering.md': '# Steering\n\nDecided: the budget stays as planned.' });
  const found = await history.search('budget');
  assert.deepEqual(found.results.map((r) => r.id).sort(), ['CU-2026-0002-M-01', 'MQ-2026-0001'], 'not MQ-2026-0002 through its photo, nor anything through meetings.md');
  assert.equal(found.searched, 3);
  const call = found.results.find((r) => r.id === 'MQ-2026-0001')!;
  assert.deepEqual(call.snippets.map((s) => [s.file, s.time]), [['MQ-2026-0001-call.webm', '00:01:10']], 'a kept recording is searched through its transcript, named by the recording');
  assert.deepEqual((await history.search('pilot November')).results.map((r) => r.id), ['MQ-2026-0002'], 'a WebVTT file through its readable copy');
  const status = (code: number) => (err: { statusCode?: number }) => err.statusCode === code;
  await assert.rejects(history.search('b'), status(400));
  await assert.rejects(history.search('x'.repeat(201)), status(400));
  await assert.rejects(history.search(['budget']), status(400));
});

test('a meeting in the trash is not searched, and comes back with a restore', async (t) => {
  const ws = await workspace(t);
  await digest(ws, 'CU-2026-0001', { status: 'done', applied_at: '2026-10-28T10:00:00.000Z', keep_materials: true });
  assert.deepEqual((await history.search('carrier volumes')).results.map((r) => r.id), ['MQ-2026-0001']);
  await history.remove('MQ-2026-0001');
  assert.deepEqual((await history.search('carrier volumes')).results, []);
  await history.restore('MQ-2026-0001');
  assert.deepEqual((await history.search('carrier volumes')).results.map((r) => r.id), ['MQ-2026-0001']);
});

test('a queued meeting is searched in its transcripts and notes before any digest, and an edit is seen at once', async (t) => {
  await workspace(t);
  const queue = new MeetingDigestService();
  const m = await queue.createMeeting({ title: 'Weekly sync', meeting_date: '2026-10-28' });
  await queue.addFile(m.id, 'call.vtt', Buffer.from('WEBVTT\n\n00:00:01.000 --> 00:00:04.000\n<v Jane Doe>The warehouse lease ends in March.</v>\n'));
  await queue.addFile(m.id, 'notes.md', Buffer.from('Follow up on the lease with legal.'));
  const hit = (await history.search('lease')).results.find((r) => r.id === m.id)!;
  assert.deepEqual(hit.snippets.map((s) => [s.file, s.time, s.speaker]), [['call.vtt', '00:00:01', 'Jane Doe'], ['notes.md', null, null]]);
  // The text read for the last search is not used once the file changed.
  await fsp.writeFile(path.join(await queue.meetingFolder(m.id), 'notes.md'), 'Follow up on the lease with finance, not legal.');
  assert.match((await history.search('finance')).results[0]!.snippets[0]!.text, /finance/);
});
