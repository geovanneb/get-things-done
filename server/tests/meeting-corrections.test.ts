import { test } from 'node:test';
import assert from 'node:assert/strict';
import { correctionChain, rootActionIdentity } from '../src/services/meetingCorrections';
import { actionItemKey, type ContextUpdate, type MeetingRecord } from '../src/services/contextUpdateService';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import { ContextUpdateService } from '../src/services/contextUpdateService';
import { MeetingHistoryService } from '../src/services/meetingHistoryService';
import { resolveMeeting } from '../src/services/meetingSources';
import { stringifyMarkdown, parseMarkdown } from '../src/utils/markdown';

/** A meeting record as the service reads it; `confirmed` and `problems` decide whether it counts. */
function record(revision: string, extra: Partial<MeetingRecord> = {}): MeetingRecord {
  return {
    id: 'M-01', title: 'Weekly sync', meeting_date: '2026-10-27', attendees: [], speakers: [], decisions: [], open_questions: [], action_items: [],
    source: '', meeting: 'MQ-2026-0001', amends: null, unsure: [], confirmation: 'confirmed', confirmed_at: '2026-10-28T00:00:00.000Z',
    revision, problems: [], changed_since_confirmed: false, ...extra,
  } as MeetingRecord;
}

/** An update holding the given records. */
function update(id: string, records: MeetingRecord[], extra: Partial<ContextUpdate> = {}): ContextUpdate {
  return {
    id, title: id, status: 'done', kind: null, origin: null, correction: null, meeting_records: records, materials: [], transcripts: [], digest_meetings: [],
    deleted_meetings: [], kept_meetings: [], meetings_linked_at: null, source_date: '2026-10-27',
    applied_at: '2026-10-29T00:00:00.000Z', updated_at: '2026-10-29T00:00:00.000Z', ...extra,
  } as unknown as ContextUpdate;
}

/** The original: a meeting digest holding MQ-2026-0001, whose record names it. */
function digest(records: MeetingRecord[], extra: Partial<ContextUpdate> = {}): ContextUpdate {
  return update('CU-2026-0001', records, {
    origin: 'meetings', kind: 'daily-digest',
    digest_meetings: [{ id: 'MQ-2026-0001', title: 'Weekly sync', meeting_date: '2026-10-27', files: [{ source: 'a.md', file: 'MQ-2026-0001-a.md', sha256: 'x' }] }],
    ...extra,
  } as Partial<ContextUpdate>);
}

const ROOT = { update_id: 'CU-2026-0001', record_id: 'M-01' };
const ROOT_ITEM = { description: 'Call Dual Line', owner: { ref: null, name: 'Jane Doe' }, due_date: '', task_ref: null };
const ROOT_KEY = actionItemKey(ROOT_ITEM);
const original = digest([record('aaaaaaaaaaaaaaaa', { action_items: [ROOT_ITEM] })]);

/** A correction of `base`, done and confirmed unless said otherwise. */
function correction(id: string, base: { update_id: string; revision: string }, revision: string, extra: Partial<ContextUpdate> = {}, meeting = 'MQ-2026-0001'): ContextUpdate {
  const version = { update_id: base.update_id, record_id: 'M-01', revision: base.revision };
  return update(id, [record(revision, { amends: version, action_items: [{ ...ROOT_ITEM, description: 'Call Dual Lane', slot: 'A-01' }] })], {
    kind: 'meeting-correction',
    correction: { meeting, root: ROOT, base: version, slots: [{ slot: 'A-01', root_key: ROOT_KEY, root_index: 0 }] },
    ...extra,
  });
}

const first = correction('CU-2026-0002', { update_id: 'CU-2026-0001', revision: 'aaaaaaaaaaaaaaaa' }, 'bbbbbbbbbbbbbbbb');
const second = correction('CU-2026-0003', { update_id: 'CU-2026-0002', revision: 'bbbbbbbbbbbbbbbb' }, 'cccccccccccccccc');

test('no correction: the original is the head', () => {
  const chain = correctionChain('MQ-2026-0001', ROOT, [original]);
  assert.equal(chain.state, 'original');
  assert.deepEqual([chain.head?.update_id, chain.head?.revision, chain.links.length], ['CU-2026-0001', 'aaaaaaaaaaaaaaaa', 1]);
});

test('corrections in order: the last one is the head, every version in between is a link', () => {
  const chain = correctionChain('MQ-2026-0001', ROOT, [second, original, first]);
  assert.equal(chain.state, 'corrected');
  assert.deepEqual(chain.links.map((l) => l.update_id), ['CU-2026-0001', 'CU-2026-0002', 'CU-2026-0003']);
  assert.equal(chain.head_record?.revision, 'cccccccccccccccc');
  assert.deepEqual([chain.open, chain.invalid], [[], []]);
});

test('two corrections of the same version are a conflict: the head stays where both started', () => {
  const sibling = correction('CU-2026-0004', { update_id: 'CU-2026-0002', revision: 'bbbbbbbbbbbbbbbb' }, 'dddddddddddddddd');
  const chain = correctionChain('MQ-2026-0001', ROOT, [original, first, second, sibling]);
  assert.equal(chain.state, 'conflict');
  assert.equal(chain.head?.update_id, 'CU-2026-0002');
});

test('a missing middle version leaves the chain broken, never jumping to a later one', () => {
  const chain = correctionChain('MQ-2026-0001', ROOT, [original, second]);
  assert.equal(chain.state, 'broken');
  assert.equal(chain.head?.update_id, 'CU-2026-0001');
  assert.deepEqual(chain.invalid, ['CU-2026-0003']);
});

test('a missing or unconfirmed root has no head, also when corrections survive', () => {
  assert.deepEqual([correctionChain('MQ-2026-0001', ROOT, [first]).state, correctionChain('MQ-2026-0001', ROOT, [first]).head], ['broken', null]);
  const unconfirmed = digest([record('aaaaaaaaaaaaaaaa', { confirmation: null })]);
  assert.equal(correctionChain('MQ-2026-0001', ROOT, [unconfirmed]).head, null);
  const notDone = digest([record('aaaaaaaaaaaaaaaa')], { status: 'in_review' });
  assert.equal(correctionChain('MQ-2026-0001', ROOT, [notDone]).head, null);
});

test('what does not count: not done (open), not confirmed, with problems, or amending another version than its base', () => {
  const open = correction('CU-2026-0005', { update_id: 'CU-2026-0001', revision: 'aaaaaaaaaaaaaaaa' }, 'eeeeeeeeeeeeeeee', { status: 'in_review' });
  const unconfirmed = correction('CU-2026-0006', { update_id: 'CU-2026-0001', revision: 'aaaaaaaaaaaaaaaa' }, 'eeeeeeeeeeeeeeee');
  unconfirmed.meeting_records[0]!.confirmation = null;
  const flawed = correction('CU-2026-0007', { update_id: 'CU-2026-0001', revision: 'aaaaaaaaaaaaaaaa' }, 'eeeeeeeeeeeeeeee');
  flawed.meeting_records[0]!.problems = ['something'];
  const elsewhere = correction('CU-2026-0008', { update_id: 'CU-2026-0001', revision: 'aaaaaaaaaaaaaaaa' }, 'eeeeeeeeeeeeeeee');
  elsewhere.meeting_records[0]!.amends = { update_id: 'CU-2026-0001', record_id: 'M-01', revision: 'ffffffffffffffff' };
  const chain = correctionChain('MQ-2026-0001', ROOT, [original, open, unconfirmed, flawed, elsewhere]);
  assert.equal(chain.state, 'original');
  assert.deepEqual(chain.open, ['CU-2026-0005']);
  assert.deepEqual(chain.invalid.sort(), ['CU-2026-0006', 'CU-2026-0007', 'CU-2026-0008']);
});

test('a correction naming another meeting or root is never followed', () => {
  const other = correction('CU-2026-0009', { update_id: 'CU-2026-0001', revision: 'aaaaaaaaaaaaaaaa' }, 'bbbbbbbbbbbbbbbb', {}, 'MQ-2026-0002');
  assert.equal(correctionChain('MQ-2026-0001', ROOT, [original, other]).state, 'original');
  const wrongRoot = correction('CU-2026-0010', { update_id: 'CU-2026-0001', revision: 'aaaaaaaaaaaaaaaa' }, 'bbbbbbbbbbbbbbbb');
  wrongRoot.correction = { ...wrongRoot.correction!, root: { update_id: 'CU-2026-0099', record_id: 'M-01' } };
  const chain = correctionChain('MQ-2026-0001', ROOT, [original, wrongRoot]);
  assert.deepEqual([chain.state, chain.invalid], ['original', ['CU-2026-0010']]);
});

test('a cycle is never followed: two corrections of each other\'s version are unreachable, so broken', () => {
  const loopA = correction('CU-2026-0011', { update_id: 'CU-2026-0012', revision: 'dddddddddddddddd' }, 'cccccccccccccccc');
  const loopB = correction('CU-2026-0012', { update_id: 'CU-2026-0011', revision: 'cccccccccccccccc' }, 'dddddddddddddddd');
  const chain = correctionChain('MQ-2026-0001', ROOT, [original, loopA, loopB]);
  assert.equal(chain.state, 'broken');
  assert.equal(chain.head?.update_id, 'CU-2026-0001');
  assert.deepEqual(chain.invalid.sort(), ['CU-2026-0011', 'CU-2026-0012']);
});

test('slots must match the original\'s own items: a wrong key, a missing item or a duplicate index never counts', () => {
  const wrongKey = correction('CU-2026-0013', { update_id: 'CU-2026-0001', revision: 'aaaaaaaaaaaaaaaa' }, 'bbbbbbbbbbbbbbbb');
  wrongKey.correction = { ...wrongKey.correction!, slots: [{ slot: 'A-01', root_key: '000000000000', root_index: 0 }] };
  const badIndex = correction('CU-2026-0014', { update_id: 'CU-2026-0001', revision: 'aaaaaaaaaaaaaaaa' }, 'bbbbbbbbbbbbbbbb');
  badIndex.correction = { ...badIndex.correction!, slots: [{ slot: 'A-01', root_key: ROOT_KEY, root_index: 3 }] };
  for (const bad of [wrongKey, badIndex]) {
    const chain = correctionChain('MQ-2026-0001', ROOT, [original, bad]);
    assert.deepEqual([chain.state, chain.head?.update_id, chain.invalid], ['broken', 'CU-2026-0001', [bad.id]], bad.id);
  }
  const twoItems = digest([record('aaaaaaaaaaaaaaaa', { action_items: [ROOT_ITEM, ROOT_ITEM] })]);
  const duplicate = correction('CU-2026-0015', { update_id: 'CU-2026-0001', revision: 'aaaaaaaaaaaaaaaa' }, 'bbbbbbbbbbbbbbbb');
  duplicate.correction = { ...duplicate.correction!, slots: [{ slot: 'A-01', root_key: ROOT_KEY, root_index: 0 }, { slot: 'A-02', root_key: ROOT_KEY, root_index: 0 }] };
  // Shaped as production writes it: one corrected item per slot.
  duplicate.meeting_records[0]!.action_items = [{ ...ROOT_ITEM, slot: 'A-01' }, { ...ROOT_ITEM, slot: 'A-02' }];
  assert.equal(correctionChain('MQ-2026-0001', ROOT, [twoItems, duplicate]).state, 'broken', 'each original item once');
});

test('a correction naming this original with another meeting is listed, never followed', () => {
  const other = correction('CU-2026-0016', { update_id: 'CU-2026-0001', revision: 'aaaaaaaaaaaaaaaa' }, 'bbbbbbbbbbbbbbbb', {}, 'MQ-2026-0009');
  const chain = correctionChain('MQ-2026-0001', ROOT, [original, other]);
  assert.deepEqual([chain.state, chain.invalid], ['original', ['CU-2026-0016']]);
});

test('a corrected item stands for its original by its slot, never by position', () => {
  assert.equal(rootActionIdentity(first.correction!, 'A-01'), `CU-2026-0001/M-01/${ROOT_KEY}`);
  assert.equal(rootActionIdentity(first.correction!, 'A-02'), null);
});

/* ---- With real updates on disk ----------------------------------------------------------------------------------- */


async function workspace(t: { after: (fn: () => Promise<void> | void) => void }): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-corrections-'));
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
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

/** Writes an update, then confirms its records as the dashboard does (the record's content hash). */
async function written(ws: string, id: string, data: Record<string, unknown>, files: Record<string, string> = {}): Promise<void> {
  const dir = path.join(ws, 'context-updates', id);
  await fsp.mkdir(path.join(dir, 'materials'), { recursive: true });
  for (const [name, content] of Object.entries(files)) await fsp.writeFile(path.join(dir, 'materials', name), content);
  const file = path.join(dir, 'update.md');
  await fsp.writeFile(file, stringifyMarkdown('', {
    schema_version: '1.0', id, type: 'context-update', title: `Fictional ${id}`, source_date: '2026-10-27', created_at: '2026-10-27T18:00:00.000Z',
    updated_at: '2026-10-28T09:00:00.000Z', materials: Object.keys(files).map((name) => ({ name, size: 1, type: 'text/plain' })), ...data,
  }));
  const shown = await service.get(id);
  const parsed = parseMarkdown(await fsp.readFile(file, 'utf-8'));
  const raws = (parsed.data['meeting_records'] as Record<string, unknown>[] | undefined) ?? [];
  raws.forEach((r, i) => { if (r['confirmation'] === 'confirmed') r['confirmed_hash'] = shown.meeting_records[i]!.revision; });
  await fsp.writeFile(file, stringifyMarkdown(parsed.content, parsed.data));
}

const transcript = 'Jane Doe: Ask Dual Line for a quote.';
async function digestWithCorrection(ws: string): Promise<{ originalRevision: string }> {
  await written(ws, 'CU-2026-0001', {
    status: 'done', applied_at: '2026-10-28T09:00:00.000Z', origin: 'meetings', kind: 'daily-digest', keep_meeting_text: true,
    digest_meetings: [{ id: 'MQ-2026-0001', title: 'Weekly sync', meeting_date: '2026-10-27', files: [{ source: 'a.md', file: 'MQ-2026-0001-a.md', sha256: sha(transcript) }] }],
    meeting_records: [{ id: 'M-01', title: 'Weekly sync', meeting_date: '2026-10-27', meeting: 'MQ-2026-0001', attendees: [{ name: 'Jane Doe' }], decisions: ['Ask Dual Line for a quote'], open_questions: [], action_items: [{ description: 'Call Dual Line', owner: { name: 'Jane Doe' } }], source: 'MQ-2026-0001-a.md', confirmation: 'confirmed' }],
  }, { 'MQ-2026-0001-a.md': transcript });
  const shown = (await service.get('CU-2026-0001')).meeting_records[0]!;
  const originalRevision = shown.revision;
  const base = { update_id: 'CU-2026-0001', record_id: 'M-01', revision: originalRevision };
  const rootKey = actionItemKey(shown.action_items[0]!);
  await written(ws, 'CU-2026-0002', {
    status: 'done', applied_at: '2026-10-30T09:00:00.000Z', origin: 'meetings', kind: 'meeting-correction',
    correction: { meeting: 'MQ-2026-0001', root: { update_id: 'CU-2026-0001', record_id: 'M-01' }, base, slots: [{ slot: 'A-01', root_key: rootKey, root_index: 0 }] },
    meeting_records: [{ id: 'M-01', title: 'Weekly sync (corrected)', meeting_date: '2026-10-27', meeting: 'MQ-2026-0001', amends: base, attendees: [{ name: 'Jane Doe' }], decisions: ['Ask Dual Lane for a quote'], open_questions: [], action_items: [{ description: 'Call Dual Lane', owner: { name: 'Jane Doe' }, slot: 'A-01' }], source: 'MQ-2026-0001-a.md', confirmation: 'confirmed' }],
  });
  return { originalRevision };
}

test('the history shows the current version of a corrected record, the files stay the original update\'s, and a correction is not a meeting', async (t) => {
  const ws = await workspace(t);
  const { originalRevision } = await digestWithCorrection(ws);
  const history = new MeetingHistoryService();
  const list = await history.list();
  assert.deepEqual(list.map((m) => m.id), ['MQ-2026-0001'], 'the correction update is not listed as a meeting');
  const m = list[0]!;
  assert.deepEqual([m.title, m.update_id, m.record_owner?.update_id, m.correction?.state], ['Weekly sync (corrected)', 'CU-2026-0001', 'CU-2026-0002', 'corrected']);
  assert.notEqual(m.record?.revision, originalRevision);
  const detail = await history.detail('MQ-2026-0001');
  assert.deepEqual(detail.record?.decisions, ['Ask Dual Lane for a quote']);
  assert.ok(detail.sources.some((s) => s.file === 'MQ-2026-0001-a.md' && s.present), 'the files are the original update\'s');

  const pinned = await resolveMeeting('MQ-2026-0001');
  assert.equal(pinned.record?.update_id, 'CU-2026-0002', 'a task pins the record under its owner');
  assert.match(pinned.sources[0]!.path, /^context-updates\/CU-2026-0001\/materials\//, 'and reads the files from the original update');
});

test('a correction record that does not match its envelope cannot count, and no other record may say it amends something', async (t) => {
  const ws = await workspace(t);
  await digestWithCorrection(ws);
  const file = path.join(ws, 'context-updates', 'CU-2026-0002', 'update.md');
  const edit = async (change: (r: Record<string, unknown>) => void, data: (d: Record<string, unknown>) => void = () => {}) => {
    const parsed = parseMarkdown(await fsp.readFile(file, 'utf-8'));
    const records = parsed.data['meeting_records'] as Record<string, unknown>[];
    change(records[0]!);
    data(parsed.data);
    await fsp.writeFile(file, stringifyMarkdown(parsed.content, parsed.data));
    return (await service.get('CU-2026-0002')).meeting_records;
  };
  const amends = async () => (parseMarkdown(await fsp.readFile(file, 'utf-8')).data['meeting_records'] as Record<string, unknown>[])[0]!['amends'];
  const base = await amends();
  let records = await edit((r) => { r['amends'] = { ...(base as object), revision: 'ffffffffffffffff' }; });
  assert.ok(records[0]!.problems.some((p) => p.includes('does not amend the version')));
  assert.equal(records[0]!.confirmation, null, 'no longer counts as confirmed');
  records = await edit((r) => { r['amends'] = base; (r['action_items'] as Record<string, unknown>[])[0]!['slot'] = 'A-02'; });
  assert.ok(records[0]!.problems.some((p) => p.includes('not the original ones')));
  records = await edit((r) => { (r['action_items'] as Record<string, unknown>[])[0]!['slot'] = 'A-01'; }, (d) => { (d['meeting_records'] as unknown[]).push({ ...(d['meeting_records'] as Record<string, unknown>[])[0]!, id: 'M-02' }); });
  assert.ok(records[0]!.problems.some((p) => p.includes('exactly one record')));
  records = await edit(() => {}, (d) => { d['correction'] = { meeting: 'MQ-2026-0001' }; (d['meeting_records'] as unknown[]).splice(1); });
  assert.ok(records[0]!.problems.some((p) => p.includes('does not say what it corrects')));
  assert.equal((await new MeetingHistoryService().list())[0]!.correction?.state ?? 'original', 'original', 'a correction that does not count leaves the original current');

  // An ordinary update whose record says it amends something: a problem, never a correction.
  const original = path.join(ws, 'context-updates', 'CU-2026-0001', 'update.md');
  const parsed = parseMarkdown(await fsp.readFile(original, 'utf-8'));
  (parsed.data['meeting_records'] as Record<string, unknown>[])[0]!['amends'] = base;
  await fsp.writeFile(original, stringifyMarkdown(parsed.content, parsed.data));
  assert.ok((await service.get('CU-2026-0001')).meeting_records[0]!.problems.some((p) => p.includes('only a correction')));
});

test('editing the correction\'s envelope after confirming takes the confirmation away', async (t) => {
  const ws = await workspace(t);
  await digestWithCorrection(ws);
  assert.equal((await service.get('CU-2026-0002')).meeting_records[0]!.confirmation, 'confirmed');
  const file = path.join(ws, 'context-updates', 'CU-2026-0002', 'update.md');
  const parsed = parseMarkdown(await fsp.readFile(file, 'utf-8'));
  (parsed.data['correction'] as { slots: { root_index: number }[] }).slots[0]!.root_index = 0;
  (parsed.data['correction'] as { meeting: string }).meeting = 'MQ-2026-0002';
  await fsp.writeFile(file, stringifyMarkdown(parsed.content, parsed.data));
  assert.equal((await service.get('CU-2026-0002')).meeting_records[0]!.confirmation, null, 'the envelope is part of what was confirmed');
});

test('a task from a corrected item is the original item\'s task: one task, whichever is made first', async (t) => {
  const ws = await workspace(t);
  await digestWithCorrection(ws);
  const fromCorrection = await service.createActionItemTask('CU-2026-0002', 'M-01', { item: 0, revision: (await service.get('CU-2026-0002')).meeting_records[0]!.revision, task: { title: 'Fictional task' } });
  assert.equal(fromCorrection.created, true);
  assert.match(String(parseMarkdown(await fsp.readFile(path.join(ws, 'tasks', 'active', fromCorrection.task.id, 'task.md'), 'utf-8')).data['meeting_action']), /^CU-2026-0001\/M-01\//, 'carries the original item\'s identity');
  const fromOriginal = await service.createActionItemTask('CU-2026-0001', 'M-01', { item: 0, revision: (await service.get('CU-2026-0001')).meeting_records[0]!.revision, task: { title: 'Fictional task' } });
  assert.deepEqual([fromOriginal.created, fromOriginal.task.id], [false, fromCorrection.task.id]);
  assert.equal((await fsp.readdir(path.join(ws, 'tasks', 'active'))).filter((n) => n.startsWith('TASK-')).length, 1);
});

test('no task from a version that is not current: a conflict refuses', async (t) => {
  const ws = await workspace(t);
  await digestWithCorrection(ws);
  // A second correction of the same original version: the two conflict, so neither is current.
  const copy = path.join(ws, 'context-updates', 'CU-2026-0003');
  await fsp.cp(path.join(ws, 'context-updates', 'CU-2026-0002'), copy, { recursive: true });
  const file = path.join(copy, 'update.md');
  await fsp.writeFile(file, (await fsp.readFile(file, 'utf-8')).replace(/^id: CU-2026-0002$/m, 'id: CU-2026-0003'));
  const revision = (await service.get('CU-2026-0002')).meeting_records[0]!.revision;
  await assert.rejects(service.createActionItemTask('CU-2026-0002', 'M-01', { item: 0, revision, task: { title: 'x' } }), /not the current version.*conflict/);
  assert.equal((await new MeetingHistoryService().list())[0]!.correction?.state, 'conflict');
  await assert.rejects(resolveMeeting('MQ-2026-0001'), (err: Error & { statusCode?: number }) => err.statusCode === 409, 'a task cannot pin a conflicting meeting');
});

test('a meeting whose original update is gone stays listed, broken, through its corrections', async (t) => {
  const ws = await workspace(t);
  await digestWithCorrection(ws);
  await fsp.rm(path.join(ws, 'context-updates', 'CU-2026-0001'), { recursive: true });
  const list = await new MeetingHistoryService().list();
  assert.deepEqual(list.map((m) => [m.id, m.correction?.state, m.linkable, m.update_id]), [['MQ-2026-0001', 'broken', false, 'CU-2026-0002']]);
});

test('a correction that empties the date shows an empty date, never the original one', async (t) => {
  const ws = await workspace(t);
  await digestWithCorrection(ws);
  const file = path.join(ws, 'context-updates', 'CU-2026-0002', 'update.md');
  const parsed = parseMarkdown(await fsp.readFile(file, 'utf-8'));
  const r = (parsed.data['meeting_records'] as Record<string, unknown>[])[0]!;
  r['meeting_date'] = '';
  delete r['confirmed_hash'];
  await fsp.writeFile(file, stringifyMarkdown(parsed.content, parsed.data));
  const revision = (await service.get('CU-2026-0002')).meeting_records[0]!.revision;
  r['confirmed_hash'] = revision;
  await fsp.writeFile(file, stringifyMarkdown(parsed.content, parsed.data));
  const m = (await new MeetingHistoryService().list())[0]!;
  assert.deepEqual([m.correction?.state, m.meeting_date], ['corrected', '']);
});

/** Writes a changed copy of an update's frontmatter. */
async function changeUpdate(ws: string, id: string, change: (data: Record<string, unknown>) => void): Promise<void> {
  const file = path.join(ws, 'context-updates', id, 'update.md');
  const parsed = parseMarkdown(await fsp.readFile(file, 'utf-8'));
  change(parsed.data);
  await fsp.writeFile(file, stringifyMarkdown(parsed.content, parsed.data));
}

test('a correction that claims another meeting\'s original never gives its items that original\'s identity', async (t) => {
  const ws = await workspace(t);
  await digestWithCorrection(ws);
  // Re-confirmed as is, so only the claim is wrong: the meeting named is not the one the original belongs to.
  await changeUpdate(ws, 'CU-2026-0002', (d) => { (d['correction'] as Record<string, unknown>)['meeting'] = 'MQ-2026-0009'; delete (d['meeting_records'] as Record<string, unknown>[])[0]!['confirmed_hash']; });
  const revision = (await service.get('CU-2026-0002')).meeting_records[0]!.revision;
  await changeUpdate(ws, 'CU-2026-0002', (d) => { (d['meeting_records'] as Record<string, unknown>[])[0]!['confirmed_hash'] = revision; });
  assert.equal((await service.get('CU-2026-0002')).meeting_records[0]!.confirmation, 'confirmed');
  await assert.rejects(service.createActionItemTask('CU-2026-0002', 'M-01', { item: 0, revision, task: { title: 'x' } }), /not the current version/);
  assert.equal((await fsp.readdir(path.join(ws, 'tasks', 'active'))).filter((n) => n.startsWith('TASK-')).length, 0);
});

test('the original record removed while its digest stays: the meeting shows its corrections broken, and no task pins it', async (t) => {
  const ws = await workspace(t);
  await digestWithCorrection(ws);
  await changeUpdate(ws, 'CU-2026-0001', (d) => { d['meeting_records'] = []; });
  const m = (await new MeetingHistoryService().list()).find((x) => x.id === 'MQ-2026-0001')!;
  assert.deepEqual([m.correction?.state, m.record], ['broken', null]);
  await assert.rejects(resolveMeeting('MQ-2026-0001'), (err: Error & { statusCode?: number }) => err.statusCode === 409);
});

test('original first, then the correction: still one task', async (t) => {
  const ws = await workspace(t);
  await digestWithCorrection(ws);
  const fromOriginal = await service.createActionItemTask('CU-2026-0001', 'M-01', { item: 0, revision: (await service.get('CU-2026-0001')).meeting_records[0]!.revision, task: { title: 'Fictional task' } });
  const fromCorrection = await service.createActionItemTask('CU-2026-0002', 'M-01', { item: 0, revision: (await service.get('CU-2026-0002')).meeting_records[0]!.revision, task: { title: 'Fictional task' } });
  assert.deepEqual([fromOriginal.created, fromCorrection.created, fromCorrection.task.id], [true, false, fromOriginal.task.id]);
});

test('a corrected record must keep every original item: one left out is a problem', async (t) => {
  const ws = await workspace(t);
  await digestWithCorrection(ws);
  await changeUpdate(ws, 'CU-2026-0002', (d) => { (d['meeting_records'] as Record<string, unknown>[])[0]!['action_items'] = []; });
  const r = (await service.get('CU-2026-0002')).meeting_records[0]!;
  assert.ok(r.problems.some((p) => p.includes('not the original ones')));
  assert.equal(r.confirmation, null);
});

test('after confirming, editing the base or a slot\'s key in the envelope takes the confirmation away', async (t) => {
  for (const edit of [
    (c: Record<string, unknown>) => { (c['base'] as Record<string, unknown>)['revision'] = 'ffffffffffffffff'; },
    (c: Record<string, unknown>) => { (c['slots'] as Record<string, unknown>[])[0]!['root_key'] = '000000000000'; },
    (c: Record<string, unknown>) => { (c['slots'] as Record<string, unknown>[])[0]!['root_index'] = 1; },
    (c: Record<string, unknown>) => { (c['root'] as Record<string, unknown>)['record_id'] = 'M-02'; },
  ]) {
    const ws = await workspace(t);
    await digestWithCorrection(ws);
    await changeUpdate(ws, 'CU-2026-0002', (d) => edit(d['correction'] as Record<string, unknown>));
    assert.equal((await service.get('CU-2026-0002')).meeting_records[0]!.confirmation, null);
  }
});

test('the original and its correction made into a task at once, from two dashboards: one task', async (t) => {
  const ws = await workspace(t);
  await digestWithCorrection(ws);
  const { execFile } = await import('node:child_process');
  const revisions = new Map([['CU-2026-0001', ''], ['CU-2026-0002', '']]);
  for (const id of revisions.keys()) revisions.set(id, (await service.get(id)).meeting_records[0]!.revision);
  const child = (update: string) => new Promise<{ task?: string; created?: boolean; error?: string }>((resolve, reject) => {
    const revision = revisions.get(update)!;
    execFile(process.execPath, ['--import', 'tsx', path.join(__dirname, 'fixtures', 'action-task-child.ts'), update, 'M-01', revision],
      { env: { ...process.env, ESB_WORKSPACE_PATH: ws }, timeout: 60_000 }, (err, stdout) => {
        try { resolve(JSON.parse(stdout.trim().split('\n').pop() ?? '')); } catch { reject(err ?? new Error(stdout)); }
      });
  });
  const [a, b] = await Promise.all([child('CU-2026-0001'), child('CU-2026-0002')]);
  assert.ok(a.task && a.task === b.task, JSON.stringify([a, b]));
  assert.equal((await fsp.readdir(path.join(ws, 'tasks', 'active'))).filter((n) => n.startsWith('TASK-')).length, 1);
});
