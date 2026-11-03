import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import { ContextUpdateService, finishReceipt, withCorrectionsLock } from '../src/services/contextUpdateService';
import { MeetingHistoryService } from '../src/services/meetingHistoryService';
import { startCorrection, startFollowUp } from '../src/services/meetingCorrectionService';
import { audioTranscriptMarkdown } from '../src/services/meetingTranscription';
import { chooseVersion, writeCorrectedVersion } from '../src/services/meetingVersions';
import { readFolder, type FolderManifest } from '../src/services/meetingFolder';
import { numberedTurns } from '../src/services/correctionTranscript';
import { parseMarkdown, stringifyMarkdown } from '../src/utils/markdown';
import { lock, unlock } from '../src/utils/fileLock';

async function workspace(t: { after: (fn: () => Promise<void> | void) => void }): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-correction-words-'));
  const previous = process.env.ESB_WORKSPACE_PATH;
  process.env.ESB_WORKSPACE_PATH = dir;
  t.after(async () => {
    if (previous === undefined) delete process.env.ESB_WORKSPACE_PATH; else process.env.ESB_WORKSPACE_PATH = previous;
    await fsp.rm(dir, { recursive: true, force: true });
  });
  for (const d of ['tasks/active', 'tasks/archive', 'context-updates', '.situation-board/routines', '.situation-board/trash']) await fsp.mkdir(path.join(dir, d), { recursive: true });
  return dir;
}

const service = new ContextUpdateService();
const history = new MeetingHistoryService();
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const MEETING = 'MQ-2026-0003';
const COPY = 'MQ-2026-0003-call.transcript.md';
const WAV = 'RIFF fictional audio';
/** A fictional recorded call: two turns, with a misheard name in each. */
const FIRST = audioTranscriptMarkdown('call.wav', sha(WAV), 'whisper-large-v3', 'auto', 10, [
  { start: 0, end: 3, text: 'We call Dual Line on Monday.' },
  { start: 4, end: 7, text: 'Dual Line, then the budget with Jon.' },
], true);

async function change(ws: string, id: string, fn: (d: Record<string, unknown>) => void): Promise<void> {
  const file = path.join(ws, 'context-updates', id, 'update.md');
  const parsed = parseMarkdown(await fsp.readFile(file, 'utf-8'));
  fn(parsed.data);
  await fsp.writeFile(file, stringifyMarkdown(parsed.content, parsed.data));
}

const manifest = async (ws: string): Promise<FolderManifest> => {
  const f = await readFolder(ws, MEETING);
  assert.equal(f.state, 'ok');
  return (f as Extract<typeof f, { state: 'ok' }>).manifest;
};

/** A recorded meeting reviewed with Keep recordings on and its record confirmed: its text in its own folder, as v1. */
async function reviewed(ws: string): Promise<void> {
  const id = 'CU-2026-0001';
  const dir = path.join(ws, 'context-updates', id);
  const files: Record<string, string> = { 'MQ-2026-0003-call.wav': WAV, [COPY]: FIRST };
  await fsp.mkdir(path.join(dir, 'materials'), { recursive: true });
  for (const [name, content] of Object.entries(files)) await fsp.writeFile(path.join(dir, 'materials', name), content);
  await fsp.writeFile(path.join(dir, 'update.md'), stringifyMarkdown('', {
    schema_version: '1.0', id, type: 'context-update', title: 'Fictional digest', status: 'in_review', source_date: '2026-10-27',
    created_at: '2026-10-27T18:00:00.000Z', updated_at: '2026-10-28T09:00:00.000Z', origin: 'meetings', kind: 'daily-digest', keep_recordings: true,
    materials: Object.keys(files).map((name) => ({ name, size: 1, type: 'text/plain' })),
    digest_meetings: [{
      id: MEETING, title: 'Recorded call', meeting_date: '2026-10-27',
      files: [{ source: 'call.wav', file: 'MQ-2026-0003-call.wav', sha256: sha(WAV) }],
      recordings: [{ source: 'call.wav', source_sha256: sha(WAV), transcript: COPY, transcript_sha256: sha(FIRST), complete: true, file: 'MQ-2026-0003-call.wav' }],
    }],
    transcripts: [{ file: COPY, source: 'MQ-2026-0003-call.wav', source_sha256: sha(WAV), sha256: sha(FIRST), complete: true, kind: 'audio' }],
    meeting_records: [{
      id: 'M-01', title: 'Recorded call', meeting_date: '2026-10-27', meeting: MEETING, source: COPY, attendees: [{ name: 'Jane Doe' }],
      decisions: ['Call Dual Lane on Monday'], open_questions: [], action_items: [], speakers: [],
    }],
  }));
  await service.saveMeetingRecords(id, { 'M-01': { confirmation: 'confirmed', revision: (await service.get(id)).meeting_records[0]!.revision } });
  await service.approve(id);
}

type Change = { file: string; turn: number; before: string; after: string; reason: string; sure: boolean };
const word = (turn: number, before: string, after: string, sure = true): Change => ({ file: COPY, turn, before, after, reason: 'The carrier in the glossary.', sure });

/** What an analysis writes into a correction: the target unchanged, plus `transcript_changes`. */
async function analyzed(ws: string, id: string, changes: Change[]): Promise<void> {
  const env = (await service.get(id)).correction!;
  const base = (await service.get(env.base.update_id)).meeting_records.find((r) => r.id === env.base.record_id)!;
  const record = {
    id: base.id, title: base.title, meeting_date: base.meeting_date, meeting: env.meeting, source: base.source, amends: env.base,
    attendees: base.attendees, decisions: base.decisions, open_questions: [], action_items: [], speakers: [], corrections: [], transcript_changes: changes,
  };
  await change(ws, id, (d) => { d['status'] = 'in_review'; d['analyzed_at'] = new Date().toISOString(); d['meeting_records'] = [record]; });
}

const revision = async (id: string) => (await service.get(id)).meeting_records[0]!.revision;
const confirm = async (id: string) => service.saveMeetingRecords(id, { 'M-01': { confirmation: 'confirmed', revision: await revision(id) } });
const turnLines = async (ws: string, version: string) => (await fsp.readFile(path.join(ws, 'meetings', MEETING, version, COPY), 'utf-8')).split('\n').filter((l) => l.startsWith('  '));

test('a correction pins the current version and gives each transcript with its turns numbered', async (t) => {
  const ws = await workspace(t);
  await reviewed(ws);
  const started = await startCorrection(MEETING);
  assert.deepEqual(started.correction!.sources.map((s) => s.path), [`meetings/${MEETING}/v1/${COPY}`]);
  const view = await fsp.readFile(path.join(ws, 'context-updates', started.id, 'materials', `turns-${COPY}`), 'utf-8');
  assert.match(view, /^#1 \[00:00:00 → 00:00:03\]/m);
  assert.match(view, /^#2 \[00:00:04 → 00:00:07\]/m);
  assert.match(view, new RegExp(`meetings/${MEETING}/v1/${COPY.replace(/\./g, '\\.')}`));
  // A copy made before numbering gets its numbers; one with them stays as it is.
  const old = FIRST.replace(/^#\d+ /gm, '');
  assert.equal(numberedTurns(old), FIRST);
  assert.equal(numberedTurns(FIRST), FIRST);
  assert.equal(numberedTurns('# Notes\n\nNo turns here.'), null);
});

test('approving writes the words that count as a new version, and the follow-up lists them', async (t) => {
  const ws = await workspace(t);
  await reviewed(ws);
  const c = await startCorrection(MEETING);
  await analyzed(ws, c.id, [word(1, 'Dual Line', 'Dual Lane'), word(2, 'Jon', 'John', false)]);
  const review = (await service.get(c.id)).correction_review!;
  assert.deepEqual(review.blocked, []);
  assert.equal(review.transcript?.base, 'v1');
  assert.deepEqual(review.transcript?.changes.map((x) => [x.turn, x.time, x.line_before, x.line_after, x.used, x.problem]), [
    [1, '00:00:00', 'We call Dual Line on Monday.', 'We call Dual Lane on Monday.', false, null],
    [2, '00:00:04', 'Dual Line, then the budget with Jon.', 'Dual Line, then the budget with John.', false, null],
  ]);
  await confirm(c.id);
  const done = await service.approve(c.id);
  assert.equal(done.status, 'done');
  assert.equal(done.finishing, null);
  assert.deepEqual(done.transcript_version, { from: 'v1', to: 'v2', changes: [{ file: COPY, turn: 1, before: 'Dual Line', after: 'Dual Lane' }] }, 'the unused suggestion is never applied');
  const m = await manifest(ws);
  assert.deepEqual(m.versions.map((v) => [v.id, v.made_from, v.correction ?? null]), [['v1', 'review', null], ['v2', 'correction', c.id]]);
  assert.deepEqual(await turnLines(ws, 'v2'), ['  We call Dual Lane on Monday.', '  Dual Line, then the budget with Jon.']);
  assert.deepEqual(await turnLines(ws, 'v1'), ['  We call Dual Line on Monday.', '  Dual Line, then the budget with Jon.'], 'the version corrected stays');
  // Done: only what was applied, and the version it made.
  const after = (await service.get(c.id)).correction_review!;
  assert.deepEqual([after.transcript?.made, after.transcript?.changes.map((x) => x.after)], [{ from: 'v1', to: 'v2' }, ['Dual Lane']]);

  // The record did not change, yet the meeting can be followed up for the words.
  assert.equal((await history.detail(MEETING)).meeting.correction?.head_changed, true);
  const follow = await startFollowUp(c.id);
  const material = await fsp.readFile(path.join(ws, 'context-updates', follow.id, 'materials', 'corrections.md'), 'utf-8');
  assert.match(material, /Words corrected in the transcript \(v1 to v2\)/);
  assert.match(material, /MQ-2026-0003-call\.transcript\.md, turn 1: "Dual Line" to "Dual Lane"/);
});

test('a suggestion is used only when it stands with the changes that count; undo takes it back', async (t) => {
  const ws = await workspace(t);
  await reviewed(ws);
  const c = await startCorrection(MEETING);
  await analyzed(ws, c.id, [word(1, 'Dual Line', 'Dual Lane'), word(1, 'Line on', 'Lane on', false), word(2, 'Jon', 'John', false)]);
  const use = async (index: number, used = true) => service.useTranscriptSuggestion(c.id, 'M-01', index, { revision: await revision(c.id), use: used });
  const views = async () => (await service.get(c.id)).correction_review!.transcript!.changes;
  assert.match((await views())[1]!.problem ?? '', /touches the same text/, 'overlaps a sure change: shown before it is tried');
  await assert.rejects(use(1), /touches the same text/);
  await assert.rejects(use(0), /Only a change marked not sure/);
  await use(2);
  assert.deepEqual((await views()).map((x) => x.used), [false, false, true]);
  await assert.rejects(use(2), /already used/);
  assert.equal((await service.get(c.id)).meeting_records[0]!.confirmation, null, 'using a suggestion needs a new confirmation');
  await use(2, false);
  await use(2);
  await confirm(c.id);
  const done = await service.approve(c.id);
  assert.deepEqual(done.transcript_version?.changes.map((x) => x.after), ['Dual Lane', 'John']);
  await assert.rejects(use(2, false), /while the update is "done"/);
});

test('a sure change that does not stand, or a version changed since the start, stops the finish', async (t) => {
  const ws = await workspace(t);
  await reviewed(ws);
  const c = await startCorrection(MEETING);
  await analyzed(ws, c.id, [word(1, 'Dual Line', 'Dual Lane'), word(1, 'Line', 'Lane')]);
  await confirm(c.id);
  assert.ok((await service.get(c.id)).correction_review!.blocked.some((b) => /touches the same text/.test(b)));
  await assert.rejects(service.approve(c.id), /touches the same text/);
  await analyzed(ws, c.id, [word(2, 'Monday', 'Tuesday')]);
  await confirm(c.id);
  await assert.rejects(service.approve(c.id), /does not stand exactly once in turn 2/);

  await analyzed(ws, c.id, [word(1, 'Dual Line', 'Dual Lane')]);
  await confirm(c.id);
  // Another version became current meanwhile (here one written by another correction).
  await writeCorrectedVersion(ws, MEETING, { from_version: 'v1', correction: 'CU-2026-0099', changes: [{ file: COPY, turn: 2, before: 'Jon', after: 'John' }], receipt: sha('another') });
  await chooseVersion(ws, MEETING, 'v2');
  await assert.rejects(service.approve(c.id), /v2 is in use now, not v1/);
  assert.equal((await manifest(ws)).versions.length, 2, 'nothing written');
});

test('a correction of a meeting kept before folders can still correct its record, never its transcript', async (t) => {
  const ws = await workspace(t);
  await reviewed(ws);
  const c = await startCorrection(MEETING);
  await change(ws, c.id, (d) => {
    const env = d['correction'] as { sources: { path: string }[] };
    env.sources = env.sources.map((s) => ({ ...s, path: `context-updates/CU-2026-0001/materials/${COPY}` }));
  });
  await analyzed(ws, c.id, [word(1, 'Dual Line', 'Dual Lane', false)]);
  const views = (await service.get(c.id)).correction_review!.transcript!;
  assert.match(views.problem ?? '', /only the record can be corrected/);
  await assert.rejects(service.useTranscriptSuggestion(c.id, 'M-01', 0, { revision: await revision(c.id), use: true }), /only the record can be corrected/);
  await confirm(c.id);
  const done = await service.approve(c.id);
  assert.deepEqual([done.status, done.transcript_version], ['done', null], 'an unused suggestion never stops the record');
});

test('an interrupted finish: approving again completes exactly it, and nothing else changes the correction until then', async (t) => {
  const ws = await workspace(t);
  await reviewed(ws);
  const c = await startCorrection(MEETING);
  await analyzed(ws, c.id, [word(1, 'Dual Line', 'Dual Lane')]);
  await confirm(c.id);
  const rev = await revision(c.id);
  const changes = [{ file: COPY, turn: 1, before: 'Dual Line', after: 'Dual Lane' }];
  const finishing = { receipt: finishReceipt(c.id, rev, 'v1', changes), from_version: 'v1', revision: rev, changes };
  // Stopped after `finishing` was kept and the version written, before done; then the user went back to v1.
  await change(ws, c.id, (d) => { d['finishing'] = finishing; });
  await writeCorrectedVersion(ws, MEETING, { from_version: 'v1', correction: c.id, changes, receipt: finishing.receipt });
  await chooseVersion(ws, MEETING, 'v1');

  assert.equal((await service.get(c.id)).correction_review!.finishing, true);
  const refused = /approve it again to finish/;
  await assert.rejects(service.saveMeetingRecords(c.id, { 'M-01': { confirmation: null, revision: rev } }), refused);
  await assert.rejects(service.useTranscriptSuggestion(c.id, 'M-01', 0, { revision: rev, use: true }), refused);
  // Its version is part of the meeting now, even with v1 in use: it can only be finished.
  await assert.rejects(service.close(c.id), /already wrote v2 of the meeting's text: approve it to finish/);
  await assert.rejects(service.reopen(c.id), /already wrote v2/);
  await assert.rejects(service.remove(c.id), /already wrote v2/);

  const done = await service.approve(c.id);
  assert.deepEqual([done.status, done.finishing, done.transcript_version?.to], ['done', null, 'v2']);
  const m = await manifest(ws);
  assert.deepEqual([m.versions.map((v) => v.id), m.current], [['v1', 'v2'], 'v1'], 'no second version; the user\'s choice stays');
  assert.equal((await service.approve(c.id)).status, 'done', 'approving a finished one again changes nothing');
  assert.equal((await manifest(ws)).versions.length, 2);
});

test('an interrupted finish before the version: approving again writes it once; a refusal clears the finish', async (t) => {
  const ws = await workspace(t);
  await reviewed(ws);
  const c = await startCorrection(MEETING);
  await analyzed(ws, c.id, [word(1, 'Dual Line', 'Dual Lane')]);
  await confirm(c.id);
  const rev = await revision(c.id);
  const changes = [{ file: COPY, turn: 1, before: 'Dual Line', after: 'Dual Lane' }];
  await change(ws, c.id, (d) => { d['finishing'] = { receipt: finishReceipt(c.id, rev, 'v1', changes), from_version: 'v1', revision: rev, changes }; });
  // The pinned text changed on disk meanwhile: the writer refuses, nothing exists, so the correction is in review again.
  const copy = path.join(ws, 'meetings', MEETING, 'v1', COPY);
  await fsp.writeFile(copy, FIRST.replace('Monday', 'Friday'));
  await assert.rejects(service.approve(c.id), /changed since it was kept/);
  const back = await service.get(c.id);
  assert.deepEqual([back.status, back.finishing], ['in_review', null]);
  await fsp.writeFile(copy, FIRST);

  const results = await Promise.allSettled([service.approve(c.id), service.approve(c.id)]);
  assert.ok(results.some((r) => r.status === 'fulfilled'));
  assert.equal((await service.get(c.id)).status, 'done');
  assert.deepEqual((await manifest(ws)).versions.map((v) => v.id), ['v1', 'v2'], 'one version, however many approvals');
});

test('a finish that cannot be read refuses, and a record changed while finishing is never finished', async (t) => {
  const ws = await workspace(t);
  await reviewed(ws);
  const c = await startCorrection(MEETING);
  await analyzed(ws, c.id, [word(1, 'Dual Line', 'Dual Lane')]);
  await confirm(c.id);
  await change(ws, c.id, (d) => { d['finishing'] = { receipt: 'not a hash' }; });
  await assert.rejects(service.approve(c.id), /cannot be read/);
  await change(ws, c.id, (d) => { d['finishing'] = { receipt: 'a'.repeat(64), from_version: 'v1', revision: '0'.repeat(16), changes: [{ file: COPY, turn: 1, before: 'Dual Line', after: 'Dual Lane' }] }; });
  await assert.rejects(service.approve(c.id), /changed while it was being finished/);
  assert.equal((await manifest(ws)).versions.length, 1);
});

test('only a correction carries transcript changes, and they bind the record\'s revision', async (t) => {
  const ws = await workspace(t);
  await reviewed(ws);
  const c = await startCorrection(MEETING);
  await analyzed(ws, c.id, []);
  const without = await revision(c.id);
  await analyzed(ws, c.id, [word(1, 'Dual Line', 'Dual Lane')]);
  const withOne = await revision(c.id);
  assert.notEqual(without, withOne);
  await analyzed(ws, c.id, [word(1, 'Dual Line', 'Dual Lane', false)]);
  assert.notEqual(await revision(c.id), withOne, 'sure is part of it');
  // Bad entries are problems, never repaired.
  await analyzed(ws, c.id, [{ ...word(1, 'Dual Line', 'Dual Line') }]);
  assert.match((await service.get(c.id)).meeting_records[0]!.problems.join(' '), /same as the old/);
  await change(ws, 'CU-2026-0001', (d) => { ((d['meeting_records'] as Record<string, unknown>[])[0]!)['transcript_changes'] = [word(1, 'Dual Line', 'Dual Lane')]; });
  assert.match((await service.get('CU-2026-0001')).meeting_records[0]!.problems.join(' '), /only a correction/);
});

test('a version this correction wrote from other changes keeps the finish, and the correction is never given up', async (t) => {
  const ws = await workspace(t);
  await reviewed(ws);
  const c = await startCorrection(MEETING);
  await analyzed(ws, c.id, [word(1, 'Dual Line', 'Dual Lane')]);
  await confirm(c.id);
  const rev = await revision(c.id);
  const changes = [{ file: COPY, turn: 1, before: 'Dual Line', after: 'Dual Lane' }];
  await change(ws, c.id, (d) => { d['finishing'] = { receipt: finishReceipt(c.id, rev, 'v1', changes), from_version: 'v1', revision: rev, changes }; });
  // Written for this correction, but from something else: only files changed by hand get here.
  await writeCorrectedVersion(ws, MEETING, { from_version: 'v1', correction: c.id, changes: [{ file: COPY, turn: 2, before: 'Jon', after: 'John' }], receipt: sha('other') });
  await assert.rejects(service.approve(c.id), /from other changes than these, so it cannot be finished/);
  assert.equal((await service.get(c.id)).finish_pending, true, 'never taken for "nothing was written"');
  await chooseVersion(ws, MEETING, 'v1');
  await assert.rejects(service.close(c.id), /already wrote v2/, 'not even once the meeting uses another version: v2 could be chosen again');
});

test('a writer that fails before it looks (a busy or damaged folder) keeps the finish', async (t) => {
  const ws = await workspace(t);
  await reviewed(ws);
  const c = await startCorrection(MEETING);
  await analyzed(ws, c.id, [word(1, 'Dual Line', 'Dual Lane')]);
  await confirm(c.id);
  const rev = await revision(c.id);
  const changes = [{ file: COPY, turn: 1, before: 'Dual Line', after: 'Dual Lane' }];
  const receipt = finishReceipt(c.id, rev, 'v1', changes);
  await change(ws, c.id, (d) => { d['finishing'] = { receipt, from_version: 'v1', revision: rev, changes }; });
  await writeCorrectedVersion(ws, MEETING, { from_version: 'v1', correction: c.id, changes, receipt });
  // Another dashboard holds the meeting's folder lock past the wait.
  const held = await lock(path.join(ws, 'meetings', `.${MEETING}.lock`), 1000, () => new Error('busy'));
  try {
    await assert.rejects(service.approve(c.id), (err: { statusCode?: number }) => err.statusCode === 409);
  } finally {
    await unlock(held);
  }
  assert.equal((await service.get(c.id)).finish_pending, true);
  await assert.rejects(service.close(c.id), /already wrote v2/);
  // A damaged meeting.json: nothing can be known, so nothing is given up.
  const file = path.join(ws, 'meetings', MEETING, 'meeting.json');
  const good = await fsp.readFile(file, 'utf-8');
  await fsp.writeFile(file, '{ not json');
  await assert.rejects(service.approve(c.id));
  assert.equal((await service.get(c.id)).finish_pending, true);
  await assert.rejects(service.close(c.id), /cannot be read now/);
  await fsp.writeFile(file, good);
  const done = await service.approve(c.id);
  assert.deepEqual([done.status, done.transcript_version?.to], ['done', 'v2']);
});

test('a finish that cannot be read is shown, and the correction can be closed when nothing was written', async (t) => {
  const ws = await workspace(t);
  await reviewed(ws);
  const c = await startCorrection(MEETING);
  await analyzed(ws, c.id, [word(1, 'Dual Line', 'Dual Lane')]);
  await confirm(c.id);
  await change(ws, c.id, (d) => { d['finishing'] = { receipt: 'not a hash' }; });
  const review = (await service.get(c.id)).correction_review!;
  assert.deepEqual([review.finishing, review.blocked], [true, []], 'shown as interrupted, Approve not blocked');
  await assert.rejects(service.approve(c.id), /cannot be read: close it/);
  await assert.rejects(service.useTranscriptSuggestion(c.id, 'M-01', 0, { revision: await revision(c.id), use: false }), /approve it again to finish, or close it/);
  const reopened = await service.reopen(c.id);
  assert.deepEqual([reopened.status, reopened.finish_pending], ['ready', false]);
});

test('a pinned file changed on disk is shown on the change; the review still loads, also while finishing', async (t) => {
  const ws = await workspace(t);
  await reviewed(ws);
  const c = await startCorrection(MEETING);
  await analyzed(ws, c.id, [word(1, 'Dual Line', 'Dual Lane')]);
  await confirm(c.id);
  const copy = path.join(ws, 'meetings', MEETING, 'v1', COPY);
  // The same turn text, another byte elsewhere: the copy no longer matches its version.
  await fsp.writeFile(copy, FIRST + '\n');
  const review = (await service.get(c.id)).correction_review!;
  assert.match(review.transcript!.changes[0]!.problem ?? '', /changed since it was kept/);
  assert.ok(review.blocked.some((b) => /changed since it was kept/.test(b)));
  const rev = await revision(c.id);
  const changes = [{ file: COPY, turn: 1, before: 'Dual Line', after: 'Dual Lane' }];
  await change(ws, c.id, (d) => { d['finishing'] = { receipt: finishReceipt(c.id, rev, 'v1', changes), from_version: 'v1', revision: rev, changes }; });
  const pending = (await service.get(c.id)).correction_review!;
  assert.deepEqual([pending.finishing, pending.blocked, pending.transcript!.changes[0]!.problem], [true, [], null]);
});

test('every change to a correction waits for the corrections lock, as a finish in another dashboard holds it', async (t) => {
  const ws = await workspace(t);
  await reviewed(ws);
  const c = await startCorrection(MEETING);
  await analyzed(ws, c.id, [word(1, 'Dual Line', 'Dual Lane')]);
  let settled = false;
  let waiting: Promise<unknown> = Promise.resolve();
  await withCorrectionsLock(async () => {
    waiting = service.keepMaterials(c.id, true).finally(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(settled, false, 'keeping materials waits');
  });
  await waiting;
  assert.equal((await service.get(c.id)).keep_materials, true);
});

test('a meeting\'s text is not deleted while a correction of it is being finished', async (t) => {
  const ws = await workspace(t);
  await reviewed(ws);
  const c = await startCorrection(MEETING);
  await analyzed(ws, c.id, [word(1, 'Dual Line', 'Dual Lane')]);
  await confirm(c.id);
  await change(ws, c.id, (d) => { d['finishing'] = { receipt: 'a'.repeat(64) }; });
  await assert.rejects(history.remove(MEETING), new RegExp(`${c.id}, a correction of this meeting, is being finished`));
  assert.equal((await readFolder(ws, MEETING)).state, 'ok');
});
