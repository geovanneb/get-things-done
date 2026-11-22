import assert from 'node:assert/strict';
import { approveNeedsWholeView, focusIndex, focusScope, meetingReviewHref, openAcrossUpdate, proposalMeetings, proposalsByMeeting } from './meetingFocus';
import type { HeldMeetingView, MeetingRecord } from '@/types';

const meeting = (id: string, record_index: number | null, files: string[] = [], linkable = true): HeldMeetingView => ({ id, title: `Fictional ${id}`, meeting_date: '2026-10-27', record_index, files, linkable });
// A digest of three meetings, in its own order; the third has no certain record.
const held = [
  meeting('MQ-2026-0001', 1, ['MQ-2026-0001-a.vtt', 'MQ-2026-0001-a.transcript.md']),
  meeting('MQ-2026-0002', 0, ['MQ-2026-0002-b.vtt', 'MQ-2026-0002-board.png']),
  meeting('MQ-2026-0010', null, ['MQ-2026-0010-notes.md']),
];
const records = [{ id: 'M-01' }, { id: 'M-02' }];

// The link other pages use, and what a link may ask for.
assert.equal(meetingReviewHref('CU-2026-0004', 'MQ-2026-0002'), '/context/updates/CU-2026-0004?meeting=MQ-2026-0002');
assert.equal(meetingReviewHref('CU-2026-0004', 'CU-2026-0004-M-01'), '/context/updates/CU-2026-0004?meeting=CU-2026-0004-M-01');
assert.equal(focusIndex(held, 'MQ-2026-0002'), 1);
assert.equal(focusIndex(held, ' MQ-2026-0010 '), 2, 'spaces around the id are ignored');
for (const asked of [null, '', 'MQ-2026-9999', 'mq-2026-0002', '<script>', 'MQ-2026-000']) assert.equal(focusIndex(held, asked), null, `${String(asked)} falls back to the whole review`);
assert.equal(focusIndex([], 'MQ-2026-0001'), null, 'an update that holds no meetings');
// A record-only meeting of an import in review: its record id may go to another meeting after a new analysis, so a
// link to it (saved before, or typed) opens the whole review. Once the update is done its id is final.
const provisional = [meeting('CU-2026-0005-M-01', 0, ['notes.md'], false), meeting('CU-2026-0005-M-02', 1, ['notes.md.backup'], false)];
assert.equal(focusIndex(provisional, 'CU-2026-0005-M-01'), null);
assert.equal(focusIndex(provisional.map((m) => ({ ...m, linkable: true })), 'CU-2026-0005-M-01'), 0);

// Meeting 2 of 3, with the way back and forward; none past either end.
assert.deepEqual(focusScope(held, 1), { position: 2, total: 3, previous: held[0], next: held[2] });
assert.deepEqual([focusScope(held, 0).previous, focusScope(held, 2).next], [null, null]);

// What a proposal cites is read from its evidence: the meeting id, one of its files, or its record id.
assert.deepEqual(proposalMeetings({ evidence: 'MQ-2026-0001-a.transcript.md, around 00:14:20' }, held, records), ['MQ-2026-0001']);
assert.deepEqual(proposalMeetings({ evidence: 'Said in MQ-2026-0002 by the owner' }, held, records), ['MQ-2026-0002']);
assert.deepEqual(proposalMeetings({ evidence: 'Record M-01, decisions' }, held, records), ['MQ-2026-0002'], 'M-01 is the record of the second meeting');
assert.deepEqual(proposalMeetings({ evidence: 'm-02 and mq-2026-0010-notes.md' }, held, records), ['MQ-2026-0001', 'MQ-2026-0010'], 'case does not matter');
// Never a name inside a longer one, and nothing from an empty evidence.
assert.deepEqual(proposalMeetings({ evidence: 'MQ-2026-00011 and XM-01 and MQ-2026-0001X' }, held, records), []);
assert.deepEqual(proposalMeetings({ evidence: 'transcript, around 00:10' }, held, records), [], 'a file name shared by no meeting');
assert.deepEqual(proposalMeetings({ evidence: '' }, held, records), []);
// A whole file name only: `notes.md` is not named by `notes.md.backup` or `old-notes.md`, but a sentence may end after it.
const imported = provisional.map((m) => ({ ...m, linkable: true }));
assert.deepEqual(proposalMeetings({ evidence: 'notes.md.backup, page 2' }, imported, records), ['CU-2026-0005-M-02']);
assert.deepEqual(proposalMeetings({ evidence: 'See old-notes.md and notes.mdx' }, imported, records), []);
assert.deepEqual(proposalMeetings({ evidence: 'Stated in notes.md.' }, imported, records), ['CU-2026-0005-M-01']);
assert.deepEqual(proposalMeetings({ evidence: '(notes.md, page 1)' }, imported, records), ['CU-2026-0005-M-01']);
assert.deepEqual(proposalMeetings({ evidence: 'M-01-draft and M-02.5' }, imported, records), [], 'a record id inside a longer name');
// A file name with a space holds a shorter known name: the longest known name wins at each place.
const spaced = [...imported, meeting('CU-2026-0005-M-03', null, ['weekly notes.md'])];
assert.deepEqual(proposalMeetings({ evidence: 'See "weekly notes.md", page 2.' }, spaced, records), ['CU-2026-0005-M-03']);
assert.deepEqual(proposalMeetings({ evidence: 'weekly notes.md, then notes.md' }, spaced, records), ['CU-2026-0005-M-01', 'CU-2026-0005-M-03'], 'both, when each stands on its own');
assert.deepEqual(proposalMeetings({ evidence: 'Some weekly notes.md' }, imported, records), ['CU-2026-0005-M-01'], 'a longer name no meeting has does not hide it');
// A meeting id stays the start of its digest files' names, also a file the digest does not list.
assert.deepEqual(proposalMeetings({ evidence: 'MQ-2026-0002-later.md' }, held, records), ['MQ-2026-0002']);
// A meeting without a certain record is never matched by a record id.
assert.deepEqual(proposalMeetings({ evidence: 'M-03' }, held, [...records, { id: 'M-03' }]), []);

// A proposal drawing on two meetings is under both; one citing none is listed apart.
const proposals = [
  { id: 'P-01', evidence: 'MQ-2026-0001-a.transcript.md 00:02:10; MQ-2026-0002-b.vtt 00:40:00' },
  { id: 'P-02', evidence: 'MQ-2026-0002-board.png' },
  { id: 'P-03', evidence: 'The deck, slide 4' },
];
const links = proposalsByMeeting(proposals, held, records);
assert.deepEqual(Object.fromEntries(links.byMeeting), { 'MQ-2026-0001': ['P-01'], 'MQ-2026-0002': ['P-01', 'P-02'], 'MQ-2026-0010': [] });
assert.deepEqual(links.cited.get('P-01'), ['MQ-2026-0001', 'MQ-2026-0002']);
assert.deepEqual(links.uncited, ['P-03']);

// The counts are for the whole update, whatever meeting is in focus: each proposal and record once.
const rec = (id: string, confirmation: MeetingRecord['confirmation']) => ({ id, confirmation }) as MeetingRecord;
const allRecords = [rec('M-01', 'confirmed'), rec('M-02', null), rec('M-03', 'rejected'), rec('M-04', null)];
const ticked = new Set(['P-01']);
assert.deepEqual(openAcrossUpdate(allRecords, (r) => r.confirmation, proposals, (id) => ticked.has(id)), { recordsOpen: 2, records: 4, selected: 1, proposals: 3 });
// A proposal shown under two meetings is still one proposal; an unsaved click counts as the page shows it.
assert.deepEqual(openAcrossUpdate(allRecords, (r) => (r.id === 'M-02' ? 'confirmed' : r.confirmation), [...proposals, proposals[0]!], (id) => ticked.has(id)), { recordsOpen: 1, records: 4, selected: 1, proposals: 3 });

// Approve at one meeting: what approval would decide out of sight is brought into view first.
const choiceOf = (r: MeetingRecord) => r.confirmation;
const shownHere = new Set(['P-01']);
assert.deepEqual(approveNeedsWholeView(0, allRecords, choiceOf, proposals, shownHere), { records: 2, proposals: 2, first: { record: 1 } }, 'records still without a choice, first M-02');
assert.deepEqual(approveNeedsWholeView(1, allRecords, choiceOf, proposals, shownHere), { records: 1, proposals: 2, first: { record: 3 } }, 'the focused record is on screen already');
assert.deepEqual(approveNeedsWholeView(0, [rec('M-01', null), rec('M-02', 'confirmed')], choiceOf, proposals, shownHere), { records: 0, proposals: 2, first: 'proposals' }, 'only proposals folded away');
assert.equal(approveNeedsWholeView(0, [rec('M-01', null), rec('M-02', 'rejected')], choiceOf, proposals, new Set(['P-01', 'P-02', 'P-03'])), null, 'nothing folded away: approve as before');
assert.deepEqual(approveNeedsWholeView(null, allRecords, choiceOf, [], new Set()), null, 'no certain record: every record is on the page');

console.log('meeting focus: ok');
