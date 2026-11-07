import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { inflateRawSync } from 'node:zlib';
import { TaskService } from '../src/services/taskService';
import { buildSharePack, previewSharePack } from '../src/services/sharePack';

async function workspace(t: { after: (fn: () => Promise<void> | void) => void }): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-share-pack-'));
  const previous = process.env.ESB_WORKSPACE_PATH;
  process.env.ESB_WORKSPACE_PATH = dir;
  t.after(async () => {
    if (previous === undefined) delete process.env.ESB_WORKSPACE_PATH;
    else process.env.ESB_WORKSPACE_PATH = previous;
    await fsp.rm(dir, { recursive: true, force: true });
  });
  for (const d of ['tasks/active', 'outputs/templates']) await fsp.mkdir(path.join(dir, d), { recursive: true });
  return dir;
}

/** The entries of a ZIP the app built: name to text, read from its local file headers (stored or deflated). */
function unzip(buf: Buffer): Map<string, string> {
  const out = new Map<string, string>();
  let at = 0;
  while (buf.readUInt32LE(at) === 0x04034b50) {
    const method = buf.readUInt16LE(at + 8);
    const size = buf.readUInt32LE(at + 18);
    const nameLength = buf.readUInt16LE(at + 26);
    const extra = buf.readUInt16LE(at + 28);
    const name = buf.subarray(at + 30, at + 30 + nameLength).toString('utf-8');
    const start = at + 30 + nameLength + extra;
    const raw = buf.subarray(start, start + size);
    out.set(name, (method === 8 ? inflateRawSync(raw) : raw).toString('utf-8'));
    at = start + size;
  }
  return out;
}

const status = (code: number) => (err: Error & { statusCode?: number }) => err.statusCode === code;
const tasks = new TaskService();

async function taskWithFiles(ws: string, title: string, confidentiality?: string) {
  const created = await tasks.createTask({ title, ...(confidentiality ? { confidentiality } : {}) } as never);
  const dir = path.join(ws, 'tasks', 'active', created.id);
  await fsp.mkdir(path.join(dir, 'deliverables'), { recursive: true });
  await fsp.mkdir(path.join(dir, 'executions'), { recursive: true });
  await fsp.writeFile(path.join(dir, 'deliverables', 'summary.md'), `# ${title} summary\n`);
  await fsp.writeFile(path.join(dir, 'brief.pdf'), `pdf of ${title}`);
  await fsp.writeFile(path.join(dir, 'executions', 'log.md'), 'internal log');
  await tasks.updateTask(created.id, { deliverables: [{ id: 'D1', format: 'md', status: 'complete', file_path: `tasks/active/${created.id}/deliverables/summary.md` }] } as never);
  return created.id;
}

test('a share pack lists the chosen files in order, with names that never collide, and a README from the facts', async (t) => {
  const ws = await workspace(t);
  const a = await taskWithFiles(ws, 'Fictional board pack', 'confidential');
  const b = await taskWithFiles(ws, 'Fictional carrier brief');
  const items = [
    { task: b, kind: 'deliverable', ref: 'D1' },
    { task: a, kind: 'deliverable', ref: 'D1' },
    { task: a, kind: 'attachment', ref: 'brief.pdf' },
  ];
  const preview = await previewSharePack({ items });
  assert.equal(preview.ready, true);
  assert.deepEqual(preview.rows.map((r) => r.zip_name), ['01-summary.md', '02-summary.md', '03-brief.pdf'], 'same file name twice, two names in the pack');
  assert.deepEqual(preview.rows.map((r) => r.confidentiality), [null, 'confidential', 'confidential'], 'shown, never a permission');
  assert.match(preview.readme, /`02-summary\.md`: Fictional board pack \(marked confidential\)/);

  const zip = await buildSharePack({ items, readme: '# For the steering group\n', token: preview.token });
  const entries = unzip(zip.data);
  const folder = zip.name.replace(/\.zip$/, '');
  assert.deepEqual([...entries.keys()], ['README.md', '01-summary.md', '02-summary.md', '03-brief.pdf'].map((n) => `${folder}/${n}`), 'only what was chosen, in order');
  assert.equal(entries.get(`${folder}/README.md`), '# For the steering group\n', 'the edited README');
  assert.equal(entries.get(`${folder}/02-summary.md`), '# Fictional board pack summary\n');
});

test('only attached files and deliverables can go in: never task.md, a subfolder or a path elsewhere', async (t) => {
  const ws = await workspace(t);
  const a = await taskWithFiles(ws, 'Fictional board pack');
  for (const ref of ['task.md', 'executions/log.md', '../../package.json', '.hidden']) {
    const preview = await previewSharePack({ items: [{ task: a, kind: 'attachment', ref }] });
    assert.ok(preview.rows[0]!.problem, ref);
    assert.equal(preview.ready, false);
  }
  await assert.rejects(previewSharePack({ items: [] }), status(400));
  await assert.rejects(previewSharePack({ items: [{ task: '../x', kind: 'attachment', ref: 'a' }] }), status(400));
  await assert.rejects(previewSharePack({ items: [{ task: a, kind: 'attachment', ref: 'brief.pdf' }, { task: a, kind: 'attachment', ref: 'brief.pdf' }] }), status(400));
});

test('the download holds exactly what was previewed: a missing or changed file is refused', async (t) => {
  const ws = await workspace(t);
  const a = await taskWithFiles(ws, 'Fictional board pack');
  const items = [{ task: a, kind: 'attachment', ref: 'brief.pdf' }, { task: a, kind: 'deliverable', ref: 'D1' }];
  const preview = await previewSharePack({ items });
  await fsp.writeFile(path.join(ws, 'tasks', 'active', a, 'brief.pdf'), 'a newer version');
  await assert.rejects(buildSharePack({ items, readme: '', token: preview.token }), status(409), 'changed since the preview');

  await fsp.rm(path.join(ws, 'tasks', 'active', a, 'brief.pdf'));
  const missing = await previewSharePack({ items });
  assert.match(missing.rows[0]!.problem ?? '', /missing/);
  assert.equal(missing.ready, false);
  await assert.rejects(buildSharePack({ items, readme: '', token: missing.token }), status(409));
});

test('a deliverable can only come from its own task folder: never another task, a log, a meeting or a link', { skip: process.platform === 'win32' ? 'symlinks need privileges' : false }, async (t) => {
  const ws = await workspace(t);
  const a = await taskWithFiles(ws, 'Fictional board pack');
  const b = await taskWithFiles(ws, 'Fictional other task');
  await fsp.mkdir(path.join(ws, 'meetings', 'MQ-2026-0001'), { recursive: true });
  await fsp.writeFile(path.join(ws, 'meetings', 'MQ-2026-0001', 'transcript.md'), 'private words');
  await fsp.symlink(path.join(ws, 'tasks', 'active', a, 'task.md'), path.join(ws, 'tasks', 'active', a, 'deliverables', 'linked.md'));
  await fsp.symlink(path.join(ws, 'tasks', 'active', a, 'task.md'), path.join(ws, 'tasks', 'active', a, 'alias.pdf'));
  const paths = [`tasks/active/${b}/task.md`, `tasks/active/${a}/executions/log.md`, 'meetings/MQ-2026-0001/transcript.md', `tasks/active/${a}/../${b}/brief.pdf`, `tasks/active/${a}/deliverables/linked.md`];
  await tasks.updateTask(a, { deliverables: paths.map((file_path, i) => ({ id: `D${i + 1}`, format: 'md', status: 'complete', file_path })) } as never);
  const preview = await previewSharePack({ items: [...paths.map((_, i) => ({ task: a, kind: 'deliverable', ref: `D${i + 1}` })), { task: a, kind: 'attachment', ref: 'alias.pdf' }] });
  assert.ok(preview.rows.every((r) => r.problem && r.sha256 === null), JSON.stringify(preview.rows.map((r) => [r.ref, r.problem])));
  assert.equal(preview.ready, false);
});

test('a task folder reached through a link is refused; an archived task still shares its own files', { skip: process.platform === 'win32' ? 'symlinks need privileges' : false }, async (t) => {
  const ws = await workspace(t);
  const a = await taskWithFiles(ws, 'Fictional archived pack');
  await tasks.archiveTask(a);
  const archived = await previewSharePack({ items: [{ task: a, kind: 'deliverable', ref: 'D1' }, { task: a, kind: 'attachment', ref: 'brief.pdf' }] });
  assert.equal(archived.ready, true, 'a path saved while active is found in the archive');

  const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-share-outside-'));
  t.after(() => fsp.rm(outside, { recursive: true, force: true }));
  await fsp.writeFile(path.join(outside, 'task.md'), '---\nid: TASK-2026-0900\ntitle: Outside\nstatus: backlog\npriority: low\n---\n');
  await fsp.writeFile(path.join(outside, 'secret.pdf'), 'outside the workspace');
  await fsp.symlink(outside, path.join(ws, 'tasks', 'active', 'TASK-2026-0900'));
  const linked = await previewSharePack({ items: [{ task: 'TASK-2026-0900', kind: 'attachment', ref: 'secret.pdf' }] });
  assert.ok(linked.rows[0]!.problem && linked.rows[0]!.sha256 === null);
});

test('a pack over the size limit is refused from the sizes, before anything large is read', async (t) => {
  const ws = await workspace(t);
  const a = await taskWithFiles(ws, 'Fictional big pack');
  // A sparse file: its size is over the limit, but nothing is allocated or read.
  const big = path.join(ws, 'tasks', 'active', a, 'huge.bin');
  await (await fsp.open(big, 'w')).close();
  await fsp.truncate(big, 201 * 1024 * 1024);
  const preview = await previewSharePack({ items: [{ task: a, kind: 'attachment', ref: 'huge.bin' }] });
  assert.match(preview.rows[0]!.problem ?? '', /too large/);
  assert.equal(preview.rows[0]!.sha256, null, 'not hashed');
});

test('internal names are refused whatever their case, and reading stops at the allowed size', async (t) => {
  const ws = await workspace(t);
  const a = await taskWithFiles(ws, 'Fictional case pack');
  await tasks.updateTask(a, { deliverables: [{ id: 'D1', format: 'md', status: 'complete', file_path: `tasks/active/${a}/Executions/log.md` }] } as never);
  const preview = await previewSharePack({ items: [{ task: a, kind: 'attachment', ref: 'TASK.MD' }, { task: a, kind: 'deliverable', ref: 'D1' }] });
  assert.ok(preview.rows.every((r) => r.problem && r.sha256 === null), JSON.stringify(preview.rows.map((r) => r.problem)));

  // A file larger than the cap (it grew since its size was checked) is never read past the cap.
  const { readCapped } = await import('../src/services/sharePack');
  const file = path.join(ws, 'tasks', 'active', a, 'brief.pdf');
  assert.equal(await readCapped(file, 3, true), null);
  assert.equal((await readCapped(file, 1000, true))?.data?.toString(), 'pdf of Fictional case pack');
});
