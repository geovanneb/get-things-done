import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { RoutineService } from '../src/services/routineService';
import { TaskService } from '../src/services/taskService';
import { ContextUpdateService } from '../src/services/contextUpdateService';
import { CLEANUP_ORIGIN, defaultSettings, parseSettings, SystemCleanupService } from '../src/services/systemCleanupService';
import { parseMarkdown, stringifyMarkdown } from '../src/utils/markdown';

/** A throwaway fictional workspace; services read its path from ESB_WORKSPACE_PATH. */
async function workspace(t: { after: (fn: () => Promise<void> | void) => void }): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-cleanup-'));
  const previous = process.env.ESB_WORKSPACE_PATH;
  process.env.ESB_WORKSPACE_PATH = dir;
  t.after(async () => {
    if (previous === undefined) delete process.env.ESB_WORKSPACE_PATH;
    else process.env.ESB_WORKSPACE_PATH = previous;
    await fsp.rm(dir, { recursive: true, force: true });
  });
  for (const d of ['tasks/active', 'tasks/archive', 'context-updates', 'kaizen', '.situation-board/trash']) {
    await fsp.mkdir(path.join(dir, d), { recursive: true });
  }
  return dir;
}

const local = (s: string) => new Date(s);

async function write(ws: string, rel: string, data: Record<string, unknown>, body = ''): Promise<void> {
  await fsp.mkdir(path.dirname(path.join(ws, rel)), { recursive: true });
  await fsp.writeFile(path.join(ws, rel), stringifyMarkdown(body, data));
}

async function task(ws: string, folder: 'active' | 'archive', id: string, fields: Record<string, unknown>): Promise<void> {
  await write(ws, `tasks/${folder}/${id}/task.md`, { schema_version: '1.0', id, type: 'task', title: `Fictional ${id}`, priority: 'medium', created_at: '2026-01-01T00:00:00.000Z', ...fields });
}

async function note(ws: string, category: string, slug: string, title: string, body: string, updatedAt = '2026-10-01T00:00:00.000Z'): Promise<void> {
  await write(ws, `context/${category}/${slug}/note.md`, { schema_version: '1.0', id: `CTX-${slug}`, type: 'context', title, category, created_at: '2026-01-01T00:00:00.000Z', updated_at: updatedAt }, body);
}

const exists = (p: string) => fsp.access(p).then(() => true, () => false);

test('by default the job runs weekly, only opens a memory review tagged with its origin, and archives or deletes nothing', async (t) => {
  const ws = await workspace(t);
  const service = new RoutineService();
  await note(ws, 'strategy', 'growth-plan', 'Growth plan', 'Grow the fictional Northwind business in two new regions.');
  await note(ws, 'strategy', 'growth-plan-copy', 'Growth Plan', 'Grow the fictional Northwind business in two new regions.');
  await task(ws, 'active', 'TASK-2026-0001', { status: 'done', done_date: '2025-01-01T00:00:00.000Z', updated_at: '2025-01-01T00:00:00.000Z' });
  await task(ws, 'archive', 'TASK-2026-0002', { status: 'archived', updated_at: '2024-01-01T00:00:00.000Z' });

  const view = await service.systemCleanup(local('2026-10-28T10:00'));
  assert.equal(view.summary, 'Every Monday at 09:00');
  assert.equal(view.settings.memory_review.enabled, true);
  assert.ok(Object.values(view.settings.rules).every((r) => !r.enabled), 'every file rule is off by default');

  // The first check only starts the clock: nothing is "missed" from before the job existed.
  assert.deepEqual(await service.runDue('timer', local('2026-10-28T10:00')), []);

  const runs = await service.runDue('timer', local('2026-11-02T09:01'));
  const run = runs.find((r) => r.routine_id === 'SYSTEM-CLEANUP');
  assert.ok(run, 'the weekly run is in the history');
  assert.equal(run!.status, 'ok');
  assert.match(run!.context_update ?? '', /^CU-\d{4}-\d{4}$/);
  assert.equal(run!.cleaned, undefined);

  const update = await new ContextUpdateService().get(run!.context_update!);
  assert.equal(update.origin, CLEANUP_ORIGIN);
  assert.equal(update.kind, 'memory-review');
  assert.equal(update.status, 'ready');
  assert.deepEqual(update.material_files.map((f) => f.name), ['memory-scan.md']);
  const scan = await fsp.readFile(path.join(ws, 'context-updates', update.id, 'materials', 'memory-scan.md'), 'utf-8');
  assert.match(scan, /Same title: `context\/strategy\/growth-plan(-copy)?\/note.md`/);

  assert.ok(await exists(path.join(ws, 'tasks/active/TASK-2026-0001/task.md')), 'an old finished task stays where it is');
  assert.ok(await exists(path.join(ws, 'tasks/archive/TASK-2026-0002/task.md')), 'an old archived task stays where it is');

  // While that review is open, the next week does not pile up another one.
  const next = (await service.runDue('timer', local('2026-11-09T09:01'))).find((r) => r.routine_id === 'SYSTEM-CLEANUP');
  assert.equal(next, undefined);
  assert.equal((await new ContextUpdateService().list()).length, 1);
});

test('an update imported through the API cannot claim to come from the cleanup job', async (t) => {
  await workspace(t);
  const created = await new ContextUpdateService().create({ title: 'Fictional import', origin: CLEANUP_ORIGIN, kind: 'memory-review' } as never);
  assert.equal(created.origin, null);
  assert.equal(created.kind, null);
});

test('enabled rules archive, trash or delete only finished items older than their threshold', async (t) => {
  const ws = await workspace(t);
  const service = new RoutineService();
  const old = '2026-01-01T00:00:00.000Z';
  await task(ws, 'active', 'TASK-2026-0001', { status: 'done', done_date: old, updated_at: old });
  await task(ws, 'active', 'TASK-2026-0002', { status: 'done', done_date: '2026-10-20T00:00:00.000Z' });
  await task(ws, 'active', 'TASK-2026-0003', { status: 'in_progress', updated_at: old });
  await task(ws, 'active', 'TASK-2026-0004', { status: 'done', done_date: old, tags: ['keep'] });
  await task(ws, 'active', 'TASK-2026-0005', { status: 'done', done_date: '2027-05-01T00:00:00.000Z' });
  await task(ws, 'archive', 'TASK-2026-0006', { status: 'archived', updated_at: '2025-01-01T00:00:00.000Z' });
  await write(ws, 'kaizen/KAIZEN-2026-001.md', { id: 'KAIZEN-2026-001', status: 'applied', applied_at: old, created_at: old, title: 'Old fix' });
  await write(ws, 'kaizen/KAIZEN-2026-002.md', { id: 'KAIZEN-2026-002', status: 'proposed', created_at: old, title: 'Open' });
  await write(ws, 'context-updates/CU-2026-0001/update.md', { id: 'CU-2026-0001', type: 'context-update', title: 'Done', status: 'done', source_date: '2026-01-01', created_at: old, applied_at: old });
  await write(ws, 'context-updates/CU-2026-0002/update.md', { id: 'CU-2026-0002', type: 'context-update', title: 'Kept', status: 'done', keep_materials: true, source_date: '2026-01-01', created_at: old, applied_at: old });
  await write(ws, 'context-updates/CU-2026-0003/update.md', { id: 'CU-2026-0003', type: 'context-update', title: 'Open', status: 'in_review', source_date: '2026-01-01', created_at: old });
  const trash = path.join(ws, '.situation-board', 'trash');
  await fsp.writeFile(path.join(trash, '2026-01-02T03-04-05-678Z-00000000-0000-4000-8000-000000000000-old.md'), 'old');
  await fsp.writeFile(path.join(trash, '2026-10-27T03-04-05-678Z-00000000-0000-4000-8000-000000000001-new.md'), 'new');
  await fsp.writeFile(path.join(trash, 'put-here-by-hand.md'), 'not ours');

  await service.updateSystemCleanup({
    memory_review: { enabled: false },
    rules: {
      completed_tasks: { enabled: true, older_than_days: 30, action: 'archive' },
      archived_tasks: { enabled: true, older_than_days: 365, action: 'delete' },
      context_updates: { enabled: true, older_than_days: 90, action: 'trash' },
      kaizen: { enabled: true, older_than_days: 90, action: 'trash' },
      trash: { enabled: true, older_than_days: 30 },
    },
  }, local('2026-10-28T10:00'));

  const preview = await service.previewSystemCleanup(undefined, local('2026-10-28T10:00'));
  assert.deepEqual(preview.plan.items.map((i) => i.id).sort(),
    ['2026-01-02T03-04-05-678Z-00000000-0000-4000-8000-000000000000-old.md', 'CU-2026-0001', 'KAIZEN-2026-001', 'TASK-2026-0001', 'TASK-2026-0006'].sort());
  assert.ok(await exists(path.join(ws, 'tasks/active/TASK-2026-0001')), 'a preview changes nothing');

  const run = await service.runSystemCleanupNow(local('2026-10-28T10:00'));
  assert.equal(run.status, 'ok', run.message);
  assert.equal(run.cleaned?.length, 5);

  assert.ok(await exists(path.join(ws, 'tasks/archive/TASK-2026-0001/task.md')), 'old finished task archived');
  for (const id of ['TASK-2026-0002', 'TASK-2026-0003', 'TASK-2026-0004', 'TASK-2026-0005']) {
    assert.ok(await exists(path.join(ws, 'tasks/active', id)), `${id} untouched (recent, open, kept or dated in the future)`);
  }
  assert.equal(await exists(path.join(ws, 'tasks/archive/TASK-2026-0006')), false, 'old archived task deleted');
  assert.equal(await exists(path.join(ws, 'kaizen/KAIZEN-2026-001.md')), false);
  assert.ok(await exists(path.join(ws, 'kaizen/KAIZEN-2026-002.md')), 'an open proposal stays');
  assert.equal(await exists(path.join(ws, 'context-updates/CU-2026-0001')), false);
  assert.ok(await exists(path.join(ws, 'context-updates/CU-2026-0002')), 'kept materials are the user\'s choice');
  assert.ok(await exists(path.join(ws, 'context-updates/CU-2026-0003')), 'an update in progress stays');

  const left = await fsp.readdir(trash);
  assert.ok(!left.some((n) => n.endsWith('-old.md')), 'old trash emptied');
  assert.ok(left.some((n) => n.endsWith('-new.md')), 'recent trash kept');
  assert.ok(left.includes('put-here-by-hand.md'), 'files the app did not name are never purged');
  assert.ok(left.some((n) => n.endsWith('-CU-2026-0001')) && left.some((n) => n.endsWith('-KAIZEN-2026-001.md')), 'trashed items are in the trash');
});

test('ids of removed tasks and updates are never handed out again', async (t) => {
  const ws = await workspace(t);
  const service = new RoutineService();
  const year = new Date().getFullYear();
  const old = `${year - 3}-01-01T00:00:00.000Z`;
  await task(ws, 'archive', `TASK-${year}-0007`, { status: 'archived', updated_at: old });
  await write(ws, `context-updates/CU-${year}-0004/update.md`, { id: `CU-${year}-0004`, type: 'context-update', title: 'Done', status: 'done', source_date: '2020-01-01', created_at: old, applied_at: old });
  await service.updateSystemCleanup({
    memory_review: { enabled: false },
    rules: { archived_tasks: { enabled: true, older_than_days: 30, action: 'delete' }, context_updates: { enabled: true, older_than_days: 30, action: 'delete' } },
  });
  const run = await service.runSystemCleanupNow();
  assert.equal(run.cleaned?.length, 2, run.message);

  const next = await new TaskService().createTask({ title: 'Fictional new task' } as never);
  assert.equal(next.id, `TASK-${year}-0008`);
  const update = await new ContextUpdateService().create({ title: 'Fictional import' });
  assert.equal(update.id, `CU-${year}-0005`);
});

test('a symlinked task folder is never followed or removed', async (t) => {
  const ws = await workspace(t);
  const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-outside-'));
  t.after(() => fsp.rm(outside, { recursive: true, force: true }));
  await fsp.writeFile(path.join(outside, 'task.md'), stringifyMarkdown('', { id: 'TASK-2026-0009', status: 'archived', updated_at: '2020-01-01T00:00:00.000Z' }));
  await fsp.symlink(outside, path.join(ws, 'tasks/archive/TASK-2026-0009'));
  const service = new RoutineService();
  await service.updateSystemCleanup({ memory_review: { enabled: false }, rules: { archived_tasks: { enabled: true, older_than_days: 30, action: 'delete' } } });
  await service.runSystemCleanupNow();
  assert.ok(await exists(path.join(outside, 'task.md')), 'the target outside the workspace survives');
});

test('settings are validated, and an unreadable settings file stops the job instead of falling back to defaults', async (t) => {
  const ws = await workspace(t);
  for (const bad of [
    { rules: { kaizen: { action: 'archive' } } },
    { rules: { trash: { action: 'trash' } } },
    { rules: { completed_tasks: { older_than_days: 0 } } },
    { memory_review: { stale_after_days: 'soon' } },
    { keep_tag: '../x' },
    { schedule: { frequency: 'hourly' } },
    { enabled: 'yes' },
  ]) assert.throws(() => parseSettings(bad), JSON.stringify(bad));
  assert.deepEqual(parseSettings({}), defaultSettings());

  await fsp.mkdir(path.join(ws, '.situation-board/routines'), { recursive: true });
  await fsp.writeFile(path.join(ws, '.situation-board/routines/system-cleanup.json'), '{"rules":{"trash":{"action":"archive"}}}');
  await assert.rejects(new RoutineService().systemCleanup(), /cannot be read/);
});

test('accepted removals move the note folder to the trash, and are held back when another change failed', async (t) => {
  const ws = await workspace(t);
  const cu = new ContextUpdateService();
  await note(ws, 'glossary', 'old-term', 'Old term', 'A fictional term nobody uses any more.');
  await fsp.writeFile(path.join(ws, 'context/glossary/old-term/diagram.png'), 'png');
  const update = await cu.create({ title: 'Fictional review' });
  const file = path.join(ws, 'context-updates', update.id, 'update.md');
  const parsed = parseMarkdown(await fsp.readFile(file, 'utf-8'));
  await fsp.writeFile(file, stringifyMarkdown(parsed.content, {
    ...parsed.data, status: 'in_review', analyzed_at: new Date(Date.now() + 5000).toISOString(),
    proposals: [{ id: 'P-01', action: 'remove', target: 'context/glossary/old-term/note.md', title: 'Remove an unused term', rationale: 'Never used.' }],
  }));
  const detail = await cu.get(update.id);
  assert.equal(detail.proposals[0]!.action, 'remove');
  assert.equal(detail.proposals[0]!.problem, null);
  assert.match(detail.proposals[0]!.current ?? '', /nobody uses/);

  await cu.saveDecisions(update.id, { 'P-01': { decision: 'accepted' } });
  const approved = await cu.approve(update.id);
  assert.equal(approved.status, 'done', 'removals alone need no agent run');
  assert.equal(approved.proposals[0]!.outcome, 'applied');
  assert.equal(await exists(path.join(ws, 'context/glossary/old-term')), false);
  const trashed = (await fsp.readdir(path.join(ws, '.situation-board/trash'))).find((n) => n.endsWith('-old-term'));
  assert.ok(trashed && await exists(path.join(ws, '.situation-board/trash', trashed, 'diagram.png')), 'the attachments went with the note');

  // A merge: update one note, remove the other. The update failed, so the removal must wait.
  await note(ws, 'programs', 'alpha', 'Alpha', 'Program alpha.');
  await note(ws, 'programs', 'alpha-2', 'Alpha 2', 'Program alpha, again.');
  const merge = await cu.create({ title: 'Fictional merge' });
  const mergeFile = path.join(ws, 'context-updates', merge.id, 'update.md');
  const m = parseMarkdown(await fsp.readFile(mergeFile, 'utf-8'));
  await fsp.writeFile(mergeFile, stringifyMarkdown(m.content, {
    ...m.data, status: 'done', applied_at: new Date().toISOString(),
    proposals: [
      { id: 'P-01', action: 'update', target: 'context/programs/alpha/note.md', title: 'Merge', rationale: 'x', decision: 'accepted', outcome: 'failed' },
      { id: 'P-02', action: 'remove', target: 'context/programs/alpha-2/note.md', title: 'Remove the copy', rationale: 'x', decision: 'accepted' },
    ],
  }));
  const held = await cu.get(merge.id);
  assert.equal(held.proposals[1]!.outcome, 'skipped');
  assert.ok(await exists(path.join(ws, 'context/programs/alpha-2/note.md')), 'the copy is kept when the merge did not land');
});


test('cleanup never deletes through a symlinked parent directory', async (t) => {
  const ws = await workspace(t);
  const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-cleanup-outside-'));
  t.after(() => fsp.rm(outside, { recursive: true, force: true }));
  await fsp.mkdir(path.join(outside, 'TASK-2026-0009'));
  const file = path.join(outside, 'TASK-2026-0009/task.md');
  await fsp.writeFile(file, stringifyMarkdown('', { id: 'TASK-2026-0009', status: 'archived', updated_at: '2020-01-01' }));
  await fsp.rmdir(path.join(ws, 'tasks/archive'));
  await fsp.symlink(outside, path.join(ws, 'tasks/archive'));
  const service = new RoutineService();
  await service.updateSystemCleanup({ memory_review: { enabled: false }, rules: { archived_tasks: { enabled: true, action: 'delete' } } });
  const run = await service.runSystemCleanupNow();
  assert.equal(run.status, 'error');
  assert.ok(await exists(file), 'external task must survive');
});

test('date-prefixed hand-written trash entries are never purged', async (t) => {
  const ws = await workspace(t);
  const file = path.join(ws, '.situation-board/trash/2020-01-01T00-00-00-000Z-important.md');
  await fsp.writeFile(file, 'Fictional manually retained file');
  const service = new RoutineService();
  await service.updateSystemCleanup({ memory_review: { enabled: false }, rules: { trash: { enabled: true } } });
  await service.runSystemCleanupNow();
  assert.ok(await exists(file));
});

test('cleanup rechecks a task age after planning', async (t) => {
  const ws = await workspace(t);
  const id = 'TASK-2026-0001';
  await task(ws, 'active', id, { status: 'done', done_date: '2020-01-01' });
  const service = new SystemCleanupService();
  const settings = parseSettings({ memory_review: { enabled: false }, rules: { completed_tasks: { enabled: true, action: 'delete' } } });
  await service.writeSettings(settings);
  const plan = service.plan.bind(service);
  service.plan = async (...args) => {
    const result = await plan(...args);
    await task(ws, 'active', id, { status: 'done', done_date: '2026-10-28' });
    return result;
  };
  const result = await service.runNow(local('2026-10-28T10:00'));
  assert.equal(result.cleaned.length, 0);
  assert.ok(await exists(path.join(ws, 'tasks/active', id)));
});

test('settings read errors other than a missing file stop cleanup', async (t) => {
  const ws = await workspace(t);
  await fsp.mkdir(path.join(ws, '.situation-board/routines/system-cleanup.json'), { recursive: true });
  await assert.rejects(new SystemCleanupService().readSettings(), /cannot be read/);
});

test('accepted removals wait for positive confirmation that the merged content was applied', async (t) => {
  const ws = await workspace(t);
  for (const outcome of [undefined, 'skipped']) {
    await note(ws, 'programs', 'source', 'Source', 'Fictional source content that must survive.');
    const cu = new ContextUpdateService();
    const update = await cu.create({ title: 'Fictional incomplete merge' });
    const file = path.join(ws, 'context-updates', update.id, 'update.md');
    const parsed = parseMarkdown(await fsp.readFile(file, 'utf-8'));
    await fsp.writeFile(file, stringifyMarkdown(parsed.content, { ...parsed.data, status: 'done', proposals: [
      { id: 'P-01', action: 'update', target: 'context/programs/destination/note.md', decision: 'accepted', ...(outcome ? { outcome } : {}) },
      { id: 'P-02', action: 'remove', target: 'context/programs/source/note.md', decision: 'accepted' },
    ] }));
    const result = await cu.get(update.id);
    assert.equal(result.proposals[1]!.outcome, 'skipped');
    assert.ok(await exists(path.join(ws, 'context/programs/source/note.md')));
  }
});

test('a removal goes ahead when the other accepted change was merged', async (t) => {
  const ws = await workspace(t);
  await note(ws, 'programs', 'source', 'Source', 'Fictional source content.');
  const cu = new ContextUpdateService();
  const update = await cu.create({ title: 'Fictional finished merge' });
  const file = path.join(ws, 'context-updates', update.id, 'update.md');
  const parsed = parseMarkdown(await fsp.readFile(file, 'utf-8'));
  await fsp.writeFile(file, stringifyMarkdown(parsed.content, { ...parsed.data, status: 'done', proposals: [
    { id: 'P-01', action: 'update', target: 'context/programs/destination/note.md', decision: 'accepted', outcome: 'merged' },
    { id: 'P-02', action: 'remove', target: 'context/programs/source/note.md', decision: 'accepted' },
  ] }));
  const result = await cu.get(update.id);
  assert.equal(result.proposals[1]!.outcome, 'applied');
  assert.ok(!(await exists(path.join(ws, 'context/programs/source/note.md'))));
});

test('a removal never follows a note symlink to another workspace folder', async (t) => {
  const ws = await workspace(t);
  await note(ws, 'programs', 'source', 'Source', 'Fictional source.');
  await note(ws, 'programs', 'destination', 'Destination', 'Fictional destination.');
  const source = path.join(ws, 'context/programs/source/note.md');
  await fsp.unlink(source);
  await fsp.symlink(path.join(ws, 'context/programs/destination/note.md'), source);
  const cu = new ContextUpdateService();
  const update = await cu.create({ title: 'Fictional linked note' });
  const file = path.join(ws, 'context-updates', update.id, 'update.md');
  const parsed = parseMarkdown(await fsp.readFile(file, 'utf-8'));
  await fsp.writeFile(file, stringifyMarkdown(parsed.content, { ...parsed.data, status: 'done', proposals: [
    { id: 'P-01', action: 'remove', target: 'context/programs/source/note.md', decision: 'accepted' },
  ] }));
  const result = await cu.get(update.id);
  assert.equal(result.proposals[0]!.outcome, 'failed');
  assert.ok(await exists(path.join(ws, 'context/programs/destination/note.md')));
});

test('a symlinked trash destination cannot receive workspace content', async (t) => {
  const ws = await workspace(t);
  const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-trash-outside-'));
  t.after(() => fsp.rm(outside, { recursive: true, force: true }));
  await fsp.rmdir(path.join(ws, '.situation-board/trash'));
  await fsp.symlink(outside, path.join(ws, '.situation-board/trash'));
  await task(ws, 'archive', 'TASK-2026-0001', { status: 'archived', updated_at: '2020-01-01' });
  const service = new RoutineService();
  await service.updateSystemCleanup({ memory_review: { enabled: false }, rules: { archived_tasks: { enabled: true, action: 'trash' } } });
  assert.equal((await service.runSystemCleanupNow()).status, 'error');
  assert.ok(await exists(path.join(ws, 'tasks/archive/TASK-2026-0001/task.md')));
  assert.deepEqual(await fsp.readdir(outside), []);
});

test('corrupt ID reservations stop cleanup and new IDs instead of reusing old links', async (t) => {
  const ws = await workspace(t);
  await fsp.writeFile(path.join(ws, '.situation-board/reserved-ids.json'), '{broken');
  const id = `TASK-${new Date().getFullYear()}-0001`;
  await task(ws, 'archive', id, { status: 'archived', updated_at: '2020-01-01' });
  const service = new RoutineService();
  await service.updateSystemCleanup({ memory_review: { enabled: false }, rules: { archived_tasks: { enabled: true, action: 'delete' } } });
  const result = await service.runSystemCleanupNow();
  assert.equal(result.status, 'error');
  assert.ok(await exists(path.join(ws, 'tasks/archive', id)));
  await assert.rejects(new TaskService().createTask({ title: 'Fictional new task' } as never), /reservations/);
});

test('a newly rejected old kaizen proposal starts retention when rejected', async (t) => {
  const ws = await workspace(t);
  const { KaizenService } = await import('../src/services/kaizenService');
  await write(ws, 'kaizen/KAIZEN-2026-001.md', { id: 'KAIZEN-2026-001', title: 'Fictional proposal', status: 'proposed', created_at: '2020-01-01' });
  await new KaizenService().updateKaizen('KAIZEN-2026-001', { status: 'rejected' });
  const service = new RoutineService();
  await service.updateSystemCleanup({ memory_review: { enabled: false }, rules: { kaizen: { enabled: true, action: 'delete' } } });
  await service.runSystemCleanupNow();
  assert.ok(await exists(path.join(ws, 'kaizen/KAIZEN-2026-001.md')));
  const raw = parseMarkdown(await fsp.readFile(path.join(ws, 'kaizen/KAIZEN-2026-001.md'), 'utf8'));
  assert.equal(raw.data['title'], 'Fictional proposal');
  assert.ok(raw.data['rejected_at']);
});


test('kaizen updates preserve YAML-sensitive titles and extra frontmatter', async (t) => {
  const ws = await workspace(t);
  const { KaizenService } = await import('../src/services/kaizenService');
  const file = path.join(ws, 'kaizen/KAIZEN-2026-001.md');
  await write(ws, 'kaizen/KAIZEN-2026-001.md', { id: 'KAIZEN-2026-001', title: 'Fictional: proposal', status: 'proposed', created_at: '2020-01-01', custom: 'preserved' }, 'Fictional body.');
  const service = new KaizenService();
  const before = await fsp.readFile(file, 'utf8');
  await assert.rejects(service.updateKaizen('KAIZEN-2026-001', { status: 'invalid' } as never), /Invalid/);
  assert.equal(await fsp.readFile(file, 'utf8'), before);
  await service.updateKaizen('KAIZEN-2026-001', { status: 'rejected' });
  const parsed = parseMarkdown(await fsp.readFile(file, 'utf8'));
  assert.equal(parsed.data['title'], 'Fictional: proposal');
  assert.equal(parsed.data['custom'], 'preserved');
  assert.match(parsed.content, /Fictional body/);
});
