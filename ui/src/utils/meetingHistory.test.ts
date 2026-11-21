import assert from 'node:assert/strict';
import { filterFromQuery, groupRows, historyReview, inFilter, matchingRows, meetingCounts, meetingRows, queueProcessing, whenLabel, type QueueFacts } from './meetingHistory';
import { setCurrentLanguage } from '@/i18n/current';
import { recheckIn, recordingElsewhere } from './meetingQueue';
import { translator } from '../../../server/src/i18n/messages';
import { en } from '../../../server/src/i18n/en';
import type { HistoryMeeting, QueuedMeeting } from '@/types';

const queued = (id: string, date: string, extra: Partial<QueuedMeeting> = {}) =>
  ({ id, title: `Fictional ${id}`, meeting_date: date, status: 'queued', created_at: `${date}T00:00:00.000Z`, files: [], held: null, in_digest: false, ...extra }) as QueuedMeeting;
const recording = (status: string, extra: Record<string, unknown> = {}) => [{ name: 'recording-20261031-1000.wav', size: 1, sha256: 'a', capture: 'c', recording: { status, ...extra } }] as QueuedMeeting['files'];
const held = (id: string, date: string, extra: Partial<HistoryMeeting> = {}, update: Partial<HistoryMeeting['update']> = {}): HistoryMeeting => ({
  id, linkable: true, review_state: 'final', record_state: 'none', update_id: 'CU-2026-0003', origin: 'digest', title: `Fictional ${id}`, meeting_date: date, people: ['Jane Doe'], recorded: true,
  update: { id: 'CU-2026-0003', title: 'Meeting digest', status: 'done', created_at: '', analyzed_at: null, applied_at: null, context_changed: false, ...update },
  record: null, unlinked_records: 0, kept: false, deleted: null, retention_start: date, has_text: true, ...extra,
});
const facts: QueueFacts = { installed: ['base'], runnable: {}, progress: null, nextDigest: 'Mon 18:00', recordingNow: (m) => m.id === 'live' };

// Processing, in the user's words.
assert.equal(queueProcessing(queued('live', '2026-10-31', { live: { generation: 'g', state: 'recording', started_at: '', saved_bytes: 0, last_block_at: null } }), facts).label, 'Recording');
assert.equal(queueProcessing(queued('cut', '2026-10-31', { live: { generation: 'g', state: 'recording', started_at: '', saved_bytes: 0, last_block_at: null } }), facts).detail, 'Recording interrupted');
assert.deepEqual(queueProcessing(queued('p', '2026-10-31', { files: recording('partial') }), facts), { label: 'Needs you', tone: 'warning', detail: 'Partial transcript' });
assert.equal(queueProcessing(queued('p', '2026-10-31', { files: recording('partial', { accepted: true }) }), facts).label, 'Waiting for digest', 'a partial transcript used as it is');
assert.equal(queueProcessing(queued('m', '2026-10-31', { files: recording('pending', { target: { model: 'large', language: 'en' } }) }), facts).detail, 'Waits for a model to download');
assert.equal(queueProcessing(queued('r', '2026-10-31', { files: recording('running') }), { ...facts, progress: { meeting: 'r', file: 'recording-20261031-1000.wav', done: 64, total: 100 } as QueueFacts['progress'] }).label, 'Transcribing 64%');
assert.deepEqual(queueProcessing(queued('q', '2026-10-31'), facts), { label: 'Waiting for digest', tone: 'accent', detail: 'Next digest Mon 18:00' });

// Review says how far the user got; "no context changes" is never "in context".
assert.equal(historyReview(held('a', '2026-10-27', {}, { status: 'analyzing' })).label, 'Waiting for analysis');
assert.deepEqual(historyReview(held('a', '2026-10-27', { record: { id: 'M-01', revision: 'r1', confirmation: null, confirmed_at: null, link: 'explicit' } }, { status: 'in_review' })), { label: 'Waiting for review', tone: 'warning', detail: 'Record to confirm' });
assert.deepEqual(historyReview(held('a', '2026-10-27', { record: { id: 'M-01', revision: 'r1', confirmation: 'confirmed', confirmed_at: '', link: 'explicit' } })), { label: 'Record confirmed', tone: 'success', detail: 'No context changes' });
assert.equal(historyReview(held('a', '2026-10-27', {}, { context_changed: true })).detail, 'Context updated');

// One list: the queue's copy wins while a meeting is being handed over; deleted text is listed apart.
const rows = meetingRows(
  [queued('MQ-2026-0009', '2026-10-31', { files: recording('partial') }), queued('MQ-2026-0008', '2026-10-30')],
  [held('MQ-2026-0008', '2026-10-30'), held('MQ-2026-0007', '2026-10-27'), held('CU-2026-0001-M-01', '2026-10-14', { origin: 'update', has_text: false }),
    held('MQ-2026-0005', '2026-10-20', { deleted: { at: '', by: 'user', in_trash: true }, has_text: false })],
  facts,
);
assert.deepEqual(rows.map((r) => r.id), ['MQ-2026-0009', 'MQ-2026-0008', 'MQ-2026-0007', 'MQ-2026-0005', 'CU-2026-0001-M-01']);
assert.ok(rows[1]!.queued, 'the queue shows a meeting it still holds');
assert.deepEqual([rows[4]!.textGone, rows[4]!.source], [true, 'Imported as an update']);
assert.deepEqual(rows.filter((r) => inFilter(r, 'all')).map((r) => r.id), ['MQ-2026-0009', 'MQ-2026-0008', 'MQ-2026-0007', 'CU-2026-0001-M-01'], 'the trash is apart');
assert.deepEqual(rows.filter((r) => inFilter(r, 'you')).map((r) => r.id), ['MQ-2026-0009']);
assert.deepEqual(rows.filter((r) => inFilter(r, 'progress')).map((r) => r.id), ['MQ-2026-0008']);
assert.deepEqual(rows.filter((r) => inFilter(r, 'reviewed')).map((r) => r.id), ['MQ-2026-0007', 'CU-2026-0001-M-01']);
assert.deepEqual([rows[2]!.href, rows[4]!.href], ['/meetings/MQ-2026-0007', '/meetings/CU-2026-0001-M-01'], 'a meeting with a final id opens its own dialog');
// A record id can change until its update is done: the row opens the update instead, and its id is not searchable.
const pending = meetingRows([], [held('CU-2026-0002-M-01', '2026-10-28', { origin: 'update', linkable: false, review_state: 'provisional', title: 'Steering call' }, { id: 'CU-2026-0002', status: 'in_review' })], facts);
assert.equal(pending[0]!.href, '/context/updates/CU-2026-0003');
assert.deepEqual(matchingRows(pending, 'M-01'), [], 'no link to a record id that may still change');
assert.deepEqual(matchingRows(rows, 'jane 2026-10-27').map((r) => r.id), ['MQ-2026-0007'], 'every word, from title, date or people');
assert.deepEqual(matchingRows(rows, 'warehouse lease', new Set(['MQ-2026-0007'])).map((r) => r.id), ['MQ-2026-0007'], 'or found by what was said in it');
assert.deepEqual(matchingRows(rows, '', new Set(['MQ-2026-0007'])).length, rows.length, 'no query, every row');

// Grouped by when they took place.
const now = new Date(2026, 9, 31, 15, 0);
assert.deepEqual(groupRows(rows, now).map((g) => [g.label, g.rows.length]), [['Today', 1], ['Yesterday', 1], ['This week', 1], ['October 2026', 2]]);
assert.equal(whenLabel(rows[2]!, now), 'Oct 27');
// Every way the processing column says "Needs you" is a meeting needsYou() counts, so a row needs the user by that rule
// alone, also in a language where the label is not "Needs you".
const liveAt = (state: 'recording' | 'damaged') => ({ live: { generation: 'g', state, started_at: '', saved_bytes: 0, last_block_at: null } });
const needing: QueuedMeeting[] = [
  queued('cut', '2026-10-31', liveAt('recording')),
  queued('damaged', '2026-10-31', liveAt('damaged')),
  queued('held', '2026-10-31', { held: 'Waiting for a missing file' }),
  queued('model', '2026-10-31', { files: recording('pending', { target: { model: 'large', language: 'en' } }) }),
  queued('failed', '2026-10-31', { files: recording('failed') }),
  queued('stopped', '2026-10-31', { files: recording('stopped') }),
  queued('partial', '2026-10-31', { files: recording('partial') }),
];
for (const m of needing) assert.equal(queueProcessing(m, facts).label, 'Needs you', m.id);
const moving: QueuedMeeting[] = [
  queued('running', '2026-10-31', { files: recording('running') }),
  queued('pending', '2026-10-31', { files: recording('pending', { target: { model: 'base', language: 'en' } }) }),
  queued('digest', '2026-10-31'),
  queued('handed', '2026-10-31', { in_digest: true }),
  queued('accepted', '2026-10-31', { files: recording('partial', { accepted: true }) }),
];
assert.deepEqual(meetingCounts([...needing, ...moving], facts), { needsYou: needing.length, inProgress: moving.length });
// The label in another language: the row still needs the user.
setCurrentLanguage(translator({ ...en, 'meetingHistory.needsYou': '対応が必要' }, 'ja'), 'ja');
try {
  const translated = meetingRows(needing, [], facts);
  assert.ok(translated.every((r) => r.processing.label !== 'Needs you' && r.needsYou), 'needs the user in another language too');
  assert.deepEqual(meetingCounts(needing, facts), { needsYou: needing.length, inProgress: 0 });
} finally { setCurrentLanguage(translator(en), 'en'); }

// The sidebar counts are the page's tabs: the same rows, the same filters. Held meetings and the trash are never counted.
const tabs = (r: ReturnType<typeof meetingRows>) => ({ needsYou: r.filter((x) => inFilter(x, 'you')).length, inProgress: r.filter((x) => inFilter(x, 'progress')).length });
const queue = [queued('MQ-2026-0009', '2026-10-31', { files: recording('partial') }), queued('MQ-2026-0008', '2026-10-30')];
assert.deepEqual(meetingCounts(queue, facts), tabs(rows));
assert.deepEqual(meetingCounts(queue, facts), { needsYou: 1, inProgress: 1 });
assert.deepEqual(meetingCounts([], { ...facts, installed: null }), { needsYou: 0, inProgress: 0 });
// Models not known yet: a recording waiting for a model is in progress, as on the page, until they are.
assert.deepEqual(meetingCounts([needing[3]!], { ...facts, installed: null }), { needsYou: 0, inProgress: 1 });
// A model the recording asks for under another name: the one that runs it counts.
assert.deepEqual(meetingCounts([needing[3]!], { ...facts, installed: ['large-v3'], runnable: { large: 'large-v3' } }), { needsYou: 0, inProgress: 1 });

// A link opens the list on a filter: the sidebar's Needs you item asks for ?show=you.
assert.equal(filterFromQuery('you'), 'you');
assert.equal(filterFromQuery('progress'), 'progress');
for (const bad of [null, '', 'You', 'trash', 'constructor', 'toString']) assert.equal(filterFromQuery(bad), 'all', String(bad));

// A meeting being recorded right now is in progress, on the page and in the sidebar; interrupted or unreadable, it needs you.
const recordingNow = queued('live', '2026-10-31', liveAt('recording'));
const [nowRow] = meetingRows([recordingNow], [], facts);
assert.deepEqual([nowRow!.processing.label, nowRow!.needsYou, inFilter(nowRow!, 'you'), inFilter(nowRow!, 'progress')], ['Recording', false, false, true]);
assert.deepEqual(meetingCounts([recordingNow], facts), { needsYou: 0, inProgress: 1 }, 'recording now');
assert.deepEqual(meetingCounts([needing[0]!], facts), { needsYou: 1, inProgress: 0 }, 'interrupted');
assert.deepEqual(meetingCounts([needing[1]!], facts), { needsYou: 1, inProgress: 0 }, 'damaged');
// Recorded in another page: the rule MeetingsList and the sidebar pass decides, the same for both.
const elsewhere = { ...facts, recordingNow: () => true };
assert.deepEqual(meetingCounts([recordingNow, needing[2]!], elsewhere), { needsYou: 1, inProgress: 1 }, 'only the live meeting is excused, not one on hold');

// The sidebar judges a recording in another page at the moment it read the queue. Timeline: a block at 0 s, the timer
// asks again at 30.1 s, and a block arrived at 30 s: still in progress. Only fresh data can say the audio stopped.
const block = (seconds: number) => queued('call', '2026-10-31', { live: { generation: 'g', state: 'recording', started_at: '', saved_bytes: 0, last_block_at: new Date(t0 + seconds * 1000).toISOString() } });
const t0 = Date.parse('2026-10-31T10:00:00.000Z');
const sidebar = (q: QueuedMeeting[], readAt: number) => meetingCounts(q, { ...facts, recordingNow: (m) => recordingElsewhere(m, readAt) });
assert.deepEqual(sidebar([block(0)], t0), { needsYou: 0, inProgress: 1 }, 'read at 0 s');
assert.equal(recheckIn([block(0)], t0), 30_100, 'asks again at 30.1 s');
assert.deepEqual(sidebar([block(30)], t0 + 30_100), { needsYou: 0, inProgress: 1 }, 'a block arriving at 30 s keeps it in progress');
assert.deepEqual(sidebar([block(0)], t0 + 30_100), { needsYou: 1, inProgress: 0 }, 'no block since 0 s: interrupted');
console.log('meeting history: ok');
