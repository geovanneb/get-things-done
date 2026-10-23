import { parseMarkdown, stringifyMarkdown } from '../src/utils/markdown';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import express from 'express';
import { request } from 'node:http';

// Raw HTTP permits explicit Host headers on every supported Node version.
function httpFetch(url: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; text: () => Promise<string> }> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: options.method, headers: options.headers }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode!, text: async () => body }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(options.body);
  });
}
import { atomicWrite } from '../src/utils/atomicWrite';
import { fileInside, saveAttachment, topLevelName } from '../src/utils/files';
import { localRequestGuard } from '../src/middleware/localRequestGuard';
import { errorHandler } from '../src/middleware/errorHandler';
import { AgentService } from '../src/services/agentService';
import { ContextService } from '../src/services/contextService';
import { OutputService } from '../src/services/outputService';
import { KaizenService } from '../src/services/kaizenService';
import { TaskService } from '../src/services/taskService';

async function temporary(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-boundaries-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('file reads reject traversal and file/directory symlink escapes', async (t) => {
  const root = await temporary(t);
  const dir = path.join(root, 'workspace');
  await fsp.mkdir(dir);
  await fsp.writeFile(path.join(root, 'private.txt'), 'private');
  await fsp.writeFile(path.join(dir, 'safe.txt'), 'safe');
  await fsp.symlink(path.join(root, 'private.txt'), path.join(dir, 'link.txt'));
  await fsp.symlink(root, path.join(dir, 'outside'));
  assert.equal(await fileInside(dir, 'safe.txt'), await fsp.realpath(path.join(dir, 'safe.txt')));
  for (const name of ['../private.txt', 'link.txt', 'outside/private.txt', '.']) {
    await assert.rejects(fileInside(dir, name), /Invalid path traversal/);
  }
  await assert.rejects(fileInside(dir, 'missing.txt'), /not found/);
  await fsp.mkdir(path.join(dir, 'folder'));
  await assert.rejects(fileInside(dir, 'folder'), /not found/);
});

test('concurrent writes publish complete content and leave no temporary files', async (t) => {
  const dir = await temporary(t);
  const target = path.join(dir, 'note.md');
  const contents = Array.from({ length: 32 }, (_, i) => `${i}:` + 'x'.repeat(32768));
  await Promise.all(contents.map((body) => atomicWrite(target, body)));
  assert.ok(contents.includes(await fsp.readFile(target, 'utf8')));
  assert.deepEqual(await fsp.readdir(dir), ['note.md']);
  await fsp.chmod(target, 0o640);
  await atomicWrite(target, 'replacement');
  assert.equal((await fsp.stat(target)).mode & 0o777, 0o640);
  const directory = path.join(dir, 'directory');
  await fsp.mkdir(directory);
  await assert.rejects(atomicWrite(directory, 'cannot replace a directory'));
  assert.deepEqual((await fsp.readdir(dir)).sort(), ['directory', 'note.md']);
});

test('uploads preserve entity metadata and do not overwrite symlink targets', async (t) => {
  const dir = await temporary(t);
  for (const reserved of ['task.md', 'note.md', 'output.md']) {
    await fsp.writeFile(path.join(dir, reserved), 'metadata');
    await assert.rejects(saveAttachment(dir, reserved.toUpperCase(), Buffer.from('bad'), reserved), /Invalid/);
    assert.equal(await fsp.readFile(path.join(dir, reserved), 'utf8'), 'metadata');
  }
  await assert.rejects(saveAttachment(dir, '.hidden', Buffer.from('bad'), 'task.md'), /Invalid/);
  const outside = path.join(dir, 'original.txt');
  await fsp.writeFile(outside, 'original');
  await fsp.symlink(outside, path.join(dir, 'attachment.txt'));
  await saveAttachment(dir, 'attachment.txt', Buffer.from('uploaded'), 'task.md');
  assert.equal(await fsp.readFile(outside, 'utf8'), 'original');
  assert.equal(await fsp.readFile(path.join(dir, 'attachment.txt'), 'utf8'), 'uploaded');
});

test('task file operations reject traversal before accessing the filesystem', async (t) => {
  const dir = await temporary(t);
  const previous = process.env.ESB_WORKSPACE_PATH;
  process.env.ESB_WORKSPACE_PATH = dir;
  t.after(async () => {
    if (previous === undefined) delete process.env.ESB_WORKSPACE_PATH;
    else process.env.ESB_WORKSPACE_PATH = previous;
  });
  const tasks = new TaskService();
  await assert.rejects(tasks.deleteTaskFile('fixture', 'TASK.MD'), /Invalid/);
  for (const id of ['../outside', '..\\outside', '..']) {
    await assert.rejects(new AgentService().deleteSkill(id), /Invalid/);
    await assert.rejects(new AgentService().installSkill(id), /Invalid/);
    await assert.rejects(new AgentService().getAgent(id), /Invalid/);
    await assert.rejects(new KaizenService().getKaizen(id), /Invalid/);
    await assert.rejects(new ContextService().createContextNote({ title: 'Fixture', slug: id }), /Invalid/);
    await assert.rejects(new OutputService().createTemplate({ name: 'Fixture', slug: id }), /Invalid/);
    await assert.rejects(tasks.getTask(id), /Invalid/);
    await assert.rejects(tasks.listTaskFiles(id), /Invalid/);
    await assert.rejects(tasks.saveTaskFile(id, 'x.txt', Buffer.from('bad')), /Invalid/);
    await assert.rejects(tasks.deleteTaskFile(id, 'x.txt'), /Invalid/);
  }
});

test('HTTP guard rejects untrusted browser requests before mutations and preserves parser statuses', async (t) => {
  const app = express();
  let mutations = 0;
  // Use a fixed logical Host to test the middleware independently of the ephemeral listener port.
  app.use(localRequestGuard(3001));
  app.use(express.json({ limit: '32b' }));
  app.post('/mutate', (_req, res) => { mutations++; res.sendStatus(204); });
  app.get('/failure', () => { throw new Error('private /workspace/secret.md'); });
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  for (const headers of [
    { Host: 'attacker.example:3001' },
    { Host: 'localhost:3001', Origin: 'https://attacker.example' },
    { Host: 'localhost:3001', Origin: 'null' },
    { Host: 'localhost:3001', 'Sec-Fetch-Site': 'cross-site' },
  ]) {
    const response = await httpFetch(`${base}/mutate`, { method: 'POST', headers });
    assert.equal(response.status, 403);
  }
  assert.equal(mutations, 0);
  for (const origin of [undefined, 'http://localhost:5173', 'http://127.0.0.1:3001']) {
    const headers: Record<string, string> = { Host: 'localhost:3001' };
    if (origin) headers.Origin = origin;
    assert.equal((await httpFetch(`${base}/mutate`, { method: 'POST', headers })).status, 204);
  }
  for (const [body, status] of [['{', 400], [JSON.stringify({ text: 'x'.repeat(64) }), 413]] as const) {
    const response = await httpFetch(`${base}/mutate`, {
      method: 'POST', headers: { Host: 'localhost:3001', 'Content-Type': 'application/json' }, body,
    });
    assert.equal(response.status, status);
  }
  const failure = await httpFetch(`${base}/failure`, { headers: { Host: 'localhost:3001' } });
  assert.equal(failure.status, 500);
  assert.ok(!(await failure.text()).includes('secret.md'));
});


test('Markdown is data only and does not cache mutable parsing results', () => {
  const globals = globalThis as typeof globalThis & { gtdParserExecuted?: boolean };
  globals.gtdParserExecuted = false;
  try {
    for (const language of ['js', 'javascript', 'JavaScript', 'JS']) {
      const raw = `---${language}\n(globalThis.gtdParserExecuted = true, {})\n---\nbody`;
      assert.throws(() => parseMarkdown(raw), /Invalid frontmatter/);
      assert.throws(() => stringifyMarkdown(raw, {}), /Invalid frontmatter/);
      assert.equal(globals.gtdParserExecuted, false);
    }
    const raw = '---\ntitle: Fixture\n---\nbody';
    parseMarkdown(raw).data.title = 'mutated';
    assert.equal(parseMarkdown(raw).data.title, 'Fixture');
    assert.equal(parseMarkdown(stringifyMarkdown('body', { title: 'Fixture' })).data.title, 'Fixture');
    assert.equal(parseMarkdown('---json\n{"title":"Fixture"}\n---\nbody').data.title, 'Fixture');
  } finally {
    delete globals.gtdParserExecuted;
  }
});


test('file components reject Windows aliases and alternate data streams', () => {
  for (const name of ['task.md.', 'task.md ', 'task.md:stream', 'C:relative']) {
    assert.throws(() => topLevelName(name), /Invalid/);
  }
});


test('filename validation preserves valid names and rejects paths rather than stripping them', () => {
  for (const name of ['report.md', 'TASK-2026-0001', 'quarterly report.md', '計画.md']) {
    assert.equal(topLevelName(name), name);
  }
  for (const name of ['../report.md', '..\\report.md', '/tmp/report.md', 'folder/report.md', 'folder\\report.md']) {
    assert.throws(() => topLevelName(name), /Invalid/);
  }
});
