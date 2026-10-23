/**
 * Unit tests for the org chart tree helpers. Run with `npm run test:org-chart --workspace=ui`.
 */
import {
  buildTree, buildUnitTree, canNestUnit, collapsedForLevel, deleteUnit, nextUnitId, placeMember, removeMember, saveUnit,
  setMemberUnit, setTitle, treeDepth, unitPath, withoutHead, editPlaceholder, isPlaceholder, nextPlaceholderId, replaceRef,
} from './orgChart';
import type { OrgChartMember, OrgUnit } from '@/types';

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

// --- Units --------------------------------------------------------------------
// Ops (U-1) ─┬─ Logistics (U-2) ── Yard (U-4)
//            └─ Warehousing (U-3)
const units: OrgUnit[] = [
  { id: 'U-1', name: 'Ops', head: 'A' }, { id: 'U-2', name: 'Logistics', parent: 'U-1', head: 'B' },
  { id: 'U-3', name: 'Warehousing', parent: 'U-1' }, { id: 'U-4', name: 'Yard', parent: 'U-2' },
];
const inUnits: OrgChartMember[] = [
  { ref: 'A', unit: 'U-1' }, { ref: 'B', reports_to: 'A', unit: 'U-2', title: 'Lead' }, { ref: 'C', reports_to: 'B', unit: 'U-2' },
  { ref: 'D', reports_to: 'B', unit: 'U-4' },
];
const unitRoots = buildUnitTree(units);
check('the unit tree nests sub-units', unitRoots.length === 1 && unitRoots[0].children.map((n) => n.unit.id).join(',') === 'U-2,U-3'
  && unitRoots[0].children[0].children[0]?.unit.id === 'U-4');
check('a unit cannot move inside its own sub-unit', !canNestUnit(units, 'U-1', 'U-4') && canNestUnit(units, 'U-3', 'U-4') && canNestUnit(units, 'U-4', null));
check('the next unit id follows the highest one', nextUnitId(units) === 'U-5' && nextUnitId([]) === 'U-1');
check('the unit path runs from the top down', unitPath(units, 'U-4').join(' / ') === 'Ops / Logistics / Yard');
const afterDelete = deleteUnit(units, inUnits, 'U-2');
check('deleting a unit moves its sub-units up', afterDelete.units.find((u) => u.id === 'U-4')?.parent === 'U-1' && !afterDelete.units.some((u) => u.id === 'U-2'));
check('deleting a unit moves its people up and keeps them in the chart',
  afterDelete.members.length === 4 && afterDelete.members.filter((m) => m.unit === 'U-1').map((m) => m.ref).join(',') === 'A,B,C');
check('deleting a unit keeps reporting lines and titles',
  afterDelete.members.find((m) => m.ref === 'C')?.reports_to === 'B' && afterDelete.members.find((m) => m.ref === 'B')?.title === 'Lead');
const topDelete = deleteUnit(units, inUnits, 'U-1');
check('deleting a top-level unit leaves its people without a unit', !('unit' in topDelete.members.find((m) => m.ref === 'A')!)
  && !('parent' in topDelete.units.find((u) => u.id === 'U-2')!));
check('moving someone to another unit keeps their title and manager',
  (() => { const b = setMemberUnit(inUnits, 'B', 'U-3').find((m) => m.ref === 'B')!; return b.unit === 'U-3' && b.title === 'Lead' && b.reports_to === 'A'; })());
check('taking someone out of a unit drops the field', !('unit' in setMemberUnit(inUnits, 'C', null).find((m) => m.ref === 'C')!));
check('changing manager keeps the unit', placeMember(inUnits, 'D', 'A').find((m) => m.ref === 'D')?.unit === 'U-4');
check('saving a unit updates it in place and clears an empty head',
  (() => { const u = saveUnit(units, { id: 'U-2', name: ' Freight ', parent: 'U-1', head: '' }).find((x) => x.id === 'U-2')!; return u.name === 'Freight' && !('head' in u); })());
check('a person leaving the chart stops being a unit head', !('head' in withoutHead(units, 'B').find((u) => u.id === 'U-2')!));

// --- Placeholders -----------------------------------------------------------
const withPh: OrgChartMember[] = [
  { ref: 'A' }, { ref: 'P-1', name: 'New sales lead', title: 'Head of Sales', reports_to: 'A', unit: 'U-1' },
  { ref: 'C', reports_to: 'P-1' }, { ref: 'P-3', name: 'Analyst (vacant)', reports_to: 'P-1' },
];
const phUnits: OrgUnit[] = [{ id: 'U-1', name: 'Sales', head: 'P-1' }];
check('placeholder ids are recognised', isPlaceholder('P-12') && !isPlaceholder('STK-0001') && !isPlaceholder('P-x'));
check('the next placeholder id follows the highest one', nextPlaceholderId(withPh) === 'P-4' && nextPlaceholderId(members) === 'P-1');
check('editing a placeholder sets name and title', (() => { const p = editPlaceholder(withPh, 'P-3', ' Analyst ', 'Data analyst').find((m) => m.ref === 'P-3')!; return p.name === 'Analyst' && p.title === 'Data analyst' && p.reports_to === 'P-1'; })());
const linked = replaceRef(withPh, phUnits, 'P-1', 'STK-0009');
const promoted = linked.members.find((m) => m.ref === 'STK-0009')!;
check('linking a placeholder keeps its manager, unit and title and drops its name',
  promoted.reports_to === 'A' && promoted.unit === 'U-1' && promoted.title === 'Head of Sales' && !('name' in promoted));
check('linking a placeholder moves its reports to the stakeholder',
  linked.members.filter((m) => m.reports_to === 'STK-0009').map((m) => m.ref).join(',') === 'C,P-3' && !linked.members.some((m) => m.ref === 'P-1'));
check('linking a placeholder moves the units it leads', linked.units[0].head === 'STK-0009');
check('making a stakeholder can drop the chart title (it becomes their role)',
  !('title' in replaceRef(withPh, phUnits, 'P-1', 'STK-0009', false).members.find((m) => m.ref === 'STK-0009')!));

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
