import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import { ContextUpdateService } from '../src/services/contextUpdateService';
import { SystemCleanupService, parseSettings } from '../src/services/systemCleanupService';
import { MAX_FILE_BYTES, MAX_TASKS_PER_REVIEW } from '../src/services/acceptedTasks';
import { parseMarkdown, stringifyMarkdown } from '../src/utils/markdown';

/** A throwaway fictional workspace; services read its path from ESB_WORKSPACE_PATH. */
async function workspace(t: { after: (fn: () => Promise<void> | void) => void }): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-accepted-'));
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
  // One note, so a memory review has something to review besides the tasks.
  await write(dir, 'context/strategy/growth-plan/note.md', { schema_version: '1.0', id: 'CTX-growth-plan', type: 'context', title: 'Growth plan', category: 'strategy', created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z' }, 'Grow the fictional Northwind business in two new regions.');
  return dir;
}

async function write(ws: string, rel: string, data: Record<string, unknown>, body = ''): Promise<void> {
  await fsp.mkdir(path.dirname(path.join(ws, rel)), { recursive: true });
  await fsp.writeFile(path.join(ws, rel), stringifyMarkdown(body, data));
}

const BEFORE = new Date('2026-11-01T00:00:00.000Z');

/** A task with one deliverable file saved before it was accepted, and an execution log. */
async function task(ws: string, id: string, fields: Record<string, unknown>, folder: 'active' | 'archive' = 'active'): Promise<void> {
  const dir = `tasks/${folder}/${id}`;
  await fsp.mkdir(path.join(ws, dir, 'deliverables'), { recursive: true });
  await fsp.writeFile(path.join(ws, dir, 'deliverables', 'report_261103.md'), `# Fictional report of ${id}\n`);
  await fsp.utimes(path.join(ws, dir, 'deliverables', 'report_261103.md'), BEFORE, BEFORE);
  await fsp.mkdir(path.join(ws, dir, 'executions'), { recursive: true });
  await fsp.writeFile(path.join(ws, dir, 'executions', '2026-11-01T00-00-00Z.md'), 'Older log\n');
  await fsp.writeFile(path.join(ws, dir, 'executions', '2026-11-02T00-00-00Z.md'), `Latest log of ${id}\n`);
  await write(ws, `${dir}/task.md`, {
    schema_version: '1.0', id, type: 'task', title: `Fictional ${id}`, priority: 'medium', created_at: '2026-10-01T00:00:00.000Z',
    deliverables: [{ id: 'DEL-01', template_ref: 'memo', status: 'complete', file_path: `tasks/active/${id}/deliverables/report_261103.md` }],
    ...fields,
  });
}

async function setTask(ws: string, id: string, patch: Record<string, unknown>): Promise<void> {
  const file = path.join(ws, 'tasks/active', id, 'task.md');
  const parsed = parseMarkdown(await fsp.readFile(file, 'utf-8'));
  const data = { ...(parsed.data as Record<string, unknown>), ...patch };
  for (const [k, v] of Object.entries(patch)) if (v === undefined) delete data[k];
  await fsp.writeFile(file, stringifyMarkdown(parsed.content, data));
}

/** The user finishes the review (what apply does to its status). */
async function finish(ws: string, id: string): Promise<void> {
  const file = path.join(ws, 'context-updates', id, 'update.md');
  const parsed = parseMarkdown(await fsp.readFile(file, 'utf-8'));
  await fsp.writeFile(file, stringifyMarkdown(parsed.content, { ...(parsed.data as Record<string, unknown>), status: 'done', applied_at: '2026-11-05T00:00:00.000Z' }));
}

const materials = (ws: string, id: string) => path.join(ws, 'context-updates', id, 'materials');
const read = (p: string) => fsp.readFile(p, 'utf-8');
const exists = (p: string) => fsp.access(p).then(() => true, () => false);
const ledger = async (ws: string) => JSON.parse(await read(path.join(ws, '.situation-board/routines/system-cleanup-accepted.json'))) as { since: string; tasks: Record<string, { accepted_at: string; update?: string; left_out?: string; files?: { name: string | null; sha256: string; copied: boolean }[] }> };
const at = (s: string) => new Date(s);

async function turnOn(service: SystemCleanupService, extra: Record<string, unknown> = {}, now = at('2026-11-02T00:00:00.000Z')): Promise<void> {
  await service.update({ memory_review: { accepted_tasks: true }, ...extra }, now);
}

test('accepted tasks are not gathered unless the switch is on, and it is validated', async (t) => {
  const ws = await workspace(t);
  const service = new SystemCleanupService();
  assert.equal((await service.view()).settings.memory_review.accepted_tasks, false);
  assert.throws(() => parseSettings({ memory_review: { accepted_tasks: 'yes' } }), /memory_review.accepted_tasks/);
  await task(ws, 'TASK-2026-0001', { status: 'done', done_date: '2026-11-03T10:00:00.000Z' });
  const run = await service.runNow(at('2026-11-09T09:00:00.000Z'));
  assert.ok(run.context_update);
  assert.deepEqual(await fsp.readdir(materials(ws, run.context_update!)), ['memory-scan.md'], 'today\'s review is unchanged');
  assert.equal(await exists(path.join(ws, '.situation-board/routines/system-cleanup-accepted.json')), false);
});

test('a run gathers the tasks accepted since the switch was turned on, with copies and hashes, and leaves confidential ones out with a count', async (t) => {
  const ws = await workspace(t);
  const service = new SystemCleanupService();
  await task(ws, 'TASK-2026-0001', { status: 'done', done_date: '2026-10-20T00:00:00.000Z' }); // before the switch
  await turnOn(service);
  await task(ws, 'TASK-2026-0002', { status: 'done', done_date: '2026-11-03T10:00:00.000Z' });
  await task(ws, 'TASK-2026-0003', { status: 'approved', done_date: '2026-11-04T10:00:00.000Z', confidentiality: 'confidential', title: 'Secret fictional merger' });
  await task(ws, 'TASK-2026-0004', { status: 'archived', done_date: '2026-11-05T10:00:00.000Z' }, 'archive');
  await task(ws, 'TASK-2026-0005', { status: 'in_review' });
  await task(ws, 'TASK-2026-0006', { status: 'done', done_date: '2026-11-06T10:00:00.000Z', confidentiality: 'restricted' });
  // A deliverable pointing outside its task is not copied; one saved after acceptance is flagged.
  await setTask(ws, 'TASK-2026-0002', { deliverables: [
    { id: 'DEL-01', file_path: 'tasks/active/TASK-2026-0002/deliverables/report_261103.md' },
    { id: 'DEL-02', file_path: 'context/strategy/growth-plan/note.md' },
    { id: 'DEL-03', file_path: 'tasks/active/TASK-2026-0002/deliverables/late.md' },
  ] });
  await fsp.writeFile(path.join(ws, 'tasks/active/TASK-2026-0002/deliverables/late.md'), 'Edited later\n');

  const run = await service.runNow(at('2026-11-09T09:00:00.000Z'));
  assert.equal(run.status, 'ok', run.message);
  assert.match(run.message, /Gathered 2 accepted tasks; left out 2 marked confidential or restricted\./);
  const id = run.context_update!;
  const files = (await fsp.readdir(materials(ws, id))).sort();
  assert.deepEqual(files, [
    'TASK-2026-0002-2026-11-02T00-00-00Z.md', 'TASK-2026-0002-late.md', 'TASK-2026-0002-report_261103.md', 'TASK-2026-0002-task.md',
    'TASK-2026-0004-2026-11-02T00-00-00Z.md', 'TASK-2026-0004-report_261103.md', 'TASK-2026-0004-task.md',
    'accepted-tasks.md', 'memory-scan.md',
  ]);
  const list = await read(path.join(materials(ws, id), 'accepted-tasks.md'));
  assert.ok(list.indexOf('TASK-2026-0002') < list.indexOf('TASK-2026-0004'), 'oldest acceptance first');
  assert.ok(!list.includes('TASK-2026-0001'), 'accepted before the switch: not gathered');
  for (const hidden of ['TASK-2026-0003', 'TASK-2026-0006', 'Secret fictional merger']) assert.ok(!list.includes(hidden), `${hidden} is not named`);
  assert.match(list, /2 accepted tasks were left out because they are marked confidential or restricted/);
  assert.match(list, /`TASK-2026-0002-late.md`: deliverable DEL-03.*Changed after it was accepted/);
  assert.ok(!/report_261103.md`.*Changed after/.test(list), 'a deliverable saved before acceptance is not flagged');
  assert.ok(!list.includes('growth-plan'), 'a deliverable outside its task folder is not copied');
  const copy = await fsp.readFile(path.join(materials(ws, id), 'TASK-2026-0002-report_261103.md'));
  const sha = createHash('sha256').update(copy).digest('hex');
  assert.ok(list.includes(sha), 'the copy is listed with its hash');

  const update = await new ContextUpdateService().get(id);
  assert.ok(update.material_files.some((f) => f.name === 'accepted-tasks.md'), 'the copies are listed as the update\'s materials');
  assert.match(update.notes, /claims written for an audience, not facts/);

  const record = await ledger(ws);
  assert.equal(record.since, '2026-11-02T00:00:00.000Z');
  assert.deepEqual(Object.keys(record.tasks).sort(), ['TASK-2026-0002', 'TASK-2026-0004']);
  assert.equal(record.tasks['TASK-2026-0002']!.update, id);
  assert.ok(record.tasks['TASK-2026-0002']!.files!.some((f) => f.sha256 === sha && f.copied));
  // Nothing identifies a left-out task outside its own folder: not the record, the run message or the materials.
  const raw = await read(path.join(ws, '.situation-board/routines/system-cleanup-accepted.json'));
  const update2 = await new ContextUpdateService().get(id);
  for (const hidden of ['TASK-2026-0003', 'TASK-2026-0006', 'Secret fictional merger', '2026-11-04T10', '2026-11-06T10', 'confidential', 'restricted']) {
    assert.ok(!raw.includes(hidden), `the record does not hold ${hidden}`);
    if (hidden.startsWith('TASK') || hidden.startsWith('Secret')) {
      assert.ok(!run.message.includes(hidden) && !update2.notes.includes(hidden), `the run and the notes do not name ${hidden}`);
      for (const f of await fsp.readdir(materials(ws, id))) assert.ok(!f.includes(hidden) && !(await read(path.join(materials(ws, id), f))).includes(hidden), `${f} does not name ${hidden}`);
    }
  }

  // Counted once: the next review does not count them again.
  await finish(ws, id);
  const next = await service.runNow(at('2026-11-16T09:00:00.000Z'));
  assert.ok(!/left out/.test(next.message), next.message);
});

test('a reopened and re-accepted task is gathered once more, an unchanged one never twice', async (t) => {
  const ws = await workspace(t);
  const service = new SystemCleanupService();
  await turnOn(service);
  await task(ws, 'TASK-2026-0001', { status: 'done', done_date: '2026-11-03T10:00:00.000Z' });
  const first = await service.runNow(at('2026-11-09T09:00:00.000Z'));
  assert.match(first.message, /Gathered 1 accepted task\./);
  await finish(ws, first.context_update!);

  const second = await service.runNow(at('2026-11-16T09:00:00.000Z'));
  assert.ok(!(await fsp.readdir(materials(ws, second.context_update!))).includes('accepted-tasks.md'), 'not gathered twice');
  await finish(ws, second.context_update!);

  // Reopened (the done date goes), then accepted again: a new acceptance.
  await setTask(ws, 'TASK-2026-0001', { status: 'in_progress', done_date: undefined });
  const reopened = await service.runNow(at('2026-11-17T09:00:00.000Z'));
  assert.ok(!(await fsp.readdir(materials(ws, reopened.context_update!))).includes('accepted-tasks.md'), 'a reopened task is not gathered');
  await finish(ws, reopened.context_update!);
  await setTask(ws, 'TASK-2026-0001', { status: 'done', done_date: '2026-11-18T10:00:00.000Z' });
  const third = await service.runNow(at('2026-11-23T09:00:00.000Z'));
  assert.match(third.message, /Gathered 1 accepted task\./);
  await finish(ws, third.context_update!);
  const fourth = await service.runNow(at('2026-11-30T09:00:00.000Z'));
  assert.ok(!(await fsp.readdir(materials(ws, fourth.context_update!))).includes('accepted-tasks.md'));
  assert.equal((await ledger(ws)).tasks['TASK-2026-0001']!.accepted_at, '2026-11-18T10:00:00.000Z');
});

test('while a review is open the schedule moves on, but no accepted task is lost, and cleanup leaves it alone until gathered', async (t) => {
  const ws = await workspace(t);
  const service = new SystemCleanupService();
  // Deleting finished tasks after one day: the strictest rule.
  await turnOn(service, { rules: { completed_tasks: { enabled: true, older_than_days: 1, action: 'delete' } } });
  const first = await service.runNow(at('2026-11-02T09:00:00.000Z'));
  assert.ok(first.context_update, 'a review is open');

  await task(ws, 'TASK-2026-0001', { status: 'done', done_date: '2026-11-03T10:00:00.000Z' });
  const preview = await service.plan(await service.readSettings(), at('2026-11-09T09:00:00.000Z'));
  assert.ok(!preview.items.some((i) => i.id === 'TASK-2026-0001'), 'the preview leaves a pending task out');

  const blocked = await service.runNow(at('2026-11-09T09:00:00.000Z'));
  assert.match(blocked.message, /still open, so no new one was started\. 1 accepted task waits for the next one\./);
  assert.ok(await exists(path.join(ws, 'tasks/active/TASK-2026-0001/task.md')), 'not deleted before it was gathered');
  assert.ok(!(await ledger(ws)).tasks['TASK-2026-0001'], 'not marked as gathered');

  await finish(ws, first.context_update!);
  const next = await service.runNow(at('2026-11-16T09:00:00.000Z'));
  assert.match(next.message, /Gathered 1 accepted task\./);
  // Gathered first, cleaned up after: the copy is safe in the review's materials.
  assert.equal(await exists(path.join(ws, 'tasks/active/TASK-2026-0001')), false, 'cleaned up once gathered');
  assert.match(await read(path.join(materials(ws, next.context_update!), 'TASK-2026-0001-report_261103.md')), /Fictional report of TASK-2026-0001/);
  assert.equal((await ledger(ws)).tasks['TASK-2026-0001']!.update, next.context_update, 'recorded with the review that holds its copies');
});

test('a record that cannot be read gathers nothing and holds every accepted task from cleanup', async (t) => {
  const ws = await workspace(t);
  const service = new SystemCleanupService();
  await turnOn(service, { rules: { completed_tasks: { enabled: true, older_than_days: 1, action: 'delete' } } });
  await task(ws, 'TASK-2026-0001', { status: 'done', done_date: '2026-10-01T10:00:00.000Z' });
  await fsp.writeFile(path.join(ws, '.situation-board/routines/system-cleanup-accepted.json'), '{ broken');
  const run = await service.runNow(at('2026-11-09T09:00:00.000Z'));
  assert.equal(run.status, 'error');
  assert.match(run.message, /cannot be read/);
  assert.ok(await exists(path.join(ws, 'tasks/active/TASK-2026-0001/task.md')));
});

test('one review takes at most 30 tasks, oldest first, and lists large files with their hash instead of copying them', async (t) => {
  const ws = await workspace(t);
  const service = new SystemCleanupService();
  await turnOn(service);
  const count = MAX_TASKS_PER_REVIEW + 2;
  for (let i = 1; i <= count; i++) {
    const day = String(3 + Math.floor(i / 10)).padStart(2, '0');
    await task(ws, `TASK-2026-${String(i).padStart(4, '0')}`, { status: 'done', done_date: `2026-11-${day}T${String(i % 10).padStart(2, '0')}:00:00.000Z` });
  }
  // Over the per-file limit.
  const big = Buffer.alloc(MAX_FILE_BYTES + 1, 'a');
  await fsp.writeFile(path.join(ws, 'tasks/active/TASK-2026-0001/deliverables/report_261103.md'), big);
  await fsp.utimes(path.join(ws, 'tasks/active/TASK-2026-0001/deliverables/report_261103.md'), BEFORE, BEFORE);
  // Five files just under the per-file limit fill the per-review limit.
  const deliverables = [];
  for (let n = 1; n <= 5; n++) {
    const name = `part-${n}.md`;
    await fsp.writeFile(path.join(ws, 'tasks/active/TASK-2026-0002/deliverables', name), Buffer.alloc(MAX_FILE_BYTES - 10, 'b'));
    deliverables.push({ id: `DEL-0${n}`, file_path: `tasks/active/TASK-2026-0002/deliverables/${name}` });
  }
  await setTask(ws, 'TASK-2026-0002', { deliverables });

  const run = await service.runNow(at('2026-11-09T09:00:00.000Z'));
  assert.match(run.message, /Gathered 30 accepted tasks; 2 wait for the next review\./);
  const dir = materials(ws, run.context_update!);
  const list = await read(path.join(dir, 'accepted-tasks.md'));
  assert.match(list, /Not copied: `tasks\/active\/TASK-2026-0001\/deliverables\/report_261103.md`.*over the 5.0 MB limit per file; sha256 `[0-9a-f]{64}`/);
  assert.match(list, /Not copied: `tasks\/active\/TASK-2026-0002\/deliverables\/part-5.md`.*limit per review/);
  assert.match(list, /2 more accepted tasks wait for the next memory review/);
  assert.ok(!list.includes('TASK-2026-0031') && !list.includes('TASK-2026-0032'), 'the newest wait');
  let total = 0;
  for (const f of await fsp.readdir(dir)) if (f !== 'accepted-tasks.md' && f !== 'memory-scan.md') total += (await fsp.stat(path.join(dir, f))).size;
  assert.ok(total <= 25 * 1024 * 1024, `copies stay within the per-review limit (${total})`);

  await finish(ws, run.context_update!);
  const next = await service.runNow(at('2026-11-16T09:00:00.000Z'));
  assert.match(next.message, /Gathered 2 accepted tasks\./);
  const rest = await read(path.join(materials(ws, next.context_update!), 'accepted-tasks.md'));
  assert.ok(rest.includes('TASK-2026-0031') && rest.includes('TASK-2026-0032'));
});

test('a task whose file was too large to copy is kept from cleanup until the review listing it is finished', async (t) => {
  const ws = await workspace(t);
  const service = new SystemCleanupService();
  await turnOn(service, { rules: { completed_tasks: { enabled: true, older_than_days: 1, action: 'delete' } } });
  await task(ws, 'TASK-2026-0001', { status: 'done', done_date: '2026-11-03T10:00:00.000Z' });
  const big = path.join(ws, 'tasks/active/TASK-2026-0001/deliverables/report_261103.md');
  await fsp.writeFile(big, Buffer.alloc(MAX_FILE_BYTES + 1, 'a'));
  await fsp.utimes(big, BEFORE, BEFORE);
  const run = await service.runNow(at('2026-11-09T09:00:00.000Z'));
  assert.match(run.message, /Gathered 1 accepted task\./);
  const list = await read(path.join(materials(ws, run.context_update!), 'accepted-tasks.md'));
  assert.match(list, /Not copied: .*under `tasks\/archive\/TASK-2026-0001\/` once archived.*kept until this review is finished/);
  assert.ok(await exists(big), 'the only copy of the large file is kept while its review is open');
  const blocked = await service.runNow(at('2026-11-10T09:00:00.000Z'));
  assert.ok(await exists(big), blocked.message);

  await finish(ws, run.context_update!);
  await service.runNow(at('2026-11-16T09:00:00.000Z'));
  assert.equal(await exists(path.join(ws, 'tasks/active/TASK-2026-0001')), false, 'cleaned up once the review is finished');
});

test('a record of any other shape is treated as damaged: an error, nothing gathered, every accepted task held', async (t) => {
  for (const bad of ['null', '[]', '{}', '{"since":"not a date","tasks":{}}', '{"since":"2026-11-02T00:00:00.000Z","tasks":[]}',
    '{"since":"2026-11-02T00:00:00.000Z","tasks":{"TASK-2026-0009":{"accepted_at":"2026-11-03T00:00:00.000Z"}}}']) {
    const ws = await workspace(t);
    const service = new SystemCleanupService();
    await turnOn(service, { rules: { completed_tasks: { enabled: true, older_than_days: 1, action: 'delete' } } });
    await task(ws, 'TASK-2026-0001', { status: 'done', done_date: '2026-11-03T10:00:00.000Z' });
    await fsp.writeFile(path.join(ws, '.situation-board/routines/system-cleanup-accepted.json'), bad);
    const run = await service.runNow(at('2026-11-09T09:00:00.000Z'));
    assert.equal(run.status, 'error', `${bad}: ${run.message}`);
    assert.match(run.message, /cannot be read/);
    assert.ok(await exists(path.join(ws, 'tasks/active/TASK-2026-0001/task.md')), `${bad}: the task is held`);
    assert.equal(await read(path.join(ws, '.situation-board/routines/system-cleanup-accepted.json')), bad, `${bad}: the record is left as it is`);
  }
});

test('with a review open and a damaged record, the run says the record cannot be read', async (t) => {
  const ws = await workspace(t);
  const service = new SystemCleanupService();
  await turnOn(service);
  const first = await service.runNow(at('2026-11-02T09:00:00.000Z'));
  assert.ok(first.context_update);
  await fsp.writeFile(path.join(ws, '.situation-board/routines/system-cleanup-accepted.json'), 'null');
  const run = await service.runNow(at('2026-11-09T09:00:00.000Z'));
  assert.match(run.message, /still open.*record of gathered tasks cannot be read/);
});
