/**
 * Unit tests for the get-started interview logic. Run with `npm run test:first-context --workspace=ui`.
 */
import {
  COUNTED_STEPS, INTERVIEW_FILE, STEPS, canSend, emptyAnswers, emptyPerson, nextStep, ownFiles, previousStep,
  stepAnswered, stepNumber, unnamedRows, withoutEmptyRows,
} from './firstContext';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
}

const empty = emptyAnswers();
check('nothing answered and no file: nothing to send', !canSend(empty, 0));
check('a file alone is enough to send', canSend(empty, 1));
check('one answer alone is enough to send', canSend({ ...empty, work: { ...empty.work, priorities: 'Launch Route 2.0' } }, 0));
check('whitespace is not an answer', !canSend({ ...empty, notes: '   \n ' }, 0));

const relationshipOnly = { ...empty, people: [{ ...emptyPerson(), relationship: 'peer' }] };
check('a person row with only a relationship does not count as answered', !stepAnswered('people', relationshipOnly, 0));
check('a named person counts as answered', stepAnswered('people', { ...empty, people: [{ ...emptyPerson(), name: 'Jane Doe' }] }, 0));
check('the notes count for the "what is going on" step', stepAnswered('current', { ...empty, notes: 'Hiring freeze' }, 0));
check('the files step is answered by files only', stepAnswered('files', empty, 2) && !stepAnswered('files', empty, 0));

const rows = {
  ...empty,
  people: [emptyPerson(), { ...emptyPerson(), role: 'CFO' }, { ...emptyPerson(), name: 'Jane Doe' }],
  organizations: [{ name: '', relationship: 'client', notes: '' }, { name: '', relationship: '', notes: 'Largest account' }],
};
const cleaned = withoutEmptyRows(rows);
check('empty rows are dropped when moving on', cleaned.people.length === 2 && cleaned.organizations.length === 1);
check('rows with text but no name are counted for the review', unnamedRows(rows) === 2, String(unnamedRows(rows)));

check('the intro is not counted as a step', stepNumber('intro') === 0 && stepNumber('work') === 1 && stepNumber('review') === COUNTED_STEPS.length);
check('next and previous stop at the ends', nextStep('review') === 'review' && previousStep('intro') === 'intro' && nextStep('intro') === 'work');
check('the steps run from the intro to the review', STEPS[0] === 'intro' && STEPS[STEPS.length - 1] === 'review');

const update = { materials: [{ name: INTERVIEW_FILE, size: 10, type: 'text/markdown' }, { name: 'org-chart.pdf', size: 99, type: 'application/pdf' }] };
check('the interview the dashboard wrote is not one of the executive files', ownFiles(update).map((m) => m.name).join() === 'org-chart.pdf');
check('no update: no files', ownFiles(null).length === 0);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll first-context checks passed.');
