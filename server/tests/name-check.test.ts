import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { buildRegistry, checkText, editDistance, glossaryTerms, proseOf, splitTerm } from '../src/services/nameCheck';

const registry = buildRegistry({
  names: ['Okabe Haruto (岡部 陽翔)', 'Lindqvist Maren', 'Tanaka Yui (田中 結衣)'],
  organizations: ['Northwind Labs'],
  terms: glossaryTerms('Dual Lane', '### QRT / QRTX\n**Pallet Pool**: shared pallets.\n| **Cross Dock (XD)** | a dock |\n'),
});
const run = (text: string, kind: 'md' | 'html' | 'txt' = 'md') => checkText(text, proseOf(text, kind), registry).map((f) => `${f.kind}:${f.found}${f.suggestion ? '>' + f.suggestion : ''}@${f.line}`);

test('glossary terms come from titles, headings, bold leads and table leads, split on / and brackets', () => {
  assert.deepEqual(splitTerm('OTS / OTSV'), ['OTS', 'OTSV']);
  assert.deepEqual(splitTerm('Cross Dock (XD)'), ['Cross Dock', 'XD']);
  assert.ok(registry.terms.has('QRTX') && registry.terms.has('XD') && registry.terms.has('Pallet Pool'));
});

test('edit distance counts a swap of neighbours once and stops early', () => {
  assert.equal(editDistance('lindqvist', 'lindqivst', 2), 1);
  assert.equal(editDistance('okabe', 'okkabe', 1), 1);
  assert.equal(editDistance('abcdef', 'uvwxyz', 1), 2);
});

test('a name close to a known one is found with an anchor; exact names, unanchored sentence starts and short words are not', () => {
  assert.deepEqual(run('We met Okkabe-san today.\n'), ['person:Okkabe>Okabe@1']);
  assert.deepEqual(run('Notes from Maren Lindqvst.\n'), ['person:Lindqvst>Lindqvist@1']);
  assert.deepEqual(run('Lindquist will send it.\n'), [], 'a sentence start without another anchor is not enough');
  assert.deepEqual(run('Okabe-san and Maren Lindqvist agreed.\n'), []);
  assert.deepEqual(run('Ask Yuki about it.\n'), [], 'four letters, but not close enough to any part');
  assert.deepEqual(run('We met Okabee san.\n'), ['person:Okabee>Okabe@1'], 'an honorific after a space is an anchor too');
});

test('names in scripts without spaces: one character off a known name, a family name only with an honorific', () => {
  assert.deepEqual(run('岡辺さんと田仲さんに確認。\n'), ['person:岡辺>岡部@1', 'person:田仲>田中@1']);
  assert.deepEqual(run('岡部陽翔さんは了承。田中さん。\n'), []);
  assert.deepEqual(run('岡辺の件\n'), [], 'two characters without an honorific are not a finding');
  assert.deepEqual(run('岡部陽斗さん\n'), ['person:岡部陽斗>岡部陽翔@1']);
});

test('abbreviations: unknown ones once with a count; known, common, defined, plural, styled capitals and labels are not', () => {
  assert.deepEqual(run('The ZPX numbers. More ZPX.\n'), ['abbreviation:ZPX@1']);
  assert.equal(checkText('ZPX and ZPX\n', proseOf('ZPX and ZPX\n', 'md'), registry)[0]!.count, 2);
  assert.deepEqual(run('QRT, QRTX, XD, KPI, PDF and EN.\n'), []);
  assert.deepEqual(run('Customer Success (CS) owns it. CS agreed. LTV (lifetime value) too.\n'), []);
  assert.deepEqual(run('Two QRTs and the NEW1 label.\n'), []);
  assert.deepEqual(run('NORTHWIND GROUP and the ANNUAL REVIEW.\n'), []);
  assert.deepEqual(run('Japanese text ZPXの数字。\n'), ['abbreviation:ZPX@1']);
});

test('code, links, URLs, markup, placeholders and workspace ids are never checked; line numbers are those of the file', () => {
  const md = '---\ntitle: ZZQ\n---\n# Title\n\n`ZPX` and [the ABQ plan](https://example.com/QQQ) www.example.com/WWQ\n' +
    '```\nLindqvst ZPZ\n```\n[PLACEHOLDER: ABCD revenue - INSERT FROM FINANCE] TASK-2026-0001 DEL-01 STK-0004\n<!-- QWE -->\nLast line has QQZ.\n';
  assert.deepEqual(run(md), ['abbreviation:ABQ@6', 'abbreviation:QQZ@12']);
  const html = '<html><head><title>TTL</title><style>.ABC{}</style><script>var ZZZ</script></head><body>\n' +
    '<table><tr><td>Role</td><td>Rose</td></tr></table>\n<p>We met&nbsp;Okkabe-san &amp; <code>QQQ</code> the YYZ team.</p>\n</body></html>\n';
  assert.deepEqual(run(html, 'html'), ['person:Okkabe>Okabe@3', 'abbreviation:YYZ@3']);
});

test('the check reads only the deliverable file in its task folder, remembers dismissals and counts what was fixed', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-name-check-'));
  const previous = process.env.ESB_WORKSPACE_PATH;
  process.env.ESB_WORKSPACE_PATH = dir;
  t.after(async () => {
    if (previous === undefined) delete process.env.ESB_WORKSPACE_PATH;
    else process.env.ESB_WORKSPACE_PATH = previous;
    await fsp.rm(dir, { recursive: true, force: true });
  });
  await fsp.mkdir(path.join(dir, 'stakeholders', 'people'), { recursive: true });
  await fsp.writeFile(path.join(dir, 'stakeholders', 'people', 'STK-0001.md'), '---\nid: STK-0001\nname: Lindqvist Maren\norganization: Northwind Labs\n---\n');
  await fsp.mkdir(path.join(dir, 'context', 'glossary', 'terms'), { recursive: true });
  await fsp.writeFile(path.join(dir, 'context', 'glossary', 'terms', 'note.md'), '---\ntitle: Terms\n---\n### QRT\n');
  const taskDir = path.join(dir, 'tasks', 'active', 'TASK-2026-0001');
  await fsp.mkdir(path.join(taskDir, 'deliverables'), { recursive: true });
  const deliverable = path.join(taskDir, 'deliverables', 'DEL-01_261107.md');
  await fsp.writeFile(deliverable, 'Notes from Maren Lindqvst on QRT and ZPX.\n');
  await fsp.writeFile(path.join(taskDir, 'deliverables', 'DEL-02_261107.pptx'), 'x');
  await fsp.writeFile(path.join(dir, 'outside.md'), 'Maren Lindqvst\n');
  const taskMd = (extra = '') => `---\nschema_version: '1.0'\nid: TASK-2026-0001\ntitle: Check\nstatus: in_progress\npriority: medium\ncreated_at: '2026-11-07T00:00:00.000Z'\nupdated_at: '2026-11-07T00:00:00.000Z'\ndeliverables:\n` +
    `  - id: DEL-01\n    status: complete\n    file_path: tasks/active/TASK-2026-0001/deliverables/DEL-01_261107.md\n` +
    `  - id: DEL-02\n    status: complete\n    file_path: tasks/active/TASK-2026-0001/deliverables/DEL-02_261107.pptx\n` +
    `  - id: DEL-03\n    status: complete\n    file_path: ${extra || 'outside.md'}\n---\nBody\n`;
  await fsp.writeFile(path.join(taskDir, 'task.md'), taskMd());
  const before = await fsp.readFile(path.join(taskDir, 'task.md'), 'utf-8');

  const { runNameCheck, setDismissed } = await import('../src/services/nameCheckService');
  const first = await runNameCheck('TASK-2026-0001', 'DEL-01');
  assert.deepEqual(first.findings.map((f) => f.key), ['person:Lindqvst>Lindqvist', 'abbreviation:ZPX']);
  assert.equal(await fsp.readFile(path.join(taskDir, 'task.md'), 'utf-8'), before, 'task.md is never changed');

  await setDismissed('TASK-2026-0001', 'DEL-01', { key: 'abbreviation:ZPX', dismissed: true });
  const second = await runNameCheck('TASK-2026-0001', 'DEL-01');
  assert.deepEqual(second.findings.filter((f) => f.dismissed).map((f) => f.key), ['abbreviation:ZPX']);

  // The name is corrected in the file: the next run counts it as fixed.
  await fsp.writeFile(deliverable, 'Notes from Maren Lindqvist on QRT and ZPX.\n');
  await runNameCheck('TASK-2026-0001', 'DEL-01');
  const state = JSON.parse(await fsp.readFile(path.join(taskDir, '.name-check.json'), 'utf-8'));
  assert.deepEqual(state.history.map((h: { shown: number; dismissed: number; fixed: number }) => [h.shown, h.dismissed, h.fixed]), [[2, 0, 0], [1, 1, 0], [0, 1, 1]]);

  const status = (p: Promise<unknown>, code: number) => assert.rejects(p, (e: { statusCode?: number }) => e.statusCode === code);
  await status(runNameCheck('TASK-2026-0001', 'DEL-02'), 400); // an Office file is not read
  await status(runNameCheck('TASK-2026-0001', 'DEL-03'), 400); // a file outside the task's folder
  await status(runNameCheck('TASK-2026-0001', 'DEL-09'), 404);
  await status(setDismissed('TASK-2026-0001', 'DEL-01', { key: 'something', dismissed: true }), 400);

  // A deliverable reached through a link is refused.
  await fsp.symlink(path.join(dir, 'outside.md'), path.join(taskDir, 'deliverables', 'linked.md'));
  await fsp.writeFile(path.join(taskDir, 'task.md'), taskMd('tasks/active/TASK-2026-0001/deliverables/linked.md'));
  await status(runNameCheck('TASK-2026-0001', 'DEL-03'), 400);
  // So is a dot file or a path that climbs out.
  await fsp.writeFile(path.join(taskDir, 'task.md'), taskMd('tasks/active/TASK-2026-0001/../TASK-2026-0001/deliverables/DEL-01_261107.md'));
  await status(runNameCheck('TASK-2026-0001', 'DEL-03'), 400);
});
