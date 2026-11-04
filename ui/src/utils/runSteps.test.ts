/**
 * Unit tests for the steps of a run in words (#246). Run with `npm run test:run-steps --workspace=ui`.
 */
import { elapsed, stepText, stepWords } from './runSteps';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
}

check('a read, now and done', stepText({ kind: 'read', path: 'context/a/note.md' }, true) === 'Reading context/a/note.md' && stepText({ kind: 'read', path: 'update.md' }) === 'Read update.md');
check('the path is kept apart, to show as code', JSON.stringify(stepWords({ kind: 'search', path: 'context' })) === JSON.stringify({ verb: 'Searched', path: 'context', rest: '' }));
check('no path: the workspace, files, a file', [
  stepText({ kind: 'search', path: null }), stepText({ kind: 'list', path: null }), stepText({ kind: 'write', path: null }),
].join('|') === 'Searched the workspace|Listed files|Wrote a file');
check('outside the workspace, never a path', stepText({ kind: 'read', path: null, outside: true }) === 'Read a file outside the workspace' && stepText({ kind: 'list', path: null, outside: true }, true) === 'Listing outside the workspace');
check('a command, a skill, another tool', [
  stepText({ kind: 'command', path: null }, true), stepText({ kind: 'skill', path: null, name: 'pdf' }), stepText({ kind: 'skill', path: null }),
  stepText({ kind: 'other', path: null, name: 'WebSearch' }), stepText({ kind: 'other', path: null }),
].join('|') === 'Running a command|Used the pdf skill|Used a skill|Used WebSearch|Used a tool');
check('a new file: the folder it goes in, never its name', stepText({ kind: 'write', path: null, folder: 'context-updates/CU-2026-0001/proposals' }, true) === 'Writing a file in context-updates/CU-2026-0001/proposals' && stepText({ kind: 'write', path: null, folder: '' }) === 'Wrote a file in the workspace folder');
check('an unknown kind still reads', stepText({ kind: 'teleport' as never, path: 'x.md' }) === 'Worked x.md');
check('elapsed time', [elapsed(-5), elapsed(45_900), elapsed(134_000), elapsed(3_780_000)].join('|') === '0 s|45 s|2 min 14 s|1 h 3 min');

if (failures) {
  console.error(`\n${failures} run step check(s) failed.`);
  process.exit(1);
}
console.log('\nAll run step checks passed.');
