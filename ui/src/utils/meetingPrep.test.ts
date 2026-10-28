/**
 * Unit tests for the "Prepare meeting" draft. Run with `npm run test:meeting-prep --workspace=ui`.
 */
import { meetingPrepDraft } from './meetingPrep';
import type { Stakeholder } from '@/types';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
}

const priya = { id: 'STK-0001', name: 'Priya Natarajan', role: 'CFO', organization: 'Northwind Labs', influence: 'decision_maker', what_matters: '', tags: [] } as Stakeholder;
const brief = { id: 'OUT-meeting-brief', slug: 'meeting-brief', format: 'md' };
const deck = { id: 'OUT-executive-deck', slug: 'executive-deck', format: 'pptx' };

const full = meetingPrepDraft(priya, [deck, brief], [{ name: 'meeting-prep' }, { name: 'stakeholder-advisor' }]);
check('the title names the person', full.title === 'Prepare: meeting with Priya Natarajan', full.title);
check('the person is the only stakeholder', full.stakeholders?.length === 1 && full.stakeholders[0]?.id === 'STK-0001');
check('the meeting brief template is the deliverable', full.deliverables?.length === 1 && full.deliverables[0]?.template_ref === 'OUT-meeting-brief' && full.deliverables[0]?.format === 'md', JSON.stringify(full.deliverables));
check('the meeting-prep agent is preferred', full.preferred_agent === 'meeting-prep');
check('the objective leaves the date and goal for the user', /\[meeting date\]/.test(full.objective ?? '') && /\[what I want/.test(full.objective ?? ''));

const bare = meetingPrepDraft(priya, [deck], []);
check('no meeting brief template: no deliverable is made up', bare.deliverables?.length === 0, JSON.stringify(bare.deliverables));
check('no meeting-prep agent (e.g. a Codex-only workspace): no agent is set', bare.preferred_agent === undefined);

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
