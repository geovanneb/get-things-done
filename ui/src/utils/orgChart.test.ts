/**
 * Unit tests for the org chart tree helpers. Run with `npm run test:org-chart --workspace=ui`.
 */
import { buildTree, collapsedForLevel, treeDepth } from './orgChart';
import type { OrgChartMember } from '@/types';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
}

// A ─┬─ B ── D ── F
//    └─ C ── E
const members: OrgChartMember[] = [
  { ref: 'A' }, { ref: 'B', reports_to: 'A' }, { ref: 'C', reports_to: 'A' },
  { ref: 'D', reports_to: 'B' }, { ref: 'E', reports_to: 'C' }, { ref: 'F', reports_to: 'D' },
];
const roots = buildTree(members);
const sorted = (s: Set<string>) => [...s].sort().join(',');

check('tree depth counts levels', treeDepth(roots) === 4, `depth=${treeDepth(roots)}`);
check('an empty chart has depth 0', treeDepth([]) === 0);
check('level 1 collapses every card that has reports', sorted(collapsedForLevel(roots, 1)) === 'A,B,C,D',
  sorted(collapsedForLevel(roots, 1)));
check('level 2 keeps the top person open', sorted(collapsedForLevel(roots, 2)) === 'B,C,D', sorted(collapsedForLevel(roots, 2)));
check('level 3 collapses only the third level down', sorted(collapsedForLevel(roots, 3)) === 'D', sorted(collapsedForLevel(roots, 3)));
check('the deepest level collapses nothing', collapsedForLevel(roots, 4).size === 0);

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
