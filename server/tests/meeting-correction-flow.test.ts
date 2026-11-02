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
import { actionItemKey, type MeetingRecord } from '../src/services/contextUpdateService';
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
  await service.runPreflight(c.id);
  await fsp.writeFile(path.join(ws, 'context-updates', 'CU-2026-0001', 'materials', 'MQ-2026-0002-b.vtt'), 'WEBVTT\n');
  await change(ws, c.id, (d) => {
    const pin = ((d['correction'] as Record<string, unknown>)['sources'] as Record<string, unknown>[])[0]!;
    pin['path'] = 'context-updates/CU-2026-0001/materials/MQ-2026-0002-b.vtt';
  });
  await assert.rejects(service.runPreflight(c.id), /not one of this meeting's files/);
});

test('a follow-up starts from the meeting\'s current correction, lists what the dashboard found changed, and is never a meeting', async (t) => {
  const ws = await workspace(t);
  await reviewedMeeting(ws);
  const { startFollowUp } = await import('../src/services/meetingCorrectionService');
  const c = await startCorrection('MQ-2026-0001');
  await assert.rejects(startFollowUp(c.id), /Only a finished correction/);
  await analyzed(ws, c.id);
  await confirm(c.id);
  await service.approve(c.id);

  const [a, b] = await Promise.allSettled([startFollowUp(c.id), startFollowUp(c.id)]);
  assert.deepEqual([a.status, b.status].sort(), ['fulfilled', 'rejected'], 'two at once: one');
  const f = (a.status === 'fulfilled' ? a.value : (b as PromiseFulfilledResult<Awaited<ReturnType<typeof startFollowUp>>>).value);
  assert.deepEqual([f.kind, f.origin, f.follows, f.status], ['correction-follow-up', 'meetings', c.id, 'ready']);
  const material = await fsp.readFile(path.join(ws, 'context-updates', f.id, 'materials', 'corrections.md'), 'utf-8');
  assert.match(material, /### decisions\n\n- before:\n {2}- Ask Dual Line for a quote\n- after:\n {2}- Ask Dual Lane for a quote/);
  assert.match(material, /not verified; the changes above are what counts/);
  assert.equal((await history.list()).length, 1, 'never listed as a meeting');
  // Both kinds, as the dashboard writes them, validate against the workspace's schema.
  const { default: Ajv } = await import('ajv');
  const schema = JSON.parse(await fsp.readFile(path.join(__dirname, '..', '..', 'templates', 'workspace', '.schemas', 'context-update.schema.json'), 'utf-8'));
  const validate = new Ajv({ strict: false, allErrors: true }).compile(schema);
  for (const id of [c.id, f.id]) {
    const data = JSON.parse(JSON.stringify(parseMarkdown(await fsp.readFile(path.join(ws, 'context-updates', id, 'update.md'), 'utf-8')).data));
    // The fixture's records copy normalized people (`ref: null`), which an agent never writes: the kind is what is checked.
    delete data['meeting_records'];
    assert.ok(validate(data), `${id}: ${JSON.stringify(validate.errors)}`);
  }

  // One open at a time per meeting, named in the refusal; once done, another may start.
  await assert.rejects(startFollowUp(c.id), (err: Error & { details?: { open?: string } }) => err.details?.open === f.id);
  await change(ws, f.id, (d) => { d['status'] = 'done'; });
  const again = await startFollowUp(c.id);
  assert.notEqual(again.id, f.id);

  // A meeting record in a follow-up is never confirmable.
  await change(ws, again.id, (d) => { d['status'] = 'in_review'; d['meeting_records'] = [{ id: 'M-01', title: 'x', action_items: [] }]; d['proposals'] = []; });
  assert.ok((await service.get(again.id)).meeting_records[0]!.problems.some((p) => p.includes('holds no meeting records')));
  // Nothing found: it is closed, not approved.
  await change(ws, again.id, (d) => { d['meeting_records'] = []; });
  await assert.rejects(service.approve(again.id), /close the update without changes/);
  assert.equal((await service.close(again.id)).status, 'done');
});

test('a follow-up needs the current version, an intact chain, and a real change', async (t) => {
  const ws = await workspace(t);
  await reviewedMeeting(ws);
  const { startFollowUp } = await import('../src/services/meetingCorrectionService');
  const c1 = await startCorrection('MQ-2026-0001');
  await analyzed(ws, c1.id);
  await confirm(c1.id);
  await service.approve(c1.id);
  const h1 = (await service.get(c1.id)).meeting_records[0]!;

  // A second correction that changes nothing: current, but nothing to follow up; and the first is no longer current.
  const c2 = await startCorrection('MQ-2026-0001');
  await analyzed(ws, c2.id, (r) => {
    r['decisions'] = h1.decisions;
    r['action_items'] = h1.action_items.map((x, i) => ({ description: x.description, owner: x.owner, due_date: x.due_date, slot: c2.correction!.slots[i]!.slot }));
    r['corrections'] = [];
  });
  await confirm(c2.id);
  await service.approve(c2.id);
  await assert.rejects(startFollowUp(c1.id), /current version/);
  await assert.rejects(startFollowUp(c2.id), /changed nothing/);
  assert.equal((await history.list())[0]!.correction?.head_changed, false, 'the meeting page offers no follow-up for it');
  await assert.rejects(startFollowUp('CU-2026-0001'), (err: Error & { statusCode?: number }) => err.statusCode === 404);
});

test('a follow-up is approved only while its correction is the meeting\'s current version, and goes through the usual apply', async (t) => {
  const ws = await workspace(t);
  await reviewedMeeting(ws);
  const { startFollowUp } = await import('../src/services/meetingCorrectionService');
  const c1 = await startCorrection('MQ-2026-0001');
  await analyzed(ws, c1.id);
  await confirm(c1.id);
  await service.approve(c1.id);
  assert.equal((await history.list())[0]!.correction?.head_changed, true);

  // What an analysis writes when it finds an old value: a proposal with its draft, accepted by the executive.
  const withProposal = async (id: string) => {
    await fsp.mkdir(path.join(ws, 'context-updates', id, 'proposals'), { recursive: true });
    await fsp.writeFile(path.join(ws, 'context-updates', id, 'proposals', 'P-01.md'), '---\nid: CTX-carriers\n---\nDual Lane quotes the Rotterdam lane.\n');
    await change(ws, id, (d) => {
      d['status'] = 'in_review';
      d['proposals'] = [{ id: 'P-01', action: 'update', target: 'context/company/carriers/note.md', title: 'Dual Lane, not Dual Line', rationale: 'The correction', decision: 'accepted' }];
    });
  };
  const f1 = await startFollowUp(c1.id);
  await withProposal(f1.id);
  // A meeting record written into it, even marked confirmed, never counts.
  await change(ws, f1.id, (d) => { d['meeting_records'] = [{ id: 'M-01', title: 'x', action_items: [], confirmation: 'confirmed' }]; });
  assert.equal((await service.get(f1.id)).meeting_records[0]!.confirmation, null);
  await change(ws, f1.id, (d) => { d['proposals'] = []; });
  await assert.rejects(service.approve(f1.id), /close the update without changes/, 'a forged record never makes it approvable');
  await withProposal(f1.id);
  await change(ws, f1.id, (d) => { delete d['meeting_records']; });
  assert.equal((await service.get(f1.id)).follow_up_problem, null);
  await service.runPreflight(f1.id);

  // A newer correction finishes: the follow-up says so, and neither analysis nor approval goes ahead.
  const c2 = await startCorrection('MQ-2026-0001');
  await analyzed(ws, c2.id, (r) => { r['title'] = 'Weekly logistics sync'; r['corrections'] = [{ field: 'title', before: 'Weekly sync', after: 'Weekly logistics sync', reason: 'As in the invite.', sure: true }]; });
  await confirm(c2.id);
  await service.approve(c2.id);
  assert.match((await service.get(f1.id)).follow_up_problem ?? '', /no longer the meeting's current version/);
  await assert.rejects(service.runPreflight(f1.id), /no longer the meeting's current version/);
  await assert.rejects(service.approve(f1.id), /no longer the meeting's current version/);
  // Approved before the newer correction finished: the apply the dashboard would start is refused too.
  await change(ws, f1.id, (d) => { d['status'] = 'approved'; });
  await assert.rejects(service.runPreflight(f1.id, 'apply'), /no longer the meeting's current version/);
  await change(ws, f1.id, (d) => { d['status'] = 'in_review'; });

  // The current one is followed up and approved: it waits for the usual apply.
  await service.close(f1.id);
  const f2 = await startFollowUp(c2.id);
  await withProposal(f2.id);
  assert.equal((await service.approve(f2.id)).status, 'approved');

  // The correction it follows gone: said, never approved.
  const f3 = await (async () => { await change(ws, f2.id, (d) => { d['status'] = 'done'; }); return startFollowUp(c2.id); })();
  await withProposal(f3.id);
  await fsp.rm(path.join(ws, 'context-updates', c2.id), { recursive: true });
  await assert.rejects(service.approve(f3.id), /no longer there/);
});

test('a task records the version it was made from, keeps it when found again, and no update can change it', async (t) => {
  const ws = await workspace(t);
  await reviewedMeeting(ws);
  const { TaskService } = await import('../src/services/taskService');
  const tasks = new TaskService();
  const root = (await service.get('CU-2026-0001')).meeting_records[0]!;
  const made = await service.createActionItemTask('CU-2026-0001', 'M-01', { item: 0, revision: root.revision, task: { title: 'Call', priority: 'medium' } });
  const source = { update_id: 'CU-2026-0001', record_id: 'M-01', revision: root.revision, root_index: 0 };
  assert.deepEqual((made.task as unknown as Record<string, unknown>)['meeting_action_source'], source);

  const c = await startCorrection('MQ-2026-0001');
  await analyzed(ws, c.id);
  await confirm(c.id);
  await service.approve(c.id);
  const head = (await service.get(c.id)).meeting_records[0]!;
  const again = await service.createActionItemTask(c.id, 'M-01', { item: 0, revision: head.revision, task: { title: 'Call', priority: 'medium' } });
  assert.equal(again.task.id, made.task.id, 'the same task');
  const saved = (await tasks.getTask(made.task.id)) as unknown as Record<string, unknown>;
  assert.deepEqual(saved['meeting_action_source'], source, 'found again: what it recorded first stays');

  await tasks.updateTask(made.task.id, { title: 'Call them', meeting_action: 'x/y/z', meeting_action_source: null } as never);
  const after = (await tasks.getTask(made.task.id)) as unknown as Record<string, unknown>;
  assert.deepEqual([after['title'], after['meeting_action'], after['meeting_action_source']], ['Call them', saved['meeting_action'], source]);
});

test('task notices: what changed for the task\'s own item since the version it was made from, never guessed', async (t) => {
  const ws = await workspace(t);
  await reviewedMeeting(ws);
  const { TaskService } = await import('../src/services/taskService');
  const { actionNotice } = await import('../src/services/meetingActionNotice');
  const tasks = new TaskService();
  const notice = async (id: string) => actionNotice((await tasks.getTask(id)) as unknown as Record<string, unknown>);
  const taskFile = (id: string) => path.join(ws, 'tasks', 'active', id, 'task.md');
  const editTask = async (id: string, fn: (d: Record<string, unknown>) => void) => {
    const parsed = parseMarkdown(await fsp.readFile(taskFile(id), 'utf-8'));
    fn(parsed.data);
    await fsp.writeFile(taskFile(id), stringifyMarkdown(parsed.content, parsed.data));
  };

  const root = (await service.get('CU-2026-0001')).meeting_records[0]!;
  const fromRoot = (await service.createActionItemTask('CU-2026-0001', 'M-01', { item: 0, revision: root.revision, task: { title: 'Call', priority: 'medium' } })).task.id;
  assert.equal((await notice(fromRoot)).state, 'current');
  assert.equal((await actionNotice({ title: 'Not from a meeting' })).state, 'none');

  // Corrected: the description and the owner of the item.
  const c = await startCorrection('MQ-2026-0001');
  await analyzed(ws, c.id, (r) => { (r['action_items'] as Record<string, unknown>[])[0]!['owner'] = { name: 'Jane Dough' }; });
  await confirm(c.id);
  await service.approve(c.id);
  const n = await notice(fromRoot);
  assert.deepEqual([n.state, n.meeting, n.current?.update_id, n.legacy], ['changed', 'MQ-2026-0001', c.id, false]);
  assert.deepEqual(n.changes.map((x) => [x.property, x.before, x.after]), [['description', 'Call Dual Line', 'Call Dual Lane'], ['owner', 'Jane Doe', 'Jane Dough']]);

  // A task made from the corrected version: nothing changed since. Without its version (made before tasks recorded it),
  // the original stands in for it.
  await editTask(fromRoot, (d) => { delete d['meeting_action_source']; });
  const legacy = await notice(fromRoot);
  assert.deepEqual([legacy.state, legacy.legacy], ['changed', true]);
  const headRevision = (await service.get(c.id)).meeting_records[0]!.revision;
  await editTask(fromRoot, (d) => { d['meeting_action_source'] = { update_id: c.id, record_id: 'M-01', revision: headRevision, root_index: 0 }; });
  assert.equal((await notice(fromRoot)).state, 'current');

  // A version that is not one of the record's versions: unknown, never compared.
  await editTask(fromRoot, (d) => { (d['meeting_action_source'] as Record<string, unknown>)['revision'] = 'ffffffffffffffff'; });
  assert.equal((await notice(fromRoot)).state, 'unknown');

  // Two corrections of the same version: a conflict, nothing listed.
  const sibling = await service.createCorrection({ title: 'Sibling', meeting_date: '2026-10-27', notes: '', correction: c.correction!, materials: [] });
  await analyzed(ws, sibling.id);
  await confirm(sibling.id);
  await change(ws, sibling.id, (d) => { d['status'] = 'done'; });
  const conflict = await notice(fromRoot);
  assert.deepEqual([conflict.state, conflict.changes], ['conflict', []]);
});

test('task notices: an older task whose original has two items alike is ambiguous, never matched to one', async (t) => {
  const ws = await workspace(t);
  await reviewedMeeting(ws);
  await change(ws, 'CU-2026-0001', (d) => {
    const r = (d['meeting_records'] as Record<string, unknown>[])[0]!;
    r['action_items'] = [{ description: 'Call Dual Line', owner: { name: 'Jane Doe' } }, { description: 'Call Dual Line', owner: { name: 'Jane Doe' } }];
  });
  const revision = (await service.get('CU-2026-0001')).meeting_records[0]!.revision;
  await change(ws, 'CU-2026-0001', (d) => { (d['meeting_records'] as Record<string, unknown>[])[0]!['confirmed_hash'] = revision; });
  const { actionNotice } = await import('../src/services/meetingActionNotice');
  const key = actionItemKey({ description: 'Call Dual Line', owner: { ref: null, name: 'Jane Doe' }, due_date: '', task_ref: null });
  assert.equal((await actionNotice({ meeting_action: `CU-2026-0001/M-01/${key}` })).state, 'ambiguous');
  assert.equal((await actionNotice({ meeting_action: `CU-2026-0001/M-01/${key}`, meeting_action_source: { update_id: 'CU-2026-0001', record_id: 'M-01', revision, root_index: 1 } })).state, 'current');
});

test('a task made first from a correction records that version and its slot\'s original place; requests never set either', async (t) => {
  const ws = await workspace(t);
  await reviewedMeeting(ws);
  // Two items in the original, so the place matters.
  await change(ws, 'CU-2026-0001', (d) => {
    (d['meeting_records'] as Record<string, unknown>[])[0]!['action_items'] = [{ description: 'Call Dual Line', owner: { name: 'Jane Doe' } }, { description: 'Send the Dual Line quote', owner: { name: 'Jane Doe' } }];
  });
  const rootRevision = (await service.get('CU-2026-0001')).meeting_records[0]!.revision;
  await change(ws, 'CU-2026-0001', (d) => { (d['meeting_records'] as Record<string, unknown>[])[0]!['confirmed_hash'] = rootRevision; });
  const { TaskService } = await import('../src/services/taskService');
  const tasks = new TaskService();

  const c = await startCorrection('MQ-2026-0001');
  await analyzed(ws, c.id);
  await confirm(c.id);
  await service.approve(c.id);
  const head = (await service.get(c.id)).meeting_records[0]!;
  const made = await service.createActionItemTask(c.id, 'M-01', { item: 1, revision: head.revision, task: { title: 'Send', priority: 'medium' } });
  const source = { update_id: c.id, record_id: 'M-01', revision: head.revision, root_index: 1 };
  const onDisk = async (id: string) => parseMarkdown(await fsp.readFile(path.join(ws, 'tasks', 'active', id, 'task.md'), 'utf-8')).data;
  assert.deepEqual((await onDisk(made.task.id))['meeting_action_source'], source);

  // The original's same item finds that task, and its first record stays.
  const fromRoot = await service.createActionItemTask('CU-2026-0001', 'M-01', { item: 1, revision: rootRevision, task: { title: 'Send', priority: 'medium' } });
  assert.equal(fromRoot.task.id, made.task.id);
  assert.deepEqual((await onDisk(made.task.id))['meeting_action_source'], source);

  // A request that names either field: never taken, on create or on update.
  const spoof = { meeting_action: `CU-2026-0001/M-01/${actionItemKey(head.action_items[0]!)}`, meeting_action_source: source };
  const plain = await tasks.createTask({ title: 'Plain', ...spoof } as never);
  await tasks.updateTask(plain.id, spoof as never);
  const plainOnDisk = await onDisk(plain.id);
  assert.deepEqual([plainOnDisk['meeting_action'], plainOnDisk['meeting_action_source']], [undefined, undefined]);

  // What is written validates against the workspace's task schema.
  const { default: Ajv } = await import('ajv');
  const schema = JSON.parse(await fsp.readFile(path.join(__dirname, '..', '..', 'templates', 'workspace', '.schemas', 'task.schema.json'), 'utf-8'));
  const ajv = new Ajv({ strict: false, allErrors: true });
  const validate = ajv.compile(schema);
  const data = JSON.parse(JSON.stringify(await onDisk(made.task.id)));
  assert.ok(validate(data), JSON.stringify(validate.errors));
});

test('task notices: a task from one correction compared after the next; what the meeting\'s versions say comes first', async (t) => {
  const ws = await workspace(t);
  await reviewedMeeting(ws);
  const { actionNotice } = await import('../src/services/meetingActionNotice');
  const c1 = await startCorrection('MQ-2026-0001');
  await analyzed(ws, c1.id);
  await confirm(c1.id);
  await service.approve(c1.id);
  const h1 = (await service.get(c1.id)).meeting_records[0]!;
  const made = await service.createActionItemTask(c1.id, 'M-01', { item: 0, revision: h1.revision, task: { title: 'Call', priority: 'medium' } });
  const task = made.task as unknown as Record<string, unknown>;
  assert.equal((await actionNotice(task)).state, 'current');

  // The next correction changes only the date: that alone is listed, from the first correction's item.
  const c2 = await startCorrection('MQ-2026-0001');
  await analyzed(ws, c2.id, (r) => {
    r['decisions'] = h1.decisions;
    r['action_items'] = h1.action_items.map((a, i) => ({ description: a.description, owner: a.owner, due_date: '2026-11-20', slot: c2.correction!.slots[i]!.slot }));
    r['corrections'] = [];
  });
  await confirm(c2.id);
  await service.approve(c2.id);
  const n = await actionNotice(task);
  assert.deepEqual([n.state, n.changes.map((x) => [x.property, x.before, x.after])], ['changed', [['due_date', '', '2026-11-20']]]);

  // What the task recorded, unreadable: never compared with the original instead.
  for (const bad of [null, { ...(task['meeting_action_source'] as object), root_index: '0' }, { update_id: c1.id }]) {
    const x = await actionNotice({ ...task, meeting_action_source: bad });
    assert.deepEqual([x.state, x.changes, x.current], ['unknown', [], null], JSON.stringify(bad));
  }

  // A correction naming this original with another meeting never decides the meeting, nor the answer.
  await service.createCorrection({ title: 'Elsewhere', meeting_date: '2026-10-27', notes: '', correction: { ...c2.correction!, meeting: 'MQ-2026-0009' }, materials: [] });
  const still = await actionNotice(task);
  assert.deepEqual([still.state, still.meeting], ['changed', 'MQ-2026-0001']);

  // The original edited on disk: the versions no longer hold, and that is what the task says, with nothing compared.
  await change(ws, 'CU-2026-0001', (d) => { ((d['meeting_records'] as Record<string, unknown>[])[0]!['action_items'] as Record<string, unknown>[])[0]!['description'] = 'Call someone'; });
  const broken = await actionNotice(task);
  assert.deepEqual([broken.state, broken.changes, broken.current], ['broken', [], null]);

  // The original's update gone: gone.
  await fsp.rm(path.join(ws, 'context-updates', 'CU-2026-0001'), { recursive: true });
  assert.equal((await actionNotice(task)).state, 'gone');
});

test('task notices: a conflict is said before an older task\'s ambiguous item', async (t) => {
  const ws = await workspace(t);
  await reviewedMeeting(ws);
  await change(ws, 'CU-2026-0001', (d) => {
    (d['meeting_records'] as Record<string, unknown>[])[0]!['action_items'] = [{ description: 'Call Dual Line', owner: { name: 'Jane Doe' } }, { description: 'Call Dual Line', owner: { name: 'Jane Doe' } }];
  });
  const revision = (await service.get('CU-2026-0001')).meeting_records[0]!.revision;
  await change(ws, 'CU-2026-0001', (d) => { (d['meeting_records'] as Record<string, unknown>[])[0]!['confirmed_hash'] = revision; });
  const { actionNotice } = await import('../src/services/meetingActionNotice');
  const key = actionItemKey({ description: 'Call Dual Line', owner: { ref: null, name: 'Jane Doe' }, due_date: '', task_ref: null });
  const c = await startCorrection('MQ-2026-0001');
  for (const id of [c.id, (await service.createCorrection({ title: 'Sibling', meeting_date: '2026-10-27', notes: '', correction: c.correction!, materials: [] })).id]) {
    await analyzed(ws, id);
    await confirm(id);
    await change(ws, id, (d) => { d['status'] = 'done'; });
  }
  assert.equal((await actionNotice({ meeting_action: `CU-2026-0001/M-01/${key}` })).state, 'conflict');
});
