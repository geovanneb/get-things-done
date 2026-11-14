import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { promises as fsPromises } from 'node:fs';
import matter from 'gray-matter';
import { FileService } from '../src/services/fileService';
import { StakeholderService } from '../src/services/stakeholderService';

async function workspace(t: { after: (fn: () => Promise<void> | void) => void }): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-stakeholder-lock-'));
  const previous = process.env.ESB_WORKSPACE_PATH;
  process.env.ESB_WORKSPACE_PATH = dir;
  t.after(async () => {
    if (previous === undefined) delete process.env.ESB_WORKSPACE_PATH;
    else process.env.ESB_WORKSPACE_PATH = previous;
    await fsp.rm(dir, { recursive: true, force: true });
  });
  for (const d of ['stakeholders/people', 'stakeholders/groups', '.situation-board']) await fsp.mkdir(path.join(dir, d), { recursive: true });
  return dir;
}

/**
 * Resolves once `other` has settled, or once it has found the stakeholder's lock taken (its exclusive create of the
 * lock file failed with EEXIST) and is waiting for it. No timer: without a lock `other` always runs to the end first.
 */
function settledOrWaiting(other: Promise<unknown>, lockSuffix: string, t: { after: (fn: () => void) => void }): Promise<void> {
  const original = fsPromises.open;
  return new Promise<void>((resolve) => {
    const done = () => { fsPromises.open = original; resolve(); };
    t.after(() => { fsPromises.open = original; });
    fsPromises.open = (async (...args: Parameters<typeof original>) => {
      try {
        return await original(...args);
      } catch (err) {
        if (String(args[0]).endsWith(lockSuffix) && (err as NodeJS.ErrnoException).code === 'EEXIST') done();
        throw err;
      }
    }) as typeof original;
    other.then(done, done);
  });
}

/**
 * Runs `other` at the moment the first save of `file` is about to write, and holds that write until `other` has
 * either finished or is waiting on the stakeholder's lock. Without a lock `other` finishes first, which is the
 * interleaving that loses data.
 */
function interleave(t: { after: (fn: () => void) => void }, file: string, id: string, other: () => Promise<unknown>) {
  const original = FileService.prototype.writeMarkdown;
  let started: Promise<unknown> | undefined;
  FileService.prototype.writeMarkdown = async function (this: FileService, filePath: string, ...rest: unknown[]) {
    if (!started && filePath === file) {
      const op = other();
      op.catch(() => {});
      started = op;
      await settledOrWaiting(op, path.join('stakeholder-locks', `${id}.lock`), t);
    }
    return (original as (...args: unknown[]) => Promise<void>).call(this, filePath, ...rest);
  } as typeof original;
  t.after(() => { FileService.prototype.writeMarkdown = original; });
  return () => started;
}

test('a save running while the stakeholder is deleted never writes the file back', async (t) => {
  await workspace(t);
  const service = new StakeholderService();
  const priya = await service.createStakeholder({ name: 'Priya Natarajan', role: 'VP Operations' });

  const other = interleave(t, priya.path!, priya.id, () => service.deleteStakeholder(priya.id));
  const save = await Promise.allSettled([service.updateStakeholder(priya.id, { role: 'COO' })]);
  const deletion = await Promise.allSettled([other()!]);

  assert.equal(deletion[0]!.status, 'fulfilled', String((deletion[0] as PromiseRejectedResult).reason));
  if (save[0]!.status === 'rejected') assert.match(String(save[0]!.reason), /not found/);
  await assert.rejects(fsp.access(priya.path!), 'the deleted stakeholder must stay deleted');
  await assert.rejects(service.getStakeholder(priya.id), /not found/);
});

test('two saves of different fields at once keep both changes', async (t) => {
  await workspace(t);
  const service = new StakeholderService();
  const priya = await service.createStakeholder({ name: 'Priya Natarajan', role: 'VP Operations' });

  const other = interleave(t, priya.path!, priya.id, () => service.updateStakeholder(priya.id, { email: 'priya@example.test' }));
  await service.updateStakeholder(priya.id, { role: 'COO' });
  await other();

  const saved = await service.getStakeholder(priya.id);
  assert.equal(saved.role, 'COO', 'the first save must not be lost');
  assert.equal(saved.email, 'priya@example.test', 'the second save must not be lost');
});

test('a save waits for another dashboard holding the stakeholder, then answers 409 stakeholder_busy and changes nothing', async (t) => {
  const ws = await workspace(t);
  const service = new StakeholderService();
  const priya = await service.createStakeholder({ name: 'Priya Natarajan', role: 'VP Operations' });
  const locks = path.join(ws, '.situation-board', 'stakeholder-locks');
  await fsp.mkdir(locks, { recursive: true });
  // A live process that is not this one holds the lock.
  await fsp.writeFile(path.join(locks, `${priya.id}.lock`), JSON.stringify({ pid: process.ppid, token: 'other-dashboard' }));

  await assert.rejects(service.updateStakeholder(priya.id, { role: 'COO' }),
    (e: Error & { statusCode?: number; details?: { code?: string } }) => e.statusCode === 409 && e.details?.code === 'stakeholder_busy');
  assert.equal((await service.getStakeholder(priya.id)).role, 'VP Operations');
});

test('request-only fields are never written into the stakeholder file; keys already in the file stay', async (t) => {
  await workspace(t);
  const service = new StakeholderService();
  const priya = await service.createStakeholder({ name: 'Priya Natarajan', role: 'VP Operations' });
  // An agent adds its own key to the file.
  const raw = await fsp.readFile(priya.path!, 'utf8');
  await fsp.writeFile(priya.path!, raw.replace(/^---\n/, '---\nsource_note: added by an agent\n'));

  const saved = await service.updateStakeholder(priya.id, {
    role: 'COO',
    version: 'a'.repeat(64),
    expected_version: 'b'.repeat(64),
    expected_updated_at: '2026-01-01T00:00:00.000Z',
    path: '/somewhere/else.md',
    something_else: 'not a stakeholder field',
  } as never);

  const { data } = matter(await fsp.readFile(priya.path!, 'utf8'));
  for (const key of ['version', 'expected_version', 'expected_updated_at', 'path', 'something_else']) {
    assert.equal(key in data, false, `${key} must not be written into the file`);
  }
  assert.equal(data.role, 'COO');
  assert.equal(data.source_note, 'added by an agent', 'a key an agent wrote stays');
  assert.equal(saved.path, priya.path);
  assert.equal(saved.role, 'COO');
  for (const key of ['version', 'expected_version', 'expected_updated_at', 'something_else']) {
    assert.equal(key in saved, false, `${key} must not come back in the response either`);
  }
});

test('notes an older file kept in its front matter move to the body on save instead of being lost', async (t) => {
  await workspace(t);
  const service = new StakeholderService();
  const priya = await service.createStakeholder({ name: 'Priya Natarajan', role: 'VP Operations' });
  const raw = await fsp.readFile(priya.path!, 'utf8');
  await fsp.writeFile(priya.path!, raw.replace(/^---\n/, '---\nnotes: Prefers short updates.\n'));

  const saved = await service.updateStakeholder(priya.id, { role: 'COO' });

  const { data, content } = matter(await fsp.readFile(priya.path!, 'utf8'));
  assert.equal('notes' in data, false, 'the notes are the body, not a front matter key');
  assert.match(content, /Prefers short updates\./);
  assert.equal(saved.notes, 'Prefers short updates.');
  assert.equal((await service.getStakeholder(priya.id)).notes?.trim(), 'Prefers short updates.');
});
