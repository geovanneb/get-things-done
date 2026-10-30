/**
 * Unit tests for who is expected at a meeting. Run with `npm run test:meeting-participants --workspace=ui`.
 */
import { addParticipant, consentSentence, isMeetingPrepTask, joinNames, recordPrefillFromTask } from './meetingParticipants';

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
}

const jane = { name: 'Jane Doe', ref: 'STK-0001' };
const bob = { name: 'Bob Lee' };
const kim = { name: 'Kim Park' };

check('a name is added, tidied', addParticipant([], { name: '  Bob   Lee ' })[0]?.name === 'Bob Lee');
check('nothing to add', addParticipant([bob], { name: '   ' }).length === 1);
check('the same stakeholder once', addParticipant([jane], { name: 'J. Doe', ref: 'STK-0001' }).length === 1);
check('a stakeholder typed as a name once', addParticipant([jane], { name: 'jane doe' }).length === 1);
check('one name', joinNames([bob]) === 'Bob Lee');
check('two names', joinNames([jane, bob]) === 'Jane Doe and Bob Lee');
check('three names', joinNames([jane, bob, kim]) === 'Jane Doe, Bob Lee and Kim Park');
check('the reminder without names', consentSentence([]) === 'I have told everyone in the meeting that it is being recorded.');
check('the reminder names them and still means everyone', consentSentence([jane, bob]) === 'I have told everyone in the meeting, including Jane Doe and Bob Lee, that it is being recorded.');

check('a task for the prep agent', isMeetingPrepTask({ title: 'Anything', preferred_agent: 'meeting-prep' }));
check('a prep task without that agent', isMeetingPrepTask({ title: 'Prepare: meeting with Jane Doe' }));
check('another task', !isMeetingPrepTask({ title: 'Prepare slides', preferred_agent: 'executive-report-writer' }));
check('a task that prepares something else', !isMeetingPrepTask({ title: 'Prepare: quarterly report' }));

const prefill = recordPrefillFromTask(
  { title: 'Prepare: meeting with Jane Doe', stakeholders: [{ ref: 'STK-0001', role: 'reviewer', key: false }, { ref: 'STK-0404', role: 'reviewer', key: false }] },
  [{ id: 'STK-0001', name: 'Jane Doe' }],
);
check('the title without Prepare', prefill.title === 'Meeting with Jane Doe', prefill);
check('its stakeholders; one that is gone has no name to show', prefill.participants.length === 1 && prefill.participants[0]?.ref === 'STK-0001', prefill);

if (failures) { console.error(`${failures} check(s) failed`); process.exit(1); }
