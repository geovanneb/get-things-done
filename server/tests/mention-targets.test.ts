import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import express from 'express';

// A fictional workspace: where references in chat answers and @-mentions open in the app.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gtd-refs-home-'));
process.env['HOME'] = home;
process.env['USERPROFILE'] = home;
const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gtd-refs-ws-')));
process.env['ESB_WORKSPACE_PATH'] = workspace;
const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gtd-refs-outside-')));

function write(rel: string, text: string) {
  const file = path.join(workspace, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
write('workspace.yaml', 'name: "Northwind Labs"\n');
write('tasks/active/TASK-2026-0001/task.md', '---\nid: TASK-2026-0001\ntitle: Budget review\nstatus: in_progress\n---\nBody\n');
write('tasks/active/TASK-2026-0001/brief.pdf', 'x');
write('tasks/active/TASK-2026-0001/deliverables/memo_261119.md', '# Memo\n');
write('tasks/archive/TASK-2026-0002/task.md', '---\nid: TASK-2026-0002\ntitle: Old launch plan\nstatus: done\n---\n');
write('tasks/archive/TASK-2026-0002/notes.txt', 'x');
write('stakeholders/people/stk-0001.md', '---\nid: STK-0001\nname: Jane Doe\nrole: CFO\norganization: Northwind Labs\n---\n');
// A file whose name is not its id: the id inside it decides.
write('stakeholders/people/stk-0003.md', '---\nid: STK-0004\nname: Named by its id\n---\n');
write('stakeholders/groups/grp-0001.md', '---\nid: GRP-0001\nname: Leadership team\n---\n');
write('stakeholders/org-charts/org-0001.md', '---\nid: ORG-0001\nname: Northwind Labs\nmembers: []\n---\n');
write('context/risks/single-supplier/note.md', '---\nid: CTX-single-supplier\ntitle: Single supplier dependency\ncategory: risks\n---\nText\n');
write('context/risks/single-supplier/chart.png', 'x');
// Two notes whose folder names differ only by a literal percent escape: each path must open its own note.
write('context/strategy/phase%2Done/note.md', '---\nid: CTX-phase-escaped\ntitle: Escaped folder\ncategory: strategy\n---\n');
write('context/strategy/phase-one/note.md', '---\nid: CTX-phase-one\ntitle: Phase one\ncategory: strategy\n---\n');
write('outputs/templates/memo/output.md', '---\nid: OUT-memo\nname: Executive memo\nformat: docx\n---\n');
write('context-updates/CU-2026-0003/update.md', '---\nid: CU-2026-0003\ntitle: October board notes\nstatus: ready\n---\n');
write('routines/RT-0001.md', '---\nid: RT-0001\ntitle: Weekly status\n---\nBody\n');
write('profile/executive-profile.md', '---\nname: Secret\n---\n');
fs.writeFileSync(path.join(outside, 'note.md'), '---\nid: CTX-outside\ntitle: Outside\n---\n');
fs.writeFileSync(path.join(outside, 'task.md'), '---\nid: TASK-2026-0009\ntitle: Outside task\n---\n');
fs.symlinkSync(outside, path.join(workspace, 'context', 'risks', 'linked-out'));
write('context-updates/CU-2026-0003/materials/notes.txt', 'private material');
// A link whose real target stays inside the workspace still counts as missing: a file is reached where it really is.
fs.symlinkSync(path.join(workspace, 'context-updates', 'CU-2026-0003', 'materials', 'notes.txt'), path.join(workspace, 'tasks', 'active', 'TASK-2026-0001', 'alias.txt'));
fs.mkdirSync(path.join(workspace, 'tasks', 'active', 'TASK-2026-0009'), { recursive: true });
fs.symlinkSync(path.join(outside, 'task.md'), path.join(workspace, 'tasks', 'active', 'TASK-2026-0009', 'task.md'));

test.after(() => {
  for (const dir of [workspace, outside, home]) fs.rmSync(dir, { recursive: true, force: true });
});

async function service() {
  const { MentionService } = await import('../src/services/mentionService');
  return new MentionService();
}

test('bare ids open their item, with its title or name', async () => {
  const targets = await (await service()).targets(['TASK-2026-0001', 'TASK-2026-0002', 'STK-0001', 'GRP-0001', 'ORG-0001', 'CU-2026-0003', 'RT-0001', 'CTX-single-supplier']);
  assert.deepEqual(targets['CTX-single-supplier'], { exists: true, route: '/context?note=CTX-single-supplier', label: 'Single supplier dependency', type: 'context' }, 'a note by its id');
  assert.deepEqual(targets['TASK-2026-0001'], { exists: true, route: '/board/task/TASK-2026-0001', label: 'Budget review', type: 'task' });
  assert.deepEqual(targets['TASK-2026-0002'], { exists: true, route: '/board/task/TASK-2026-0002', label: 'Old launch plan', type: 'task' }, 'an archived task still opens');
  assert.deepEqual(targets['STK-0001'], { exists: true, route: '/stakeholders/STK-0001', label: 'Jane Doe', type: 'stakeholder' });
  assert.deepEqual(targets['GRP-0001'], { exists: true, route: '/stakeholders/GRP-0001', label: 'Leadership team', type: 'stakeholder' }, 'a group has its own page');
  assert.deepEqual(targets['ORG-0001'], { exists: true, route: '/stakeholders?tab=charts&chart=ORG-0001', label: 'Northwind Labs', type: 'stakeholder' });
  assert.deepEqual(targets['CU-2026-0003'], { exists: true, route: '/context/updates/CU-2026-0003', label: 'October board notes', type: 'context' });
  assert.deepEqual(targets['RT-0001'], { exists: true, route: '/routines', label: 'Weekly status', type: 'task' });
});

test('ids that point at nothing are missing', async () => {
  const targets = await (await service()).targets(['TASK-2026-0404', 'STK-0404', 'CU-2026-0404', 'MQ-2026-0404', 'CU-2026-0003-M-01', 'RT-0404', 'KAIZEN-2026-001', 'CTX-nothing']);
  for (const [ref, target] of Object.entries(targets)) assert.deepEqual(target, { exists: false, route: null }, ref);
});

test('workspace paths open exactly the item they name', async () => {
  const s = await service();
  const targets = await s.targets([
    '/tasks/active/TASK-2026-0001/task.md',
    'tasks/active/TASK-2026-0001',
    'tasks/active/TASK-2026-0001/brief.pdf',
    'tasks/active/TASK-2026-0001/deliverables/memo_261119.md',
    'tasks/archive/TASK-2026-0002/notes.txt',
    '/stakeholders/people/stk-0001.md',
    'stakeholders/groups/grp-0001.md',
    'stakeholders/people/stk-0003.md',
    'stakeholders/org-charts/org-0001.md',
    '/context/risks/single-supplier/note.md',
    'context/risks/single-supplier/chart.png',
    'context/risks/single-supplier',
    '/outputs/templates/memo/output.md',
    'context-updates/CU-2026-0003/update.md',
    'routines/RT-0001.md',
  ]);
  const route = (ref: string) => targets[ref]?.route;
  assert.equal(route('/tasks/active/TASK-2026-0001/task.md'), '/board/task/TASK-2026-0001');
  assert.equal(route('tasks/active/TASK-2026-0001'), '/board/task/TASK-2026-0001', 'a task folder is the task');
  assert.equal(route('tasks/active/TASK-2026-0001/brief.pdf'), '/board/task/TASK-2026-0001?tab=files', 'an attachment opens the Files tab');
  assert.equal(route('tasks/active/TASK-2026-0001/deliverables/memo_261119.md'), '/board/task/TASK-2026-0001', 'a deliverable is listed on the task');
  assert.equal(route('tasks/archive/TASK-2026-0002/notes.txt'), '/board/task/TASK-2026-0002', 'an archived task has no Files tab');
  assert.equal(targets['tasks/active/TASK-2026-0001/brief.pdf']?.label, 'Budget review');
  assert.equal(route('/stakeholders/people/stk-0001.md'), '/stakeholders/STK-0001');
  assert.equal(route('stakeholders/people/stk-0003.md'), '/stakeholders/STK-0004', 'the id in the file, not its name');
  assert.equal(targets['stakeholders/people/stk-0003.md']?.label, 'Named by its id');
  assert.equal(route('stakeholders/groups/grp-0001.md'), '/stakeholders/GRP-0001');
  assert.equal(route('stakeholders/org-charts/org-0001.md'), '/stakeholders?tab=charts&chart=ORG-0001');
  assert.deepEqual(targets['/context/risks/single-supplier/note.md'], { exists: true, route: '/context?note=CTX-single-supplier', label: 'Single supplier dependency', type: 'context' });
  assert.equal(route('context/risks/single-supplier/chart.png'), '/context?note=CTX-single-supplier', "a note's file opens its note");
  assert.equal(route('context/risks/single-supplier'), '/context?note=CTX-single-supplier');
  assert.deepEqual(targets['/outputs/templates/memo/output.md'], { exists: true, route: '/outputs', label: 'Executive memo', type: 'template' });
  assert.equal(route('context-updates/CU-2026-0003/update.md'), '/context/updates/CU-2026-0003');
  assert.equal(route('routines/RT-0001.md'), '/routines');
});

test('a file that is gone is missing, even inside a task that exists', async () => {
  const targets = await (await service()).targets(['tasks/active/TASK-2026-0001/deliverables/gone.pdf', 'context/risks/nothing/note.md', 'stakeholders/people/stk-0404.md']);
  for (const [ref, target] of Object.entries(targets)) assert.equal(target.exists, false, ref);
});

test('nothing outside the workspace or its known folders is ever resolved', async () => {
  const unsafe = [
    '/tasks/../profile/executive-profile.md',
    'tasks/%2e%2e/profile/executive-profile.md',
    '/profile/executive-profile.md',
    '.situation-board/chat/x.json',
    `${outside}/note.md`,
    '/etc/passwd',
    'C:\\Windows\\win.ini',
    'tasks\\active\\TASK-2026-0001\\task.md',
    'context/risks/linked-out/note.md',
    'context/risks/linked-out',
    'tasks/active/TASK-2026-0009/task.md',
    'TASK-2026-0009',
    'tasks/active/TASK-2026-0001/alias.txt',
    'tasks/active/invented/TASK-2026-0001/task.md',
    'tasks/TASK-2026-0001',
    'tasks/other/TASK-2026-0001/task.md',
    'context-updates/CU-2026-0003/materials/notes.txt',
    'routines/RT-0001.md/x',
    'meetings/MQ-2026-0001/transcript.txt',
    'https://example.com/tasks/a',
    '',
  ];
  const targets = await (await service()).targets(unsafe);
  for (const ref of unsafe) assert.deepEqual(targets[ref], { exists: false, route: null }, `refused: ${ref}`);
});

/** Records every file read, to prove nothing outside the workspace is opened. */
function recordReads(t: { after: (fn: () => void) => void }): string[] {
  const fsPromises = createRequire(__filename)('fs').promises as typeof fs.promises;
  const original = fsPromises.readFile;
  const reads: string[] = [];
  fsPromises.readFile = ((file: fs.PathLike, ...rest: unknown[]) => {
    reads.push(String(file));
    return (original as (...a: unknown[]) => Promise<unknown>).call(fsPromises, file, ...rest);
  }) as typeof original;
  t.after(() => { fsPromises.readFile = original; });
  return reads;
}

test('resolving ids changes nothing: an empty workspace stays empty', async () => {
  const { resolveReferences } = await import('../src/services/referenceTargets');
  const empty = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gtd-refs-empty-')));
  try {
    const targets = await resolveReferences(empty, ['STK-0001', 'GRP-0001', 'ORG-0001', 'CTX-x', 'TASK-2026-0001', 'MQ-2026-0001', 'CU-2026-0001', 'RT-0001', 'outputs/templates/memo/output.md']);
    for (const [ref, target] of Object.entries(targets)) assert.equal(target.exists, false, ref);
    assert.deepEqual(fs.readdirSync(empty), [], 'no folder was created');
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

test('an owner folder linked out of the workspace is missing, and nothing outside is read', async (t) => {
  const { resolveReferences } = await import('../src/services/referenceTargets');
  const linked = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gtd-refs-linked-')));
  const away = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gtd-refs-away-')));
  t.after(() => { for (const dir of [linked, away]) fs.rmSync(dir, { recursive: true, force: true }); });
  for (const sub of ['people', 'groups', 'org-charts']) fs.mkdirSync(path.join(away, sub));
  fs.writeFileSync(path.join(away, 'people', 'stk-0001.md'), '---\nid: STK-0001\nname: Outside person\n---\n');
  fs.writeFileSync(path.join(away, 'groups', 'grp-0001.md'), '---\nid: GRP-0001\nname: Outside group\n---\n');
  fs.writeFileSync(path.join(away, 'org-charts', 'org-0001.md'), '---\nid: ORG-0001\nname: Outside chart\n---\n');
  fs.mkdirSync(path.join(away, 'risks', 'x'), { recursive: true });
  fs.writeFileSync(path.join(away, 'risks', 'x', 'note.md'), '---\nid: CTX-outside\ntitle: Outside\n---\n');
  fs.mkdirSync(path.join(away, 'CU-2026-0001'));
  fs.writeFileSync(path.join(away, 'CU-2026-0001', 'update.md'), '---\nid: CU-2026-0001\ntitle: Outside\n---\n');
  fs.symlinkSync(away, path.join(linked, 'stakeholders'));
  fs.symlinkSync(away, path.join(linked, 'context'));
  fs.symlinkSync(away, path.join(linked, 'context-updates'));
  fs.mkdirSync(path.join(linked, 'routines'));
  fs.writeFileSync(path.join(linked, 'routines', 'RT-0001.md'), '---\nid: RT-0001\ntitle: Inside\n---\n');
  const reads = recordReads(t);
  const inside = await resolveReferences(linked, ['RT-0001']);
  assert.equal(inside['RT-0001']?.exists, true);
  assert.ok(reads.some((r) => r.endsWith('RT-0001.md')), 'reads are recorded');
  const targets = await resolveReferences(linked, ['STK-0001', 'GRP-0001', 'ORG-0001', 'CTX-outside', 'CU-2026-0001', 'CU-2026-0001-M-01', 'stakeholders/people/stk-0001.md', 'context/risks/x/note.md']);
  for (const [ref, target] of Object.entries(targets)) assert.deepEqual(target, { exists: false, route: null }, ref);
  assert.deepEqual(reads.filter((r) => path.resolve(r).startsWith(away) || !path.resolve(r).startsWith(linked)), [], 'no file outside the workspace was read');
});

test('meetings: queued and held ones open their page, and a link skips only its own candidate', async (t) => {
  const { resolveReferences } = await import('../src/services/referenceTargets');
  const { MeetingHistoryService } = await import('../src/services/meetingHistoryService');
  const { withWorkspacePath } = await import('../src/services/workspace');
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gtd-refs-meetings-')));
  const away = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gtd-refs-meetings-away-')));
  t.after(() => { for (const dir of [ws, away]) fs.rmSync(dir, { recursive: true, force: true }); });
  const put = (rel: string, body: string) => { fs.mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true }); fs.writeFileSync(path.join(ws, rel), body); };
  const done = (id: string, title: string) => `---\nschema_version: '1.0'\nid: ${id}\ntype: context-update\ntitle: ${title}\nstatus: done\nsource_date: '2026-10-27'\ncreated_at: '2026-10-27T18:00:00.000Z'\nupdated_at: '2026-10-28T09:00:00.000Z'\nmeeting_records:\n  - id: M-01\n    title: ${title} meeting\n    meeting_date: '2026-10-27'\n    attendees: []\n    decisions: []\n    source: ''\n---\n`;
  put('context-updates/meeting-queue/MQ-2026-0007/meeting.md', '---\nid: MQ-2026-0007\ntitle: Weekly sync\nstatus: queued\nmeeting_date: \'2026-10-27\'\n---\n');
  put('context-updates/CU-2026-0005/update.md', done('CU-2026-0005', 'Steering'));
  put('context-updates/CU-2026-0006/real.md', done('CU-2026-0006', 'Linked inside'));
  // An unrelated link beside the updates, a whole update linked out of the workspace, and an update.md that is a link
  // within its own update: only those candidates are skipped.
  put('README.md', 'readme');
  fs.symlinkSync(path.join(ws, 'README.md'), path.join(ws, 'context-updates', 'README.md'));
  fs.mkdirSync(path.join(away, 'CU-2026-0008'));
  fs.writeFileSync(path.join(away, 'CU-2026-0008', 'update.md'), done('CU-2026-0008', 'Outside'));
  fs.symlinkSync(path.join(away, 'CU-2026-0008'), path.join(ws, 'context-updates', 'CU-2026-0008'));
  fs.symlinkSync(path.join(ws, 'context-updates', 'CU-2026-0006', 'real.md'), path.join(ws, 'context-updates', 'CU-2026-0006', 'update.md'));

  const reads = recordReads(t);
  const targets = await resolveReferences(ws, ['MQ-2026-0007', '/meetings/MQ-2026-0007', 'CU-2026-0005-M-01', 'meetings/CU-2026-0005-M-01', 'CU-2026-0006-M-01', 'CU-2026-0008-M-01', 'MQ-2026-0404']);
  assert.deepEqual(targets['MQ-2026-0007'], { exists: true, route: '/meetings/MQ-2026-0007', label: 'Weekly sync', type: 'meeting' });
  assert.deepEqual(targets['/meetings/MQ-2026-0007'], targets['MQ-2026-0007']);
  assert.deepEqual(targets['CU-2026-0005-M-01'], { exists: true, route: '/meetings/CU-2026-0005-M-01', label: 'Steering meeting', type: 'meeting' });
  assert.deepEqual(targets['meetings/CU-2026-0005-M-01'], targets['CU-2026-0005-M-01']);
  for (const ref of ['CU-2026-0006-M-01', 'CU-2026-0008-M-01', 'MQ-2026-0404']) assert.deepEqual(targets[ref], { exists: false, route: null }, ref);
  assert.deepEqual(reads.filter((r) => !path.resolve(r).startsWith(ws + path.sep) || r.endsWith(path.join('CU-2026-0006', 'update.md')) || r.endsWith('real.md')), [], 'nothing outside, and no link, was read');

  // The same meetings the Meetings page lists as linkable.
  const listed = await withWorkspacePath(ws, () => new MeetingHistoryService().list());
  assert.ok(listed.some((m) => m.id === 'CU-2026-0005-M-01' && m.linkable));
});

test('a path is literal: a folder named with a percent escape is not another folder', async () => {
  const targets = await (await service()).targets(['context/strategy/phase%2Done/note.md', 'context/strategy/phase-one/note.md', 'context/strategy/phase%252Done/note.md']);
  // The page sends literal paths: from a code span as written, from a citation decoded once (see references.test.ts).
  assert.equal(targets['context/strategy/phase%2Done/note.md']?.route, '/context?note=CTX-phase-escaped');
  assert.equal(targets['context/strategy/phase-one/note.md']?.route, '/context?note=CTX-phase-one');
  assert.equal(targets['context/strategy/phase%252Done/note.md']?.exists, false, 'never decoded again');
});

test('the resolve endpoints answer batches, and refuse too many at once', async (t) => {
  const { default: mentionsRouter } = await import('../src/routes/mentions');
  const { errorHandler } = await import('../src/middleware/errorHandler');
  const app = express();
  app.use(express.json());
  app.use('/api/mentions', mentionsRouter);
  app.use(errorHandler);
  const listener = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => listener.once('listening', resolve));
  t.after(() => listener.close());
  const base = `http://127.0.0.1:${(listener.address() as AddressInfo).port}/api/mentions/resolve`;
  const post = (body: unknown) => fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  const ok = await post({ refs: ['TASK-2026-0001', '/context/risks/single-supplier/note.md', 'TASK-2026-0001'] });
  assert.equal(ok.status, 200);
  const { targets } = await ok.json() as { targets: Record<string, { route: string }> };
  assert.deepEqual(Object.keys(targets), ['TASK-2026-0001', '/context/risks/single-supplier/note.md']);
  assert.equal(targets['/context/risks/single-supplier/note.md']!.route, '/context?note=CTX-single-supplier');

  assert.equal((await post({ refs: Array.from({ length: 51 }, (_, i) => `STK-${String(i).padStart(4, '0')}`) })).status, 400);
  assert.equal((await post({ refs: 'TASK-2026-0001' })).status, 400);
  assert.equal((await post({ refs: [1] })).status, 400);
  // Names that are also object properties come back like any other reference.
  const odd = ['constructor', 'toString', '__proto__', 'hasOwnProperty'];
  const oddTargets = (await (await post({ refs: odd })).json() as { targets: Record<string, unknown> }).targets;
  assert.deepEqual(Object.keys(oddTargets).sort(), [...odd].sort());
  for (const ref of odd) assert.deepEqual(Object.getOwnPropertyDescriptor(oddTargets, ref)?.value, { exists: false, route: null }, ref);

  // The single check keeps its answer, and now says where the mention opens.
  const one = await (await fetch(`${base}?href=${encodeURIComponent('/stakeholders/people/stk-0001.md')}`)).json();
  assert.deepEqual(one, { exists: true, route: '/stakeholders/STK-0001', label: 'Jane Doe', type: 'stakeholder' });
  // GET answers exactly as one reference of a batch: a gone attachment of a task that exists is missing in both.
  const gone = '/tasks/active/TASK-2026-0001/gone.pdf';
  const single = await (await fetch(`${base}?href=${encodeURIComponent(gone)}`)).json();
  const batch = (await (await post({ refs: [gone] })).json() as { targets: Record<string, unknown> }).targets[gone];
  assert.deepEqual(single, { exists: false, route: null });
  assert.deepEqual(batch, single);
  assert.deepEqual(await (await fetch(base)).json(), { exists: false, route: null });
  // GET takes a mention's href (a link): its URL syntax is decoded once. `%252D` is a literal `%2D` in the folder name.
  const escaped = await (await fetch(`${base}?href=${encodeURIComponent('/context/strategy/phase%252Done/note.md')}`)).json() as { route: string };
  assert.equal(escaped.route, '/context?note=CTX-phase-escaped');
  const plain = await (await fetch(`${base}?href=${encodeURIComponent('/context/strategy/phase%2Done/note.md')}`)).json() as { route: string };
  assert.equal(plain.route, '/context?note=CTX-phase-one', 'in a link, %2D is a hyphen');
  // POST takes literal paths and decodes nothing.
  const literal = (await (await post({ refs: ['context/strategy/phase%2Done/note.md'] })).json() as { targets: Record<string, { route: string }> }).targets;
  assert.equal(literal['context/strategy/phase%2Done/note.md']!.route, '/context?note=CTX-phase-escaped');
});
