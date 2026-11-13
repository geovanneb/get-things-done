import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import type { FileWatchEvent } from '../src/types';

// chmod 000 does not stop root, and Windows has no such mode bits.
const canMakeUnreadable = process.platform !== 'win32' && process.getuid?.() !== 0;

// Windows makes directory symlinks only with extra rights; a junction needs none and is followed the same way.
const linkType = process.platform === 'win32' ? 'junction' : 'dir';

async function workspace(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gtd-watcher-errors-'));
  const ws = path.join(root, 'ws');
  await fs.mkdir(path.join(ws, 'context', 'company', 'board-pack'), { recursive: true });
  await fs.mkdir(path.join(ws, 'tasks', 'active', 'TASK-2026-0001'), { recursive: true });
  t.after(async () => {
    await fs.chmod(path.join(ws, 'context', 'private'), 0o755).catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  });
  return ws;
}

const taskFile = path.join('tasks', 'active', 'TASK-2026-0001', 'task.md');

type Watcher = InstanceType<typeof import('../src/services/watcherService').WatcherService>;

const isProbe = (file: string): boolean => path.basename(file).startsWith('probe-');

/**
 * Resolves once changes in `dir` are reported. A fixed wait can end too early on a loaded machine, and even after
 * chokidar's 'ready' (end of the first crawl) the system can take a moment to deliver events, so new probe files
 * are written until one is reported. Callers ignore probe files.
 */
async function whenLive(watcher: Watcher, dir: string): Promise<void> {
  const inner = (watcher as unknown as { watcher: { once(event: 'ready', fn: () => void): unknown } | null }).watcher;
  assert.ok(inner, 'the watcher started');
  await new Promise<void>((resolve) => inner.once('ready', () => resolve()));
  let live = false;
  const onAdd = (event: FileWatchEvent): void => {
    if (isProbe(event.path)) live = true;
  };
  watcher.on('add', onAdd);
  try {
    for (let i = 0; !live; i++) {
      assert.ok(i < 20, `no change in ${dir} reported`);
      await fs.writeFile(path.join(dir, `probe-${i}.md`), '');
      const deadline = Date.now() + 500;
      while (!live && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    }
  } finally {
    watcher.off('add', onAdd);
  }
}

/** The adds reported after writing a task file, once the first crawl (and any planting) has finished. */
async function addsAfterWrite(ws: string, plantLater?: () => Promise<void>): Promise<string[]> {
  const { WatcherService } = await import('../src/services/watcherService');
  const watcher = new WatcherService();
  const seen: string[] = [];
  watcher.on('add', (event: FileWatchEvent) => {
    if (!isProbe(event.path)) seen.push(path.relative(ws, event.path));
  });
  watcher.start(ws);
  try {
    await whenLive(watcher, path.join(ws, 'tasks', 'active', 'TASK-2026-0001'));
    if (plantLater) {
      await plantLater();
      await new Promise((resolve) => setTimeout(resolve, 800));
      seen.length = 0;
    }
    await fs.writeFile(path.join(ws, 'tasks', 'active', 'TASK-2026-0001', 'task.md'), '---\ntitle: Board pack\n---\n');
    const deadline = Date.now() + 5000;
    while (!seen.length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    // Let copies of the same event through a link arrive too, if any would.
    await new Promise((resolve) => setTimeout(resolve, 300));
    return seen;
  } finally {
    watcher.stop();
  }
}

// Before the fix two links back to the workspace made the watcher crawl copies of it until it ran out of files.
const timeout = 30_000;

test('a symlink loop in the workspace neither stops the watcher nor reports a change through the loop', { timeout }, async (t) => {
  const ws = await workspace(t);
  await fs.symlink(ws, path.join(ws, 'context', 'company', 'board-pack', 'shortcut-to-workspace'), linkType);
  await fs.symlink(ws, path.join(ws, 'context', 'company', 'board-pack', 'second-shortcut'), linkType);
  assert.deepEqual(await addsAfterWrite(ws), [taskFile]);
});

test('a symlink loop made while the watcher runs does not stop it', { timeout }, async (t) => {
  const ws = await workspace(t);
  const seen = await addsAfterWrite(ws, () => fs.symlink(ws, path.join(ws, 'context', 'company', 'board-pack', 'shortcut-to-workspace'), linkType));
  assert.deepEqual(seen, [taskFile]);
});

test('an unreadable folder in the workspace does not stop the watcher', { timeout, skip: !canMakeUnreadable && 'needs a non-root POSIX user' }, async (t) => {
  const ws = await workspace(t);
  await fs.mkdir(path.join(ws, 'context', 'private'));
  await fs.writeFile(path.join(ws, 'context', 'private', 'note.md'), '# Private\n');
  await fs.chmod(path.join(ws, 'context', 'private'), 0o000);
  assert.deepEqual(await addsAfterWrite(ws), [taskFile]);
});

test('a folder made unreadable while the watcher runs does not stop it', { timeout, skip: !canMakeUnreadable && 'needs a non-root POSIX user' }, async (t) => {
  const ws = await workspace(t);
  const seen = await addsAfterWrite(ws, async () => {
    await fs.mkdir(path.join(ws, 'context', 'private'));
    await fs.writeFile(path.join(ws, 'context', 'private', 'note.md'), '# Private\n');
    await fs.chmod(path.join(ws, 'context', 'private'), 0o000);
  });
  assert.deepEqual(seen, [taskFile]);
});

test('a folder linked from outside the workspace is still watched', { timeout }, async (t) => {
  const ws = await workspace(t);
  const shared = path.join(path.dirname(ws), 'shared-drive', 'board-pack');
  await fs.mkdir(shared, { recursive: true });
  await fs.symlink(shared, path.join(ws, 'context', 'company', 'shared'), linkType);
  const { WatcherService } = await import('../src/services/watcherService');
  const watcher = new WatcherService();
  const seen: string[] = [];
  watcher.on('add', (event: FileWatchEvent) => {
    if (!isProbe(event.path)) seen.push(path.relative(ws, event.path));
  });
  watcher.start(ws);
  t.after(() => watcher.stop());
  await whenLive(watcher, shared);
  await fs.writeFile(path.join(shared, 'note.md'), '# Board pack\n');
  const deadline = Date.now() + 5000;
  while (!seen.length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(seen, [path.join('context', 'company', 'shared', 'note.md')]);
});

test('a workspace opened through a symlink is watched', { timeout }, async (t) => {
  const ws = await workspace(t);
  const link = path.join(path.dirname(ws), 'ws-link');
  await fs.symlink(ws, link, linkType);
  const seen = await addsAfterWrite(link);
  assert.deepEqual(seen, [taskFile]);
});

test('a link to another folder of the workspace is still followed', { timeout }, async (t) => {
  const ws = await workspace(t);
  await fs.symlink(path.join(ws, 'tasks', 'active'), path.join(ws, 'context', 'company', 'active-tasks'), linkType);
  const seen = await addsAfterWrite(ws);
  assert.deepEqual(seen.sort(), [path.join('context', 'company', 'active-tasks', 'TASK-2026-0001', 'task.md'), taskFile]);
});

test('two folders linking to each other are not crawled in a loop', { timeout }, async (t) => {
  const ws = await workspace(t);
  await fs.symlink(path.join(ws, 'tasks'), path.join(ws, 'context', 'company', 'board-pack', 'tasks-link'), linkType);
  await fs.symlink(path.join(ws, 'context'), path.join(ws, 'tasks', 'context-link'), linkType);
  const seen = await addsAfterWrite(ws);
  assert.deepEqual(seen.sort(), [path.join('context', 'company', 'board-pack', 'tasks-link', 'active', 'TASK-2026-0001', 'task.md'), taskFile]);
});
