import assert from 'node:assert/strict';
import { duration, roundLeft, timeLeft, transcriptionView } from './transcriptionProgress';
import { queueProcessing, type QueueFacts } from './meetingHistory';
import type { QueuedMeeting, TranscriptionProgress } from '@/types';

const start = Date.parse('2026-11-20T10:00:00Z');
const at = (seconds: number) => start + seconds * 1000;
const iso = (seconds: number) => new Date(at(seconds)).toISOString();
/** A fictional job that entered its step `inStep` seconds after it started. */
const job = (extra: Partial<TranscriptionProgress> = {}, inStep = 0): TranscriptionProgress => ({
  meeting: 'MQ-2026-0001', file: 'recording.wav', done: 0, total: 0, started_at: iso(0), phase: 'loading', phase_started_at: iso(inStep), ...extra,
});

// Percent: whole percents, never 100 while it runs; the bar is filled to the same number.
// 1020 s of 3120 done in 510 s of work: 2 s of audio a second, 1050 s left, shown as about 20 min.
const half = transcriptionView(job({ phase: 'transcribing', done: 1020, total: 3120 }), at(510));
assert.equal(half.badge, 'Transcribing 32%');
assert.equal(half.percent, 32);
assert.equal(half.detail, '52 min recording · about 20 min left');
assert.equal(half.line, 'Transcribing: 32% of 52 min · about 20 min left');
assert.equal(half.spoken, 'Transcribing, 32 percent, about 20 minutes left');
// Before a minute of audio is done: just the recording's length.
assert.equal(transcriptionView(job({ phase: 'transcribing', done: 50, total: 3120 }), at(40)).detail, '52 min recording');
assert.equal(transcriptionView(job({ phase: 'transcribing', done: 3119.9, total: 3120 }), at(10)).percent, 99);

// The steps before transcribing: no percent of the audio, the bar only moves, and from a minute on, how long it ran.
const loading = transcriptionView(job(), at(20));
assert.deepEqual([loading.badge, loading.detail, loading.line, loading.percent, loading.phase], ['Transcribing', 'Loading the model', 'Loading the model', null, 'loading']);
assert.equal(transcriptionView(job({ phase: 'converting' }), at(59)).detail, 'Converting the recording');
assert.equal(transcriptionView(job({ phase: 'converting' }), at(150)).detail, 'Converting the recording · 2 min', 'whole minutes spent, never rounded up');
const speakers = transcriptionView(job({ phase: 'speakers' }, 30), at(30 + 200));
assert.deepEqual([speakers.detail, speakers.percent], ['Finding who speaks · 3 min', null]);
assert.equal(speakers.spoken, 'Transcribing, Finding who speaks, 3 minutes');
const counted = transcriptionView(job({ phase: 'speakers', phase_part: 0.405 }), at(10));
assert.deepEqual([counted.detail, counted.percent, counted.badge], ['Finding who speaks 40%', 40, 'Transcribing']);
// Transcribing, but the total is not known yet.
assert.deepEqual(transcriptionView(job({ phase: 'transcribing' }), at(5)).percent, null);
// An older server sends no step: known from the total.
assert.equal(transcriptionView({ meeting: 'm', file: 'f', done: 64, total: 100, started_at: iso(0) }, at(1)).badge, 'Transcribing 64%');
assert.equal(transcriptionView({ meeting: 'm', file: 'f', done: 0, total: 0, started_at: iso(0) }, at(1)).detail, 'Loading the model');

// Another dashboard runs it: the same view, saying so; with nothing known, only that.
const other = transcriptionView(job({ phase: 'transcribing', done: 1020, total: 3120, elsewhere: true }), at(510));
assert.equal(other.detail, '52 min recording · about 20 min left · in another dashboard');
assert.equal(other.spoken, 'Transcribing, 32 percent, about 20 minutes left, in another dashboard');
assert.equal(transcriptionView(job({ elsewhere: true }), at(10)).detail, 'Loading the model · in another dashboard');
const unknown = transcriptionView(null, at(10));
assert.deepEqual([unknown.badge, unknown.detail, unknown.line, unknown.percent, unknown.phase], ['Transcribing', 'In another dashboard', 'Transcribing in another dashboard', null, null]);

// Time left: from the transcribing step's own pace (loading and finding speakers before it do not count), once a minute
// of audio is done; whole minutes up to 10, fives up to an hour, then quarter hours.
assert.deepEqual([roundLeft(10), roundLeft(61), roundLeft(9.5 * 60), roundLeft(12.4 * 60), roundLeft(13 * 60), roundLeft(52 * 60), roundLeft(97 * 60)], [60, 120, 600, 600, 900, 3000, 5400]);
// The step began 300 s into the job; 600 s of 2400 done in 150 s of work: 4 s of audio a second, 450 s left.
const paced = job({ phase: 'transcribing', done: 600, total: 2400 }, 300);
assert.equal(timeLeft(paced, at(450)), 480, 'from the step, not the job: 8 min, rounded up');
assert.equal(transcriptionView(paced, at(450)).detail, '40 min recording · about 8 min left');
assert.equal(transcriptionView(paced, at(450)).line, 'Transcribing: 25% of 40 min · about 8 min left');
assert.equal(transcriptionView(paced, at(450)).spoken, 'Transcribing, 25 percent, about 8 minutes left');
// Stability: the pace wobbling a little between updates does not move the estimate.
const long = (done: number, spent: number) => timeLeft(job({ phase: 'transcribing', done, total: 7200 }, 0), at(spent));
const estimates = new Set([long(1800, 1100), long(1830, 1110), long(1860, 1120), long(1880, 1150)].map((s) => s && s / 60));
assert.deepEqual([...estimates], [55], 'one estimate across updates');
// Unknown pace: nothing is guessed.
assert.equal(timeLeft(job({ phase: 'transcribing', done: 59, total: 3120 }), at(30)), null, 'under a minute of audio done');
assert.equal(timeLeft(job({ phase: 'transcribing', done: 600, total: 3120 }, 100), at(100)), null, 'no time spent yet');
assert.equal(timeLeft(job({ phase: 'transcribing', done: 600, total: 3120, phase_started_at: 'not a time' }), at(100)), null);
assert.equal(timeLeft(job({ phase: 'loading', done: 600, total: 3120 }), at(100)), null, 'only the transcribing step has a pace');

assert.deepEqual([duration(0.4), duration(45), duration(52 * 60), duration(65 * 60)], ['a moment', '45 s', '52 min', '1 h 05 min']);

// The Meetings row: the badge, the detail line, the bar and what a screen reader hears, from the same view.
const meeting = { id: 'MQ-2026-0001', title: 'Fictional sync', meeting_date: '2026-11-20', status: 'queued', created_at: '', files: [{ name: 'recording.wav', size: 1, sha256: 'a', capture: 'c', recording: { status: 'running' } }], held: null, in_digest: false } as unknown as QueuedMeeting;
const facts: QueueFacts = { installed: ['base'], runnable: {}, progress: paced, nextDigest: null, recordingNow: () => false, now: at(450) };
assert.deepEqual(queueProcessing(meeting, facts), {
  label: 'Transcribing 25%', tone: 'info', detail: '40 min recording · about 8 min left',
  progress: { percent: 25, spoken: 'Transcribing, 25 percent, about 8 minutes left' },
});
assert.deepEqual(queueProcessing(meeting, { ...facts, progress: { ...paced, file: 'another.wav' } }).progress, { percent: null, spoken: 'Transcribing in another dashboard' }, 'progress of another recording is not this one\'s');

console.log('transcriptionProgress tests passed');
