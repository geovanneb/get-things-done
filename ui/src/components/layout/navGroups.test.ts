/**
 * Unit tests for the sidebar's default groups. Run with `npm run test:nav --workspace=ui`.
 */
import { DEFAULT_SIDEBAR, arrangeSidebar, isDefaultSidebar, moveItem, navGroups, setHidden } from './navGroups';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
}

const ids = (agentFloor: boolean) => navGroups({ agentFloor }).map((g) => `${g.id}:${g.items.map((i) => i.id).join(',')}`);

const off = ids(false);
check('default order without Agent Floor', JSON.stringify(off) === JSON.stringify([
  'work:situation,board,meetings,insights',
  'memory:context,stakeholders,outputs',
  'automation:agents,routines',
  'account:profile,settings',
]), JSON.stringify(off));

const on = navGroups({ agentFloor: true });
check('Agent Floor closes the automation group when on', on[2].items[on[2].items.length - 1].id === 'agent-floor');

const groups = navGroups({ agentFloor: false });
check('Situation is the first item (home route)', groups[0].items[0].path === '/situation');
check('no group has fewer than two items', groups.every((g) => g.items.length >= 2));
check('only Memory and Automation have headings',
  groups.filter((g) => g.heading).map((g) => g.heading).join(',') === 'Memory,Automation');
check('Outputs is labelled like its page', groups[1].items.find((i) => i.id === 'outputs')?.label === 'Output templates');

const all = on.flatMap((g) => g.items);
check('ids are unique', new Set(all.map((i) => i.id)).size === all.length);
check('paths are unique', new Set(all.map((i) => i.path)).size === all.length);

// Customization (part 2 of #191)
const defaults = navGroups({ agentFloor: false });
const order = (prefs: Parameters<typeof arrangeSidebar>[1], g = defaults) =>
  arrangeSidebar(g, prefs).map((group) => group.items.map((i) => (i.hidden ? `(${i.id})` : i.id)).join(',')).join(' | ');

check('no saved preferences keep the default sidebar', isDefaultSidebar(defaults, DEFAULT_SIDEBAR));

const moved = moveItem(defaults, DEFAULT_SIDEBAR, 'insights', 0);
check('an item moves inside its own group', order(moved).startsWith('insights,situation,board,meetings |'), order(moved));
check('a moved sidebar is no longer the default', !isDefaultSidebar(defaults, moved));
check('moving back gives the default again', isDefaultSidebar(defaults, moveItem(defaults, moved, 'insights', 3)));
check('moving past the end stops at the end', order(moveItem(defaults, DEFAULT_SIDEBAR, 'situation', 99)).startsWith('board,meetings,insights,situation |'));
check('the order of other groups is untouched', order(moved).includes('| context,stakeholders,outputs |'));

const saved = { order: { automation: ['routines', 'agents'] }, hidden: [] };
check('Agent Floor switched on later shows up after its default neighbour',
  order(saved, navGroups({ agentFloor: true })).includes('| routines,agent-floor,agents |'), order(saved, navGroups({ agentFloor: true })));
const newItemFirst = { order: { work: ['meetings', 'insights'] }, hidden: [] };
check('items missing from a saved order keep their default place',
  order(newItemFirst).startsWith('situation,board,meetings,insights |'), order(newItemFirst));
const stale = { order: { work: ['insights', 'gone-feature', 'situation', 'insights'] }, hidden: ['gone-feature'] };
check('unknown and repeated ids are ignored', order(stale).startsWith('insights,situation,board,meetings |'), order(stale));

const hidden = setHidden(setHidden(DEFAULT_SIDEBAR, 'routines', true), 'stakeholders', true);
check('hidden items are marked, not dropped', order(hidden).includes('context,(stakeholders),outputs') && order(hidden).includes('agents,(routines)'));
check('Situation and Settings cannot be hidden',
  setHidden(DEFAULT_SIDEBAR, 'situation', true).hidden.length === 0 && setHidden(DEFAULT_SIDEBAR, 'settings', true).hidden.length === 0);
check('a hand-edited file cannot hide Situation either', !order({ order: {}, hidden: ['situation', 'settings'] }).includes('('));
check('showing an item again', setHidden(hidden, 'routines', false).hidden.join() === 'stakeholders');
check('an item hidden twice is listed once', setHidden(hidden, 'routines', true).hidden.filter((h) => h === 'routines').length === 1);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nAll nav group checks passed');
