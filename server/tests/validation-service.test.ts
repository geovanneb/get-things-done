import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { ValidationService } from '../src/services/validationService';
import type { Stakeholder, Task, ValidationResult } from '../src/types';

const service = new ValidationService();

// Dates far enough from today that the overdue check never depends on when the tests run.
const PAST = '2000-01-15';
const FUTURE = '2999-12-31';

function task(fields: Partial<Task> = {}): Task {
  return {
    id: 'TASK-2026-0001',
    title: 'Prepare the quarterly review',
    status: 'backlog',
    priority: 'medium',
    tags: [],
    stakeholder_refs: [],
    skills: [],
    deliverables: [],
    dependencies: [],
    created_at: '2026-01-05T09:00:00.000Z',
    updated_at: '2026-01-05T09:00:00.000Z',
    ...fields,
  } as Task;
}

function stakeholder(fields: Partial<Stakeholder> = {}): Stakeholder {
  return { id: 'STK-0001', name: 'Alex Example', influence: 'informed', ...fields } as Stakeholder;
}

const rules = (results: ValidationResult[]) => results.map((r) => r.rule);

// --- validateTask ---------------------------------------------------------------------------

test('a well-formed task has no findings', () => {
  assert.deepEqual(service.validateTask(task({ due_date: FUTURE, start_date: '2026-01-05T09:00:00.000Z' })), []);
});

test('every status the app uses passes the schema', () => {
  for (const status of ['backlog', 'ready', 'in_progress', 'blocked', 'review', 'in_review', 'approved', 'done', 'archived']) {
    const done_date = status === 'done' || status === 'approved' || status === 'archived' ? '2026-02-01' : undefined;
    const schema = service.validateTask(task({ status: status as Task['status'], done_date })).filter((r) => r.rule === 'schema');
    assert.deepEqual(schema, [], `status ${status}`);
  }
});

test('an unknown status, priority or id format is a schema error', () => {
  const results = service.validateTask(task({ id: 'T-1', status: 'someday' as Task['status'], priority: 'urgent' as Task['priority'] }));
  const paths = results.filter((r) => r.rule === 'schema' && r.level === 'error').map((r) => r.path);
  assert.deepEqual(paths.sort(), ['/id', '/priority', '/status']);
});

test('a blank title is reported as a required field', () => {
  const results = service.validateTask(task({ title: '   ' }));
  assert.ok(results.some((r) => r.rule === 'required_fields' && r.level === 'error' && r.path === 'title'));
});

test('a due date before the start date is an error, but the same calendar day is fine', () => {
  const late = service.validateTask(task({ start_date: '2026-03-10T08:00:00.000Z', due_date: '2026-03-09' }));
  assert.ok(late.some((r) => r.rule === 'date_logic' && r.level === 'error'));

  const sameDay = service.validateTask(task({ start_date: '2026-03-10T18:00:00.000Z', due_date: '2026-03-10' }));
  assert.ok(!sameDay.some((r) => r.rule === 'date_logic'));
});

test('a done_date on an open task is a warning', () => {
  const results = service.validateTask(task({ status: 'in_progress', done_date: '2026-02-01' }));
  assert.ok(results.some((r) => r.rule === 'date_logic' && r.level === 'warning' && r.path === 'done_date'));

  assert.ok(!rules(service.validateTask(task({ status: 'archived', done_date: '2026-02-01' }))).includes('date_logic'));
});

test('a finished task without a done_date gets a hint, for both done spellings', () => {
  for (const status of ['done', 'approved'] as const) {
    const results = service.validateTask(task({ status }));
    assert.ok(results.some((r) => r.rule === 'best_practice' && r.level === 'info'), status);
  }
});

test('an open task past its due date is overdue; finished and archived ones are not', () => {
  for (const status of ['backlog', 'in_progress', 'blocked', 'in_review'] as const) {
    assert.ok(rules(service.validateTask(task({ status, due_date: PAST }))).includes('overdue'), status);
  }
  for (const status of ['done', 'approved', 'archived'] as const) {
    assert.ok(!rules(service.validateTask(task({ status, due_date: PAST, done_date: PAST }))).includes('overdue'), status);
  }
  assert.ok(!rules(service.validateTask(task({ due_date: FUTURE }))).includes('overdue'));
});

// --- validateStakeholder --------------------------------------------------------------------

test('a well-formed person or group has no findings', () => {
  assert.deepEqual(service.validateStakeholder(stakeholder({ email: 'alex@example.com' })), []);
  assert.deepEqual(service.validateStakeholder(stakeholder({ id: 'GRP-0001', name: 'Steering group', influence: 'decision_maker' })), []);
});

test('a bad stakeholder id, influence or email is a schema error', () => {
  const results = service.validateStakeholder(stakeholder({ id: 'S-1', influence: 'boss' as Stakeholder['influence'], email: 'not-an-email' }));
  const paths = results.filter((r) => r.rule === 'schema').map((r) => r.path);
  assert.deepEqual(paths.sort(), ['/email', '/id', '/influence']);
});

test('a blank stakeholder name is reported as a required field', () => {
  assert.ok(service.validateStakeholder(stakeholder({ name: ' ' })).some((r) => r.rule === 'required_fields'));
});

// --- validateWorkspace ----------------------------------------------------------------------

/** A throwaway fictional workspace; the services read its path from ESB_WORKSPACE_PATH. */
async function workspace(t: { after: (fn: () => Promise<void> | void) => void }): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-validation-'));
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

async function writeFile(ws: string, rel: string, frontmatter: string[]): Promise<void> {
  const file = path.join(ws, rel);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, `---\n${frontmatter.join('\n')}\n---\n\nBody.\n`);
}

const writeTask = (ws: string, folder: string, lines: string[]) => writeFile(ws, path.join('tasks', 'active', folder, 'task.md'), lines);

test('a clean workspace reports that validation passed', async (t) => {
  const ws = await workspace(t);
  await writeFile(ws, 'stakeholders/people/alex-example.md', ['id: STK-0001', 'name: Alex Example', 'influence: sponsor']);
  await writeTask(ws, 'TASK-2026-0001', ['id: TASK-2026-0001', 'title: Quarterly review', 'status: backlog', 'priority: high', 'stakeholder_refs:', '  - STK-0001']);

  const results = await service.validateWorkspace();
  assert.deepEqual(results.map((r) => [r.level, r.rule]), [['info', 'workspace']]);
});

test('duplicate ids, unknown stakeholders and unknown templates are reported', async (t) => {
  const ws = await workspace(t);
  await writeFile(ws, 'stakeholders/people/alex-example.md', ['id: STK-0001', 'name: Alex Example', 'influence: sponsor']);
  await writeFile(ws, 'stakeholders/people/sam-sample.md', ['id: STK-0001', 'name: Sam Sample', 'influence: informed']);
  await writeTask(ws, 'TASK-2026-0001', ['id: TASK-2026-0001', 'title: Quarterly review', 'status: backlog', 'priority: high']);
  await writeTask(ws, 'TASK-2026-0001-copy', ['id: TASK-2026-0001', 'title: Quarterly review (copy)', 'status: backlog', 'priority: high']);
  await writeTask(ws, 'TASK-2026-0002', [
    'id: TASK-2026-0002', 'title: Board pack', 'status: ready', 'priority: medium',
    'stakeholder_refs:', '  - STK-0099', 'template_ref: no-such-template',
  ]);

  const results = await service.validateWorkspace();
  const messages = results.map((r) => r.message);

  assert.ok(messages.includes('Duplicate task ID: TASK-2026-0001'));
  assert.ok(messages.includes('Duplicate stakeholder ID: STK-0001'));
  assert.ok(messages.includes('Task TASK-2026-0002 references unknown stakeholder: STK-0099'));
  assert.ok(messages.includes('Task TASK-2026-0002 references unknown template: no-such-template'));
  assert.ok(!results.some((r) => r.rule === 'workspace' && r.level === 'info'), 'no "passed" message when there are findings');
});

test('task findings are prefixed with the task id', async (t) => {
  const ws = await workspace(t);
  await writeTask(ws, 'TASK-2026-0003', ['id: TASK-2026-0003', 'title: Budget memo', 'status: in_progress', 'priority: low', `due_date: '${PAST}'`]);

  const overdue = (await service.validateWorkspace()).find((r) => r.rule === 'overdue');
  assert.equal(overdue?.path, 'TASK-2026-0003: due_date');
});

test('an org chart with a reporting loop or an unknown member is reported', async (t) => {
  const ws = await workspace(t);
  await writeFile(ws, 'stakeholders/people/alex-example.md', ['id: STK-0001', 'name: Alex Example', 'influence: sponsor']);
  await writeFile(ws, 'stakeholders/people/sam-sample.md', ['id: STK-0002', 'name: Sam Sample', 'influence: informed']);
  await writeFile(ws, 'stakeholders/org-charts/org-0001.md', [
    'id: ORG-0001', 'name: Example team', 'members:',
    '  - ref: STK-0001', '    reports_to: STK-0002',
    '  - ref: STK-0002', '    reports_to: STK-0001',
    '  - ref: STK-0077',
  ]);

  const results = await service.validateWorkspace();
  assert.ok(results.some((r) => r.rule === 'org_chart_loop' && r.level === 'error' && r.message.startsWith('Org chart ORG-0001 has a reporting loop')));
  assert.ok(results.some((r) => r.message === 'Org chart ORG-0001 references unknown stakeholder: STK-0077'));
});
