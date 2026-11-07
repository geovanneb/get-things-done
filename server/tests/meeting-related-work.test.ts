import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import { TaskService } from '../src/services/taskService';
import { refreshTaskMeetings, syncTaskMeetings } from '../src/services/meetingSources';
import { relatedWork } from '../src/services/meetingRelatedWork';
import { stringifyMarkdown } from '../src/utils/markdown';
import { ContextUpdateService } from '../src/services/contextUpdateService';
import { MeetingHistoryService } from '../src/services/meetingHistoryService';

async function workspace(t: { after: (fn: () => Promise<void> | void) => void }): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-related-work-'));
  const previous = process.env.ESB_WORKSPACE_PATH;
  process.env.ESB_WORKSPACE_PATH = dir;
  t.after(async () => {
    if (previous === undefined) delete process.env.ESB_WORKSPACE_PATH;
    else process.env.ESB_WORKSPACE_PATH = previous;
    await fsp.rm(dir, { recursive: true, force: true });
  });
  for (const d of ['tasks/active', 'tasks/archive', 'context-updates', '.situation-board/routines', '.situation-board/trash', 'outputs/templates', 'context', 'stakeholders/people']) {
    await fsp.mkdir(path.join(dir, d), { recursive: true });
  }
  return dir;
}

const tasks = new TaskService();
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const vtt = (who: string, words: string) => `WEBVTT\n\n00:00:01.000 --> 00:00:04.000\n<v ${who}>${words}</v>\n`;
const MEETING = 'MQ-2026-0001';

/** A finished digest of one fictional meeting: transcript kept, a confirmed record with one action item. */
async function finishedDigest(ws: string): Promise<string> {
  const dir = path.join(ws, 'context-updates', 'CU-2026-0001');
  await fsp.mkdir(path.join(dir, 'materials'), { recursive: true });
  const files: Record<string, string> = {
    'meetings.md': '# Meetings in this digest',
    'MQ-2026-0001-a.vtt': vtt('Jane Doe', 'Budget next week.'),
    'MQ-2026-0001-a.transcript.md': 'Jane Doe: Budget next week.',
  };
  for (const [name, content] of Object.entries(files)) await fsp.writeFile(path.join(dir, 'materials', name), content);
  await fsp.writeFile(path.join(dir, 'update.md'), stringifyMarkdown('', {
    schema_version: '1.0', id: 'CU-2026-0001', type: 'context-update', title: 'Fictional digest', status: 'done', source_date: '2026-10-27',
    origin: 'meetings', kind: 'daily-digest', keep_meeting_text: true,
    created_at: '2026-10-27T18:00:00.000Z', updated_at: '2026-10-28T09:00:00.000Z', applied_at: '2026-10-28T09:00:00.000Z',
    materials: Object.keys(files).map((name) => ({ name, size: 1, type: 'text/plain' })),
    digest_meetings: [{ id: MEETING, title: 'Weekly sync', meeting_date: '2026-10-27', files: [{ source: 'a.vtt', file: 'MQ-2026-0001-a.vtt', sha256: sha(files['MQ-2026-0001-a.vtt']!) }] }],
    transcripts: [{ file: 'MQ-2026-0001-a.transcript.md', source: 'MQ-2026-0001-a.vtt', source_sha256: sha(files['MQ-2026-0001-a.vtt']!), sha256: sha(files['MQ-2026-0001-a.transcript.md']!), complete: true, kind: 'webvtt' }],
    meeting_records: [{ id: 'M-01', title: 'Weekly sync', meeting_date: '2026-10-27', meeting: MEETING, attendees: [{ name: 'Jane Doe' }], decisions: ['Fictional budget review next week'], open_questions: [], action_items: [{ description: 'Send the fictional budget', owner: { name: 'Jane Doe' } }], source: 'MQ-2026-0001-a.vtt', confirmation: 'confirmed' }],
  }));
  const revision = (await new ContextUpdateService().get('CU-2026-0001')).meeting_records[0]!.revision;
  const file = path.join(dir, 'update.md');
  await fsp.writeFile(file, (await fsp.readFile(file, 'utf-8')).replace('confirmation: confirmed', `confirmation: confirmed\n    confirmed_hash: ${revision}`));
  return path.join(dir, 'materials', 'MQ-2026-0001-a.transcript.md');
}

async function pinnedTask(title: string, deliverables: unknown[] = []) {
  const created = await tasks.createTask({ title, body: `Summarize [@Weekly sync](/meetings/${MEETING}).`, deliverables } as never);
  const task = await tasks.getTask(created.id);
  await syncTaskMeetings(task.path!, async () => [MEETING]);
  return task;
}

/** Every file and folder under the workspace with its size and time, to show a check writes nothing. */
async function snapshot(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(d: string) {
    for (const e of await fsp.readdir(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      const s = await fsp.lstat(full);
      out.push(`${path.relative(dir, full)} ${s.size} ${s.mtimeMs}`);
      if (e.isDirectory()) await walk(full);
    }
  }
  await walk(dir);
  return out.sort();
}

test('the tasks that used a meeting, how each stands, archived last; nothing else is listed and nothing is written', async (t) => {
  const ws = await workspace(t);
  const transcript = await finishedDigest(ws);
  const current = await pinnedTask('Fictional summary', [{ id: 'D1', format: 'md', status: 'complete', file_path: 'tasks/active/x/deliverables/summary.md' }, { id: 'D2', format: 'pdf', status: 'pending' }]);
  const old = await pinnedTask('Fictional older brief');
  await tasks.archiveTask(old.id);
  const mentionOnly = await tasks.createTask({ title: 'Fictional follow-up', body: `See [@Weekly sync](/meetings/${MEETING}).` });
  await tasks.createTask({ title: 'Unrelated fictional task', body: 'Nothing about meetings.' });

  const before = await snapshot(path.join(ws, 'tasks'));
  const first = await relatedWork(MEETING);
  assert.deepEqual(await snapshot(path.join(ws, 'tasks')), before, 'a check changes no task: no lock, no sources folder, no sheet');

  assert.equal(first.meeting_readable, true);
  assert.deepEqual(first.tasks.map((r) => [r.id, r.state, r.archived]), [
    [mentionOnly.id, 'unpinned', false],
    [current.id, 'no_change', false],
    [old.id, 'no_change', true],
  ], 'active first, most important first; the unrelated task is not listed');
  const row = first.tasks.find((r) => r.id === current.id)!;
  assert.deepEqual(row.via, { latest: true, earlier: false, mention: true, action: false });
  assert.deepEqual(row.deliverables, [{ id: 'D1', name: 'summary.md' }], 'complete deliverables only, by file name');
  assert.equal(first.scanned, 4);
  assert.deepEqual(first.skipped, []);

  // The transcript is corrected: every task that pinned it now has a change to look at.
  await fsp.writeFile(transcript, 'Jane Doe: Budget the week after.');
  const changed = await relatedWork(MEETING);
  assert.deepEqual(changed.tasks.filter((r) => r.via.latest).map((r) => [r.id, r.state, r.findings.map((f) => f.code)]), [
    [current.id, 'changed', ['source_changed']],
    [old.id, 'changed', ['source_changed']],
  ]);

  // Refreshing one task takes the new text: no change in its latest selection, and an earlier one is noted.
  await refreshTaskMeetings(current.path!, async () => [MEETING]);
  const refreshed = (await relatedWork(MEETING)).tasks.find((r) => r.id === current.id)!;
  assert.deepEqual([refreshed.state, refreshed.via.earlier, refreshed.selection], ['no_change', true, 'S-002']);

  // The meeting is deleted: what the tasks pinned is no longer part of it, as the task page says too.
  await new MeetingHistoryService().remove(MEETING);
  const gone = await relatedWork(MEETING);
  assert.ok(gone.tasks.filter((r) => r.via.latest).every((r) => r.state === 'changed' && r.findings.some((f) => f.code === 'source_missing')));
});

test('a task made from an action item is found through its original record, and a failed pin is its own state', async (t) => {
  const ws = await workspace(t);
  await finishedDigest(ws);
  const updates = new ContextUpdateService();
  const shown = (await updates.get('CU-2026-0001')).meeting_records[0]!;
  const made = await updates.createActionItemTask('CU-2026-0001', 'M-01', { item: 0, revision: shown.revision, task: { title: 'Fictional budget task' } });

  const result = await relatedWork(MEETING);
  const row = result.tasks.find((r) => r.id === made.task.id)!;
  assert.deepEqual([row.via.action, row.via.latest, row.state], [true, false, 'related'], 'tied by its action item; its item is unchanged');

  // A meeting still in review cannot be pinned: the task that mentions it says so, apart from "not pinned yet".
  await fsp.mkdir(path.join(ws, 'context-updates', 'CU-2026-0002', 'materials'), { recursive: true });
  await fsp.writeFile(path.join(ws, 'context-updates', 'CU-2026-0002', 'materials', 'steering.md'), 'Fictional steering notes.');
  await fsp.writeFile(path.join(ws, 'context-updates', 'CU-2026-0002', 'update.md'), stringifyMarkdown('', {
    schema_version: '1.0', id: 'CU-2026-0002', type: 'context-update', title: 'Fictional steering', status: 'in_review', source_date: '2026-10-29',
    created_at: '2026-10-29T18:00:00.000Z', updated_at: '2026-10-29T19:00:00.000Z', materials: [{ name: 'steering.md', size: 1, type: 'text/markdown' }],
    meeting_records: [{ id: 'M-01', title: 'Steering', meeting_date: '2026-10-29', attendees: [], decisions: [], open_questions: [], action_items: [], source: 'steering.md' }],
  }));
  const steering = 'CU-2026-0002-M-01';
  const task = await tasks.getTask((await tasks.createTask({ title: 'Fictional steering notes', body: `From [@Steering](/meetings/${steering}).` })).id);
  await syncTaskMeetings(task.path!, async () => [steering]);
  const failed = (await relatedWork(steering)).tasks.find((r) => r.id === task.id)!;
  assert.equal(failed.state, 'pin_failed');
  assert.deepEqual(failed.findings.map((f) => f.code), ['pin_failed'], 'its reason is not passed on as text; the task page shows it');
  assert.equal(failed.via.latest, false, 'a failed pin is not a pinned source');
});

test('a task that cannot be read, or whose selection is damaged, is reported as not checked', async (t) => {
  const ws = await workspace(t);
  await finishedDigest(ws);
  const damaged = await pinnedTask('Fictional damaged');
  await fsp.writeFile(path.join(path.dirname(damaged.path!), 'sources', 'meetings.json'), '{ not json');
  await fsp.mkdir(path.join(ws, 'tasks', 'active', 'TASK-2026-0999'), { recursive: true });
  await fsp.writeFile(path.join(ws, 'tasks', 'active', 'TASK-2026-0999', 'task.md'), '---\nid: [unclosed\n---\n');

  // A task whose selection is damaged and that does not mention the meeting: whether it used it is unknown.
  const silent = await pinnedTask('Fictional silent');
  await tasks.updateTask(silent.id, { body: 'No mention any more.' } as never);
  await fsp.writeFile(path.join(path.dirname(silent.path!), 'sources', 'meetings.json'), '[]');
  // An update the list cannot read: tasks made from its action items may be missing, so it is said.
  await fsp.mkdir(path.join(ws, 'context-updates', 'CU-2026-0005'), { recursive: true });
  await fsp.writeFile(path.join(ws, 'context-updates', 'CU-2026-0005', 'update.md'), '---\nid: [unclosed\n---\n');

  const result = await relatedWork(MEETING);
  const row = result.tasks.find((r) => r.id === damaged.id)!;
  assert.equal(row.state, 'not_compared', 'mentioned, but its pins cannot be read: nothing claimed');
  assert.deepEqual(row.findings.map((f) => f.code), ['selection_damaged'], 'never "not pinned yet" when the pins cannot be read');
  assert.deepEqual(result.skipped.map((s) => [s.item, s.reason]).sort(), [
    ['CU-2026-0005', 'update_unreadable'], ['TASK-2026-0999', 'task_unreadable'], [silent.id, 'selection_damaged'],
  ].sort());
  await assert.rejects(relatedWork('../../etc'), (err: Error & { statusCode?: number }) => err.statusCode === 400);
});

test('a task reached through a link is never read: not a linked task folder, not a linked task.md', { skip: process.platform === 'win32' ? 'symlinks need privileges' : false }, async (t) => {
  const ws = await workspace(t);
  await finishedDigest(ws);
  const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-related-outside-'));
  t.after(() => fsp.rm(outside, { recursive: true, force: true }));
  const secret = `---\nid: TASK-2026-0900\ntitle: Outside secret\nstatus: backlog\npriority: low\n---\n\nSee [@x](/meetings/${MEETING}).\n`;
  await fsp.mkdir(path.join(outside, 'TASK-2026-0900'), { recursive: true });
  await fsp.writeFile(path.join(outside, 'TASK-2026-0900', 'task.md'), secret);
  await fsp.symlink(path.join(outside, 'TASK-2026-0900'), path.join(ws, 'tasks', 'active', 'TASK-2026-0900'));
  await fsp.mkdir(path.join(ws, 'tasks', 'active', 'TASK-2026-0901'));
  await fsp.symlink(path.join(outside, 'TASK-2026-0900', 'task.md'), path.join(ws, 'tasks', 'active', 'TASK-2026-0901', 'task.md'));

  const result = await relatedWork(MEETING);
  assert.ok(!result.tasks.some((r) => r.title === 'Outside secret'), 'nothing from outside the workspace is shown');
  assert.deepEqual(result.skipped.map((s) => [s.item, s.reason]), [['TASK-2026-0901', 'task_unreadable']], 'a linked task.md is reported; a linked folder is not a task');
});

test('a context-updates folder that cannot be read is reported, not taken for "no task"', { skip: process.platform === 'win32' || process.getuid?.() === 0 ? 'POSIX permissions' : false }, async (t) => {
  const ws = await workspace(t);
  await finishedDigest(ws);
  const updates = path.join(ws, 'context-updates');
  await fsp.chmod(updates, 0o000);
  let result;
  try {
    result = await relatedWork(MEETING);
  } finally {
    // Before the workspace is removed: that runs first among the cleanups.
    await fsp.chmod(updates, 0o755);
  }
  assert.ok(result.skipped.some((s) => s.item === 'context-updates' && s.reason === 'folder_unreadable'), JSON.stringify(result.skipped));
});

test('checking many action tasks reads the update collection once for their comparisons', async (t) => {
  const ws = await workspace(t);
  await finishedDigest(ws);
  const updates = new ContextUpdateService();
  const shown = (await updates.get('CU-2026-0001')).meeting_records[0]!;
  const made = await updates.createActionItemTask('CU-2026-0001', 'M-01', { item: 0, revision: shown.revision, task: { title: 'Fictional budget task' } });
  const original = path.join(ws, 'tasks/active', made.task.id, 'task.md');
  const text = await fsp.readFile(original, 'utf8');
  for (let i = 900; i < 910; i++) {
    const id = `TASK-2026-${String(i).padStart(4, '0')}`;
    const dir = path.join(ws, 'tasks/active', id);
    await fsp.mkdir(dir);
    await fsp.writeFile(path.join(dir, 'task.md'), text.replace(made.task.id, id));
  }
  const spy = t.mock.method(ContextUpdateService.prototype, 'list');
  const start = performance.now();
  const result = await relatedWork(MEETING);
  t.diagnostic(`11 action tasks: ${Math.round(performance.now() - start)} ms, ${spy.mock.callCount()} update collection scans`);
  assert.equal(result.tasks.length, 11);
  assert.ok(result.tasks.every((row) => row.state === 'related' && row.via.action));
  assert.ok(spy.mock.callCount() <= 3, 'update scans must not grow with the number of tasks');
});
