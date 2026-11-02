import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import { ContextUpdateService } from '../src/services/contextUpdateService';
import { MeetingHistoryService } from '../src/services/meetingHistoryService';
import { startCorrection } from '../src/services/meetingCorrectionService';
import { recordDiff } from '../src/services/meetingCorrections';
import type { MeetingRecord } from '../src/services/contextUpdateService';
import { stringifyMarkdown, parseMarkdown } from '../src/utils/markdown';

async function workspace(t: { after: (fn: () => Promise<void> | void) => void }): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-correction-flow-'));
  const previous = process.env.ESB_WORKSPACE_PATH;
  process.env.ESB_WORKSPACE_PATH = dir;
  t.after(async () => {
    if (previous === undefined) delete process.env.ESB_WORKSPACE_PATH; else process.env.ESB_WORKSPACE_PATH = previous;
    await fsp.rm(dir, { recursive: true, force: true });
  });
  for (const d of ['tasks/active', 'tasks/archive', 'context-updates', '.situation-board/routines']) await fsp.mkdir(path.join(dir, d), { recursive: true });
  return dir;
}

const service = new ContextUpdateService();
const history = new MeetingHistoryService();
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const transcript = 'WEBVTT\n\n00:00:01.000 --> 00:00:04.000\n<v Speaker 1>Ask Dual Line for a quote.</v>\n';

async function change(ws: string, id: string, fn: (d: Record<string, unknown>) => void): Promise<void> {
  const file = path.join(ws, 'context-updates', id, 'update.md');
  const parsed = parseMarkdown(await fsp.readFile(file, 'utf-8'));
  fn(parsed.data);
  await fsp.writeFile(file, stringifyMarkdown(parsed.content, parsed.data));
}

/** A finished digest of one meeting with a confirmed record (and its speaker evidence), as a review leaves it. */
async function reviewedMeeting(ws: string, status = 'done'): Promise<void> {
  const dir = path.join(ws, 'context-updates', 'CU-2026-0001');
  await fsp.mkdir(path.join(dir, 'materials'), { recursive: true });
  await fsp.writeFile(path.join(dir, 'materials', 'MQ-2026-0001-a.vtt'), transcript);
  await fsp.writeFile(path.join(dir, 'update.md'), stringifyMarkdown('', {
    schema_version: '1.0', id: 'CU-2026-0001', type: 'context-update', title: 'Fictional digest', status, source_date: '2026-10-27',
    created_at: '2026-10-27T18:00:00.000Z', updated_at: '2026-10-28T09:00:00.000Z', applied_at: '2026-10-28T09:00:00.000Z',
    origin: 'meetings', kind: 'daily-digest', keep_meeting_text: true,
    materials: [{ name: 'MQ-2026-0001-a.vtt', size: transcript.length, type: 'vtt' }],
    digest_meetings: [{ id: 'MQ-2026-0001', title: 'Weekly sync', meeting_date: '2026-10-27', files: [{ source: 'a.vtt', file: 'MQ-2026-0001-a.vtt', sha256: sha(transcript) }] }],
    meeting_records: [{
      id: 'M-01', title: 'Weekly sync', meeting_date: '2026-10-27', meeting: 'MQ-2026-0001', source: 'MQ-2026-0001-a.vtt',
      attendees: [{ name: 'Jane Doe' }], decisions: ['Ask Dual Line for a quote'], open_questions: [],
      action_items: [{ description: 'Call Dual Line', owner: { name: 'Jane Doe' } }],
      speakers: [{ label: 'Speaker 1', source: 'MQ-2026-0001-a.vtt', person: { name: 'Jane Doe' }, reason: 'Named in the call.' }],
      confirmation: 'confirmed', speakers_evidence: { 'MQ-2026-0001-a.vtt': sha(transcript) },
    }],
  }));
  const revision = (await service.get('CU-2026-0001')).meeting_records[0]!.revision;
  await change(ws, 'CU-2026-0001', (d) => { (d['meeting_records'] as Record<string, unknown>[])[0]!['confirmed_hash'] = revision; });
}

/**
 * What an analysis writes into a correction: the target with its changes, and why. `edit` changes the record before it
 * is written (the corrected values), `extra` anything else on the update.
 */
async function analyzed(ws: string, id: string, edit: (r: Record<string, unknown>) => void = () => {}, extra: Record<string, unknown> = {}): Promise<void> {
  const update = await service.get(id);
  const env = update.correction!;
  const base = (await service.get(env.base.update_id)).meeting_records.find((r) => r.id === env.base.record_id)!;
  const record: Record<string, unknown> = {
    id: base.id, title: base.title, meeting_date: base.meeting_date, meeting: env.meeting, source: base.source, amends: env.base,
    attendees: base.attendees, decisions: base.decisions.map((d) => d.replace('Dual Line', 'Dual Lane')), open_questions: base.open_questions,
    action_items: base.action_items.map((a, i) => ({ description: a.description.replace('Dual Line', 'Dual Lane'), owner: a.owner, due_date: a.due_date, slot: env.slots[i]!.slot })),
    speakers: base.speakers,
    corrections: [{ field: 'decisions', before: 'Ask Dual Line for a quote', after: 'Ask Dual Lane for a quote', reason: 'Dual Lane is the carrier in the glossary.', sure: true }],
  };
  edit(record);
  await change(ws, id, (d) => { d['status'] = 'in_review'; d['analyzed_at'] = new Date().toISOString(); d['meeting_records'] = [record]; Object.assign(d, extra); });
}

const confirm = async (id: string) => service.saveMeetingRecords(id, { 'M-01': { confirmation: 'confirmed', revision: (await service.get(id)).meeting_records[0]!.revision } });

test('starting a correction: only from a final confirmed record, one open at a time, with its slots and its pinned sources', async (t) => {
  const ws = await workspace(t);
  await reviewedMeeting(ws);
  const started = await startCorrection('MQ-2026-0001');
  const env = started.correction!;
  assert.equal(started.kind, 'meeting-correction');
  assert.deepEqual([env.meeting, env.root, env.base.update_id], ['MQ-2026-0001', { update_id: 'CU-2026-0001', record_id: 'M-01' }, 'CU-2026-0001']);
  assert.equal(env.base.revision, (await service.get('CU-2026-0001')).meeting_records[0]!.revision);
  assert.deepEqual(env.slots.map((s) => [s.slot, s.root_index]), [['A-01', 0]]);
  assert.match(env.sources[0]!.path, /^context-updates\/CU-2026-0001\/materials\//);
  const materials = await fsp.readdir(path.join(ws, 'context-updates', started.id, 'materials'));
  assert.deepEqual(materials.sort(), ['correction-target.md', 'meeting-sources.md']);
  assert.match(await fsp.readFile(path.join(ws, 'context-updates', started.id, 'materials', 'correction-target.md'), 'utf-8'), /slot A-01 · Call Dual Line/);
  assert.equal((await history.list())[0]!.correction?.open[0], started.id, 'the meeting shows its open correction');

  await assert.rejects(startCorrection('MQ-2026-0001'), /already open/);
});

test('two starts at once, from two dashboards: one correction', async (t) => {
  const ws = await workspace(t);
  await reviewedMeeting(ws);
  const results = await Promise.allSettled([startCorrection('MQ-2026-0001'), startCorrection('MQ-2026-0001')]);
  assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
});

test('no correction of a record still in review', async (t) => {
  const ws = await workspace(t);
  await reviewedMeeting(ws, 'in_review');
  await assert.rejects(startCorrection('MQ-2026-0001'), (err: Error & { statusCode?: number }) => err.statusCode === 409);
});

test('analyze, confirm, approve: the meeting shows the corrected record, and the next correction starts from it', async (t) => {
  const ws = await workspace(t);
  await reviewedMeeting(ws);
  const first = await startCorrection('MQ-2026-0001');
  await analyzed(ws, first.id);
  const r = (await service.get(first.id)).meeting_records[0]!;
  assert.deepEqual([r.problems, r.corrections[0]!.after], [[], 'Ask Dual Lane for a quote']);
  // The review compares with the version corrected itself: every changed field, also one the agent did not explain.
  const review = (await service.get(first.id)).correction_review!;
  assert.equal(review.base?.id, 'M-01');
  assert.equal(review.stale, false);
  assert.deepEqual(review.changes.map((c) => [c.field, c.before, c.after]), [
    ['decisions', ['Ask Dual Line for a quote'], ['Ask Dual Lane for a quote']],
    ['action_items', ['"Call Dual Line" · owner: "Jane Doe" · due: none'], ['"Call Dual Lane" · owner: "Jane Doe" · due: none']],
  ]);
  await confirm(first.id);
  const done = await service.approve(first.id);
  assert.equal(done.status, 'done');
  const m = (await history.list())[0]!;
  assert.deepEqual([m.correction?.state, m.record_owner?.update_id], ['corrected', first.id]);
  assert.deepEqual((await history.detail('MQ-2026-0001')).record?.decisions, ['Ask Dual Lane for a quote']);

  const second = await startCorrection('MQ-2026-0001');
  assert.equal(second.correction!.base.update_id, first.id, 'from the corrected version');
  assert.deepEqual(second.correction!.slots, first.correction!.slots, 'the items keep standing for the same originals');
});

test('finishing refuses a correction that is stale, carries proposals, or is not confirmed; closing never makes it current', async (t) => {
  const ws = await workspace(t);
  await reviewedMeeting(ws);
  const a = await startCorrection('MQ-2026-0001');
  await analyzed(ws, a.id);
  await assert.rejects(service.approve(a.id), /Confirm the corrected record/);
  await confirm(a.id);

  // A second correction of the same original version, made by hand: whichever finishes second is stale.
  const b = await startCorrection('MQ-2026-0001').catch(() => null);
  assert.equal(b, null, 'one open at a time');
  await service.approve(a.id);
  const stale = await service.createCorrection({ title: 'Stale', meeting_date: '2026-10-27', notes: '', correction: a.correction!, materials: [] });
  await analyzed(ws, stale.id);
  await confirm(stale.id);
  await assert.rejects(service.approve(stale.id), /Another correction of this meeting finished first/);
  assert.equal((await service.get(stale.id)).correction_review?.stale, true, 'the review says so before approving');
  assert.equal((await service.get(a.id)).correction_review?.stale, false, 'a finished correction is never stale');

  // Proposals are refused: changes to the context go through an ordinary update.
  await change(ws, stale.id, (d) => { d['proposals'] = [{ id: 'P-01', action: 'update', target: 'context/company/x/note.md', title: 'x', rationale: 'x', decision: 'accepted' }]; });
  await assert.rejects(service.approve(stale.id), /without proposals|Another correction/);

  // Closing: the record is rejected, the meeting's current version unchanged.
  await change(ws, stale.id, (d) => { d['proposals'] = []; });
  const closed = await service.close(stale.id);
  assert.deepEqual([closed.status, closed.meeting_records[0]!.confirmation], ['done', 'rejected']);
  assert.equal((await history.list())[0]!.record_owner?.update_id, a.id);
});

test('speakers: unchanged ones keep their evidence even when the transcript is gone; a changed one needs the transcript pinned at the start, kept unchanged', async (t) => {
  const ws = await workspace(t);
  await reviewedMeeting(ws);
  const vtt = path.join(ws, 'context-updates', 'CU-2026-0001', 'materials', 'MQ-2026-0001-a.vtt');
  const evidenceOf = async (id: string) => ((parseMarkdown(await fsp.readFile(path.join(ws, 'context-updates', id, 'update.md'), 'utf-8')).data['meeting_records'] as Record<string, unknown>[])[0]!['speakers_evidence']);
  const rename = (r: Record<string, unknown>) => { r['speakers'] = [{ label: 'Speaker 1', source: 'MQ-2026-0001-a.vtt', person: { name: 'Jane Dough' }, reason: 'Spelled as in the stakeholder file.' }]; };

  // Pinned while the transcript is there: deleted or changed later, refused; kept and unchanged, the speaker changes.
  const renamed = await startCorrection('MQ-2026-0001');
  await analyzed(ws, renamed.id, rename);
  await confirm(renamed.id);
  await fsp.rm(vtt);
  await assert.rejects(service.approve(renamed.id), /started with, kept unchanged/, 'the transcript is gone');
  await fsp.writeFile(vtt, transcript.replace('Ask', 'Please ask'));
  await assert.rejects(service.approve(renamed.id), /started with, kept unchanged/, 'the transcript changed');
  await fsp.writeFile(vtt, transcript);
  assert.equal((await service.approve(renamed.id)).status, 'done', 'kept and unchanged: the speaker can be corrected');
  assert.deepEqual(await evidenceOf(renamed.id), { 'MQ-2026-0001-a.vtt': sha(transcript) });

  // Gone when the next one starts: an unchanged speaker keeps its evidence; a changed one is refused, even once the
  // transcript is back, because nothing was pinned for it.
  await fsp.rm(vtt);
  const unchanged = await startCorrection('MQ-2026-0001');
  await analyzed(ws, unchanged.id);
  await confirm(unchanged.id);
  await service.approve(unchanged.id);
  assert.deepEqual(await evidenceOf(unchanged.id), { 'MQ-2026-0001-a.vtt': sha(transcript) }, 'inherited as it was confirmed');
  const unpinned = await startCorrection('MQ-2026-0001');
  await analyzed(ws, unpinned.id, (r) => { r['speakers'] = [{ label: 'Speaker 1', source: 'MQ-2026-0001-a.vtt', person: { name: 'Jane Doe' }, reason: 'Back to the original.' }]; });
  await confirm(unpinned.id);
  await fsp.writeFile(vtt, transcript);
  await assert.rejects(service.approve(unpinned.id), /started with/);
});

test('the corrected record is checked against the versions themselves, not against what the correction says', async (t) => {
  const ws = await workspace(t);
  await reviewedMeeting(ws);
  const c = await startCorrection('MQ-2026-0001');
  const blockedBy = async () => (await service.get(c.id)).correction_review!.blocked;

  for (const [what, edit, problem] of [
    ['a changed source', (r: Record<string, unknown>) => { r['source'] = 'other.vtt'; }, /keep its source/],
    ['another meeting', (r: Record<string, unknown>) => { r['meeting'] = 'MQ-2026-0002'; }, /keep its meeting/],
    ['a change marked not sure but applied', (r: Record<string, unknown>) => {
      r['title'] = 'Weekly sink';
      r['corrections'] = [{ field: 'title', before: 'Weekly sync', after: 'Weekly sink', reason: 'Maybe.', sure: false }];
    }, /must stay as it was/],
  ] as const) {
    await analyzed(ws, c.id, edit);
    await confirm(c.id);
    assert.ok((await blockedBy()).some((b) => problem.test(b)), `${what}: shown before approving`);
    await assert.rejects(service.approve(c.id), problem, `${what}: refused`);
  }

  // Slots edited before confirming: both the envelope and the items, consistently, so the record itself is fine.
  await analyzed(ws, c.id);
  await change(ws, c.id, (d) => {
    ((d['correction'] as Record<string, unknown>)['slots'] as Record<string, unknown>[])[0]!['root_key'] = 'abcdefabcdef';
  });
  await confirm(c.id);
  await assert.rejects(service.approve(c.id), /no longer say which original item/);
  assert.equal((await history.list())[0]!.correction?.state ?? 'original', 'original', 'nothing was published');

  // An envelope that pins another update's material is not an envelope at all.
  await change(ws, c.id, (d) => {
    ((d['correction'] as Record<string, unknown>)['sources'] as Record<string, unknown>[])[0]!['path'] = 'context-updates/CU-2026-0009/materials/x.vtt';
  });
  assert.equal((await service.get(c.id)).correction, null);
});

test('approving again after it finished completes it; the original\'s tasks wait while its versions conflict', async (t) => {
  const ws = await workspace(t);
  await reviewedMeeting(ws);
  const a = await startCorrection('MQ-2026-0001');
  await analyzed(ws, a.id);
  await confirm(a.id);
  const first = await service.approve(a.id);
  const again = await service.approve(a.id);
  assert.deepEqual([first.status, again.status, again.meeting_records[0]!.revision], ['done', 'done', first.meeting_records[0]!.revision]);

  // A second correction of the same original version, finished by hand: a conflict.
  const b = await service.createCorrection({ title: 'Sibling', meeting_date: '2026-10-27', notes: '', correction: a.correction!, materials: [] });
  await analyzed(ws, b.id);
  await confirm(b.id);
  await change(ws, b.id, (d) => { d['status'] = 'done'; });
  assert.equal((await history.list())[0]!.correction?.state, 'conflict');
  const root = (await service.get('CU-2026-0001')).meeting_records[0]!;
  await assert.rejects(service.createActionItemTask('CU-2026-0001', 'M-01', { item: 0, revision: root.revision, task: { title: 'Call', priority: 'medium' } }), /conflict/);
});

test('explanations are part of what is confirmed, and only a correction may carry them', async (t) => {
  const ws = await workspace(t);
  await reviewedMeeting(ws);
  const c = await startCorrection('MQ-2026-0001');
  await analyzed(ws, c.id);
  await confirm(c.id);
  await change(ws, c.id, (d) => { ((d['meeting_records'] as Record<string, unknown>[])[0]!['corrections'] as Record<string, unknown>[])[0]!['reason'] = 'Something else.'; });
  assert.equal((await service.get(c.id)).meeting_records[0]!.confirmation, null);
  await change(ws, c.id, (d) => { ((d['meeting_records'] as Record<string, unknown>[])[0]!['corrections'] as Record<string, unknown>[])[0]!['sure'] = 'yes'; });
  assert.ok((await service.get(c.id)).meeting_records[0]!.problems.some((p) => p.includes('whether it is sure')));
  await change(ws, 'CU-2026-0001', (d) => { (d['meeting_records'] as Record<string, unknown>[])[0]!['corrections'] = [{ field: 'title', before: 'a', after: 'b', reason: 'x', sure: true }]; });
  assert.ok((await service.get('CU-2026-0001')).meeting_records[0]!.problems.some((p) => p.includes('only a correction')));
});

test('the diff decides on values: two items that read alike still count as changed', () => {
  const record = (items: MeetingRecord['action_items'], speakers: MeetingRecord['speakers'] = []) => ({
    id: 'M-01', title: 'T', meeting_date: '', attendees: [], speakers, decisions: [], open_questions: [], action_items: items, source: '',
  } as unknown as MeetingRecord);
  const owned = record([{ description: 'Call vendor', owner: { ref: null, name: 'Jane Doe' }, due_date: '', task_ref: null }]);
  const inText = record([{ description: 'Call vendor · owner Jane Doe', owner: null, due_date: '', task_ref: null }]);
  assert.deepEqual(recordDiff(owned, inText).map((c) => c.field), ['action_items']);
  const sp = (reason: string) => [{ label: 'Speaker 1', source: 'a.vtt', person: { ref: null, name: 'Jane Doe' }, reason }];
  assert.deepEqual(recordDiff(record([], sp('Named.')), record([], sp('Guessed.'))).map((c) => c.field), ['speakers'], 'a reason is part of a speaker');
});

test('a change marked not sure leaves the value as it was: no longer version, no deletion, quoted exactly', async (t) => {
  const ws = await workspace(t);
  await reviewedMeeting(ws);
  const c = await startCorrection('MQ-2026-0001');
  for (const [what, edit, problem] of [
    ['a longer title', (r: Record<string, unknown>) => {
      r['title'] = 'Weekly sync planning';
      r['corrections'] = [{ field: 'title', before: 'Weekly sync', after: 'Weekly sync planning', reason: 'Maybe.', sure: false }];
    }, /must stay as it was/],
    ['a deletion', (r: Record<string, unknown>) => {
      r['decisions'] = [];
      r['corrections'] = [{ field: 'decisions', before: 'Ask Dual Line for a quote', after: '', reason: 'Maybe not decided.', sure: false }];
    }, /must stay as it was/],
    ['a value not quoted exactly', (r: Record<string, unknown>) => {
      r['corrections'] = [{ field: 'title', before: 'weekly SYNC', after: 'Weekly sink', reason: 'Maybe.', sure: false }];
    }, /quote a value of title exactly/],
  ] as const) {
    await analyzed(ws, c.id, edit);
    assert.ok((await service.get(c.id)).correction_review!.blocked.some((b) => problem.test(b)), what);
  }
  // Kept as it was, offered as a suggestion: fine.
  await analyzed(ws, c.id, (r) => { r['corrections'] = [{ field: 'title', before: 'Weekly sync', after: 'Weekly sink', reason: 'Maybe.', sure: false }]; });
  assert.deepEqual((await service.get(c.id)).correction_review!.blocked, []);
});

test('pins and speaker evidence: only this meeting\'s own transcript counts', async (t) => {
  const ws = await workspace(t);
  await reviewedMeeting(ws);
  const other = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<v Speaker 1>Another meeting.</v>\n';
  await fsp.writeFile(path.join(ws, 'context-updates', 'CU-2026-0001', 'materials', 'MQ-2026-0002-b.vtt'), other);
  const c = await startCorrection('MQ-2026-0001');
  await analyzed(ws, c.id);
  // Another meeting's file in the same update, with its real hash.
  await change(ws, c.id, (d) => {
    const pin = ((d['correction'] as Record<string, unknown>)['sources'] as Record<string, unknown>[])[0]!;
    pin['path'] = 'context-updates/CU-2026-0001/materials/MQ-2026-0002-b.vtt';
    pin['sha256'] = sha(other);
  });
  assert.ok((await service.get(c.id)).correction_review!.blocked.some((b) => /not one of this meeting's files/.test(b)));

  // Its own transcript pinned as notes: no evidence for a changed speaker.
  const d = await startCorrection('MQ-2026-0001').catch(() => null);
  assert.equal(d, null, 'one open at a time');
  await change(ws, c.id, (data) => {
    const pin = ((data['correction'] as Record<string, unknown>)['sources'] as Record<string, unknown>[])[0]!;
    pin['path'] = 'context-updates/CU-2026-0001/materials/MQ-2026-0001-a.vtt';
    pin['sha256'] = sha(transcript);
    pin['kind'] = 'notes';
  });
  await analyzed(ws, c.id, (r) => { r['speakers'] = [{ label: 'Speaker 1', source: 'MQ-2026-0001-a.vtt', person: { name: 'Jane Dough' }, reason: 'Spelled as in the stakeholder file.' }]; });
  assert.ok((await service.get(c.id)).correction_review!.blocked.some((b) => /started with/.test(b)));
});

test('doubts the corrected record no longer has are shown, and items that read alike still read differently', async (t) => {
  const ws = await workspace(t);
  await reviewedMeeting(ws);
  await change(ws, 'CU-2026-0001', (d) => {
    (d['meeting_records'] as Record<string, unknown>[])[0]!['unsure'] = [{ field: 'attendees', value: 'Jane Doe', reason: 'Only a first name was said.', suggestion: 'Jane Dow' }];
  });
  const revision = (await service.get('CU-2026-0001')).meeting_records[0]!.revision;
  await change(ws, 'CU-2026-0001', (d) => { (d['meeting_records'] as Record<string, unknown>[])[0]!['confirmed_hash'] = revision; });
  const c = await startCorrection('MQ-2026-0001');
  assert.match(await fsp.readFile(path.join(ws, 'context-updates', c.id, 'materials', 'correction-target.md'), 'utf-8'), /unsure:\n {2}- attendees: "Jane Doe"/);
  await analyzed(ws, c.id);
  assert.deepEqual((await service.get(c.id)).correction_review!.doubts_dropped.map((x) => x.value), ['Jane Doe']);

  const record = (items: MeetingRecord['action_items']) => ({ id: 'M-01', title: 'T', meeting_date: '', attendees: [], speakers: [], decisions: [], open_questions: [], action_items: items, source: '', unsure: [] } as unknown as MeetingRecord);
  const [changed] = recordDiff(
    record([{ description: 'Call vendor', owner: { ref: null, name: 'Jane Doe' }, due_date: '', task_ref: null }]),
    record([{ description: 'Call vendor · owner Jane Doe', owner: null, due_date: '', task_ref: null }]));
  assert.notEqual(changed!.before[0], changed!.after[0]);
});

test('a field with a change marked not sure must not change at all: a changed owner is refused', async (t) => {
  const ws = await workspace(t);
  await reviewedMeeting(ws);
  const c = await startCorrection('MQ-2026-0001');
  await analyzed(ws, c.id, (r) => {
    r['decisions'] = ['Ask Dual Line for a quote'];
    (r['action_items'] as Record<string, unknown>[])[0]!['description'] = 'Call Dual Line';
    (r['action_items'] as Record<string, unknown>[])[0]!['owner'] = { name: 'Alex Morgan' };
    r['corrections'] = [{ field: 'action_items', before: 'Jane Doe', after: 'Alex Morgan', reason: 'Maybe Alex.', sure: false }];
  });
  await confirm(c.id);
  assert.ok((await service.get(c.id)).correction_review!.blocked.some((b) => /must stay as it was/.test(b)));
  await assert.rejects(service.approve(c.id), /must stay as it was/);
});

test('names and their links read apart in the comparison', () => {
  const record = (attendees: MeetingRecord['attendees']) => ({ id: 'M-01', title: 'T', meeting_date: '', attendees, speakers: [], decisions: [], open_questions: [], action_items: [], source: '', unsure: [] } as unknown as MeetingRecord);
  const [changed] = recordDiff(record([{ ref: 'me', name: 'Jane Doe' }]), record([{ ref: null, name: 'Jane Doe (me)' }]));
  assert.notEqual(changed!.before[0], changed!.after[0]);
});

test('an analysis never starts from a correction that pins another meeting\'s file', async (t) => {
  const ws = await workspace(t);
  await reviewedMeeting(ws);
  const c = await startCorrection('MQ-2026-0001');
  await service.analysisPreflight(c.id);
  await fsp.writeFile(path.join(ws, 'context-updates', 'CU-2026-0001', 'materials', 'MQ-2026-0002-b.vtt'), 'WEBVTT\n');
  await change(ws, c.id, (d) => {
    const pin = ((d['correction'] as Record<string, unknown>)['sources'] as Record<string, unknown>[])[0]!;
    pin['path'] = 'context-updates/CU-2026-0001/materials/MQ-2026-0002-b.vtt';
  });
  await assert.rejects(service.analysisPreflight(c.id), /not one of this meeting's files/);
});
