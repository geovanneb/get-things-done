/**
 * Unit tests for making a task from meetings. Run with `npm run test:meeting-deliverable --workspace=ui`.
 */
import { audienceSuggestions, canMakeDeliverable, canTaskFromAction, deliverableDraft, hasConfirmedRecord, meetingMention, recordProblem, templateFor, withMeetingMention } from './meetingDeliverable';
import { meetingActionDraft } from './meetingAction';
import type { HistoryMeeting, MeetingDetail, MeetingRecord, QueuedMeeting, Stakeholder } from '@/types';

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

// ---- One meeting with a confirmed record ---------------------------------------------------------------------

const person = (id: string, name: string) => ({ id, name } as Stakeholder);
const ana = person('STK-0001', 'Ana Lima');
const kenji = person('STK-0002', 'Sato Kenji (佐藤 健二)');
const jon = person('STK-0003', 'Jon Park');
const people = [ana, kenji, jon, person('STK-0004', 'Lee Min'), person('STK-0005', 'Lee Min')];
const templates = [
  { id: 'OUT-executive-deck', name: 'Executive deck', format: 'pptx' },
  { id: 'OUT-executive-document', name: 'Executive document', format: 'pdf' },
  { id: 'OUT-meeting-brief', name: 'Meeting brief', format: 'md' },
  { id: 'OUT-plain-text', name: 'Plain text message', format: 'txt' },
];
const record: MeetingRecord = {
  id: 'M-01', title: 'Weekly sync', meeting_date: '2026-10-30',
  attendees: [{ ref: 'STK-0001', name: 'Ana Lima' }, { ref: null, name: '佐藤 健二' }, { ref: 'me', name: 'me' }, { ref: null, name: 'John Park' }],
  speakers: [{ label: 'Speaker 2', person: { ref: 'STK-0003', name: 'Jon Park' }, reason: '', source: '' }, { label: 'Speaker 3', person: null, reason: '', source: '' }],
  decisions: ['Run the pilot in two teams', '  '],
  open_questions: [],
  action_items: [
    { description: 'Send the board a deck on the pilot results', owner: { ref: 'STK-0001', name: 'Ana Lima' }, due_date: '2026-11-10', task_ref: null },
    { description: 'Book the room', owner: { ref: 'me', name: 'me' }, due_date: '', task_ref: null },
  ],
  source: 'transcript.md', confirmation: 'confirmed', confirmed_at: null, revision: 'r1', problems: [], changed_since_confirmed: false,
};
const source = (item: number | null, over: Partial<MeetingRecord> = {}) => ({ record: { ...record, ...over }, item, stakeholders: people, templates });

check('only a held meeting with a confirmed record gets the richer draft',
  hasConfirmedRecord({ held: { record: { confirmation: 'confirmed' } } as HistoryMeeting })
  && !hasConfirmedRecord({ held: { record: { confirmation: null } } as HistoryMeeting }) && !hasConfirmedRecord({}));

const plain = deliverableDraft([weekly]);
check('no record: the generic text, as before', plain.objective!.startsWith('Make a deliverable from this meeting:') && !plain.suggested_stakeholders && !plain.due_date);
const unconfirmed = deliverableDraft([weekly], source(0, { confirmation: null }));
check('an unconfirmed record is not used', unconfirmed.objective === plain.objective && unconfirmed.title === plain.title);

const whole = deliverableDraft([weekly], source(null));
check('a record with decisions: the mention, then the decisions, blanks dropped',
  whole.objective!.includes(meetingMention(weekly)) && whole.objective!.includes('Decisions:\n- Run the pilot in two teams') && !whole.objective!.includes('-   '), whole.objective);
check('no action chosen: named after the record, no template, no due date', whole.title === 'Deliverable from Weekly sync' && whole.deliverables?.length === 1 && !whole.deliverables[0]!.template_ref && !whole.due_date);
check('a decision over two lines stays one list item', deliverableDraft([weekly], source(null, { decisions: ['Pilot first\n  then roll out'] })).objective!.includes('- Pilot first then roll out'));
check('no decisions: no empty heading', !deliverableDraft([weekly], source(null, { decisions: [] })).objective!.includes('Decisions:'));

const deck = deliverableDraft([weekly], source(0));
check('an action chosen: "Prepare as agreed" with its owner and due date', deck.objective!.startsWith('Prepare as agreed: Send the board a deck on the pilot results\n- Owner: Ana Lima\n- Due: 2026-11-10'), deck.objective);
check('the action becomes the title and its due date the task\'s', deck.title === 'Send the board a deck on the pilot results' && deck.due_date === '2026-11-10');
check('the meeting mention stays, after the action', deck.objective!.indexOf(meetingMention(weekly)) > deck.objective!.indexOf('Prepare as agreed'));
check('"a deck" alone picks no template: kinds are not guessed', !deck.deliverables?.[0]?.template_ref && deck.objective!.includes('Choose the output template'));
const named = deliverableDraft([weekly], source(0, { action_items: [{ description: 'Prepare the Executive deck on the pilot results', owner: null, due_date: '', task_ref: null }] }));
check('a template named in full is preselected, and the hint only asks for what is left', named.deliverables?.[0]?.template_ref === 'OUT-executive-deck' && named.deliverables[0].format === 'pptx'
  && !named.objective!.includes('output template') && named.objective!.includes('Tick who it is for'));
check('the user as owner reads "me"', deliverableDraft([weekly], source(1)).objective!.includes('- Owner: me'));
check('several meetings keep the combined draft, even with a record', deliverableDraft([weekly, weekly], source(0)).title === 'Deliverable from 2 meetings');

// ---- Audience ------------------------------------------------------------------------------------------------

const audience = audienceSuggestions(record, people).map((s) => s.id);
check('linked attendees, exact names and named speakers are suggested, in order', JSON.stringify(audience) === JSON.stringify(['STK-0001', 'STK-0002', 'STK-0003']), audience);
check('suggested, never set', deck.suggested_stakeholders?.length === 3 && !deck.stakeholders);
check('a near miss is not a match ("John Park" vs "Jon Park")', audienceSuggestions({ attendees: [{ ref: null, name: 'John Park' }], speakers: [] }, people).length === 0);
check('case is not guessed either', audienceSuggestions({ attendees: [{ ref: null, name: 'ana lima' }], speakers: [] }, people).length === 0);
check('a link whose name differs is not trusted', audienceSuggestions({ attendees: [{ ref: 'STK-0001', name: 'Anna Lima' }], speakers: [] }, people).length === 0);
check('an id that no longer resolves suggests nobody, not a namesake', audienceSuggestions({ attendees: [{ ref: 'STK-0001', ref_found: false, name: 'Lee Min' }], speakers: [] }, [person('STK-0002', 'Lee Min')]).length === 0
  && audienceSuggestions({ attendees: [{ ref: 'STK-0009', name: 'Ana Lima' }], speakers: [] }, people).length === 0);
check('only a record with no id falls back to the name', audienceSuggestions({ attendees: [{ ref: null, name: 'Ana Lima' }, { ref: '', name: 'Jon Park' }], speakers: [] }, people).map((s) => s.id).join() === 'STK-0001,STK-0003');
check('two stakeholders with the same name: none', audienceSuggestions({ attendees: [{ ref: null, name: 'Lee Min' }], speakers: [] }, people).length === 0);
check('whitespace aside, the full stored name matches', audienceSuggestions({ attendees: [{ ref: null, name: ' Sato  Kenji (佐藤 健二) ' }], speakers: [] }, people)[0]?.id === 'STK-0002');
check('an unnamed speaker and the user are never suggested', audienceSuggestions({ attendees: [{ ref: 'me', name: 'Ana Lima' }], speakers: [{ label: 'S1', person: null, reason: '', source: '' }] }, people).length === 0);
check('nobody matched: nothing suggested, and the hint says so', !deliverableDraft([weekly], { ...source(null, { attendees: [], speakers: [] }) }).suggested_stakeholders
  && deliverableDraft([weekly], source(null, { attendees: [], speakers: [] })).objective!.endsWith('Choose the output template under Deliverables, and say who it is for under Stakeholders.'));

// ---- Template ------------------------------------------------------------------------------------------------

const pick = (text: string) => templateFor(text, templates)?.id ?? null;
check('a template named in full', pick('Draft the executive document for the steering group') === 'OUT-executive-document');
check('a kind of deliverable is never guessed', pick('Prepare slides for Friday') === null && pick('Prepare a presentation for the board') === null && pick('Make decks') === null && pick('Send the board a deck on the pilot results') === null);
check('the full name still counts', pick('Prepare the meeting brief for Monday') === 'OUT-meeting-brief' && pick('Brief the team on the pilot') === null);
check('a file format is never guessed', pick('Share the results as a PDF') === null);
check('nothing named: none', pick('Follow up with finance on the budget') === null);
check('a kind no template has: none', pick('Send a summary to the team') === null && pick('Write a memo') === null);
check('kinds in passing give none either', pick('Prepare a presentation schedule') === null && pick('Send a deck or a document') === null);
check('two distinct templates named: none, whichever name is longer', pick('Turn the executive document into a meeting brief') === null && pick('Use either the executive document or the meeting brief') === null
  && !deliverableDraft([weekly], source(0, { action_items: [{ description: 'Turn the executive document into a meeting brief', owner: null, due_date: '', task_ref: null }] })).deliverables![0]!.template_ref);
check('a kind merely mentioned is not a request', pick('Book a room for the presentation') === null && pick('Prepare the room for the presentation') === null
  && !deliverableDraft([weekly], source(0, { action_items: [{ description: 'Book a room for the presentation', owner: null, due_date: '', task_ref: null }] })).deliverables![0]!.template_ref);

check('words inside other words do not count', pick('Debrief the decking contractor') === null);
check('the longest name wins when one holds the other', templateFor('Use the Executive deck v2', [...templates, { id: 'OUT-v2', name: 'Executive deck v2', format: 'pptx' }])?.id === 'OUT-v2');
check('a name in another script matches as written', templateFor('週次報告書を作成する', [{ id: 'OUT-ja', name: '週次報告書', format: 'docx' }])?.id === 'OUT-ja');
check('no templates installed: none', templateFor('Prepare the Executive deck', []) === null);
check('a whole-meeting draft never guesses a template from decisions', !deliverableDraft([weekly], source(null, { decisions: ['Make a deck'] })).deliverables![0]!.template_ref);

// ---- The record when the choice is accepted ------------------------------------------------------------------

const detail = (over: Partial<MeetingRecord> | null, correction?: string) => ({
  meeting: { correction: correction ? { state: correction } : null }, record: over === null ? null : { ...record, ...over },
} as unknown as MeetingDetail);
check('a confirmed record whose versions agree can be used', recordProblem(detail({})) === null && recordProblem(detail({}, 'corrected'), 'r1') === null);
check('a correction conflict, or broken versions: no facts copied', recordProblem(detail({}, 'conflict')) === 'versions' && recordProblem(detail({}, 'broken')) === 'versions');
check('rejected or gone since the choice opened', recordProblem(detail({ confirmation: 'rejected' }), 'r1') === 'not_confirmed' && recordProblem(detail(null), 'r1') === 'not_confirmed');
check('a new revision since the choice opened', recordProblem(detail({ revision: 'r2' }), 'r1') === 'changed');

// ---- One action, one task ------------------------------------------------------------------------------------

const meeting = (status: string, state?: string) => ({ update: { status }, correction: state ? { state } : null } as unknown as HistoryMeeting);
check('an action becomes a task once the review is done and versions agree',
  canTaskFromAction(meeting('done'), record) && canTaskFromAction(meeting('done', 'corrected'), record)
  && !canTaskFromAction(meeting('in_review'), record) && !canTaskFromAction(meeting('done', 'conflict'), record)
  && !canTaskFromAction(meeting('done'), { confirmation: 'rejected' }));
const asTask = withMeetingMention(meetingActionDraft({ id: 'CU-2026-0001' }, record, 0, ana), weekly);
check('the action-to-task draft keeps the meeting mention, so its sources are pinned', asTask.objective!.endsWith(`From this meeting:\n\n- ${meetingMention(weekly)}`) && asTask.meeting_action?.item === 0);
check('a mention already there is not added twice', withMeetingMention(asTask, weekly).objective === asTask.objective);
// A plain link in the action text is not a mention the server pins: the mention is still added (the server test saves this text).
const linked = withMeetingMention({ objective: 'Review [Weekly sync](/meetings/MQ-2026-0001)' }, { id: 'MQ-2026-0001', title: 'Weekly sync', date: '2026-10-27' });
check('a plain link is not a mention: the @-mention is added', linked.objective === 'Review [Weekly sync](/meetings/MQ-2026-0001)\n\nFrom this meeting:\n\n- [@Weekly sync · 2026-10-27](/meetings/MQ-2026-0001)', linked.objective);
check('a mention of another meeting does not count', withMeetingMention({ objective: 'See [@Other](/meetings/MQ-2026-0002)' }, weekly).objective!.includes(meetingMention(weekly)));

console.log(failures ? `\n${failures} failed` : '\nAll meeting deliverable tests passed');
process.exit(failures ? 1 : 0);
