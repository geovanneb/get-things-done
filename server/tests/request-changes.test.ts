import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { TaskService } from '../src/services/taskService';
import { FileService } from '../src/services/fileService';
import { parseMarkdown } from '../src/utils/markdown';

async function workspace(t: { after: (fn: () => Promise<void> | void) => void }): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-request-changes-'));
  const previous = process.env.ESB_WORKSPACE_PATH;
  process.env.ESB_WORKSPACE_PATH = dir;
  t.after(async () => {
    if (previous === undefined) delete process.env.ESB_WORKSPACE_PATH;
    else process.env.ESB_WORKSPACE_PATH = previous;
    await fsp.rm(dir, { recursive: true, force: true });
  });
  await fsp.mkdir(path.join(dir, 'tasks', 'active'), { recursive: true });
  return dir;
}

const status = (code: number) => (err: Error & { statusCode?: number }) => err.statusCode === code;
const tasks = new TaskService();

async function inReview(title = 'Fictional board pack') {
  const created = await tasks.createTask({ title, body: '## Objective\n\nA fictional board pack.\n' });
  await tasks.updateTask(created.id, { status: 'in_progress' });
  return tasks.updateTask(created.id, { status: 'in_review' });
}

test('Request changes records dated feedback and moves the task back to rework, keeping its start and body', async (t) => {
  const ws = await workspace(t);
  const task = await inReview();
  const started = task.start_date;
  assert.ok(started);

  const first = await tasks.requestChanges(task.id, { feedback: '  Shorten the summary to five bullets.  ', seen_updated_at: task.updated_at, request_id: 'req-00000001' });
  assert.equal(first.created, true);
  assert.equal(first.task.status, 'in_progress');
  assert.equal(first.task.start_date, started, 'the start date stays');
  assert.deepEqual([first.request.id, first.request.status, first.request.feedback], ['CR-01', 'open', 'Shorten the summary to five bullets.']);

  const file = path.join(ws, 'tasks', 'active', task.id, 'task.md');
  const saved = parseMarkdown(await fsp.readFile(file, 'utf-8'));
  assert.equal(saved.content.trim(), '## Objective\n\nA fictional board pack.', 'the body is not touched');
  assert.equal((saved.data['change_requests'] as unknown[]).length, 1);

  // Sent twice (a double click, a retry): recorded once, answered with the first.
  const again = await tasks.requestChanges(task.id, { feedback: 'Shorten the summary to five bullets.', seen_updated_at: task.updated_at, request_id: 'req-00000001' });
  assert.deepEqual([again.created, again.request.id], [false, 'CR-01']);

  // An ordinary save never changes the list, whatever it sends.
  await tasks.updateTask(task.id, { change_requests: [] } as never);
  assert.equal(((await tasks.getTask(task.id)) as Record<string, unknown>)['change_requests'] instanceof Array, true);
  assert.equal((((await tasks.getTask(task.id)) as Record<string, unknown>)['change_requests'] as unknown[]).length, 1);

  // A second round: back in review, another request.
  const back = await tasks.updateTask(task.id, { status: 'in_review' });
  const second = await tasks.requestChanges(task.id, { feedback: 'Add the Q3 baseline.', seen_updated_at: back.updated_at, request_id: 'req-00000002' });
  assert.equal(second.request.id, 'CR-02');
});

test('Request changes is refused when the task is not in review, changed since, or the feedback is missing', async (t) => {
  await workspace(t);
  const task = await inReview();
  await assert.rejects(tasks.requestChanges(task.id, { feedback: '', seen_updated_at: task.updated_at, request_id: 'req-00000003' }), status(400));
  await assert.rejects(tasks.requestChanges(task.id, { feedback: 'x'.repeat(4001), seen_updated_at: task.updated_at, request_id: 'req-00000003' }), status(400));
  await assert.rejects(tasks.requestChanges(task.id, { feedback: 'ok', seen_updated_at: task.updated_at, request_id: '../x' }), status(400));
  await assert.rejects(tasks.requestChanges(task.id, { feedback: 'Fix the title.', seen_updated_at: '2020-01-01T00:00:00.000Z', request_id: 'req-00000003' }), status(409), 'a stale view never overwrites');

  const backlog = await tasks.createTask({ title: 'Fictional backlog item' });
  await assert.rejects(tasks.requestChanges(backlog.id, { feedback: 'Fix it.', seen_updated_at: backlog.updated_at, request_id: 'req-00000004' }), status(409));
  await assert.rejects(tasks.requestChanges('TASK-2026-0999', { feedback: 'Fix it.', seen_updated_at: 'x', request_id: 'req-00000005' }), status(404));
});

test('two requests sent at once on the same version: one is recorded, the other is told the task changed', async (t) => {
  await workspace(t);
  const task = await inReview();
  const results = await Promise.allSettled([
    tasks.requestChanges(task.id, { feedback: 'First reviewer note.', seen_updated_at: task.updated_at, request_id: 'req-00000010' }),
    tasks.requestChanges(task.id, { feedback: 'Second reviewer note.', seen_updated_at: task.updated_at, request_id: 'req-00000011' }),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter((r) => r.status === 'rejected' && (r.reason as { statusCode?: number }).statusCode === 409).length, 1);
  assert.equal((((await tasks.getTask(task.id)) as Record<string, unknown>)['change_requests'] as unknown[]).length, 1);
});

/**
 * Holds the next read of this task's task.md for a moment, so another write starts exactly between the request's read
 * and its write. Without the task lock, that write would lose the request or bring the task back from the archive.
 */
function pauseNextRead(taskId: string, t: { after: (fn: () => void) => void }): Promise<void> {
  const proto = FileService.prototype as unknown as { readMarkdown: (...args: unknown[]) => Promise<unknown> };
  const original = proto.readMarkdown;
  let armed = true;
  let reached!: () => void;
  const atRead = new Promise<void>((resolve) => { reached = resolve; });
  proto.readMarkdown = async function (this: unknown, ...args: unknown[]) {
    const result = await original.apply(this, args);
    if (armed && String(args[0]).endsWith(`${taskId}${path.sep}task.md`)) {
      armed = false;
      reached();
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    return result;
  };
  t.after(() => { proto.readMarkdown = original; });
  return atRead;
}

test('a content save between the request\'s read and write waits, and the request is kept', async (t) => {
  await workspace(t);
  const task = await inReview();
  const atRead = pauseNextRead(task.id, t);
  const request = tasks.requestChanges(task.id, { feedback: 'Keep me.', seen_updated_at: task.updated_at, request_id: 'req-content-01' });
  await atRead;
  const save = tasks.updateTaskContent(task.id, '## Objective\n\nEdited meanwhile.\n');
  const [r, c] = await Promise.allSettled([request, save]);
  assert.deepEqual([r.status, c.status], ['fulfilled', 'fulfilled']);
  const saved = (await tasks.getTask(task.id)) as Record<string, unknown>;
  assert.deepEqual((saved['change_requests'] as { request_id: string }[]).map((x) => x.request_id), ['req-content-01'], 'the request survives the save');
  assert.match(String(saved['body']), /Edited meanwhile\./, 'and the save happened after it');
  assert.equal(saved['status'], 'in_progress');
});

test('archiving between the request\'s read and write waits, and never brings the task back to the board', async (t) => {
  const ws = await workspace(t);
  const task = await inReview();
  const atRead = pauseNextRead(task.id, t);
  const request = tasks.requestChanges(task.id, { feedback: 'Fix the title.', seen_updated_at: task.updated_at, request_id: 'req-archive-01' });
  await atRead;
  const archive = tasks.archiveTask(task.id);
  const [r, a] = await Promise.allSettled([request, archive]);
  assert.deepEqual([r.status, a.status], ['fulfilled', 'fulfilled']);
  await assert.rejects(fsp.access(path.join(ws, 'tasks', 'active', task.id)), 'no active copy is written back');
  const kept = parseMarkdown(await fsp.readFile(path.join(ws, 'tasks', 'archive', task.id, 'task.md'), 'utf-8')).data;
  assert.equal((kept['change_requests'] as unknown[]).length, 1, 'recorded first, then archived with it');
});
