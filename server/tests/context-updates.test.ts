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
  const saved = await service.addMaterial(id, '../../evil.md', Buffer.from('x'));
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
  await service.addMaterial(id, 'more.txt', Buffer.from('x'));

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
