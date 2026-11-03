import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { ContextUpdateService } from '../src/services/contextUpdateService';
import { MeetingHistoryService } from '../src/services/meetingHistoryService';
import { MeetingDigestService } from '../src/services/meetingDigestService';
import { SystemCleanupService, parseSettings, defaultSettings, MEETING_TRASH_DAYS } from '../src/services/systemCleanupService';
import { parseMarkdown, stringifyMarkdown } from '../src/utils/markdown';
import { trashDir } from '../src/services/trash';

/** A throwaway fictional workspace; services read its path from ESB_WORKSPACE_PATH. */
async function workspace(t: { after: (fn: () => Promise<void> | void) => void }): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-meetings-'));
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

const vtt = (who: string, words: string) => `WEBVTT\n\n00:00:01.000 --> 00:00:04.000\n<v ${who}>${words}</v>\n`;

/** Writes a context update by hand, as an analysis and review leave it, with its material files. */
async function update(ws: string, id: string, data: Record<string, unknown>, files: Record<string, string> = {}): Promise<void> {
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
const transcript = (file: string, source: string) => ({ file, source, source_sha256: 'x', sha256: 'y', complete: true, kind: 'webvtt' });

/** A digest of two queued meetings: MQ-2026-0001 (a transcript) and MQ-2026-0002 (a transcript and a photo). */
async function digest(ws: string, id: string, records: Record<string, unknown>[], extra: Record<string, unknown> = {}): Promise<void> {
  await update(ws, id, {
    origin: 'meetings', kind: 'daily-digest',
    digest_meetings: [
      { id: 'MQ-2026-0001', title: 'Weekly sync', meeting_date: '2026-10-27', files: [{ source: 'a.vtt', file: 'MQ-2026-0001-a.vtt', sha256: '1' }] },
      { id: 'MQ-2026-0002', title: 'Pilot review', meeting_date: '2026-10-27', files: [{ source: 'b.vtt', file: 'MQ-2026-0002-b.vtt', sha256: '2' }, { source: 'board.png', file: 'MQ-2026-0002-board.png', sha256: '3' }] },
    ],
    transcripts: [transcript('MQ-2026-0001-a.transcript.md', 'MQ-2026-0001-a.vtt'), transcript('MQ-2026-0002-b.transcript.md', 'MQ-2026-0002-b.vtt')],
    meeting_records: records, ...extra,
  }, {
    'meetings.md': '# Meetings in this digest', 'MQ-2026-0001-a.vtt': vtt('Jane Doe', 'Budget next week.'), 'MQ-2026-0001-a.transcript.md': 'copy a',
    'MQ-2026-0002-b.vtt': vtt('Taro Yamada', 'Pilot on track.'), 'MQ-2026-0002-b.transcript.md': 'copy b', 'MQ-2026-0002-board.png': 'png',
  });
}

test('the history lists digest meetings by queue id, imported records by update and record, and nothing else', async (t) => {
  const ws = await workspace(t);
  await digest(ws, 'CU-2026-0001', [record('M-01', { meeting: 'MQ-2026-0002' }), record('M-02', { source: 'MQ-2026-0001-a.transcript.md' })]);
  await update(ws, 'CU-2026-0002', { meeting_records: [record('M-01', { source: 'steering.vtt' })], transcripts: [transcript('steering.transcript.md', 'steering.vtt')] }, { 'steering.vtt': vtt('Kim Park', 'Hello.') });
  // Not analyzed yet: an imported transcript waits for its record. A memory review is not a meeting.
  await update(ws, 'CU-2026-0003', { status: 'ready', transcripts: [transcript('call.transcript.md', 'call.vtt')] }, { 'call.vtt': vtt('Kim Park', 'Hi.') });
  await update(ws, 'CU-2026-0004', { origin: 'system-cleanup', kind: 'memory-review', meeting_records: [record('M-01')] });
  await update(ws, 'CU-2026-0005', { status: 'ready' }, { 'deck.md': '# A deck, not a meeting' });

  const list = await history.list();
  const byId = new Map(list.map((m) => [m.id, m]));
  assert.deepEqual([...byId.keys()].sort(), ['CU-2026-0002-M-01', 'CU-2026-0003', 'MQ-2026-0001', 'MQ-2026-0002']);
  assert.deepEqual([byId.get('MQ-2026-0002')!.record?.id, byId.get('MQ-2026-0002')!.record?.link], ['M-01', 'explicit'], 'a record that names its meeting');
  assert.deepEqual([byId.get('MQ-2026-0001')!.record?.id, byId.get('MQ-2026-0001')!.record?.link], ['M-02', 'source'], 'a record whose source is a file of that meeting only');
  assert.equal(byId.get('CU-2026-0002-M-01')!.origin, 'update');
  assert.equal(byId.get('CU-2026-0003')!.record, null);
});

test('a record is shown with a meeting only when that is certain', async (t) => {
  const ws = await workspace(t);
  // Two records, neither naming a meeting or a file: no guessing which is which.
  await digest(ws, 'CU-2026-0001', [record('M-01'), record('M-02')]);
  const list = await history.list();
  assert.ok(list.every((m) => m.record === null));
  assert.ok(list.every((m) => m.unlinked_records === 2));
  const detail = await history.detail('MQ-2026-0001');
  assert.deepEqual(detail.update_records.map((r) => r.id), ['M-01', 'M-02'], 'shown as the update\'s records instead');
});

test('a record-only meeting gets an id to link to only once its update is done', async (t) => {
  const ws = await workspace(t);
  // Record ids are written by the analysis: a re-analysis during review may number them differently.
  await update(ws, 'CU-2026-0002', { meeting_records: [record('M-01', { source: 'steering.vtt' })] }, { 'steering.vtt': vtt('Kim Park', 'Hello.') });
  await update(ws, 'CU-2026-0003', { status: 'ready', transcripts: [transcript('call.transcript.md', 'call.vtt')] }, { 'call.vtt': vtt('Kim Park', 'Hi.') });
  await digest(ws, 'CU-2026-0001', [record('M-01', { meeting: 'MQ-2026-0001' })]);
  const byId = new Map((await history.list()).map((m) => [m.id, m]));
  assert.deepEqual([byId.get('CU-2026-0002-M-01')!.linkable, byId.get('CU-2026-0002-M-01')!.review_state], [false, 'provisional']);
  assert.deepEqual([byId.get('CU-2026-0003')!.linkable, byId.get('CU-2026-0003')!.review_state], [false, 'waiting']);
  assert.deepEqual([byId.get('MQ-2026-0001')!.linkable, byId.get('MQ-2026-0001')!.review_state], [true, 'provisional'], 'a queue id is final from the start');
  const refused = (err: { statusCode?: number }) => err.statusCode === 409;
  await assert.rejects(history.detail('CU-2026-0002-M-01'), refused);
  await assert.rejects(history.text('CU-2026-0002-M-01', 'steering.vtt'), refused);
  await assert.rejects(history.keep('CU-2026-0002-M-01', true), refused, 'a kept record id could point at another meeting after a re-analysis');
  await assert.rejects(history.detail('CU-2026-0003'), refused);

  await updates.close('CU-2026-0002');
  const done = (await history.list()).find((m) => m.id === 'CU-2026-0002-M-01')!;
  assert.deepEqual([done.linkable, done.review_state], [true, 'final']);
  assert.equal((await history.detail('CU-2026-0002-M-01')).meeting.id, 'CU-2026-0002-M-01');
});

test('a meeting says its record version, each file\'s hash and state, and an unclear record link', async (t) => {
  const ws = await workspace(t);
  await digest(ws, 'CU-2026-0001', [record('M-01', { meeting: 'MQ-2026-0002' }), record('M-02'), record('M-03')]);
  const linked = await history.detail('MQ-2026-0002');
  assert.equal(linked.meeting.record_state, 'linked');
  assert.match(linked.meeting.record?.revision ?? '', /^[0-9a-f]{16}$/);
  assert.deepEqual(linked.sources.map((s) => [s.name, s.sha256, s.state]), [['b.vtt', '2', 'present'], ['board.png', '3', 'present']]);
  // Two records left for one meeting: which is its own is not certain, so none is shown.
  const unclear = await history.detail('MQ-2026-0001');
  assert.deepEqual([unclear.meeting.record_state, unclear.record], ['ambiguous', null]);

  // Once its text is in the trash, a file can come back; deleted for good, it is missing.
  await cleanup.update({ meetings: { keep_text: true } });
  await updates.close('CU-2026-0001');
  await updates.trashMeeting('CU-2026-0001', 'MQ-2026-0002');
  // The photo went when the update was done; only the transcript went to the trash with the meeting.
  assert.deepEqual((await history.detail('MQ-2026-0002')).sources.map((s) => [s.name, s.state]), [['b.vtt', 'unavailable'], ['board.png', 'missing']]);
  await updates.purgeMeeting('CU-2026-0001', 'MQ-2026-0002');
  assert.deepEqual((await history.detail('MQ-2026-0002')).sources.map((s) => s.state), ['missing', 'missing']);
});

/** update.md as written, to check what the dashboard saved. */
async function raw(ws: string, id: string): Promise<Record<string, unknown>> {
  return parseMarkdown(await fsp.readFile(path.join(ws, 'context-updates', id, 'update.md'), 'utf-8')).data as Record<string, unknown>;
}
const rawRecords = (data: Record<string, unknown>) => data['meeting_records'] as Record<string, unknown>[];

test('closing an imported update saves each meeting\'s id on its record and files, and a confirmation stays', async (t) => {
  const ws = await workspace(t);
  await update(ws, 'CU-2026-0002', {
    meeting_records: [record('M-01', { source: 'steering.vtt' }), record('M-02', { source: 'vendor.vtt' })],
    transcripts: [transcript('steering.transcript.md', 'steering.vtt'), transcript('vendor.transcript.md', 'vendor.vtt')],
  }, { 'steering.vtt': vtt('Kim Park', 'Steering.'), 'steering.transcript.md': 'copy s', 'vendor.vtt': vtt('Kim Park', 'Vendor.'), 'vendor.transcript.md': 'copy v' });
  const before = await updates.get('CU-2026-0002');
  const m1 = before.meeting_records.find((r) => r.id === 'M-01')!;
  await updates.saveMeetingRecords('CU-2026-0002', { 'M-01': { confirmation: 'confirmed', revision: m1.revision } });

  await updates.close('CU-2026-0002');
  const data = await raw(ws, 'CU-2026-0002');
  assert.ok(typeof data['meetings_linked_at'] === 'string');
  assert.deepEqual(rawRecords(data).map((r) => r['meeting_id']), ['CU-2026-0002-M-01', 'CU-2026-0002-M-02']);
  assert.deepEqual((data['materials'] as Record<string, unknown>[]).map((m) => [m['name'], m['meetings']]).sort(), [
    ['steering.transcript.md', ['CU-2026-0002-M-01']], ['steering.vtt', ['CU-2026-0002-M-01']],
    ['vendor.transcript.md', ['CU-2026-0002-M-02']], ['vendor.vtt', ['CU-2026-0002-M-02']],
  ]);
  const after = (await updates.get('CU-2026-0002')).meeting_records.find((r) => r.id === 'M-01')!;
  assert.deepEqual([after.confirmation, after.revision], ['confirmed', m1.revision], 'the saved id is not part of what was confirmed');

  // Saved means permanent: a record whose source is edited by hand afterwards stays with the files saved for it.
  const edited = await raw(ws, 'CU-2026-0002');
  rawRecords(edited)[0]!['source'] = 'vendor.vtt';
  await fsp.writeFile(path.join(ws, 'context-updates', 'CU-2026-0002', 'update.md'), stringifyMarkdown('', edited));
  const steering = (await history.list()).find((m) => m.id === 'CU-2026-0002-M-01')!;
  assert.equal(steering.record?.link, 'saved');
  assert.deepEqual((await history.detail('CU-2026-0002-M-01')).sources.map((s) => s.name), ['steering.vtt']);
});

test('a digest saves only the links that are certain, and a meeting id an agent wrote never counts', async (t) => {
  const ws = await workspace(t);
  // M-01 names its meeting. M-02 and M-03 name nothing, so which one is MQ-2026-0001's is not certain;
  // M-02 also carries a meeting_id the analysis made up.
  await digest(ws, 'CU-2026-0001', [record('M-01', { meeting: 'MQ-2026-0002' }), record('M-02', { meeting_id: 'MQ-2026-0001' }), record('M-03')]);
  const open = new Map((await history.list()).map((m) => [m.id, m]));
  assert.equal(open.get('MQ-2026-0001')!.record_state, 'ambiguous', 'before the update is done, a written meeting_id is not read');

  await updates.close('CU-2026-0001');
  const data = await raw(ws, 'CU-2026-0001');
  assert.deepEqual(rawRecords(data).map((r) => r['meeting_id'] ?? null), ['MQ-2026-0002', null, null]);
  const done = new Map((await history.list()).map((m) => [m.id, m]));
  assert.deepEqual([done.get('MQ-2026-0002')!.record?.id, done.get('MQ-2026-0002')!.record?.link], ['M-01', 'saved']);
  assert.equal(done.get('MQ-2026-0001')!.record_state, 'ambiguous', 'an unclear link stays unclear');
  // A digest's files already sit under their meeting; they are saved on the materials too.
  const materials = new Map((data['materials'] as Record<string, unknown>[]).map((m) => [m['name'], m['meetings']]));
  assert.deepEqual([materials.get('MQ-2026-0002-b.vtt'), materials.get('meetings.md')], [['MQ-2026-0002'], undefined]);
});

test('an update the apply command finished gets its links saved the first time it is opened', async (t) => {
  const ws = await workspace(t);
  await update(ws, 'CU-2026-0002', { status: 'done', applied_at: '2026-10-28T10:00:00.000Z', meeting_records: [record('M-01', { source: 'call.vtt' })] }, { 'call.vtt': vtt('Kim Park', 'Hi.') });
  // Not opened yet: the link is worked out as before, and nothing is written by reading the list.
  assert.equal((await history.list())[0]!.record?.link, null);
  assert.equal((await raw(ws, 'CU-2026-0002'))['meetings_linked_at'], undefined);
  await updates.get('CU-2026-0002');
  const data = await raw(ws, 'CU-2026-0002');
  assert.ok(typeof data['meetings_linked_at'] === 'string');
  assert.equal(rawRecords(data)[0]!['meeting_id'], 'CU-2026-0002-M-01');
  const savedAt = data['meetings_linked_at'];
  await updates.get('CU-2026-0002');
  assert.equal((await raw(ws, 'CU-2026-0002'))['meetings_linked_at'], savedAt, 'saved once, not on every read');
});

test('an update with no meeting gets no links saved', async (t) => {
  const ws = await workspace(t);
  await update(ws, 'CU-2026-0005', {}, { 'deck.md': '# A deck, not a meeting' });
  await updates.close('CU-2026-0005');
  const data = await raw(ws, 'CU-2026-0005');
  assert.equal(data['meetings_linked_at'], undefined);
  assert.equal((data['materials'] as Record<string, unknown>[])[0]!['meetings'], undefined);
});

test('a meeting\'s text is read from its own files only', async (t) => {
  const ws = await workspace(t);
  await digest(ws, 'CU-2026-0001', [record('M-01', { meeting: 'MQ-2026-0001' })]);
  assert.equal(await history.text('MQ-2026-0001', 'MQ-2026-0001-a.vtt'), 'copy a', 'a transcript is read as its readable copy');
  await assert.rejects(history.text('MQ-2026-0001', 'MQ-2026-0002-b.vtt'), /No such file in this meeting/, 'another meeting\'s file');
  await assert.rejects(history.text('MQ-2026-0001', '../update.md'), /Invalid file name/);
  await assert.rejects(history.text('MQ-2026-0001', 'meetings.md'), /No such file in this meeting/);
  await assert.rejects(history.text('MQ-2026-0002', 'MQ-2026-0002-board.png'), (err: { statusCode?: number }) => err.statusCode === 415);
  await assert.rejects(history.text('CU-2026-0001-M-01', 'x'), (err: { statusCode?: number }) => err.statusCode === 404, 'a digest meeting is named by its queue id');
  await assert.rejects(history.detail('MQ-2026-12345'), (err: { statusCode?: number }) => err.statusCode === 400);
});

test('a queued meeting\'s imported transcript and notes can be read before any digest', async (t) => {
  await workspace(t);
  const queue = new MeetingDigestService();
  const m = await queue.createMeeting({ title: 'Weekly sync', meeting_date: '2026-10-28' });
  await queue.addFile(m.id, 'call.vtt', Buffer.from(vtt('Jane Doe', 'Budget next week.')));
  await queue.addFile(m.id, 'notes.md', Buffer.from('Fictional notes'));
  assert.match(await history.text(m.id, 'call.vtt'), /Budget next week\./);
  assert.equal(await history.text(m.id, 'notes.md'), 'Fictional notes');
  await assert.rejects(history.text(m.id, 'other.md'), /No such file in this meeting/);
});

/** A digest of one recorded meeting, as the digest writes it with Keep recordings on: the audio is kept next to its transcript. */
async function recordedDigest(ws: string, id: string, extra: Record<string, unknown> = {}): Promise<void> {
  await update(ws, id, {
    origin: 'meetings', kind: 'daily-digest',
    digest_meetings: [{
      id: 'MQ-2026-0001', title: 'Weekly sync', meeting_date: '2026-10-27',
      files: [{ source: 'call.webm', file: 'MQ-2026-0001-call.webm', sha256: 'a1' }, { source: 'call.transcript.md', file: 'MQ-2026-0001-call.transcript.md', sha256: 't1' }],
      recordings: [{ source: 'call.webm', source_sha256: 'a1', transcript: 'MQ-2026-0001-call.transcript.md', transcript_sha256: 't1', complete: true, file: 'MQ-2026-0001-call.webm' }],
    }],
    transcripts: [{ file: 'MQ-2026-0001-call.transcript.md', source: 'MQ-2026-0001-call.webm', source_sha256: 'a1', sha256: 't1', complete: true, kind: 'audio' }],
    meeting_records: [record('M-01', { meeting: 'MQ-2026-0001' })], ...extra,
  }, { 'meetings.md': '# Meetings in this digest', 'MQ-2026-0001-call.webm': 'fictional audio', 'MQ-2026-0001-call.transcript.md': 'copy of the call' });
}

test('a kept recording is read through its transcript and played from its own file only', async (t) => {
  const ws = await workspace(t);
  await recordedDigest(ws, 'CU-2026-0001');
  const { sources } = await history.detail('MQ-2026-0001');
  assert.deepEqual(sources.map((s) => [s.name, s.kind, s.readable, s.playable]), [['call.webm', 'recording', true, true]],
    'one recording, with something to read and something to play (it read as "No transcript" before)');
  assert.equal(await history.text('MQ-2026-0001', 'MQ-2026-0001-call.webm'), 'copy of the call');
  assert.equal(await history.audio('MQ-2026-0001', 'MQ-2026-0001-call.webm'), await fsp.realpath(path.join(ws, 'context-updates', 'CU-2026-0001', 'materials', 'MQ-2026-0001-call.webm')));
  const status = (code: number) => (err: { statusCode?: number }) => err.statusCode === code;
  await assert.rejects(history.audio('MQ-2026-0001', 'MQ-2026-0001-call.transcript.md'), status(415), 'only audio is played');
  await assert.rejects(history.audio('MQ-2026-0001', 'meetings.md'), status(415));
  await assert.rejects(history.audio('MQ-2026-0001', 'other.webm'), status(404), 'not a file of this meeting');
  await assert.rejects(history.audio('MQ-2026-0001', '../update.webm'), /Invalid file name/);
});

test('once only the meeting text is kept, the recording is read but no longer played', async (t) => {
  const ws = await workspace(t);
  await cleanup.update({ meetings: { keep_text: true } });
  await recordedDigest(ws, 'CU-2026-0001');
  await updates.close('CU-2026-0001');
  const { sources } = await history.detail('MQ-2026-0001');
  assert.deepEqual(sources.map((s) => [s.kind, s.readable, s.playable, s.present]), [['recording', true, false, true]], 'its transcript stays, its audio does not');
  assert.equal(await history.text('MQ-2026-0001', 'MQ-2026-0001-call.webm'), 'copy of the call');
  await assert.rejects(history.audio('MQ-2026-0001', 'MQ-2026-0001-call.webm'), (err: { statusCode?: number }) => err.statusCode === 410);
});

test('a deleted meeting\'s recording is not played, and comes back with it', async (t) => {
  const ws = await workspace(t);
  await recordedDigest(ws, 'CU-2026-0001', { status: 'done', applied_at: '2026-10-28T10:00:00.000Z', keep_materials: true });
  await history.remove('MQ-2026-0001');
  assert.equal((await history.detail('MQ-2026-0001')).sources[0]!.playable, false);
  await assert.rejects(history.audio('MQ-2026-0001', 'MQ-2026-0001-call.webm'), (err: { statusCode?: number }) => err.statusCode === 410);
  await history.restore('MQ-2026-0001');
  assert.equal((await history.detail('MQ-2026-0001')).sources[0]!.playable, true);
  assert.ok(await history.audio('MQ-2026-0001', 'MQ-2026-0001-call.webm'));
});

/** A short PCM WAV file of silence, which every computer can transcribe. */
function wav(seconds = 1): Buffer {
  const rate = 16000;
  const data = Buffer.alloc(rate * 2 * seconds);
  const head = Buffer.alloc(44);
  head.write('RIFF', 0); head.writeUInt32LE(36 + data.length, 4); head.write('WAVE', 8); head.write('fmt ', 12);
  head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22); head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * 2, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34); head.write('data', 36); head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

test('a queued meeting\'s recording can be played before any digest, but not while it is being recorded', async (t) => {
  await workspace(t);
  const queue = new MeetingDigestService();
  const m = await queue.createMeeting({ title: 'Weekly sync', meeting_date: '2026-10-28' });
  await queue.addFile(m.id, 'call.wav', wav());
  await queue.addFile(m.id, 'notes.md', Buffer.from('Fictional notes'));
  assert.match(await history.audio(m.id, 'call.wav'), /call\.wav$/);
  await assert.rejects(history.audio(m.id, 'notes.md'), (err: { statusCode?: number }) => err.statusCode === 415);
  await assert.rejects(history.audio(m.id, 'other.wav'), /No such recording in this meeting/);
  // The file a live recording writes is refused until it is finished, also under a name a listed file has.
  const manifest = path.join(await queue.meetingFolder(m.id), 'meeting.md');
  const { data, content } = parseMarkdown(await fsp.readFile(manifest, 'utf8'));
  await fsp.writeFile(manifest, stringifyMarkdown(content, { ...data, live_recording: { generation: '00000000-0000-4000-8000-000000000001', token_sha256: 'x'.repeat(64), state: 'recording', started_at: '2026-10-28T09:00:00.000Z', name: 'call.wav' } }));
  await assert.rejects(history.audio(m.id, 'call.wav'), (err: { statusCode?: number }) => err.statusCode === 409);
});

test('without the user\'s choice, a reviewed update deletes its materials as before', async (t) => {
  const ws = await workspace(t);
  await digest(ws, 'CU-2026-0001', [record('M-01', { meeting: 'MQ-2026-0001' })]);
  const done = await updates.close('CU-2026-0001');
  assert.equal(done.keep_meeting_text, false);
  await assert.rejects(fsp.access(path.join(ws, 'context-updates', 'CU-2026-0001', 'materials')));
});

test('with meeting text kept, a reviewed update keeps only its meetings\' transcripts and notes', async (t) => {
  const ws = await workspace(t);
  await cleanup.update({ meetings: { keep_text: true } });
  await digest(ws, 'CU-2026-0001', [record('M-01', { meeting: 'MQ-2026-0001' })]);
  const done = await updates.close('CU-2026-0001');
  assert.equal(done.keep_meeting_text, true, 'said in update.md, so the apply command leaves materials/ alone');
  // Each meeting's text left the update for its own folder; the photo and meetings.md went as before.
  await assert.rejects(fsp.access(path.join(ws, 'context-updates', 'CU-2026-0001', 'materials')));
  assert.deepEqual((await fsp.readdir(path.join(ws, 'meetings', 'MQ-2026-0001', 'v1'))).sort(), ['MQ-2026-0001-a.transcript.md', 'MQ-2026-0001-a.vtt']);
  assert.deepEqual((await fsp.readdir(path.join(ws, 'meetings', 'MQ-2026-0002', 'v1'))).sort(), ['MQ-2026-0002-b.transcript.md', 'MQ-2026-0002-b.vtt'], 'no photo, no meetings.md');
  // An approved update says so before the apply command runs.
  await digest(ws, 'CU-2026-0002', [record('M-01', { meeting: 'MQ-2026-0001', confirmation: null })], { proposals: [{ id: 'P-01', action: 'update', target: 'context/company/x/note.md', title: 'x', decision: 'accepted' }] });
  const approved = await updates.approve('CU-2026-0002');
  assert.equal(approved.keep_meeting_text, true);
});

test('one meeting is deleted to the trash, restored, and deleted for good; its record stays', async (t) => {
  const ws = await workspace(t);
  await cleanup.update({ meetings: { keep_text: true } });
  await digest(ws, 'CU-2026-0001', [record('M-01', { meeting: 'MQ-2026-0001' })]);
  await assert.rejects(history.remove('MQ-2026-0001'), (err: { statusCode?: number }) => err.statusCode === 409, 'not before the review is done');
  await updates.close('CU-2026-0001');
  const materials = path.join(ws, 'meetings', 'MQ-2026-0001', 'v1');

  await history.remove('MQ-2026-0001');
  assert.equal(await fsp.access(materials).then(() => true, () => false), false, 'its whole folder went');
  assert.deepEqual((await fsp.readdir(path.join(ws, 'meetings', 'MQ-2026-0002', 'v1'))).sort(), ['MQ-2026-0002-b.transcript.md', 'MQ-2026-0002-b.vtt'], 'the other meeting stays');
  const [entry] = await fsp.readdir(trashDir(ws));
  assert.deepEqual((await fsp.readdir(path.join(trashDir(ws), entry!, 'v1'))).sort(), ['MQ-2026-0001-a.transcript.md', 'MQ-2026-0001-a.vtt']);
  const deleted = (await history.list()).find((m) => m.id === 'MQ-2026-0001')!;
  assert.deepEqual([deleted.deleted?.in_trash, deleted.record?.id], [true, 'M-01']);
  await assert.rejects(history.text('MQ-2026-0001', 'MQ-2026-0001-a.vtt'), (err: { statusCode?: number }) => err.statusCode === 410);

  await history.restore('MQ-2026-0001');
  assert.deepEqual((await fsp.readdir(materials)).sort(), ['MQ-2026-0001-a.transcript.md', 'MQ-2026-0001-a.vtt'], 'back in its folder');
  assert.equal(await history.text('MQ-2026-0001', 'MQ-2026-0001-a.vtt'), 'copy a');
  assert.deepEqual(await fsp.readdir(trashDir(ws)), []);

  await history.remove('MQ-2026-0001');
  await history.purge('MQ-2026-0001');
  assert.deepEqual(await fsp.readdir(trashDir(ws)), []);
  const gone = (await history.list()).find((m) => m.id === 'MQ-2026-0001')!;
  assert.deepEqual([gone.deleted?.in_trash, gone.has_text], [false, false]);
  await assert.rejects(history.restore('MQ-2026-0001'), (err: { statusCode?: number }) => err.statusCode === 404);
});

test('a hand-edited deleted meeting never points restore outside the trash', async (t) => {
  const ws = await workspace(t);
  await digest(ws, 'CU-2026-0001', [record('M-01', { meeting: 'MQ-2026-0001' })], {
    status: 'done', deleted_meetings: [{ meeting: 'MQ-2026-0001', at: '2026-10-28T00:00:00Z', files: ['../update.md'], trash: '../../context-updates' }],
  });
  await assert.rejects(history.restore('MQ-2026-0001'), (err: { statusCode?: number }) => err.statusCode === 404);
  assert.ok(await fsp.stat(path.join(ws, 'context-updates', 'CU-2026-0001', 'update.md')));
});

test('the Meetings rule is on by default and counts from the later of the meeting and its import', () => {
  const defaults = defaultSettings();
  assert.deepEqual([defaults.rules.meetings.enabled, defaults.rules.meetings.older_than_days, defaults.rules.meetings.action], [true, 180, 'trash']);
  assert.equal(defaults.meetings.keep_text, null, 'nothing is kept until the user chose');
  assert.equal(parseSettings({ meetings: { keep_text: true } }).meetings.keep_text, true);
  assert.throws(() => parseSettings({ meetings: { keep_text: 'yes' } }), /keep_text/);
  assert.throws(() => parseSettings({ rules: { meetings: { action: 'archive' } } }), /rules\.meetings\.action/);
});

test('System cleanup moves old meeting text to the trash, skips kept meetings, then deletes it for good', async (t) => {
  const ws = await workspace(t);
  await cleanup.update({ meetings: { keep_text: true } });
  await digest(ws, 'CU-2026-0001', [record('M-01', { meeting: 'MQ-2026-0001' })], { created_at: '2026-01-05T00:00:00.000Z' });
  // Imported long after the meeting: its 180 days count from the import.
  await update(ws, 'CU-2026-0002', { meeting_records: [record('M-01', { meeting_date: '2025-01-01', source: 'old.vtt' })], created_at: '2026-12-01T00:00:00.000Z' }, { 'old.vtt': vtt('Kim Park', 'Old call.') });
  await updates.close('CU-2026-0001');
  await updates.close('CU-2026-0002');
  await history.keep('MQ-2026-0002', true);

  const settings = await cleanup.readSettings();
  const now = new Date('2027-05-01T12:00:00');
  const plan = await cleanup.plan(settings, now);
  assert.deepEqual(plan.items.filter((i) => i.type === 'meetings').map((i) => i.id), ['MQ-2026-0001'], 'the kept one and the recent import stay');

  // Finished context updates would otherwise remove the whole folder: it waits while meetings are kept in it.
  const all = parseSettings({ rules: { context_updates: { enabled: true, older_than_days: 1 } } }, settings);
  assert.ok(!(await cleanup.plan(all, now)).items.some((i) => i.type === 'context_updates' && i.id === 'CU-2026-0001'));

  const ran = await cleanup.runNow(now);
  assert.equal(ran.status, 'ok', ran.message);
  const after = (await history.list()).find((m) => m.id === 'MQ-2026-0001')!;
  assert.deepEqual([after.deleted?.by, after.deleted?.in_trash], ['system-cleanup', true]);

  const later = new Date(now.getTime() + (MEETING_TRASH_DAYS + 1) * 86_400_000);
  await cleanup.runNow(later);
  const purged = (await history.list()).find((m) => m.id === 'MQ-2026-0001')!;
  assert.equal(purged.deleted?.in_trash, false);
  const raw = parseMarkdown(await fsp.readFile(path.join(ws, 'context-updates', 'CU-2026-0001', 'update.md'), 'utf-8')).data as Record<string, unknown>;
  assert.ok(Array.isArray(raw['meeting_records']) && (raw['meeting_records'] as unknown[]).length === 1, 'the record stays');
});
