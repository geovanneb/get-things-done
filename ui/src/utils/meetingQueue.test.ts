import assert from 'node:assert/strict';
import { matching, meetingPeriod, newestFirst, visibleMeetings } from './meetingQueue';
import type { QueuedMeeting } from '@/types';

const meeting = (id: string, date: string, extra: Partial<QueuedMeeting> = {}) =>
  ({ id, title: `Fictional ${id}`, meeting_date: date, created_at: `${date}T00:00:00.000Z`, files: [], ...extra }) as QueuedMeeting;
const recorded = (name: string, seconds?: number, status = 'done', capture = 'c') => [{ name, size: 1, sha256: 'a', ...(capture ? { capture } : {}), recording: { status, ...(seconds ? { seconds } : {}) } }] as QueuedMeeting['files'];

assert.equal(meetingPeriod(meeting('a', '2026-10-31', { files: recorded('recording-20261031-1458.wav', 170) })), '14:58–15:01');
assert.equal(meetingPeriod(meeting('a', '2026-10-31', { files: recorded('recording-20261031-2350-2.wav', 1800) })), '23:50–00:20', 'past midnight');
assert.equal(meetingPeriod(meeting('a', '2026-10-31', { files: recorded('recording-20261031-0905.wav') })), '09:05', 'length not known yet');
assert.equal(meetingPeriod(meeting('a', '2026-10-31', { files: recorded('recording-20261031-1458.wav', 60, 'done', '') })), null, 'an upload named like a recording');
assert.equal(meetingPeriod(meeting('a', '2026-10-31', { files: recorded('recording-20261031-9966-notes.txt', 60) })), null);
assert.equal(meetingPeriod(meeting('a', '2026-10-31', { files: recorded('recording-20261031-2575.wav', 60) })), null, 'no such time');
assert.equal(meetingPeriod(meeting('a', '2026-10-31', { files: recorded('recording-20261030-1000.wav', 60) })), null, 'recorded on another day than the meeting');

const list = [
  meeting('old', '2026-10-29'),
  meeting('morning', '2026-10-31', { files: recorded('recording-20261031-0900.wav', 600) }),
  meeting('afternoon', '2026-10-31', { files: recorded('recording-20261031-1500.wav', 600) }),
  meeting('early', '2026-10-31', { files: recorded('recording-20261031-1500.wav', 6000) }),
];
assert.deepEqual(newestFirst(list).map((m) => m.id).slice(0, 2).sort(), ['afternoon', 'early'], 'the same start: the length does not decide');
assert.deepEqual(newestFirst(list).map((m) => m.id).slice(2), ['morning', 'old']);

// What needs the user is shown however old; the rest five at a time.
const many = [
  ...Array.from({ length: 7 }, (_, i) => meeting(`ready${i}`, `2026-10-2${i}`)),
  meeting('failed', '2026-09-01', { files: recorded('recording-20260901-1000.wav', 60, 'failed') }),
  meeting('held', '2026-09-02', { held: 'Its digest was removed' }),
  meeting('open', '2026-08-01', { live: { generation: 'g', state: 'recording', started_at: '', saved_bytes: 0, last_block_at: null } }),
];
const { shown, hidden } = visibleMeetings(many, '', false);
assert.deepEqual(shown.slice(0, 3).map((m) => m.id).sort(), ['failed', 'held', 'open']);
assert.equal(shown.length, 8);
assert.equal(hidden, 2);
assert.equal(visibleMeetings(many, '', true).shown.length, 10);
const waiting = [...Array.from({ length: 6 }, (_, i) => meeting(`new${i}`, `2026-10-2${i}`)),
  meeting('blocked', '2026-01-01', { files: [{ name: 'a.wav', size: 1, sha256: 'a', recording: { status: 'pending', target: { model: 'whisper-large-v3', language: 'auto' } } }] as unknown as QueuedMeeting['files'] })];
assert.ok(visibleMeetings(waiting, '', false, ['sensevoice-2024-07-17']).shown.some((m) => m.id === 'blocked'), 'waiting for a model that is not downloaded');
assert.ok(!visibleMeetings(waiting, '', false, ['whisper-large-v3']).shown.some((m) => m.id === 'blocked'), 'just waiting its turn');
assert.deepEqual(visibleMeetings(many, 'fictional ready1', false).shown.map((m) => m.id), ['ready1']);

const people = [meeting('kim', '2026-10-30', { title: 'Budget review', participants: [{ name: 'Kim Park' }] }), meeting('x', '2026-10-30', { title: 'Standup' })];
assert.deepEqual(matching(people, 'kim').map((m) => m.id), ['kim']);
assert.deepEqual(matching(people, 'BUDGET park').map((m) => m.id), ['kim'], 'every word, any order, any case');
assert.deepEqual(matching(people, '2026-10-30').length, 2);
assert.deepEqual(matching(people, '  ').length, 2);
console.log('meeting queue: ok');
