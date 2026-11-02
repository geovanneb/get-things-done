/**
 * Unit tests for the analysis's doubts on a meeting record. Run with `npm run test:record-doubts --workspace=ui`.
 */
import { doubtLine, doubtsAbout } from './recordDoubts';
import type { RecordDoubt } from '@/types';

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
}

const name: RecordDoubt = { field: 'attendees', value: 'Shimoto', reason: 'Sounds like a stakeholder spelled differently.', suggestion: 'Shiomoto' };
const term: RecordDoubt = { field: 'decisions', value: 'Dual Line', reason: 'May be the carrier in the glossary.', suggestion: 'Dual Lane' };
const doubts = [name, term];
check('an attendee is matched by the name, any case, also inside a full name', doubtsAbout(doubts, 'attendees', 'shimoto').length === 1 && doubtsAbout(doubts, 'attendees', 'Ken Shimoto').length === 1);
check('not inside another word', doubtsAbout([{ ...term, value: 'ARC' }], 'decisions', 'Review in March, then archive it').length === 0);
check('punctuation is a boundary', doubtsAbout(doubts, 'decisions', 'Quote from Dual Line, then decide.').length === 1);
check('Japanese names match without spaces', doubtsAbout([{ ...name, value: '塩本' }], 'attendees', '塩本 直弘').length === 1);
check('a value with regex characters is plain text', doubtsAbout([{ ...term, value: 'Q4 (draft)' }], 'decisions', 'Send the Q4 (draft) plan').length === 1);
check('a decision holding the doubted words is matched', doubtsAbout(doubts, 'decisions', 'Ask Dual Line for a quote').length === 1);
check('only the field it names', doubtsAbout(doubts, 'open_questions', 'Ask Dual Line for a quote').length === 0);
check('nothing for empty text or an empty value', doubtsAbout(doubts, 'decisions', '  ').length === 0 && doubtsAbout([{ ...term, value: ' ' }], 'decisions', 'anything').length === 0);
check('a line says what, why and the suggestion', doubtLine(name) === 'Attendees: "Shimoto". Sounds like a stakeholder spelled differently. Maybe: Shiomoto.', doubtLine(name));
check('no suggestion, no "Maybe"', !doubtLine({ ...term, suggestion: '' }).includes('Maybe'));

console.log(failures ? `\n${failures} failed` : '\nAll record doubt tests passed');
process.exit(failures ? 1 : 0);
