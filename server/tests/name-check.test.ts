import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { buildRegistry, checkText, checkTextFull, editDistance, glossaryTerms, MAX_FINDINGS, proseOf, splitTerm } from '../src/services/nameCheck';

const registry = buildRegistry({
  names: ['Okabe Haruto (岡部 陽翔)', 'Lindqvist Maren', 'Tanaka Yui (田中 結衣)', 'Dana Patel', 'Natarajan Priya', 'Nguyễn Văn An',
    'Lindqvist Dana', 'Kobayashi Mariko (小林木村佐藤 真理子)', 'Hasegawa Ken (長谷川 健太郎)'],
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

test('review cases: fences, possessives, common words, emphasis, tables, periods, accents, BOM', () => {
  assert.deepEqual(run('```\nfirst ZPA\nsecond ZPB\nthird Lindqvst\n```\nAfter ZPC.\n'), ['abbreviation:ZPC@6'], 'a whole fence is code');
  assert.deepEqual(run('- item\n   ```js\n   ZQD here\n   ```\n'), [], 'an indented fence too');
  assert.deepEqual(run("We read Natarajan's notes and Lindqvst's plan.\n"), ["person:Lindqvst>Lindqvist@1"]);
  assert.deepEqual(run('The new Data Platform and the Advisory Panel met. We use Data daily.\n'), [], 'common words and title case are not names');
  assert.deepEqual(run('We met **Lindqvst** today.\n'), ['person:Lindqvst>Lindqvist@1'], 'bold does not hide a name');
  assert.deepEqual(run('| Owner | Plan |\n|---|---|\n| Lindqvst | ship |\n'), ['person:Lindqvst>Lindqvist@3'], 'a table cell is not a sentence start');
  assert.deepEqual(run('FY2026, FY26, Q3FY26, CY2025, DRAFT, PhD and WIP.\n'), []);
  assert.deepEqual(run('Notes from An Nguyển today.\n'), ['person:Nguyển>Nguyễn@1'], 'accents outside Latin-1 stay in the word');
  assert.deepEqual(run('\ufeff---\ntitle: ZQK\n---\nBody ZQL.\n'), ['abbreviation:ZQL@4'], 'frontmatter after a BOM');
  const image = 'data:image/png;base64,' + 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA'.repeat(200);
  assert.deepEqual(run(`<p>Report <img alt="logo" src="${image}"> by Lindqvst.</p>\n`, 'html'), ['person:Lindqvst>Lindqvist@1'], 'an embedded image is markup');
  assert.deepEqual(run(`![logo](${image}) Plain ZQM.\n`), ['abbreviation:ZQM@1']);
});

test('second review cases: titles and neighbours, unclosed tags in Markdown, one-line fences', () => {
  for (const line of ['We met Mr Lindqvst today.', 'Ms Natarjan agreed.', 'The Lindqvst report is out.', 'Our CEO Lindqvst said so.',
    'Ask John Lindqvst about it.', 'We met Dnaa Lindqvst.', 'Notes from Dr. Lindqvst.']) {
    assert.ok(run(line + '\n').some((f) => f.startsWith('person:')), line);
  }
  assert.deepEqual(run('Use the <pre> tag here.\n\nLater Lindqvst joined and ZQM.\n'), ['person:Lindqvst>Lindqvist@3', 'abbreviation:ZQM@3']);
  assert.deepEqual(run('An <!-- open comment, then ZQN.\n'), ['abbreviation:ZQN@1']);
  assert.deepEqual(run('```js```\nAfter it ZQG.\n'), ['abbreviation:ZQG@2']);
  assert.deepEqual(run('<!-- hidden ZQH', 'html'), [], 'in HTML an unclosed comment runs to the end');
});

test('a file with very many findings lists the first ones and says how many there were', () => {
  const text = Array.from({ length: 1000 }, (_, i) => `Z${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + Math.floor(i / 26) % 26)}Q`).join(' and ') + '\n';
  const result = checkTextFull(text, proseOf(text, 'txt'), registry);
  assert.equal(result.findings.length, MAX_FINDINGS);
  assert.ok(result.total > MAX_FINDINGS);
});

test('adversarial input of 2 MB never stalls: every step is linear', () => {
  const big = 2 * 1024 * 1024;
  const cases: Array<[string, string, 'md' | 'html' | 'txt']> = [
    ['an opening < with no >', 'costs < 5% ' + 'a'.repeat(big), 'md'],
    ['a long word with no @', 'x'.repeat(big), 'txt'],
    ['many comment openers', '<!-- '.repeat(big / 5), 'html'],
    ['many script openers', '<script '.repeat(big / 8), 'html'],
    ['many unclosed definitions', 'AB (word '.repeat(big / 9), 'md'],
    ['many unclosed links', '[x'.repeat(big / 2), 'md'],
    ['many backticks', '`a'.repeat(big / 2), 'md'],
    ['many block tags', '<td '.repeat(big / 4), 'html'],
    ['capital words', 'Lindqvst Okkabe Dana Data '.repeat(big / 26), 'md'],
    ['kanji', '岡辺田仲陽斗結'.repeat(big / 21), 'txt'],
    ['kanji near long names', '小林木村佐藤真理子長谷川健太郎'.repeat(big / 45), 'txt'],
    ['unclosed pre in Markdown', '<pre '.repeat(big / 5), 'md'],
    ['many link openers', '[a]('.repeat(big / 4), 'md'],
    ['many image openers', '![a]('.repeat(big / 5), 'md'],
    ['many brackets', '['.repeat(big), 'md'],
  ];
  for (const [name, text, kind] of cases) {
    const started = Date.now();
    checkTextFull(text, proseOf(text, kind), registry);
    const ms = Date.now() - started;
    assert.ok(ms < 1500, `${name}: ${ms} ms`);
  }
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

  // A deliverable id that is not one (never a key like __proto__) is refused, and nothing leaks into objects.
  await status(setDismissed('TASK-2026-0001', '__proto__', { key: 'abbreviation:ZQX', dismissed: true }), 400);
  assert.equal(({} as Record<string, unknown>)['dismissed'], undefined);

  // A damaged record is set aside, never overwritten silently.
  await fsp.writeFile(path.join(taskDir, '.name-check.json'), '{ not json');
  await runNameCheck('TASK-2026-0001', 'DEL-01');
  const names = await fsp.readdir(taskDir);
  assert.ok(names.some((n) => n.startsWith('.name-check.json.bad-')), names.join(','));
  assert.ok(!names.some((n) => n.endsWith('.tmp')), 'no temporary file is left behind');

  // Dismissing needs only the task and the deliverable, even while its file is missing.
  await fsp.rename(deliverable, deliverable + '.away');
  await setDismissed('TASK-2026-0001', 'DEL-01', { key: 'abbreviation:ZPX', dismissed: true });
  await fsp.rename(deliverable + '.away', deliverable);

  // A pipe in place of the record or the deliverable is refused at once, never waited on.
  if (process.platform !== 'win32') {
    const { execFileSync } = await import('node:child_process');
    await fsp.rename(path.join(taskDir, '.name-check.json'), path.join(taskDir, 'record.keep'));
    execFileSync('mkfifo', [path.join(taskDir, '.name-check.json')]);
    await status(runNameCheck('TASK-2026-0001', 'DEL-01'), 409);
    await fsp.rm(path.join(taskDir, '.name-check.json'));
    await fsp.rename(path.join(taskDir, 'record.keep'), path.join(taskDir, '.name-check.json'));
    execFileSync('mkfifo', [path.join(taskDir, 'deliverables', 'pipe.md')]);
    await fsp.writeFile(path.join(taskDir, 'task.md'), taskMd('tasks/active/TASK-2026-0001/deliverables/pipe.md'));
    await status(runNameCheck('TASK-2026-0001', 'DEL-03'), 400);
    await fsp.rm(path.join(taskDir, 'deliverables', 'pipe.md'));
    await fsp.writeFile(path.join(taskDir, 'task.md'), taskMd());
  }

  // The app's own dot files are not shown among the task's files.
  const { TaskService } = await import('../src/services/taskService');
  assert.ok(!(await new TaskService().listTaskFiles('TASK-2026-0001')).some((f) => f.name.startsWith('.')));

  // A deliverable reached through a link is refused.
  await fsp.symlink(path.join(dir, 'outside.md'), path.join(taskDir, 'deliverables', 'linked.md'));
  await fsp.writeFile(path.join(taskDir, 'task.md'), taskMd('tasks/active/TASK-2026-0001/deliverables/linked.md'));
  await status(runNameCheck('TASK-2026-0001', 'DEL-03'), 400);
  // So is a dot file or a path that climbs out.
  await fsp.writeFile(path.join(taskDir, 'task.md'), taskMd('tasks/active/TASK-2026-0001/../TASK-2026-0001/deliverables/DEL-01_261107.md'));
  await status(runNameCheck('TASK-2026-0001', 'DEL-03'), 400);

  // An archived task is only read: the run is shown, not recorded, and nothing can be dismissed.
  await fsp.writeFile(path.join(taskDir, 'task.md'), taskMd());
  const archiveDir = path.join(dir, 'tasks', 'archive', 'TASK-2026-0001');
  await fsp.mkdir(path.dirname(archiveDir), { recursive: true });
  await fsp.rename(taskDir, archiveDir);
  const recordBefore = await fsp.readFile(path.join(archiveDir, '.name-check.json'), 'utf-8');
  const archived = await runNameCheck('TASK-2026-0001', 'DEL-01');
  assert.equal(archived.recorded, false);
  assert.ok(archived.findings.some((f) => f.dismissed), 'dismissals still show');
  assert.equal(await fsp.readFile(path.join(archiveDir, '.name-check.json'), 'utf-8'), recordBefore);
  await status(setDismissed('TASK-2026-0001', 'DEL-01', { key: 'abbreviation:ZPX', dismissed: false }), 409);
});
