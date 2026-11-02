/**
 * What a task made from a meeting action item says about the meeting record. Rendered to static HTML, so it runs in
 * plain Node. Run with `npm run test:task-notice --workspace=ui`.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom';
import { ActionNoticeView } from './TaskMeetingAction';
import type { ActionNotice } from '@/types';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? '  ' + detail : ''}`);
  if (!ok) failures++;
}
const noop = () => {};
const html = (data: ActionNotice | null, failed = false, retrying = false) =>
  renderToStaticMarkup(<StaticRouter location="/board/task/TASK-2026-0001"><ActionNoticeView data={data} failed={failed} retrying={retrying} onRetry={noop} /></StaticRouter>);
const notice = (over: Partial<ActionNotice>): ActionNotice => ({ state: 'current', meeting: 'MQ-2026-0001', changes: [], current: null, legacy: false, ...over });

const changed = notice({
  state: 'changed', current: { update_id: 'CU-2026-0002', record_id: 'M-01', at: '2026-11-02T10:00:00.000Z' },
  changes: [{ property: 'owner', before: 'Kim Parker', after: 'Kim Park' }, { property: 'due_date', before: '', after: '2026-11-20' }],
});
const shown = html(changed);
check('a change lists each property, before and after', shown.includes('Owner: Kim Parker → Kim Park') && shown.includes('Due date: (none) → 2026-11-20'));
check('it says the version, not when the task was made', shown.includes('differs from the version used for this task') && !shown.includes('after this task was made'));
check('it links the current version and the meeting', shown.includes('href="/context/updates/CU-2026-0002"') && shown.includes('href="/meetings/MQ-2026-0001"'));
check('an older task says it is compared with the original', html({ ...changed, legacy: true }).includes('compared with the original'));

check('nothing to say when nothing changed', html(notice({})) === '' && html(null) === '');
check('nothing for a task not made from a meeting', html(notice({ state: 'none', meeting: null })) === '');

for (const [state, title] of [
  ['conflict', 'The versions of this meeting&#x27;s record disagree.'],
  ['broken', 'The versions of this meeting&#x27;s record do not hold.'],
  ['unknown', 'The version used for this task cannot be verified.'],
  ['ambiguous', 'This task cannot be matched to one action item.'],
] as const) {
  const out = html(notice({ state }));
  check(`${state} is said, with no changes listed`, out.includes(title) && !out.includes('→'), out);
}
check('an original that is gone says nothing', html(notice({ state: 'gone' })) === '');
check('an unreadable saved version is not blamed on the meeting', html(notice({ state: 'unknown' })).includes('cannot be verified') && !html(notice({ state: 'unknown' })).includes('changed or removed'));
check('a version that does not hold is a warning', html(notice({ state: 'broken' })).includes('gtd-notice--warning'));

const failed = html(changed, true);
check('a failed check is said, and the older answer is not shown', failed.includes('Could not check') && !failed.includes('Kim Park'));
check('it offers a retry', failed.includes('Try again'));
check('while retrying, still no older answer, and the button says so', (() => { const out = html(changed, true, true); return out.includes('Checking') && !out.includes('Kim Park'); })());

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll task notice checks passed.');
