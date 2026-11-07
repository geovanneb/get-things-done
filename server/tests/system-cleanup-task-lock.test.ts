import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { parseSettings, SystemCleanupService } from '../src/services/systemCleanupService';
import { parseMarkdown, stringifyMarkdown } from '../src/utils/markdown';
import { lock, unlock } from '../src/utils/fileLock';

/**
 * A task reopened while cleanup runs is never archived, trashed or deleted: cleanup decides under the task's lock, so
 * a reopen that holds the lock first is what cleanup then sees.
 */
for (const action of ['archive', 'delete'] as const) {
  test(`cleanup (${action}) leaves a task reopened while it waited for the task's lock`, async (t) => {
    const ws = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-cleanup-lock-'));
    const previous = process.env.ESB_WORKSPACE_PATH;
    process.env.ESB_WORKSPACE_PATH = ws;
    t.after(async () => {
      if (previous === undefined) delete process.env.ESB_WORKSPACE_PATH;
      else process.env.ESB_WORKSPACE_PATH = previous;
      await fsp.rm(ws, { recursive: true, force: true });
    });
    for (const d of ['tasks/active', 'tasks/archive', 'context-updates', 'kaizen', '.situation-board/trash', '.situation-board/task-locks']) {
      await fsp.mkdir(path.join(ws, d), { recursive: true });
    }
    const id = 'TASK-2026-0001';
    const file = path.join(ws, 'tasks', 'active', id, 'task.md');
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, stringifyMarkdown('Body.\n', { schema_version: '1.0', id, type: 'task', title: 'Fictional', priority: 'medium', status: 'done', done_date: '2020-01-01T00:00:00.000Z', created_at: '2020-01-01T00:00:00.000Z' }));

    const service = new SystemCleanupService();
    await service.writeSettings(parseSettings({ memory_review: { enabled: false }, rules: { completed_tasks: { enabled: true, older_than_days: 30, action } } }));
    // Between planning and acting: someone else holds the task (a save), and reopens it before letting go.
    const plan = service.plan.bind(service);
    service.plan = async (...args) => {
      const result = await plan(...args);
      const held = await lock(path.join(ws, '.situation-board', 'task-locks', `${id}.lock`), 1000, () => new Error('busy'));
      setTimeout(async () => {
        const parsed = parseMarkdown(await fsp.readFile(file, 'utf-8'));
        const { done_date: _done, ...rest } = parsed.data as Record<string, unknown>;
        await fsp.writeFile(file, stringifyMarkdown(parsed.content, { ...rest, status: 'in_progress' }));
        await unlock(held);
      }, 200);
      return result;
    };
    const result = await service.runNow(new Date('2026-10-28T10:00'));
    assert.equal(result.cleaned.length, 0, 'nothing cleaned');
    assert.equal(parseMarkdown(await fsp.readFile(file, 'utf-8')).data['status'], 'in_progress', 'still on the board, reopened');
  });
}
