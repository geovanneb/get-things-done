/**
 * Unit tests for making a task from meetings. Run with `npm run test:meeting-deliverable --workspace=ui`.
 */
import { canMakeDeliverable, deliverableDraft, meetingMention } from './meetingDeliverable';
import type { HistoryMeeting, QueuedMeeting } from '@/types';

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
}

const queued = (status: 'draft' | 'queued', in_digest = false) => ({ status, in_digest } as QueuedMeeting);
const held = (linkable: boolean) => ({ linkable } as HistoryMeeting);
check('a queued meeting can be used', canMakeDeliverable({ inTrash: false, queued: queued('queued') }));
check('a draft or one being digested cannot', !canMakeDeliverable({ inTrash: false, queued: queued('draft') }) && !canMakeDeliverable({ inTrash: false, queued: queued('queued', true) }));
check('a held meeting only once its id is final', canMakeDeliverable({ inTrash: false, held: held(true) }) && !canMakeDeliverable({ inTrash: false, held: held(false) }));
check('nothing from the trash', !canMakeDeliverable({ inTrash: true, held: held(true) }));

const weekly = { id: 'MQ-2026-0012', title: 'Weekly sync', date: '2026-10-30' };
check('a mention with title and date', meetingMention(weekly) === '[@Weekly sync · 2026-10-30](/meetings/MQ-2026-0012)', meetingMention(weekly));
check('brackets in a title never end the link', meetingMention({ ...weekly, title: 'Q4 [draft] plan' }).startsWith('[@Q4 (draft) plan ·'));
check('no date, no dangling dot', meetingMention({ ...weekly, date: '' }) === '[@Weekly sync](/meetings/MQ-2026-0012)');

const one = deliverableDraft([weekly]);
check('one meeting: named after it', one.title === 'Deliverable from Weekly sync' && one.objective!.includes('this meeting'));
const two = deliverableDraft([weekly, { id: 'CU-2026-0031-M-01', title: 'Steering committee', date: '2026-11-02' }]);
check('several: every mention, in order', two.title === 'Deliverable from 2 meetings' && two.objective!.indexOf('MQ-2026-0012') < two.objective!.indexOf('CU-2026-0031-M-01'));
check('one deliverable to pick a template for, and no audience guessed', two.deliverables?.length === 1 && !two.stakeholders);

console.log(failures ? `\n${failures} failed` : '\nAll meeting deliverable tests passed');
process.exit(failures ? 1 : 0);
