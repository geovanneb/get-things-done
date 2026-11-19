/**
 * The anchors the Markdown renderer gives workspace references, before any lookup has answered (rendered to static
 * HTML, so it runs in plain Node). Run with `npm run test:references --workspace=ui`.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import MarkdownRenderer from './MarkdownRenderer';

// The router's layout effect cannot run in a static render; that is expected here.
const warn = console.error;
console.error = (...args: unknown[]) => { if (!String(args[0]).includes('useLayoutEffect does nothing on the server')) warn(...args); };

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? '  ' + detail : ''}`);
  if (!ok) failures++;
}
const html = (content: string, props: { references?: boolean; settled?: boolean } = {}) =>
  renderToStaticMarkup(<MemoryRouter><MarkdownRenderer content={content} {...props} /></MemoryRouter>);
/** Every anchor: its classes, href and target. */
const anchors = (markup: string) => [...markup.matchAll(/<a ([^>]*)>/g)].map((m) => ({
  cls: /class="([^"]*)"/.exec(m[1]!)?.[1] ?? '',
  href: /href="([^"]*)"/.exec(m[1]!)?.[1] ?? null,
  target: /target="([^"]*)"/.exec(m[1]!)?.[1] ?? null,
}));

// Explicit @ citations in the format the assistant is asked for: chips to the item's page, never new-tab file links.
const cited = anchors(html([
  '[@Quarterly review](/context-updates/CU-2026-0003/update.md)',
  '[@Weekly review](/routines/RT-0001.md)',
  '[@Budget review](/tasks/active/TASK-2026-0001/task.md)',
  '[@Jane Doe](/stakeholders/people/stk-0001.md)',
  '[@Supplier risk](CTX-single-supplier)',
  '[@Old style](stakeholders/people/stk-0002.md)',
  '[@Kickoff](/meetings/MQ-2026-0001)',
].join('\n\n'), { references: true }));
check('every citation format is a chip, none a new-tab link', cited.length === 7 && cited.every((a) => a.cls.startsWith('mention-chip') && a.target === null), JSON.stringify(cited));
// Where each opens is the workspace's answer (server tests): before it, no address is guessed from the file name,
// since a file may carry another id than its name (`stk-0001.md` holding STK-0002).
check('no citation has a guessed address before its lookup answered', cited.every((a) => a.href === null), JSON.stringify(cited.map((a) => a.href)));
const mismatched = html('[@Someone](/stakeholders/people/stk-0001.md)', { references: true });
check('a citation of stk-0001.md never links to STK-0001 by its name', !mismatched.includes('/stakeholders/STK-0001') && /role="link"[^>]*tabindex="0"|tabindex="0"[^>]*role="link"/.test(mismatched), mismatched)

// A formatted label is still a citation.
const formatted = anchors(html('[**@Budget review**](/tasks/active/TASK-2026-0001/task.md) and [_@Jane_ Doe](/stakeholders/people/stk-0001.md)', { references: true }));
check('a citation with a formatted label is a chip too', formatted.length === 2 && formatted.every((a) => a.cls.startsWith('mention-chip') && a.target === null), JSON.stringify(formatted));

// A citation's href is decoded once, through the Markdown pipeline too: the chip names the literal folder.
const escaped = html('[@Escaped](/context/strategy/phase%252Done/note.md) and [@Hyphen](/context/strategy/phase%2Done/note.md)', { references: true });
const titles = [...escaped.matchAll(/class="mention-chip[^"]*"[^>]*title="([^"]*)"/g)].map((m) => m[1]);
check('a %25 escape in a citation names the literal folder, a %2D a hyphen',
  JSON.stringify(titles) === JSON.stringify(['/context/strategy/phase%2Done/note.md', '/context/strategy/phase-one/note.md']), JSON.stringify(titles));

// The same in a task's objective (no references in the text there): citations are still chips.
check('citations are chips outside the chat too', anchors(html('[@Weekly review](/routines/RT-0001.md)')).every((a) => a.cls.startsWith('mention-chip')));

// A reference found in the text is plain text until the workspace confirms it: nothing guessed is clickable.
const bare = html('TASK-2026-0001, CTX-single-supplier and tasks/active/TASK-2026-0001/brief.pdf', { references: true });
check('unconfirmed bare references are not links', anchors(bare).length === 0 && bare.includes('TASK-2026-0001') && bare.includes('CTX-single-supplier'), bare);

// While an answer is still being written, citations wait as plain text.
const streaming = html('[@Budget review](/tasks/active/TASK-2026-0001/task.md) and TASK-2026-0002', { references: true, settled: false });
check('a citation in an unfinished answer is plain text', anchors(streaming).length === 0 && streaming.includes('@Budget review'), streaming);

// Other links stay ordinary links that open in a new tab.
const other = anchors(html('[docs](https://example.test/a) and [@Profile](/profile/executive-profile.md) and [@Up](/tasks/../profile/x.md)', { references: true }));
check('outside links and paths outside the workspace folders are ordinary new-tab links', other.length === 3 && other.every((a) => a.target === '_blank' && !a.cls.includes('mention-chip')), JSON.stringify(other));

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nAll renderer reference checks passed');
