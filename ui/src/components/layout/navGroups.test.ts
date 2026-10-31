/**
 * Unit tests for the sidebar's default groups. Run with `npm run test:nav --workspace=ui`.
 */
import { navGroups } from './navGroups';

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

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nAll nav group checks passed');
