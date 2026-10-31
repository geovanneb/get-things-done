/**
 * Unit tests for the New task draft made from a meeting action item. Run with `npm run test:meeting-action --workspace=ui`.
 */
import { meetingActionDraft, namesMatch } from './meetingAction';
import type { MeetingRecord, Stakeholder } from '@/types';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
}

const record: MeetingRecord = {
  id: 'M-01', title: 'Fictional steering', meeting_date: '2026-10-20', attendees: [], speakers: [], decisions: [], open_questions: [],
  action_items: [
    { description: 'Send the revised plan', owner: { ref: 'STK-0001', name: 'Priya Natarajan' }, due_date: '2026-10-27', task_ref: null },
    { description: 'x'.repeat(250), owner: null, due_date: '', task_ref: null },
    { description: 'Book the room', owner: { ref: 'me', name: 'me' }, due_date: '', task_ref: null },
  ],
  source: 'transcript.txt', confirmation: 'confirmed', confirmed_at: null, revision: 'abc123', problems: [], changed_since_confirmed: false,
};
const priya = { id: 'STK-0001', name: 'Priya Natarajan' } as Stakeholder;

const draft = meetingActionDraft({ id: 'CU-2026-0001' }, record, 0, priya);
check('the item becomes the title', draft.title === 'Send the revised plan');
check('the objective says where it comes from', draft.objective!.includes('Fictional steering on 2026-10-20') && draft.objective!.includes('CU-2026-0001') && draft.objective!.includes('M-01'));
check('owner and due date are carried over', draft.objective!.includes('Owner: Priya Natarajan') && draft.due_date === '2026-10-27' && draft.stakeholders?.[0]?.id === 'STK-0001');
check('the link back names the item and the revision the user saw', JSON.stringify(draft.meeting_action) === JSON.stringify({ update_id: 'CU-2026-0001', record_id: 'M-01', item: 0, revision: 'abc123' }));

const long = meetingActionDraft({ id: 'CU-2026-0001' }, record, 1);
check('a long item is shortened only in the title; the objective keeps it whole', long.title!.length === 200 && long.objective!.includes('x'.repeat(250)));
check('no owner, no due date and no stakeholder when the item has none', !long.objective!.includes('Owner:') && long.due_date === undefined && long.stakeholders!.length === 0);
check('an item for me says so', meetingActionDraft({ id: 'CU-2026-0001' }, record, 2).objective!.includes('Owner: me'));

const priyaJa = { id: 'STK-0002', name: 'Shiomoto Naohiro (塩本 直弘)' } as Stakeholder;
check('names match only as stored: full name, either form of a two-form name, extra spaces', namesMatch('Priya  Natarajan', 'Priya Natarajan')
  && namesMatch('塩本　直弘', priyaJa.name) && namesMatch('Shiomoto Naohiro', priyaJa.name) && namesMatch('', 'Priya Natarajan'));
check('no guessing: other case, order or a part of the name is a mismatch', !namesMatch('priya natarajan', 'Priya Natarajan')
  && !namesMatch('Naohiro Shiomoto', priyaJa.name) && !namesMatch('Shiomoto', priyaJa.name) && !namesMatch('Jane Doe', 'Priya Natarajan'));
const wrong = meetingActionDraft({ id: 'CU-2026-0001' }, { ...record, action_items: [{ description: 'Plan', owner: { ref: 'STK-0001', name: 'Jane Doe' }, due_date: '', task_ref: null }] }, 0, priya);
check('a wrong link leaves the stakeholder out and says why', wrong.stakeholders!.length === 0 && wrong.objective!.includes('names "Jane Doe" but links STK-0001, which is Priya Natarajan'));
const refOnly = meetingActionDraft({ id: 'CU-2026-0001' }, { ...record, action_items: [{ description: 'Plan', owner: { ref: 'STK-0001', name: '' }, due_date: '', task_ref: null }] }, 0, priya);
check('a link without a written name keeps the stakeholder', refOnly.stakeholders?.[0]?.id === 'STK-0001');

if (failures) { console.error(`${failures} meeting action check(s) failed`); process.exit(1); }
console.log('All meeting action checks passed');
