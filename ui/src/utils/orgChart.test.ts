/**
 * Unit tests for the org chart tree helpers. Run with `npm run test:org-chart --workspace=ui`.
 */
import { buildTree, collapsedForLevel, placeMember, removeMember, setTitle, treeDepth } from './orgChart';
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

// --- Extra member fields survive every edit ---------------------------------
const titled: OrgChartMember[] = [
  { ref: 'A', title: 'Chair' }, { ref: 'B', reports_to: 'A', title: 'Lead' }, { ref: 'C', reports_to: 'B', title: 'Analyst' },
];
const moved = placeMember(titled, 'C', 'A');
check('moving someone keeps their title', moved.find((m) => m.ref === 'C')?.title === 'Analyst'
  && moved.find((m) => m.ref === 'C')?.reports_to === 'A');
const toTop = placeMember(titled, 'B', null);
check('moving someone to the top keeps their title and drops reports_to',
  toTop.find((m) => m.ref === 'B')?.title === 'Lead' && !('reports_to' in toTop.find((m) => m.ref === 'B')!));
const removed = removeMember(titled, 'B');
check('removing a manager moves their reports up and keeps the reports\' titles',
  removed.find((m) => m.ref === 'C')?.reports_to === 'A' && removed.find((m) => m.ref === 'C')?.title === 'Analyst');
check('setTitle sets a trimmed title', setTitle(titled, 'A', '  Board chair ').find((m) => m.ref === 'A')?.title === 'Board chair');
const cleared = setTitle(titled, 'A', '   ').find((m) => m.ref === 'A')!;
check('a blank title clears it (the profile role applies again)', !('title' in cleared));

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
