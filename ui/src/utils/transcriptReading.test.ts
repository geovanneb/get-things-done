import assert from 'node:assert/strict';
import { readableTranscript, transcriptOnItsWay, transcriptParts } from './transcriptReading';
import type { QueuedMeeting } from '@/types';

const meeting = (files: QueuedMeeting['files']) => ({ id: 'MQ-2026-0001', files }) as QueuedMeeting;
const draft = { transcript: 'live.transcript.md', transcript_sha256: 'a', model: 'fast', language: 'auto', seconds: 1 };

assert.deepEqual(readableTranscript(meeting([{ name: 'a.wav', recording: { status: 'running', draft } }] as unknown as QueuedMeeting['files'])), { name: 'live.transcript.md', final: false, file: 'a.wav', sha256: 'a', names: [] }, 'the live text while the accurate one is made');
assert.deepEqual(readableTranscript(meeting([{ name: 'a.wav', recording: { status: 'done', transcript: 'a.transcript.md', transcript_sha256: 'b', draft } }] as unknown as QueuedMeeting['files'])), { name: 'a.transcript.md', final: true, file: 'a.wav', sha256: 'b', names: [] }, 'the final one first');
const named = { transcript_sha256: 'b', names: [{ label: 'Speaker 1', name: 'Kim Park' }] };
assert.deepEqual(readableTranscript(meeting([{ name: 'a.wav', recording: { status: 'done', transcript: 'a.md', transcript_sha256: 'b', speaker_names: named } }] as unknown as QueuedMeeting['files']))?.names, named.names);
assert.deepEqual(readableTranscript(meeting([{ name: 'a.wav', recording: { status: 'done', transcript: 'a.md', transcript_sha256: 'c', speaker_names: named } }] as unknown as QueuedMeeting['files']))?.names, [], 'names of an earlier transcript do not count');
assert.equal(readableTranscript(meeting([{ name: 'a.wav', recording: { status: 'pending' } }] as unknown as QueuedMeeting['files'])), null);
assert.equal(readableTranscript(meeting([{ name: 'notes.txt' }] as unknown as QueuedMeeting['files'])), null);
assert.deepEqual(readableTranscript(meeting([
  { name: 'a.wav', recording: { status: 'done', transcript: 'a.md', transcript_sha256: 'a' } },
  { name: 'b.wav', recording: { status: 'done', transcript: 'b.md', transcript_sha256: 'b' } },
] as unknown as QueuedMeeting['files']), 'b.wav')?.name, 'b.md', 'the recording asked for');

assert.equal(transcriptOnItsWay(meeting([{ name: 'a.wav', recording: { status: 'running' } }] as unknown as QueuedMeeting['files'])), true);
assert.equal(transcriptOnItsWay(meeting([{ name: 'a.wav', recording: { status: 'done' } }] as unknown as QueuedMeeting['files'])), false);

const file = [
  '# Transcript: a.wav', '', 'Made on this computer.', '', '```text',
  '[00:00:01 → 00:00:04]', '  Fictional words.', '', '[01:02:03 → 01:02:09]', '  [ten past] in brackets', '```', '',
].join('\n');
assert.deepEqual(transcriptParts(file), [{ time: '00:00:01', text: 'Fictional words.' }, { time: '01:02:03', text: '[ten past] in brackets' }]);
assert.deepEqual(transcriptParts('# Transcript\n\n```text\n\n```\n'), [], 'a transcript with no speech');
assert.deepEqual(transcriptParts('```text\n[00:00:01 → 00:00:04] Speaker 2\n  Fictional words.\n```\n'), [{ time: '00:00:01', speaker: 'Speaker 2', text: 'Fictional words.' }]);
assert.equal(transcriptParts('```text\n[00:00:01 → 00:00:04] Speaker two\n  Fictional.\n```\n'), null, 'anything else after the time is not ours');
assert.equal(transcriptParts('nothing here'), null, 'not a transcript: never reported as no speech');
assert.equal(transcriptParts('```text\nsome other format\n```\n'), null);
assert.equal(transcriptParts('```text\n[00:00:01 → 00:00:02]\n  no end'), null);
assert.deepEqual(transcriptParts('````text\n[08:00:00 → 08:00:02]\n  has ``` inside\n````\n'), [{ time: '08:00:00', text: 'has ``` inside' }], 'a longer fence around backticks');
console.log('transcript reading: ok');
