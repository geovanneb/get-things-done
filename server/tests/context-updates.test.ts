import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { ContextUpdateService, proposalTarget, updateId } from '../src/services/contextUpdateService';
import { parseMarkdown, stringifyMarkdown } from '../src/utils/markdown';

/** A throwaway fictional workspace; the service reads its path from ESB_WORKSPACE_PATH. */
async function workspace(t: { after: (fn: () => Promise<void> | void) => void }): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-cu-'));
  const previous = process.env.ESB_WORKSPACE_PATH;
  process.env.ESB_WORKSPACE_PATH = dir;
  t.after(async () => {
    if (previous === undefined) delete process.env.ESB_WORKSPACE_PATH;
    else process.env.ESB_WORKSPACE_PATH = previous;
    await fsp.rm(dir, { recursive: true, force: true });
  });
  await fsp.mkdir(path.join(dir, 'context', 'strategy', 'growth-plan'), { recursive: true });
  await fsp.writeFile(path.join(dir, 'context', 'strategy', 'growth-plan', 'note.md'), '---\nid: CTX-growth-plan\n---\nOld plan\n');
  return dir;
}

/** What the analysis command writes: proposals in update.md and one draft per proposal. */
async function analyze(ws: string, id: string, proposals: Record<string, unknown>[], drafts: Record<string, string>): Promise<void> {
  const file = path.join(ws, 'context-updates', id, 'update.md');
  const parsed = parseMarkdown(await fsp.readFile(file, 'utf-8'));
  const data = { ...parsed.data, status: 'in_review', analyzed_at: new Date(Date.now() + 5000).toISOString(), summary: 'A fictional meeting.', proposals };
  await fsp.writeFile(file, stringifyMarkdown(parsed.content, data));
  await fsp.mkdir(path.join(ws, 'context-updates', id, 'proposals'), { recursive: true });
  for (const [name, content] of Object.entries(drafts)) await fsp.writeFile(path.join(ws, 'context-updates', id, 'proposals', name), content);
}

test('ids and proposal targets from requests or agent files are validated before use as paths', () => {
  assert.equal(updateId('CU-2026-0001'), 'CU-2026-0001');
  for (const bad of ['../CU-2026-0001', 'CU-2026-0001/..', 'CU-26-1', '', 'cu-2026-0001']) assert.throws(() => updateId(bad));

  assert.equal(proposalTarget('context/strategy/growth-plan/note.md'), 'context/strategy/growth-plan/note.md');
  assert.equal(proposalTarget('stakeholders/people/STK-0004.md'), 'stakeholders/people/STK-0004.md');
  for (const bad of [
    '../outside.md', 'context/../profile/executive-profile.md', '/etc/passwd.md', 'context/unknown/x/note.md',
    'CLAUDE.md', '.claude/commands/gtd-task.md', 'context/strategy/.hidden/note.md', 'context\\strategy\\x.md',
    'context/strategy/x/note.txt', 'stakeholders/other/x.md', 'context-updates/CU-2026-0001/update.md',
  ]) assert.equal(proposalTarget(bad), null, bad);
});

test('create stores pasted text as material and a second file with the same name never replaces the first', async (t) => {
  await workspace(t);
  const service = new ContextUpdateService();
  const update = await service.create({ title: 'Steering committee', source_date: '2026-10-20', notes: 'Budget figures are preliminary.', text: 'Transcript...' });
  assert.match(update.id, /^CU-\d{4}-0001$/);
  assert.equal(update.status, 'ready');
  assert.equal(update.notes, 'Budget figures are preliminary.');

  await service.addMaterial(update.id, 'deck.pptx', Buffer.from('a'));
  await service.addMaterial(update.id, 'deck.pptx', Buffer.from('b'));
  const detail = await service.get(update.id);
  assert.deepEqual(detail.materials.map((m) => m.name).sort(), ['deck-2.pptx', 'deck.pptx', 'pasted-text.md']);

  const second = await service.create({});
  assert.notEqual(second.id, update.id);
  await assert.rejects(service.create({ source_date: '20-10-2026' }), /source_date/);
});

test('material names cannot escape the materials folder', async (t) => {
  await workspace(t);
  const service = new ContextUpdateService();
  const { id } = await service.create({ text: 'x' });
  await assert.rejects(service.materialPath(id, '../update.md'), /traversal/);
  await assert.rejects(service.removeMaterial(id, '../update.md'), /Invalid file name/);
  const saved = await service.addMaterial(id, '../../evil.md', Buffer.from('evil'));
  assert.equal(saved.name, 'evil.md');
  await fsp.access(path.join(process.env.ESB_WORKSPACE_PATH!, 'context-updates', id, 'materials', 'evil.md'));
});

test('review shows current and proposed content, flags stale files and refuses targets outside the context', async (t) => {
  const ws = await workspace(t);
  const service = new ContextUpdateService();
  const { id } = await service.create({ text: 'x' });
  await analyze(ws, id, [
    { id: 'P-01', action: 'update', target: 'context/strategy/growth-plan/note.md', title: 'Refresh the plan', rationale: 'New targets' },
    { id: 'P-02', action: 'create', target: 'context/glossary/north-star/note.md', title: 'Add term', rationale: 'Used 6 times' },
    { id: 'P-03', action: 'update', target: '../profile/executive-profile.md', title: 'Escape', rationale: 'x' },
  ], { 'P-01.md': 'New plan\n', 'P-02.md': 'Term\n', 'P-03.md': 'x' });

  const detail = await service.get(id);
  const [p1, p2, p3] = detail.proposals;
  assert.equal(p1!.current, '---\nid: CTX-growth-plan\n---\nOld plan\n');
  assert.equal(p1!.proposed, 'New plan\n');
  assert.equal(p1!.stale, false);
  assert.equal(p2!.target_exists, false);
  assert.equal(p2!.stale, false);
  assert.ok(p3!.problem);
  assert.equal(p3!.current, null);

  // Edited after the analysis: the reviewer must know the diff is against newer content.
  const later = new Date(Date.now() + 60_000);
  await fsp.utimes(path.join(ws, 'context', 'strategy', 'growth-plan', 'note.md'), later, later);
  assert.equal((await service.get(id)).proposals[0]!.stale, true);
});

test('a symlinked target outside the workspace is not read', { skip: process.platform === 'win32' }, async (t) => {
  const ws = await workspace(t);
  const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-cu-outside-'));
  t.after(() => fsp.rm(outside, { recursive: true, force: true }));
  await fsp.writeFile(path.join(outside, 'secret.md'), 'private');
  await fsp.mkdir(path.join(ws, 'context', 'risks'), { recursive: true });
  await fsp.symlink(outside, path.join(ws, 'context', 'risks', 'linked'));
  const service = new ContextUpdateService();
  const { id } = await service.create({ text: 'x' });
  await analyze(ws, id, [{ id: 'P-01', action: 'update', target: 'context/risks/linked/secret.md', title: 'x', rationale: 'x' }], { 'P-01.md': 'x' });
  const [p] = (await service.get(id)).proposals;
  assert.equal(p!.current, null);
  assert.ok(p!.problem);
});

test('decisions, approval and closing follow the status flow', async (t) => {
  const ws = await workspace(t);
  const service = new ContextUpdateService();
  const { id } = await service.create({ text: 'x' });

  await assert.rejects(service.approve(id), /Cannot approve/);
  await analyze(ws, id, [
    { id: 'P-01', action: 'update', target: 'context/strategy/growth-plan/note.md', title: 'a', rationale: 'a', agent_field: 'kept' },
    { id: 'P-02', action: 'create', target: 'context/glossary/term/note.md', title: 'b', rationale: 'b' },
  ], { 'P-01.md': 'a', 'P-02.md': 'b' });
  await assert.rejects(service.addMaterial(id, 'late.txt', Buffer.from('x')), /Cannot add material/);
  await assert.rejects(service.saveDecisions(id, { 'P-99': { decision: 'accepted' } }), /Invalid proposal id/);
  await assert.rejects(service.saveDecisions(id, { 'P-01': { decision: 'maybe' } }), /Invalid decision/);
  await assert.rejects(service.approve(id), /select at least one/);

  await service.saveDecisions(id, { 'P-01': { decision: 'accepted', reviewer_note: 'Keep the old title' } });
  const approved = await service.approve(id);
  assert.equal(approved.status, 'approved');
  assert.deepEqual(approved.proposals.map((p) => p.decision), ['accepted', 'rejected']);
  assert.equal(approved.proposals[0]!.reviewer_note, 'Keep the old title');
  const raw = parseMarkdown(await fsp.readFile(path.join(ws, 'context-updates', id, 'update.md'), 'utf-8')).data as { proposals: Record<string, unknown>[] };
  assert.equal(raw.proposals[0]!['agent_field'], 'kept', 'fields the dashboard does not know survive its writes');

  assert.equal((await service.backToReview(id)).status, 'in_review');
  const closed = await service.close(id);
  assert.equal(closed.status, 'done');
  assert.deepEqual(closed.proposals.map((p) => p.decision), ['rejected', 'rejected']);
  assert.equal(closed.materials.length, 1, 'the record keeps the list of materials');
  await assert.rejects(fsp.access(path.join(ws, 'context-updates', id, 'materials')));
  await assert.rejects(fsp.access(path.join(ws, 'context-updates', id, 'proposals')));
  assert.equal((await fsp.readFile(path.join(ws, 'context', 'strategy', 'growth-plan', 'note.md'), 'utf-8')).includes('Old plan'), true);
});

test('reopen discards proposals so the next analysis sees all material, and applying cannot be deleted', async (t) => {
  const ws = await workspace(t);
  const service = new ContextUpdateService();
  const { id } = await service.create({ text: 'x' });
  await analyze(ws, id, [{ id: 'P-01', action: 'update', target: 'context/strategy/growth-plan/note.md', title: 'a', rationale: 'a' }], { 'P-01.md': 'a' });
  const reopened = await service.reopen(id);
  assert.equal(reopened.status, 'ready');
  assert.deepEqual(reopened.proposals, []);
  await assert.rejects(fsp.access(path.join(ws, 'context-updates', id, 'proposals')));
  await service.addMaterial(id, 'more.txt', Buffer.from('more'));

  const file = path.join(ws, 'context-updates', id, 'update.md');
  const parsed = parseMarkdown(await fsp.readFile(file, 'utf-8'));
  await fsp.writeFile(file, stringifyMarkdown(parsed.content, { ...parsed.data, status: 'applying' }));
  await assert.rejects(service.remove(id), /Cannot delete/);
});

test('an id written inside update.md never points the dashboard at another folder', async (t) => {
  const ws = await workspace(t);
  const service = new ContextUpdateService();
  const { id } = await service.create({ text: 'x' });
  const file = path.join(ws, 'context-updates', id, 'update.md');
  const parsed = parseMarkdown(await fsp.readFile(file, 'utf-8'));
  await fsp.writeFile(file, stringifyMarkdown(parsed.content, { ...parsed.data, id: '../../profile', source_date: new Date('2026-10-20') }));
  const [listed] = await service.list();
  assert.equal(listed!.id, id);
  assert.equal(listed!.source_date, '2026-10-20');
});

test('a done update left with materials by the agent is cleaned up when opened', async (t) => {
  const ws = await workspace(t);
  const service = new ContextUpdateService();
  const { id } = await service.create({ text: 'x' });
  const file = path.join(ws, 'context-updates', id, 'update.md');
  const parsed = parseMarkdown(await fsp.readFile(file, 'utf-8'));
  await fsp.writeFile(file, stringifyMarkdown(parsed.content, { ...parsed.data, status: 'done' }));
  await fsp.mkdir(path.join(ws, 'context-updates', id, 'proposals'));
  const detail = await service.get(id);
  assert.equal(detail.materials.length, 1, 'the record keeps the list');
  await assert.rejects(fsp.access(path.join(ws, 'context-updates', id, 'materials')));
  await assert.rejects(fsp.access(path.join(ws, 'context-updates', id, 'proposals')));
});

test('kept materials survive closing and opening a done update, and go only when the user releases them', async (t) => {
  const ws = await workspace(t);
  const service = new ContextUpdateService();
  const { id } = await service.create({ text: 'Transcript of a fictional meeting' });
  const materials = path.join(ws, 'context-updates', id, 'materials');
  await assert.rejects(service.keepMaterials(id, 'yes'), /Invalid keep/);
  assert.equal((await service.keepMaterials(id, true)).keep_materials, true);

  await analyze(ws, id, [{ id: 'P-01', action: 'update', target: 'context/strategy/growth-plan/note.md' }], { 'P-01.md': 'New plan\n' });
  assert.equal((await service.get(id)).keep_materials, true, 'the analysis rewrites update.md but keeps the choice');
  const closed = await service.close(id);
  assert.equal(closed.status, 'done');
  await assert.rejects(fsp.access(path.join(ws, 'context-updates', id, 'proposals')), 'drafts are always deleted');

  // The dashboard's cleanup of a done update must respect the choice too.
  const detail = await service.get(id);
  assert.deepEqual(detail.material_files.map((f) => f.name), ['pasted-text.md']);
  assert.equal(await fsp.readFile(await service.materialPath(id, 'pasted-text.md'), 'utf-8'), 'Transcript of a fictional meeting');
  await assert.rejects(service.keepMaterials(id, true), /Cannot keep the materials/);

  const released = await service.keepMaterials(id, false);
  assert.equal(released.keep_materials, false);
  assert.equal(released.materials.length, 1, 'the record keeps the list');
  await assert.rejects(fsp.access(materials));
  assert.equal('keep_materials' in parseMarkdown(await fsp.readFile(path.join(ws, 'context-updates', id, 'update.md'), 'utf-8')).data, false);
});

test('materials cannot be kept or released while the agent is applying', async (t) => {
  const ws = await workspace(t);
  const service = new ContextUpdateService();
  const { id } = await service.create({ text: 'x' });
  const file = path.join(ws, 'context-updates', id, 'update.md');
  const parsed = parseMarkdown(await fsp.readFile(file, 'utf-8'));
  await fsp.writeFile(file, stringifyMarkdown(parsed.content, { ...parsed.data, status: 'applying' }));
  await assert.rejects(service.keepMaterials(id, true), /Cannot keep/);
  await assert.rejects(service.keepMaterials(id, false), /Cannot release/);
});

test('simultaneous uploads preserve both files and the complete material inventory', async (t) => {
  await workspace(t);
  const service = new ContextUpdateService();
  const { id } = await service.create({});
  const saved = await Promise.all([
    service.addMaterial(id, 'meeting.txt', Buffer.from('first meeting')),
    new ContextUpdateService().addMaterial(id, 'meeting.txt', Buffer.from('second meeting')),
  ]);
  assert.equal(new Set(saved.map((f) => f.name)).size, 2);
  const contents = await Promise.all(saved.map(async (f) => fsp.readFile(await service.materialPath(id, f.name), 'utf8')));
  assert.deepEqual(contents, ['first meeting', 'second meeting']);
  assert.equal((await service.get(id)).materials.length, 2);
});

test('simultaneous review choices survive and approval waits for the preceding save', async (t) => {
  const ws = await workspace(t);
  const service = new ContextUpdateService();
  const { id } = await service.create({});
  await analyze(ws, id, [
    { id: 'P-01', action: 'update', target: 'context/strategy/growth-plan/note.md' },
    { id: 'P-02', action: 'create', target: 'context/glossary/term/note.md' },
  ], { 'P-01.md': 'a', 'P-02.md': 'b' });
  await Promise.all([
    service.saveDecisions(id, { 'P-01': { decision: 'accepted' } }),
    new ContextUpdateService().saveDecisions(id, { 'P-02': { decision: 'accepted' } }),
  ]);
  assert.deepEqual((await service.get(id)).proposals.map((p) => p.decision), ['accepted', 'accepted']);
  await Promise.all([
    service.saveDecisions(id, { 'P-02': { reviewer_note: 'Preserve the definition' } }),
    service.approve(id),
  ]);
  const approved = await service.get(id);
  assert.equal(approved.status, 'approved');
  assert.equal(approved.proposals[1]!.reviewer_note, 'Preserve the definition');
  await assert.rejects(service.saveDecisions(id, { 'P-01': { decision: null } }), /Cannot change decisions/);
  assert.equal((await service.backToReview(id)).status, 'in_review', 'a failed mutation must release the queue');
});

test('source dates reject impossible calendar days without changing the record', async (t) => {
  await workspace(t);
  const service = new ContextUpdateService();
  for (const source_date of ['2026-02-29', '2026-02-30', '2026-04-31']) {
    await assert.rejects(service.create({ source_date }), /source_date/);
  }
  const update = await service.create({ source_date: '2024-02-29' });
  await assert.rejects(service.edit(update.id, { source_date: '2026-02-30' }), /source_date/);
  assert.equal((await service.get(update.id)).source_date, '2024-02-29');
});

/** Two fictional meetings as the analysis writes them. */
const MEETINGS = [
  {
    id: 'M-01', title: 'Steering committee', meeting_date: '2026-10-20', source: 'transcript.txt',
    attendees: [{ ref: 'STK-0004', name: 'Jane Doe' }, { name: 'Speaker 2' }],
    decisions: ['The pilot moves to Q1.'], open_questions: ['Who owns the budget?'],
    action_items: [{ description: 'Send the revised plan', owner: { ref: 'me', name: 'me' }, due_date: '2026-10-27' }],
  },
  { id: 'M-02', title: 'Weekly sync', meeting_date: '2026-10-21', decisions: ['Keep the Friday demo.'] },
];

/** An update in review with the given meeting records and, optionally, proposals with drafts. */
async function withMeetings(t: Parameters<typeof workspace>[0], records: unknown[] = MEETINGS, proposals: Record<string, unknown>[] = [], drafts: Record<string, string> = {}) {
  const ws = await workspace(t);
  const service = new ContextUpdateService();
  const { id } = await service.create({ text: 'Transcript...' });
  await analyze(ws, id, proposals, drafts);
  const file = path.join(ws, 'context-updates', id, 'update.md');
  const edit = async (change: (records: Record<string, unknown>[]) => unknown[]) => {
    const parsed = parseMarkdown(await fsp.readFile(file, 'utf-8'));
    const current = (parsed.data['meeting_records'] ?? []) as Record<string, unknown>[];
    await fsp.writeFile(file, stringifyMarkdown(parsed.content, { ...parsed.data, meeting_records: change(current) }));
  };
  await edit(() => records);
  /** What the dashboard sends: the choice plus the revision the user saw. */
  const choose = async (choices: Record<string, 'confirmed' | 'rejected' | null>) => {
    const shown = await service.get(id);
    const body = Object.fromEntries(Object.entries(choices).map(([rid, confirmation]) =>
      [rid, { confirmation, revision: shown.meeting_records.find((r) => r.id === rid)?.revision }]));
    return service.saveMeetingRecords(id, body);
  };
  return { ws, service, id, file, edit, choose };
}

test('meeting records are shown as written: malformed or over-long content is flagged, never cut or converted', async (t) => {
  const hidden = `${'x'.repeat(1000)} DO NOT PROCEED`;
  const { service, id, choose } = await withMeetings(t, [
    { id: 'M-01', title: 'Long', decisions: [hidden], attendees: [{ ref: '../profile', name: 'Speaker 2' }, { name: '' }] },
    { id: 'M-02', title: 42, decisions: Array.from({ length: 31 }, (_, i) => `D${i}`), meeting_date: '2026-02-30' },
    { id: 'M-03', title: 'Fine', attendees: [{ ref: 'STK-0004', name: 'Jane Doe' }], action_items: [{ description: 'Plan', owner: { ref: 'me', name: 'me' } }] },
  ]);
  const [long, odd, fine] = (await service.get(id)).meeting_records;
  assert.equal(long!.decisions[0], hidden, 'the whole text is shown');
  assert.match(long!.problems.join(' '), /longer than 1000/);
  assert.match(long!.problems.join(' '), /not a stakeholder id/);
  assert.deepEqual(long!.attendees.map((p) => p.name), ['Speaker 2'], 'an empty person is left out, a bad ref is not linked');
  assert.equal(odd!.title, '');
  assert.match(odd!.problems.join(' '), /title is not text/);
  assert.match(odd!.problems.join(' '), /more than 30 entries/);
  assert.match(odd!.problems.join(' '), /not a date/);
  assert.equal(odd!.decisions.length, 31, 'no entry is dropped');
  assert.deepEqual(fine!.problems, []);
  assert.equal(fine!.attendees[0]!.ref_found, false, 'a link to a stakeholder that does not exist is shown as such');
  assert.equal(fine!.action_items[0]!.owner!.ref_found, true);

  await assert.rejects(choose({ 'M-01': 'confirmed' }), /cannot be confirmed/);
  await assert.rejects(choose({ 'M-02': 'confirmed' }), /cannot be confirmed/);
  const rejected = await choose({ 'M-01': 'rejected' });
  assert.equal(rejected.meeting_records[0]!.confirmation, 'rejected', 'a flawed record can still be rejected');
});

test('saving a choice never drops records over the limit, and more than 20 cannot be confirmed', async (t) => {
  const many = Array.from({ length: 21 }, (_, i) => ({ id: `M-${String(i + 1).padStart(2, '0')}`, title: `Meeting ${i + 1}` }));
  const { service, id, file, choose } = await withMeetings(t, many);
  const shown = await service.get(id);
  assert.equal(shown.meeting_records.length, 21);
  assert.match(shown.meeting_records[0]!.problems.join(' '), /more than 20/);
  await choose({ 'M-01': 'rejected' });
  const saved = parseMarkdown(await fsp.readFile(file, 'utf-8')).data['meeting_records'] as unknown[];
  assert.equal(saved.length, 21);
});

test('records without a unique id cannot be confirmed, so one choice never confirms two meetings', async (t) => {
  const { service, id, choose } = await withMeetings(t, [
    { id: 'M-02', title: 'First' }, { id: 'bad', title: 'Second' }, { id: 'M-02', title: 'Third' },
  ]);
  const records = (await service.get(id)).meeting_records;
  assert.equal(records[1]!.id, 'bad', 'the id stays as written; none is invented');
  assert.match(records[1]!.problems.join(' '), /no valid id/);
  assert.match(records[0]!.problems.join(' '), /same id M-02/);
  await assert.rejects(choose({ 'M-02': 'confirmed' }), /same id/);
  await assert.rejects(choose({ 'M-02': 'rejected' }), /same id/);
  await assert.rejects(choose({ bad: 'confirmed' }), /cannot be confirmed/);
  assert.deepEqual((await service.get(id)).meeting_records.map((r) => r.confirmation), [null, null, null], 'nothing was written');
});

test('a confirmation is bound to the content the user saw', async (t) => {
  const { service, id, edit, choose } = await withMeetings(t);
  const shown = await service.get(id);
  await edit((records) => records.map((r) => r['id'] === 'M-01' ? { ...r, title: 'Changed before the click' } : r));
  await assert.rejects(service.saveMeetingRecords(id, { 'M-01': { confirmation: 'confirmed', revision: shown.meeting_records[0]!.revision } }), /changed since you loaded it/);

  const confirmed = await choose({ 'M-01': 'confirmed' });
  assert.equal(confirmed.meeting_records[0]!.confirmation, 'confirmed');
  await edit((records) => records.map((r) => r['id'] === 'M-01' ? { ...r, title: 'Changed after confirmation' } : r));
  const changed = (await service.get(id)).meeting_records[0]!;
  assert.equal(changed.confirmation, null, 'changed content is no longer confirmed');
  assert.equal(changed.changed_since_confirmed, true);
  await assert.rejects(service.approve(id), /changed after you confirmed it/);
  await assert.rejects(service.close(id), /changed after you confirmed it/);
  assert.equal((await service.get(id)).status, 'in_review', 'nothing was finished or deleted');
  assert.equal((await choose({ 'M-01': 'confirmed' })).meeting_records[0]!.confirmation, 'confirmed', 'a new review clears it');
});

test('a confirmation written into the file by an agent is not the user\'s', async (t) => {
  const { service, id } = await withMeetings(t, [{ ...MEETINGS[1], confirmation: 'confirmed', confirmed_at: '2026-10-29T00:00:00.000Z' }]);
  assert.equal((await service.get(id)).meeting_records[0]!.confirmation, null);
  await assert.rejects(service.approve(id), /confirm a meeting record/);
});

test('meeting records are confirmed apart from the proposals, and only while reviewing', async (t) => {
  const { service, id, choose } = await withMeetings(t);
  await assert.rejects(service.saveMeetingRecords(id, { 'M-09': { confirmation: 'confirmed', revision: 'x' } }), /Invalid meeting record id/);
  await assert.rejects(choose({ 'M-01': 'yes' as never }), /Invalid confirmation/);

  let update = await choose({ 'M-01': 'confirmed' });
  assert.equal(update.meeting_records[0]!.confirmation, 'confirmed');
  assert.ok(update.meeting_records[0]!.confirmed_at);
  assert.equal(update.proposals.length, 0, 'records do not touch proposals');
  update = await choose({ 'M-01': null });
  assert.equal(update.meeting_records[0]!.confirmation, null);
  assert.equal(update.meeting_records[0]!.confirmed_at, null);
  assert.equal(update.meeting_records[0]!.title, 'Steering committee', 'the agent\'s fields survive');

  await assert.rejects(service.approve(id), /confirm a meeting record/);
  await service.close(id);
  await assert.rejects(choose({ 'M-01': 'confirmed' }), /Cannot confirm meeting records while the update is "done"/);
});

test('an update with only confirmed meeting records finishes on approval, without the apply command', async (t) => {
  const { ws, service, id, choose } = await withMeetings(t, MEETINGS,
    [{ id: 'P-01', action: 'update', target: 'context/strategy/growth-plan/note.md', title: 'Not this', rationale: 'x' }],
    { 'P-01.md': 'New plan\n' });
  await choose({ 'M-01': 'confirmed' });

  const done = await service.approve(id);
  assert.equal(done.status, 'done', 'a meeting record needs no file, so nothing is left to apply');
  assert.deepEqual(done.meeting_records.map((r) => r.confirmation), ['confirmed', 'rejected'], 'a record nobody confirmed is rejected');
  assert.equal(done.proposals[0]!.decision, 'rejected');
  assert.equal(done.proposals[0]!.outcome, 'skipped');
  assert.equal(await fsp.readFile(path.join(ws, 'context', 'strategy', 'growth-plan', 'note.md'), 'utf-8'), '---\nid: CTX-growth-plan\n---\nOld plan\n');
  await assert.rejects(fsp.access(path.join(ws, 'context-updates', id, 'materials')), 'the transcript goes unless it is kept');
  assert.equal((await service.get(id)).meeting_records[0]!.decisions[0], 'The pilot moves to Q1.', 'the confirmed record stays');
});

test('a confirmed record with an accepted removal finishes at once and still removes the file', async (t) => {
  const { ws, service, id, choose } = await withMeetings(t, MEETINGS,
    [{ id: 'P-01', action: 'remove', target: 'context/strategy/growth-plan/note.md', title: 'Obsolete', rationale: 'x' }]);
  await service.saveDecisions(id, { 'P-01': { decision: 'accepted' } });
  await choose({ 'M-02': 'confirmed' });
  const done = await service.approve(id);
  assert.equal(done.status, 'done');
  assert.equal(done.proposals[0]!.outcome, 'applied');
  await assert.rejects(fsp.access(path.join(ws, 'context', 'strategy', 'growth-plan')));
  assert.deepEqual(done.meeting_records.map((r) => r.confirmation), ['rejected', 'confirmed']);
});

test('with an accepted proposal, approval waits for the apply command and freezes the records', async (t) => {
  const { service, id, choose } = await withMeetings(t, MEETINGS,
    [{ id: 'P-01', action: 'update', target: 'context/strategy/growth-plan/note.md', title: 'Plan', rationale: 'x' }],
    { 'P-01.md': 'New plan\n' });
  await service.saveDecisions(id, { 'P-01': { decision: 'accepted' } });
  await choose({ 'M-02': 'confirmed' });
  const approved = await service.approve(id);
  assert.equal(approved.status, 'approved');
  assert.deepEqual(approved.meeting_records.map((r) => r.confirmation), ['rejected', 'confirmed']);
});

test('closing keeps confirmed records, and reopening discards every record with the proposals', async (t) => {
  const first = await withMeetings(t);
  await first.choose({ 'M-02': 'confirmed' });
  const reopened = await first.service.reopen(first.id);
  assert.deepEqual(reopened.meeting_records, [], 'a confirmation belongs to the record the user read');

  const second = await withMeetings(t);
  await second.choose({ 'M-01': 'confirmed' });
  const closed = await second.service.close(second.id);
  assert.deepEqual(closed.meeting_records.map((r) => r.confirmation), ['confirmed', 'rejected']);
});

test('a WebVTT transcript gets a readable copy, recorded by the dashboard, and the same file twice is refused', async (t) => {
  const ws = await workspace(t);
  const service = new ContextUpdateService();
  const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<v Jane Doe>Fictional words.</v>\n';
  const { id } = await service.create({ text: 'x' });
  const saved = await service.addMaterial(id, 'Weekly sync.vtt', Buffer.from(vtt));
  assert.equal(saved.name, 'Weekly_sync.vtt');
  assert.deepEqual([saved.transcript, saved.transcript_complete], ['Weekly_sync.transcript.md', true]);
  const dir = path.join(ws, 'context-updates', id, 'materials');
  assert.equal(await fsp.readFile(path.join(dir, 'Weekly_sync.vtt'), 'utf-8'), vtt, 'the original is kept as it was');
  assert.match(await fsp.readFile(path.join(dir, 'Weekly_sync.transcript.md'), 'utf-8'), /\[00:00:01 → 00:00:02\] Jane Doe\n {2}Fictional words\./);
  const [record] = (await service.get(id)).transcripts;
  assert.deepEqual([record!.file, record!.source, record!.complete], ['Weekly_sync.transcript.md', 'Weekly_sync.vtt', true]);

  await assert.rejects(service.addMaterial(id, 'copy.vtt', Buffer.from(vtt)), /already in the update, as Weekly_sync\.vtt/);
  assert.equal((await service.addMaterial(id, 'notes.txt', Buffer.from('Not a transcript'))).transcript, undefined, 'other files are saved as they are');

  await service.removeMaterial(id, 'Weekly_sync.vtt');
  const after = await service.get(id);
  assert.deepEqual(after.materials.map((m) => m.name).sort(), ['notes.txt', 'pasted-text.md'], 'the copy goes with its original');
  assert.deepEqual(after.transcripts, []);

  const pasted = await service.create({ text: vtt });
  const pastedDetail = await service.get(pasted.id);
  assert.deepEqual(pastedDetail.materials.map((m) => m.name).sort(), ['pasted-text.transcript.md', 'pasted-text.vtt'], 'pasted WebVTT is handled like an upload');
  assert.equal(pastedDetail.transcripts[0]?.source, 'pasted-text.vtt');
});

test('only a copy the dashboard recorded goes with its original, and never one that was changed', async (t) => {
  const ws = await workspace(t);
  const service = new ContextUpdateService();
  const { id } = await service.create({ text: 'notes' });
  const dir = path.join(ws, 'context-updates', id, 'materials');
  await service.addMaterial(id, 'independent.transcript.md', Buffer.from('<!-- gtd:transcript source="pasted-text.md" -->\nMy own notes'));
  await service.removeMaterial(id, 'pasted-text.md');
  await fsp.access(path.join(dir, 'independent.transcript.md'));

  const vtt = (n: number) => Buffer.from(`WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<v A>Words ${n}.</v>\n`);
  const first = await service.addMaterial(id, 'sync.vtt', vtt(1));
  await fsp.appendFile(path.join(dir, first.transcript!), '\nMy correction.');
  await service.removeMaterial(id, 'sync.vtt');
  await fsp.access(path.join(dir, first.transcript!));
  assert.deepEqual((await service.get(id)).transcripts, [], 'the changed copy stays, as an ordinary file');

  await service.addMaterial(id, 'sync.vtt', vtt(2));
  const third = await service.addMaterial(id, 'sync.txt', Buffer.concat([vtt(3)]));
  assert.equal(third.transcript, 'sync-3.transcript.md', 'a name collision keeps the .transcript.md ending');
  assert.deepEqual((await service.get(id)).transcripts.map((x) => [x.source, x.file]), [['sync.vtt', 'sync-2.transcript.md'], ['sync.txt', 'sync-3.transcript.md']]);
});

test('a transcript that cannot be converted is saved alone, with the reason, and can be removed and added again', async (t) => {
  const ws = await workspace(t);
  const service = new ContextUpdateService();
  const { id } = await service.create({ text: 'x' });
  const odd = await service.addMaterial(id, 'broken.vtt', Buffer.from([0xfe, 0xff, 0x41]));
  assert.equal(odd.transcript, undefined);
  assert.match(odd.transcript_problem!, /not valid UTF-8 or UTF-16/);
  const notVtt = await service.addMaterial(id, 'wrong.vtt', Buffer.from('Hello'));
  assert.match(notVtt.transcript_problem!, /does not start with WEBVTT/);
  assert.equal((await service.addMaterial(id, 'bytes.txt', Buffer.from([0x57, 0xff]))).transcript_problem, undefined, 'a .txt that is not text is just a file');

  const partial = await service.addMaterial(id, 'partial.vtt', Buffer.from('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nok\n\nstray block\n'));
  assert.equal(partial.transcript_complete, false);
  assert.match(await fsp.readFile(path.join(ws, 'context-updates', id, 'materials', partial.transcript!), 'utf-8'), /\*\*Incomplete\.\*\*/);

  assert.deepEqual((await service.get(id)).transcript_problems.map((p) => p.source), ['broken.vtt', 'wrong.vtt'], 'the reason stays with the update');
  await service.removeMaterial(id, 'broken.vtt');
  assert.deepEqual((await service.get(id)).transcript_problems.map((p) => p.source), ['wrong.vtt']);
  await service.addMaterial(id, 'broken.vtt', Buffer.from([0xfe, 0xff, 0x41]));
  assert.ok((await service.get(id)).materials.some((m) => m.name === 'broken.vtt'), 'metadata and files stay in step');
});

test('a copy no longer counts once its source or the copy itself was edited, and pasted problems are kept', async (t) => {
  const ws = await workspace(t);
  const service = new ContextUpdateService();
  const { id } = await service.create({ text: 'x' });
  const dir = path.join(ws, 'context-updates', id, 'materials');
  const saved = await service.addMaterial(id, 'sync.vtt', Buffer.from('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<v A>Launch.</v>\n'));
  assert.equal((await service.get(id)).transcripts[0]!.current, true);
  await fsp.writeFile(path.join(dir, 'sync.vtt'), 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<v A>Do not launch.</v>\n');
  assert.equal((await service.get(id)).transcripts[0]!.current, false, 'an edited source');

  const other = await service.addMaterial(id, 'other.vtt', Buffer.from('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<v B>Yes.</v>\n'));
  await fsp.appendFile(path.join(dir, other.transcript!), 'edited');
  assert.equal((await service.get(id)).transcripts.find((x) => x.source === 'other.vtt')!.current, false, 'an edited copy');
  assert.ok(saved.transcript);

  const pasted = await service.create({ text: 'WEBVTT\n\nnot a cue\n' });
  assert.deepEqual((await service.get(pasted.id)).transcript_problems, [{ source: 'pasted-text.vtt', reason: 'No cue could be read, so no readable copy was made.' }]);
});
