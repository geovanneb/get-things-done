/**
 * What the context update importer shows before Save when it is opened for one workspace (the chat panel's
 * "Create context update"), and the title it saves with. Rendered to static HTML, so it runs in plain Node.
 * Run with `npm run test:import-summary --workspace=ui`.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { ImportSummary } from './ImportUpdateModal';
import { importPlan, importTitle, importedUpdateLocation, savedTitle } from '../../utils/importPlan';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? '  ' + detail : ''}`);
  if (!ok) failures++;
}
const file = (name: string) => ({ name });
const workspace = { path: '/home/someone/workspaces/demo', name: 'Demo workspace' };
const now = new Date('2026-11-20T23:30:00Z');
const html = (title: string, files: { name: string }[], text: string, date = '2026-11-19') =>
  renderToStaticMarkup(<ImportSummary workspace={workspace} plan={importPlan(title, files, text, date, now)} />);

// ---- The title it saves with ------------------------------------------------
check('a typed title is used, trimmed', importTitle('  Weekly sync  ', [file('notes.vtt')]) === 'Weekly sync');
check('without one, the first file names the update', importTitle('', [file('board-review.final.pptx'), file('b.pdf')]) === 'board-review.final');
check('pasted text alone leaves the title to the server', importTitle(' ', []) === '');

// ---- The title the server saves (ContextUpdateService.create) ------------------
const long = 'x'.repeat(201);
check('a title over 200 characters is cut to 200, as the server saves it', savedTitle(long, [], '2026-11-19', now) === 'x'.repeat(200));
check('a long first file name is cut the same way', savedTitle('', [file(`${'y'.repeat(250)}.pdf`)], '2026-11-19', now) === 'y'.repeat(200));
check('pasted text alone gets the server\'s date title', savedTitle('', [], '2026-11-19', now) === 'Update 2026-11-19');
check('with no date, the server\'s date is today in UTC', savedTitle('', [], '', now) === 'Update 2026-11-20');
check('a file named only by an extension also gets the date title', savedTitle('', [file('.vtt')], '2026-11-19', now) === 'Update 2026-11-19');
check('the cut is made after trimming, as on the server', savedTitle(`  ${'z'.repeat(199)} tail`, [], '2026-11-19', now) === `${'z'.repeat(199)} `);

// ---- Where the user goes after Save -------------------------------------------
const to = importedUpdateLocation('CU-2026-0001', workspace.path);
check('it opens the new update', to.to === '/context/updates/CU-2026-0001');
check('the page is pinned to the workspace it was made in, so a retry after a switch is refused', to.state.workspace === workspace.path);

// ---- The plan ----------------------------------------------------------------
const plan = importPlan('', [file('a.vtt'), file('b.pdf')], '  some notes ', '2026-11-19', now);
check('the files are listed in upload order', plan.files.join(',') === 'a.vtt,b.pdf');
check('pasted text counts as one more file', plan.pastedText);
check('blank pasted text is not saved', !importPlan('', [file('a.vtt')], ' \n ', '2026-11-19', now).pastedText);

// ---- What the user sees before Save ------------------------------------------
const shown = html('', [file('transcript.vtt'), file('deck.pdf')], 'Follow-up email');
check('it names the workspace, with its folder on hover', shown.includes('Demo workspace') && shown.includes(`title="${workspace.path}"`), shown);
check('it says a new context update is made, under the title it will get', shown.includes('A new context update, “transcript”'), shown);
check('it lists every file and the pasted text', shown.includes('transcript.vtt, deck.pdf, pasted text (saved as a file)'), shown);
check('it says nothing runs until the user starts it, and that Cancel discards', shown.includes('Nothing is analyzed or changed until you start it') && shown.includes('Cancel discards'), shown);
check('the summary is a labelled region', /<section aria-labelledby="([^"]+)"[\s\S]*<h3 id="\1"/.test(shown), shown);

const empty = html('', [], '');
check('with nothing added yet it says so, and shows the server\'s date title', empty.includes('None yet') && empty.includes('A new context update, “Update 2026-11-19”'), empty);
check('pasted text alone shows the date title too', html('', [], 'Only notes').includes('“Update 2026-11-19”'));

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log('\nAll import summary checks passed');
