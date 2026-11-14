import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as http from 'node:http';
import * as path from 'node:path';
import * as os from 'node:os';
import express from 'express';
import { TaskService } from '../src/services/taskService';
import { StakeholderService } from '../src/services/stakeholderService';
import { ContextService } from '../src/services/contextService';
import { OutputService } from '../src/services/outputService';
import { SituationService } from '../src/services/situationService';
import { InsightsService } from '../src/services/insightsService';
import { ValidationService } from '../src/services/validationService';
import { ExecutionPackageService } from '../src/services/executionPackageService';
import { SearchService } from '../src/services/searchService';
import { OrgChartService } from '../src/services/orgChartService';
import { GitService } from '../src/services/gitService';
import { localRequestGuard } from '../src/middleware/localRequestGuard';
import { topLevelName } from '../src/utils/files';

// Regressions found in the review before 0.14: files written by hand or by an agent, and requests with the wrong
// types, must never take a whole screen down. Fictional data in temporary workspaces only.

async function workspace(t: { after: (fn: () => Promise<void> | void) => void }): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-release-014-'));
  const previous = process.env.ESB_WORKSPACE_PATH;
  process.env.ESB_WORKSPACE_PATH = dir;
  t.after(async () => {
    if (previous === undefined) delete process.env.ESB_WORKSPACE_PATH;
    else process.env.ESB_WORKSPACE_PATH = previous;
    await fsp.rm(dir, { recursive: true, force: true });
  });
  for (const d of ['tasks/active', 'tasks/archive', 'stakeholders/people', 'stakeholders/groups', 'context', 'outputs/templates', '.situation-board']) {
    await fsp.mkdir(path.join(dir, d), { recursive: true });
  }
  return dir;
}

async function write(file: string, text: string): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, text);
}

const status = (err: unknown) => (err as { statusCode?: number }).statusCode;

test('a stakeholder file without a name does not take the whole list down', async (t) => {
  const ws = await workspace(t);
  const service = new StakeholderService();
  await service.createStakeholder({ name: 'Mara Lindholm', role: 'CFO' });
  await write(path.join(ws, 'stakeholders/people/stk-0099.md'), '---\nid: STK-0099\nrole: Advisor\ntags: finance\n---\nnotes\n');
  await write(path.join(ws, 'stakeholders/people/stk-0098.md'), '---\nid: STK-0098\nname: 2026\n---\n');

  const list = await service.listStakeholders();
  assert.equal(list.length, 3);
  const unnamed = list.find((s) => s.id === 'STK-0099')!;
  assert.equal(unnamed.name, 'STK-0099', 'a person without a name is listed under their id');
  assert.deepEqual(unnamed.tags, ['finance'], 'one tag written as text is one tag');
  assert.equal(list.find((s) => s.id === 'STK-0098')!.name, '2026');
  assert.equal((await service.getStakeholder('STK-0099')).name, 'STK-0099');
});

test('an output template without a name does not take the whole list down', async (t) => {
  const ws = await workspace(t);
  const service = new OutputService();
  await service.createTemplate({ name: 'Board memo' });
  await write(path.join(ws, 'outputs/templates/hand/output.md'), '---\nid: OUT-hand\nformat: md\n---\n');
  const list = await service.listTemplates();
  assert.deepEqual(list.map((x) => x.name).sort(), ['Board memo', 'OUT-hand']);
});

test('context notes with unquoted dates are listed, newest first', async (t) => {
  const ws = await workspace(t);
  const service = new ContextService();
  await service.createContextNote({ title: 'Carrier risk', category: 'risks' });
  await write(path.join(ws, 'context/company/aaa/note.md'), '---\nid: CTX-aaa\ntitle: Aaa\nupdated_at: 2026-11-20\n---\nBody\n');
  await write(path.join(ws, 'context/situation/zzz/note.md'), '---\nid: CTX-zzz\ntitle: 42\ncreated_at: 2026-11-08T09:30:00Z\nupdated_at: 2026-11-08T09:30:00Z\ntags: one\n---\nBody\n');
  const list = await service.listContextNotes();
  assert.equal(list.length, 3);
  for (const note of list) {
    assert.equal(typeof note.updated_at, 'string');
    assert.equal(typeof note.title, 'string');
  }
  assert.equal(list.find((n) => n.id === 'CTX-zzz')!.updated_at, '2026-11-08T09:30:00.000Z');
});

test('reading the notes of an unknown category is refused and makes no folder', async (t) => {
  const ws = await workspace(t);
  await assert.rejects(new ContextService().listContextNotes('made-by-a-read' as never), (err) => status(err) === 400);
  await assert.rejects(fsp.stat(path.join(ws, 'context/made-by-a-read')), 'a read must not create folders in the workspace');
});

test('a task file written loosely still reads as a task every screen can use', async (t) => {
  const ws = await workspace(t);
  await write(path.join(ws, 'tasks/active/TASK-2026-0900/task.md'),
    '---\nid: TASK-2026-0900\ntitle: 2026\nstatus: in_progress\npriority: high\ntags: urgent\nstakeholders: [STK-0001, 7]\nskills: writing\ndependencies: TASK-2026-0001\ndeliverables: report.md\ndue_date: 2026-11-20\nstart_date: 2026-11-01\n---\nBody\n');
  await write(path.join(ws, 'tasks/active/TASK-2026-0901/task.md'), '---\nid: TASK-2026-0901\nstatus: backlog\n---\nNo title\n');

  const tasks = await new TaskService().listTasks();
  const loose = tasks.find((x) => x.id === 'TASK-2026-0900')!;
  assert.equal(loose.title, '2026');
  assert.deepEqual(loose.tags, ['urgent']);
  assert.deepEqual(loose.skills, ['writing']);
  assert.deepEqual(loose.dependencies, ['TASK-2026-0001']);
  assert.deepEqual(loose.deliverables, ['report.md']);
  assert.deepEqual(loose.stakeholder_refs, ['STK-0001']);
  assert.deepEqual(loose['stakeholders'], [{ ref: 'STK-0001' }]);
  assert.equal(typeof tasks.find((x) => x.id === 'TASK-2026-0901')!.title, 'string');
  assert.deepEqual((await new TaskService().getTask('TASK-2026-0900')).tags, ['urgent']);

  // Every screen that reads all tasks keeps working.
  await new SituationService().getSituationData();
  await new InsightsService().getInsightsData(30);
  const results = await new ValidationService().validateWorkspace();
  assert.ok(results.length > 0);
  const search = new SearchService();
  try { await search.buildIndex(); await search.search('body'); } finally { search.reset(); }
});

test('clearing a field of a task removes it instead of writing null', async (t) => {
  await workspace(t);
  const service = new TaskService();
  const task = await service.createTask({ title: 'Renewal plan', due_date: '2026-11-20', template_ref: 'OUT-board-memo' });
  const saved = await service.updateTask(task.id, { due_date: null, template_ref: null } as never);
  assert.ok(!('due_date' in saved));
  const file = await fsp.readFile(saved.path!, 'utf8');
  assert.doesNotMatch(file, /due_date|template_ref/, 'null is not a date in the task schema');
  const problems = new ValidationService().validateTask(await service.getTask(task.id));
  assert.deepEqual(problems.filter((p) => p.level === 'error'), []);
});

test('a task is never saved with a status or priority the board does not know', async (t) => {
  await workspace(t);
  const service = new TaskService();
  await assert.rejects(service.createTask({ title: 'x', status: 'flying' as never }), (err) => status(err) === 400);
  await assert.rejects(service.createTask({ title: 'x', priority: 'urgent' as never }), (err) => status(err) === 400);
  const task = await service.createTask({ title: 'Renewal plan' });
  await assert.rejects(service.updateTask(task.id, { status: 42 as never }), (err) => status(err) === 400);
  await assert.rejects(service.updateTask(task.id, { priority: 'urgent' as never }), (err) => status(err) === 400);
  await assert.rejects(service.updateTask(task.id, { title: ['a'] as never }), (err) => status(err) === 400);
  await assert.rejects(service.updateTask(task.id, { tags: 'one' as never }), (err) => status(err) === 400);
  assert.equal((await service.getTask(task.id)).status, 'backlog');
});

test('text fields sent with another type are refused, not written or crashed on', async (t) => {
  await workspace(t);
  const person = await new StakeholderService().createStakeholder({ name: 'Mara Lindholm' });
  await assert.rejects(new StakeholderService().updateStakeholder(person.id, { notes: 42 as never }), (err) => status(err) === 400);
  await assert.rejects(new StakeholderService().updateStakeholder(person.id, { name: {} as never }), (err) => status(err) === 400);
  assert.equal((await new StakeholderService().getStakeholder(person.id)).name, 'Mara Lindholm');

  const note = await new ContextService().createContextNote({ title: 'Carrier risk', category: 'risks' });
  await assert.rejects(new ContextService().updateContextNote(note.id, { body: 42 as never }), (err) => status(err) === 400);
  await assert.rejects(new ContextService().updateContextNote(note.id, { title: [] as never }), (err) => status(err) === 400);

  const template = await new OutputService().createTemplate({ name: 'Board memo' });
  await assert.rejects(new OutputService().updateTemplate(template.id, { description: 42 as never }), (err) => status(err) === 400);
  await assert.rejects(new OutputService().updateTemplate(template.id, { name: 42 as never }), (err) => status(err) === 400);

  const charts = new OrgChartService();
  await assert.rejects(charts.createChart({ name: 'Leadership', notes: 42 as never }), (err) => status(err) === 400);
  const chart = await charts.createChart({ name: 'Leadership' });
  await assert.rejects(charts.updateChart(chart.id, { organization: 42 as never }), (err) => status(err) === 400);
  await charts.updateChart(chart.id, { description: null as never });

  await assert.rejects(new GitService().commit(42 as never), (err) => status(err) === 400);
  await assert.rejects(new GitService().commit('Weekly notes'), (err) => status(err) === 409, 'not a repository is a conflict, not a server error');
  assert.deepEqual(await new GitService().getLog(Number.NaN), []);
  assert.equal((await new ContextService().updateContextNote(note.id, { body: null as never })).body, '');

  const task = await new TaskService().createTask({ title: 'Renewal plan' });
  const pkg = await new ExecutionPackageService().buildPackage(task.id, { includeStakeholders: true, includeContext: true, includeProfile: true, includeTemplate: true, selectedStakeholderRefs: 42 as never, selectedContextIds: 'x' as never });
  assert.ok(pkg);
});

test('a name longer than a file name can be is refused as a name, not a server error', () => {
  assert.throws(() => topLevelName('x'.repeat(300)), /Invalid file name/);
  assert.equal(topLevelName('TASK-2026-0001'), 'TASK-2026-0001');
});

test('search does not repeat a description that is also the body', async (t) => {
  await workspace(t);
  await new TaskService().createTask({ title: 'Zebra audit', description: 'Count every zebra once.' });
  const search = new SearchService();
  try {
    await search.buildIndex();
    const [hit] = await search.search('zebra');
    assert.equal(hit!.excerpt, 'Count every zebra once.');
  } finally { search.reset(); }
});

function request(port: number, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/x', method: 'POST', headers }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on('error', reject);
    req.end();
  });
}

test('a page on a development port is not trusted by an installed dashboard', async (t) => {
  const previous = process.env.NODE_ENV;
  t.after(() => { if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous; });
  const serve = async (): Promise<number> => {
    const app = express();
    app.use(localRequestGuard(3001));
    app.post('/api/x', (_req, res) => { res.sendStatus(204); });
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
    return (server.address() as { port: number }).port;
  };

  process.env.NODE_ENV = 'production';
  const installed = await serve();
  for (const origin of ['http://localhost:3000', 'http://localhost:5173', 'http://127.0.0.1:4173']) {
    assert.equal(await request(installed, { Host: 'localhost:3001', Origin: origin }), 403, `${origin} must not reach an installed dashboard`);
  }
  assert.equal(await request(installed, { Host: 'localhost:3001', Origin: 'http://localhost:3001' }), 204);
  assert.equal(await request(installed, { Host: 'localhost:3001' }), 204);

  delete process.env.NODE_ENV;
  const development = await serve();
  assert.equal(await request(development, { Host: 'localhost:3001', Origin: 'http://localhost:5173' }), 204, 'npm run dev keeps working');
});
