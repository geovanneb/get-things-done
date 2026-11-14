import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { parseMarkdown, stringifyMarkdown } from '../src/utils/markdown';
import { TaskService } from '../src/services/taskService';
import { ContextService } from '../src/services/contextService';
import { ContextUpdateService } from '../src/services/contextUpdateService';
import { parseSchedule } from '../src/services/routineSchedule';
import { ValidationService } from '../src/services/validationService';

async function workspace(t: { after: (fn: () => Promise<void> | void) => void }): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-frontmatter-dates-'));
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

/** What an agent or a person may write: a front-matter field without quotes. */
async function setField(file: string, key: string, value: string): Promise<void> {
  const text = await fsp.readFile(file, 'utf-8');
  const line = new RegExp(`^${key}: .*$`, 'm');
  await fsp.writeFile(file, line.test(text) ? text.replace(line, `${key}: ${value}`) : text.replace(/^title: /m, `${key}: ${value}\ntitle: `));
}

const fieldIn = async (file: string, key: string) => (await fsp.readFile(file, 'utf-8')).match(new RegExp(`^${key}: .*$`, 'm'))?.[0];

test('the parser keeps an unquoted day as text and a save quotes it; a value with a time part is a Date as before', () => {
  const parsed = parseMarkdown('---\nday: 2026-11-20\nstamp: 2026-11-08T09:30:00Z\nnested:\n  - due_date: 2026-11-30\nodd: 2026-02-30\n---\nBody\n');
  assert.equal(parsed.data['day'], '2026-11-20');
  assert.deepEqual(parsed.data['nested'], [{ due_date: '2026-11-30' }]);
  assert.equal(parsed.data['odd'], '2026-02-30', 'a day that does not exist is kept as written, not rolled into March');
  assert.ok(parsed.data['stamp'] instanceof Date, 'unchanged: a timestamp is still a Date');
  assert.equal((parsed.data['stamp'] as Date).toISOString(), '2026-11-08T09:30:00.000Z');
  const saved = stringifyMarkdown(parsed.content, parsed.data);
  assert.match(saved, /^day: '2026-11-20'$/m);
  assert.match(saved, /^stamp: 2026-11-08T09:30:00.000Z$/m, 'a timestamp is saved as before');
  assert.deepEqual(parseMarkdown(saved).data['day'], '2026-11-20', 'read, save, read keeps the day');
});

/** Every value in parsed front matter, at any depth, so a test can check nothing internal leaked out. */
function everyValue(value: unknown, out: unknown[] = []): unknown[] {
  out.push(value);
  if (Array.isArray(value)) value.forEach((v) => everyValue(v, out));
  else if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) Object.values(value).forEach((v) => everyValue(v, out));
  return out;
}

test('an unquoted day in a timestamp field (*_at, at any depth) reads as the Date it was before; elsewhere it is the day', () => {
  const parsed = parseMarkdown([
    '---',
    'created_at: 2026-11-08',
    'updated_at: 2026-11-08',
    'review_date: 2026-11-20',
    'change_requests:',
    '  - requested_at: 2026-11-09',
    '    feedback: Shorten it.',
    'waiting: { since: 2026-11-01, set_at: 2026-11-01 }',
    'by_day:',
    '  2026-11-20: Quarterly review',
    'quoted_at: \'2026-11-08\'',
    '---',
    '',
  ].join('\n'));
  const d = parsed.data as Record<string, any>;
  for (const v of [d.created_at, d.updated_at, d.change_requests[0].requested_at, d.waiting.set_at]) {
    assert.ok(v instanceof Date, 'a timestamp field is a Date, as before');
  }
  assert.equal(d.updated_at.toISOString(), '2026-11-08T00:00:00.000Z');
  assert.equal(d.change_requests[0].requested_at.toISOString(), '2026-11-09T00:00:00.000Z');
  assert.equal(d.review_date, '2026-11-20');
  assert.equal(d.waiting.since, '2026-11-01');
  assert.deepEqual(d.by_day, { '2026-11-20': 'Quarterly review' }, 'a day used as a key is its text');
  assert.equal(d.quoted_at, '2026-11-08', 'quoted text is never touched');
  const leaked = everyValue(d).filter((v) => v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date) && Object.getPrototypeOf(v) !== Object.prototype);
  assert.deepEqual(leaked, [], 'no internal marker leaves the parser');
});

test('a task with unquoted day-only created_at and updated_at reads, validates and accepts its old token as before', async (t) => {
  await workspace(t);
  const tasks = new TaskService();
  const created = await tasks.createTask({ title: 'Fictional supplier audit' });
  const file = created.path!;
  await tasks.updateTask(created.id, { status: 'in_progress' });
  await tasks.updateTask(created.id, { status: 'in_review' });
  const dayOnly = async () => {
    await setField(file, 'created_at', '2026-11-08');
    await setField(file, 'updated_at', '2026-11-08');
  };
  const oldToken = '2026-11-08T00:00:00.000Z';

  await dayOnly();
  const task = await tasks.getTask(created.id);
  assert.deepEqual([task.created_at, task.updated_at], [oldToken, oldToken], 'the token an open page holds from before');
  const problems = (await new ValidationService().validateWorkspace()).filter((r) => /^TASK-\S+: (created_at|updated_at)/.test(r.path ?? ''));
  assert.deepEqual(problems, [], 'validation as before: no new errors');

  const requested = await tasks.requestChanges(created.id, { feedback: 'Shorten it.', seen_updated_at: oldToken, request_id: 'req-00000001' });
  assert.equal(requested.task.status, 'in_progress', 'Request changes accepts the old token');

  await dayOnly();
  await tasks.setWaiting(created.id, { waiting: { for: 'Signed sheet', since: '2026-11-01' }, seen_updated_at: oldToken });
  await dayOnly();
  assert.equal((await tasks.resolveWaiting(created.id, { seen_updated_at: oldToken })).waiting, undefined, 'waiting writes accept the old token');

  await dayOnly();
  const saved = await tasks.updateTask(created.id, { priority: 'high', expected_updated_at: oldToken } as never);
  assert.equal(saved.priority, 'high', 'a save accepts the old token');
});

test('only the timestamp type changed: merge keys and the other safe tags read as before; an explicit !!timestamp day is text', () => {
  const parsed = parseMarkdown([
    '---',
    'base: &base { owner: Priya Natarajan, priority: high }',
    'task:',
    '  <<: *base',
    '  priority: low',
    'tags: !!set { alpha: null, beta: null }',
    'pairs: !!pairs [ { a: 1 }, { b: 2 } ]',
    'blob: !!binary aGVsbG8=',
    'tagged: !!timestamp 2026-11-20',
    'tagged_stamp: !!timestamp 2026-11-20T10:00:00+09:00',
    '---',
    '',
  ].join('\n'));
  assert.deepEqual(parsed.data['task'], { owner: 'Priya Natarajan', priority: 'low' }, 'a merge key still merges');
  assert.deepEqual(parsed.data['tags'], { alpha: null, beta: null });
  assert.deepEqual(parsed.data['pairs'], [['a', 1], ['b', 2]]);
  assert.equal(Buffer.from(parsed.data['blob'] as Uint8Array).toString(), 'hello');
  assert.equal(parsed.data['tagged'], '2026-11-20', 'an explicit day is kept as its text too');
  assert.equal((parsed.data['tagged_stamp'] as Date).toISOString(), '2026-11-20T01:00:00.000Z', 'an explicit timestamp is a Date as before');
  assert.throws(() => parseMarkdown('---js\n{ a: 1 }\n---\n'), /executable languages are not supported/);
});

test('routine schedules read unquoted days and, as before, unquoted timestamps as days', () => {
  const read = (startsOn: string, endsOn: string) => parseSchedule(parseMarkdown(
    `---\nschedule:\n  frequency: weekly\n  weekdays: [mon]\n  time: '09:00'\n  starts_on: ${startsOn}\n  ends_on: ${endsOn}\n---\n`,
  ).data['schedule']);
  assert.deepEqual([read('2026-11-02', '2026-12-28').starts_on, read('2026-11-02', '2026-12-28').ends_on], ['2026-11-02', '2026-12-28']);
  const stamped = read('2026-11-01T00:00:00.000Z', '2026-12-31T00:00:00.000Z');
  assert.deepEqual([stamped.starts_on, stamped.ends_on], ['2026-11-01', '2026-12-31']);
});

test('a task review_date written without quotes stays a day through read, save and read', async (t) => {
  await workspace(t);
  const tasks = new TaskService();
  const created = await tasks.createTask({ title: 'Fictional quarterly review' });
  const file = created.path!;
  await setField(file, 'review_date', '2026-11-20');

  let task = await tasks.getTask(created.id);
  assert.equal(task.review_date, '2026-11-20');
  task = await tasks.updateTask(created.id, { priority: 'high', expected_updated_at: task.updated_at } as never);
  assert.equal(task.review_date, '2026-11-20');
  assert.equal(await fieldIn(file, 'review_date'), "review_date: '2026-11-20'", 'still a day in task.md');
  assert.equal((await tasks.getTask(created.id)).review_date, '2026-11-20');
});

test('a context note expiry_date written without quotes stays a day through read, save and read', async (t) => {
  await workspace(t);
  const context = new ContextService();
  const note = await context.createContextNote({ title: 'Fictional market note', category: 'company' });
  await setField(note.path!, 'expiry_date', '2026-12-31');

  assert.equal((await context.getContextNote(note.id)).expiry_date, '2026-12-31');
  await context.updateContextNote(note.id, { body: 'Updated body' });
  assert.equal(await fieldIn(note.path!, 'expiry_date'), "expiry_date: '2026-12-31'", 'still a day in note.md');
  assert.equal((await context.getContextNote(note.id)).expiry_date, '2026-12-31');
});

test('the context list survives an unquoted updated_at and sorts mixed offsets by time, newest first', async (t) => {
  await workspace(t);
  const context = new ContextService();
  const tokyo = await context.createContextNote({ title: 'Fictional pricing note', category: 'company' });
  const unquoted = await context.createContextNote({ title: 'Fictional hiring note', category: 'organization' });
  const server = await context.createContextNote({ title: 'Fictional market note', category: 'strategy' });
  await setField(tokyo.path!, 'updated_at', "'2026-11-08T09:30:00+09:00'");
  await setField(unquoted.path!, 'updated_at', '2026-11-08T05:00:00Z');
  await setField(server.path!, 'updated_at', "'2026-11-08T01:00:00.000Z'");

  const notes = await context.listContextNotes();
  assert.deepEqual(notes.map((n) => n.id), [unquoted.id, server.id, tokyo.id], '05:00Z, 01:00Z, then 00:30Z');
});

test('a quoted updated_at with an offset is kept as written and its token still saves the task', async (t) => {
  await workspace(t);
  const tasks = new TaskService();
  const created = await tasks.createTask({ title: 'Fictional supplier review' });
  await setField(created.path!, 'updated_at', "'2026-11-08T09:30:00+09:00'");
  const task = await tasks.getTask(created.id);
  assert.equal(task.updated_at, '2026-11-08T09:30:00+09:00');
  const saved = await tasks.updateTask(created.id, { priority: 'high', expected_updated_at: '2026-11-08T09:30:00+09:00' } as never);
  assert.equal(saved.priority, 'high');
});

test('a context update source_date and nested dates written without quotes survive an edit of the title', async (t) => {
  const ws = await workspace(t);
  const service = new ContextUpdateService();
  const { id } = await service.create({ text: 'Fictional notes' });
  const file = path.join(ws, 'context-updates', id, 'update.md');
  await setField(file, 'source_date', '2026-11-02');
  await setField(file, 'extra_dates', '{ due_date: 2026-11-30 }');

  assert.equal((await service.get(id)).source_date, '2026-11-02');
  await service.edit(id, { title: 'Renamed fictional update' });
  const text = await fsp.readFile(file, 'utf-8');
  assert.match(text, /^source_date: '2026-11-02'$/m, 'still a day in update.md');
  assert.doesNotMatch(text, /T00:00:00/, 'no field was rewritten as a timestamp');
  assert.equal((await service.get(id)).source_date, '2026-11-02');
});

test('files an earlier save already rewrote as timestamps read as before', async (t) => {
  const ws = await workspace(t);
  const tasks = new TaskService();
  const created = await tasks.createTask({ title: 'Fictional board pack' });
  await setField(created.path!, 'due_date', '2026-11-20T00:00:00.000Z');
  assert.equal((await tasks.getTask(created.id)).due_date, '2026-11-20', 'a due date reads as its day, as since the earlier fix');

  const service = new ContextUpdateService();
  const { id } = await service.create({ text: 'Fictional notes' });
  await setField(path.join(ws, 'context-updates', id, 'update.md'), 'source_date', '2026-11-02T00:00:00.000Z');
  assert.equal((await service.get(id)).source_date, '2026-11-02');
});
