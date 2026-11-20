/**
 * Unit tests for references in chat answers (ids and workspace paths that become chips).
 * Run with `npm run test:references --workspace=ui`.
 */
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import {
  cleanPath, hrefReference, opensDialog, referenceResolver, remarkReferences, splitReferences, wholeReference, RESOLVE_BATCH,
  type ReferenceTarget,
} from './references';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

interface HNode { type: string; tagName?: string; value?: string; properties?: Record<string, unknown>; children?: HNode[] }

/** The Markdown as the renderer gets it (hast), with the references step on. */
function render(markdown: string): HNode {
  const processor = unified().use(remarkParse).use(remarkGfm).use(remarkReferences).use(remarkRehype);
  return processor.runSync(processor.parse(markdown)) as unknown as HNode;
}
function textOf(node: HNode): string {
  return node.type === 'text' ? node.value ?? '' : (node.children ?? []).map(textOf).join('');
}
/** Every reference link: what it refers to, its href and its text. */
function refs(markdown: string): { ref: string; href: string; text: string }[] {
  const out: { ref: string; href: string; text: string }[] = [];
  const walk = (n: HNode) => {
    if (n.tagName === 'a' && typeof n.properties?.['dataReference'] === 'string') {
      out.push({ ref: n.properties['dataReference'] as string, href: String(n.properties['href']), text: textOf(n) });
    }
    (n.children ?? []).forEach(walk);
  };
  walk(render(markdown));
  return out;
}
const refList = (markdown: string) => refs(markdown).map((r) => r.ref);

// Bare ids
check('a task id in text becomes a reference', same(refs('See TASK-2026-0001 first.'), [{ ref: 'TASK-2026-0001', href: '/TASK-2026-0001', text: 'TASK-2026-0001' }]));
check('every id format the app opens is found',
  same(refList('TASK-2026-0001, STK-0001, GRP-0002, ORG-0003, CU-2026-0004, CU-2026-0004-M-01, MQ-2026-0005 and RT-0006.'),
    ['TASK-2026-0001', 'STK-0001', 'GRP-0002', 'ORG-0003', 'CU-2026-0004', 'CU-2026-0004-M-01', 'MQ-2026-0005', 'RT-0006']));
check('a note id is a reference, without the sentence after it', same(refList('See CTX-single-supplier. Also CTX-a-b-c, and CTX-x-'), ['CTX-single-supplier', 'CTX-a-b-c']));
check('an id inside a longer word or number is not one', same(refList('XTASK-2026-0001 TASK-2026-00012 STK-00011 TASK-2026-0001-draft'), []));
check('an id followed by a period, comma or bracket ends there', same(refList('(STK-0001), TASK-2026-0001.'), ['STK-0001', 'TASK-2026-0001']));
check('Japanese text around an id does not stop it', same(refs('担当はSTK-0001です。TASK-2026-0001の期限は明日。').map((r) => r.text), ['STK-0001', 'TASK-2026-0001']));
check('the text around a reference is kept exactly', textOf(render('担当はSTK-0001です。')) === '担当はSTK-0001です。');

// Paths
check('a workspace path in text becomes a reference to that path',
  same(refs('Open tasks/active/TASK-2026-0001/task.md now'), [{ ref: 'tasks/active/TASK-2026-0001/task.md', href: '/tasks/active/TASK-2026-0001/task.md', text: 'tasks/active/TASK-2026-0001/task.md' }]));
check('a leading slash is allowed and kept in the text', same(refs('/context/risks/single-supplier/note.md').map((r) => [r.ref, r.text]), [['context/risks/single-supplier/note.md', '/context/risks/single-supplier/note.md']]));
check('a sentence-ending period is not part of a path', same(refList('It is in stakeholders/people/stk-0001.md.'), ['stakeholders/people/stk-0001.md']));
check('trailing punctuation and closing brackets are left out', same(refList('(see outputs/templates/memo/output.md), or context/company/acme/note.md!'), ['outputs/templates/memo/output.md', 'context/company/acme/note.md']));
check('Japanese text right after a file name is not part of the path', same(refList('context/company/acme/note.mdを参照してください'), ['context/company/acme/note.md']));
check('Japanese text right after a task folder is not part of the path', same(refList('tasks/active/TASK-2026-0001にあります'), ['tasks/active/TASK-2026-0001']));
check('Japanese text right after a Japanese file name is not part of the path', same(refList('context/risks/報告.mdを参照'), ['context/risks/報告.md']));
check('a Japanese file name stays whole', same(refList('tasks/active/TASK-2026-0001/deliverables/報告書_261119.pdf を開く'), ['tasks/active/TASK-2026-0001/deliverables/報告書_261119.pdf']));
check('Japanese punctuation ends a path', same(refList('「context/strategy/plan/note.md」。'), ['context/strategy/plan/note.md']));
check('a path in inline code becomes a reference, kept as code', (() => {
  const hast = render('Read `tasks/active/TASK-2026-0001/task.md`.');
  const link = refs('Read `tasks/active/TASK-2026-0001/task.md`.')[0];
  const json = JSON.stringify(hast);
  return link?.ref === 'tasks/active/TASK-2026-0001/task.md' && json.includes('"tagName":"code"');
})());
check('an id in inline code becomes a reference', same(refList('The id is `STK-0001`.'), ['STK-0001']));
check('a code span is the whole path, spaces and all', same(refList('Open `tasks/active/TASK-2026-0001/Board brief.pdf` now'), ['tasks/active/TASK-2026-0001/Board brief.pdf']));
check('inline code with more than a reference stays code', same(refList('Run `cat tasks/active/TASK-2026-0001/task.md`'), []));

// Never linked
check('nothing in a fenced code block is linked', same(refList('```\nTASK-2026-0001 tasks/active/TASK-2026-0001/task.md\n```'), []));
check('nothing in an indented code block is linked', same(refList('    STK-0001 context/a/b/note.md'), []));
check('text inside an existing link is not linked again', same(refList('[TASK-2026-0001 summary](https://example.com/TASK-2026-0001) and [@Jane](/stakeholders/people/stk-0001.md)'), []));
check('an autolinked address is not linked again', same(refList('https://example.com/tasks/active/TASK-2026-0001/task.md'), []));
check('nothing inside an address that was not autolinked', same(refList('ftp://example.test/?item=STK-0001 and ftp://example.test/tasks/active/TASK-2026-0001/task.md'), []));
check('nothing inside a query of an autolinked address', same(refList('https://example.test/search?item=STK-0001&task=TASK-2026-0001'), []));
check('a bold link label stays one link, not linked again', same(refList('[**TASK-2026-0001**](https://example.test/x)'), []));
check('an emphasised id on its own is a reference', same(refList('*STK-0001* and **TASK-2026-0001**'), ['STK-0001', 'TASK-2026-0001']));
check('a path with .. is never linked', same(refList('tasks/../profile/executive-profile.md and context/a/../../etc/passwd'), []));
check('a path outside the known folders is never linked', same(refList('profile/executive-profile.md .claude/settings.json /etc/passwd ~/tasks/x.md'), []));
check('a path that continues another path is never linked', same(refList('/Users/someone/workspace/tasks/active/TASK-2026-0001/task.md ../tasks/a/b'), []));
check('a bare folder name is not a path', same(refList('tasks/ and context/'), []));
check('a Windows path is never linked', same(refList('C:\\workspace\\tasks\\active'), []));

// Pure helpers
check('cleanPath refuses empty segments and backslashes', cleanPath('tasks//x') === null && cleanPath('tasks/a\\b') === null);
check('wholeReference takes a whole id or path only', wholeReference(' TASK-2026-0001 ') === 'TASK-2026-0001' && wholeReference('TASK-2026-0001 x') === null && wholeReference('/context/a/b/') === 'context/a/b');
check('hrefReference takes a bare id too, with or without a slash', hrefReference('TASK-2026-0001') === 'TASK-2026-0001' && hrefReference('/CTX-a-b') === 'CTX-a-b' && hrefReference('https://x.test/a') === null);
check('tasks and notes open as dialogs; pages do not',
  opensDialog('/board/task/TASK-2026-0001') && opensDialog('/board/task/TASK-2026-0001?tab=files') && opensDialog('/context?note=CTX-a')
  && !opensDialog('/stakeholders/STK-0001') && !opensDialog('/context') && !opensDialog('/outputs'));
check('a path with a literal percent escape stays literal, from a code span and from text',
  same(refList('Open `context/strategy/phase%2Done/note.md` and context/strategy/phase%2Done/note.md'), ['context/strategy/phase%2Done/note.md', 'context/strategy/phase%2Done/note.md']));
check('a citation\'s href is decoded once: %25 is a literal percent, %2D a hyphen',
  hrefReference('/context/strategy/phase%252Done/note.md') === 'context/strategy/phase%2Done/note.md'
  && hrefReference('/context/strategy/phase%2Done/note.md') === 'context/strategy/phase-one/note.md');
check('hrefReference decodes an encoded href, and refuses an encoded ..',
  hrefReference('/tasks/active/TASK-2026-0001/deliverables/%E5%A0%B1%E5%91%8A.pdf') === 'tasks/active/TASK-2026-0001/deliverables/報告.pdf'
  && hrefReference('/tasks/%2E%2E/profile/x.md') === null && hrefReference('/tasks/%E0%A4%A') === null);
check('splitReferences joined back is the same text', (() => {
  const text = 'A TASK-2026-0001, tasks/active/TASK-2026-0002/task.md. 終わりSTK-0001。';
  return splitReferences(text).map((p) => p.text).join('') === text;
})());

// The resolver: batched, limited and cached
await (async () => {
  const calls: string[][] = [];
  let run: (() => void) | null = null;
  let clock = 0;
  const resolve = referenceResolver(async (_path, body) => {
    const asked = (body as { refs: string[] }).refs;
    calls.push(asked);
    const targets: Record<string, ReferenceTarget> = {};
    for (const r of asked) targets[r] = { exists: r !== 'STK-0404', route: r === 'STK-0404' ? null : `/x/${r}` };
    return { targets };
  }, { ttlMs: 1000, now: () => clock, schedule: (fn) => { run = fn; } });

  const ids = Array.from({ length: 70 }, (_, i) => `STK-${String(i + 1).padStart(4, '0')}`);
  const answers = Promise.all([...ids, 'STK-0001', 'STK-0404'].map(resolve));
  check('nothing is asked before the tick ends', calls.length === 0);
  run!();
  const got = await answers;
  check(`one tick's references go in batches of at most ${RESOLVE_BATCH}`, calls.length === 2 && calls[0]!.length === RESOLVE_BATCH && calls[1]!.length === 21, JSON.stringify(calls.map((c) => c.length)));
  check('a reference asked twice is asked of the server once', calls.flat().filter((r) => r === 'STK-0001').length === 1);
  check('each answer goes to its own reference', got[0]?.route === '/x/STK-0001' && got[71]?.exists === false);
  run = null;
  await resolve('STK-0001');
  check('a recent answer is reused', calls.length === 2 && run === null);
  clock = 5000;
  const again = resolve('STK-0001');
  run!();
  await again;
  check('an old answer is asked again', calls.length === 3);
  check('expired answers are dropped when new ones are asked for', resolve.size() === 1, String(resolve.size()));
  resolve.invalidate();
  check('invalidate drops every answer', resolve.size() === 0);
  const fresh = resolve('STK-0001');
  run!();
  await fresh;
  check('after invalidate a reference is asked again', calls.length === 4);

  let fail = true;
  let next: (() => void) | null = null;
  const flaky = referenceResolver(async () => { if (fail) throw new Error('offline'); return { targets: { 'TASK-2026-0001': { exists: true, route: '/board/task/TASK-2026-0001' } } }; },
    { schedule: (fn) => { next = fn; } });
  const first = flaky('TASK-2026-0001');
  next!();
  check('a failed request answers null', (await first) === null);
  fail = false;
  const second = flaky('TASK-2026-0001');
  next!();
  check('a failed reference is asked again next time', (await second)?.exists === true);
})();

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nAll reference checks passed');
