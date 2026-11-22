/**
 * Unit tests for a meeting's Next step (#483): one test per state of the issue's table, and the rules around it.
 * Run with `npm run test:meeting-next-step --workspace=ui`.
 */
import assert from 'node:assert/strict';
import { digestPlace, meetingNextStep, tasksFromMeeting, type DigestFacts, type NextStepFacts } from './meetingNextStep';
import { queueProcessing } from './meetingHistory';
import { missingModel, needsYou } from './meetingQueue';
import type { HistoryMeeting, QueuedMeeting, TranscriptionProgress } from '@/types';

const FILE = 'recording-20261031-1000.wav';
const queued = (extra: Partial<QueuedMeeting> = {}) =>
  ({ id: 'MQ-2026-0009', title: 'Fictional sync', meeting_date: '2026-10-31', status: 'queued', created_at: '2026-10-31T00:00:00.000Z', files: [], held: null, in_digest: false, ...extra }) as QueuedMeeting;
const recording = (status: string, extra: Record<string, unknown> = {}) => [{ name: FILE, size: 1, sha256: 'a', capture: 'c', recording: { status, ...extra } }] as QueuedMeeting['files'];
const held = (status: HistoryMeeting['update']['status'], extra: Partial<HistoryMeeting> = {}): HistoryMeeting => ({
  id: 'MQ-2026-0007', linkable: true, review_state: 'final', record_state: 'linked', update_id: 'CU-2026-0003', origin: 'digest', title: 'Fictional review', meeting_date: '2026-10-27', people: ['Jane Doe'], recorded: true,
  update: { id: 'CU-2026-0003', title: 'Meeting digest', status, created_at: '', analyzed_at: null, applied_at: null, context_changed: false },
  record: null, unlinked_records: 0, kept: false, deleted: null, retention_start: '2026-10-27', has_text: true, ...extra,
});
const digest = (extra: Partial<DigestFacts> = {}, settings: Partial<DigestFacts['settings']> = {}): DigestFacts =>
  ({ open_digest: null, analyze_open_digest: 'no', ...extra, settings: { enabled: true, auto_analyze: false, after_each_meeting: false, max_meetings: 10, ...settings } });
const facts = (extra: Partial<NextStepFacts> = {}): NextStepFacts =>
  ({ installed: ['base'], runnable: {}, progress: null, nextDigest: 'Mon 18:00', recordingNow: () => false, digest: digest(), queue: [], ...extra });
const step = (m: QueuedMeeting, f = facts()) => meetingNextStep({ queued: m }, { ...f, queue: f.queue.length ? f.queue : [m] });
const heldStep = (h: HistoryMeeting, d = digest()) => meetingNextStep({ held: h }, facts({ digest: d }));
const kinds = (s: ReturnType<typeof step>) => s.actions.map((a) => a.kind).join(',');

// Transcribing: the progress, in the list's own wording (#480), with its bar; nothing to click.
{
  const progress = { meeting: 'MQ-2026-0009', file: FILE, done: 64, total: 100 } as TranscriptionProgress;
  const s = step(queued({ files: recording('running') }), facts({ progress }));
  assert.equal(s.code, 'transcribing');
  assert.equal(s.text, 'Transcribing 64%');
  assert.equal(s.progress?.percent, 64);
  assert.equal(kinds(s), '');
}

// Waiting for a model that is not downloaded: Download it in Settings, at the Transcription section.
{
  const s = step(queued({ files: recording('pending', { target: { model: 'large', language: 'en' } }) }));
  assert.equal(s.code, 'download_model');
  assert.deepEqual(s.actions, [{ kind: 'link', to: '/settings#transcription', label: 'Download it in Settings' }]);
  // A model that runs as a downloaded one is not missing.
  assert.equal(step(queued({ files: recording('pending', { target: { model: 'large-gpu', language: 'en' } }) }), facts({ runnable: { 'large-gpu': 'base' } })).code, 'waiting_transcription');
}

// Transcription failed, stopped or partial: the existing Retry, or Use this transcript, for that recording.
{
  const failed = step(queued({ files: recording('failed', { error: 'engine crashed' }) }));
  assert.equal(failed.code, 'transcription_failed');
  assert.equal(failed.detail, 'engine crashed');
  assert.deepEqual(failed.actions, [{ kind: 'retry', file: FILE, label: 'Try again' }]);
  const stopped = step(queued({ files: recording('stopped') }));
  assert.equal(stopped.code, 'transcription_stopped');
  assert.equal(kinds(stopped), 'retry');
  const partial = step(queued({ files: recording('partial') }));
  assert.equal(partial.code, 'partial_transcript');
  assert.equal(kinds(partial), 'accept,retry');
  assert.equal(partial.actions[0]!.label, 'Use this transcript');
  // A partial transcript used as it is waits for the digest like any other.
  assert.equal(step(queued({ files: recording('partial', { accepted: true }) })).code, 'make_digest');
}

// Waiting for the digest, none open: Make digest now, or when the schedule runs.
{
  const s = step(queued({ files: recording('done') }));
  assert.equal(s.code, 'make_digest');
  // Its recording names no transcript, so Process this meeting now is not offered (see below).
  assert.equal(kinds(s), 'make_digest');
  assert.equal(s.actions[0]!.label, 'Make digest now');
  assert.equal(s.detail, 'Or wait for the next digest, Mon 18:00.');
  assert.match(step(queued(), facts({ digest: digest({}, { after_each_meeting: true }) })).detail ?? '', /right after each meeting/);
  assert.match(step(queued(), facts({ nextDigest: null, digest: digest({}, { enabled: false }) })).detail ?? '', /paused/);
}

// Process this meeting now (#487) next to Make digest now, only while #487's own rule says it can run.
{
  const ready = queued({ files: [
    { name: FILE, size: 1, sha256: 'a', capture: 'c', recording: { status: 'done', transcript: 't.md', transcript_sha256: 'h' } },
    { name: 't.md', size: 1, sha256: 'h' },
  ] as QueuedMeeting['files'] });
  const s = step(ready);
  assert.equal(s.code, 'make_digest');
  assert.deepEqual(s.actions[1], { kind: 'process_now', label: 'Process this meeting now' });
  // Paused, or with automatic analysis: still offered; its own confirmation says what happens to the analysis.
  assert.equal(kinds(step(ready, facts({ digest: digest({}, { enabled: false, auto_analyze: true }) }))), 'make_digest,process_now');
  // Another meeting going into a digest right now: a digest is being made, so it is not offered.
  const other = queued({ id: 'MQ-2026-0001', in_digest: true });
  assert.equal(kinds(step(ready, facts({ queue: [other, ready] }))), 'make_digest');
  // A transcript counted as done but missing from the meeting's files: not offered.
  const missing = queued({ files: recording('done', { transcript: 'gone.md', transcript_sha256: 'h' }) });
  assert.equal(kinds(step(missing)), 'make_digest');
  // An open digest blocks it: the step says so once, with Open it, and offers no Process button.
  const blocked = step(ready, facts({ digest: digest({ open_digest: 'CU-2026-0004' }) }));
  assert.equal(blocked.code, 'blocked_by_digest');
  assert.equal(kinds(blocked), 'link');
  // Not ready yet (on hold, transcribing): never offered.
  assert.ok(!kinds(step(queued({ held: 'Files changed' }))).includes('process_now'));
  assert.ok(!kinds(step(queued({ files: recording('running') }))).includes('process_now'));
}

// Blocked by an open digest: "Waiting for CU-… to be reviewed", with Open it.
{
  const s = step(queued(), facts({ digest: digest({ open_digest: 'CU-2026-0004' }) }));
  assert.equal(s.code, 'blocked_by_digest');
  assert.equal(s.text, 'Waiting for CU-2026-0004 to be reviewed');
  assert.deepEqual(s.actions, [{ kind: 'link', to: '/context/updates/CU-2026-0004', label: 'Open it' }]);
}

// In a digest to analyze: Open its update, saying whether automatic analysis will start it.
{
  const manual = heldStep(held('ready'));
  assert.equal(manual.code, 'analyze');
  assert.deepEqual(manual.actions, [{ kind: 'link', to: '/context/updates/CU-2026-0003?meeting=MQ-2026-0007', label: 'Open its update' }]);
  assert.match(manual.detail ?? '', /only starts when you click/);
  const auto = heldStep(held('ready'), digest({ open_digest: 'CU-2026-0003', analyze_open_digest: 'yes' }, { auto_analyze: true }));
  assert.match(auto.detail ?? '', /starts it by itself/);
  assert.equal(kinds(auto), 'link', 'still a click to open it, never a run from here');
  assert.doesNotMatch(auto.detail ?? '', /within a minute/, 'never promises a start time: the runner may be busy');
  assert.match(heldStep(held('ready'), digest({ open_digest: 'CU-2026-0003', analyze_open_digest: 'yes' }, { auto_analyze: true, enabled: false })).detail ?? '', /once the meeting digest is resumed/);
  assert.match(heldStep(held('ready'), digest({ open_digest: 'CU-2026-0003', analyze_open_digest: 'maybe' }, { auto_analyze: true })).detail ?? '', /may start it/);
  // Automatic analysis off, refused before, or another update: the user starts it.
  assert.match(heldStep(held('ready'), digest({ open_digest: 'CU-2026-0003', analyze_open_digest: 'yes' })).detail ?? '', /only starts when you click/);
  assert.match(heldStep(held('ready'), digest({ open_digest: 'CU-2026-0003', analyze_open_digest: 'no' }, { auto_analyze: true })).detail ?? '', /only starts when you click/);
  assert.match(heldStep(held('ready'), digest({ open_digest: 'CU-2026-0099', analyze_open_digest: 'yes' }, { auto_analyze: true })).detail ?? '', /only starts when you click/);
  assert.equal(heldStep(held('analyzing')).code, 'analyzing');
}

// In review or approved: Review this meeting / Apply, opening the update's review at this meeting (#488).
{
  const review = heldStep(held('in_review', { record: { id: 'M-01', revision: 'r1', confirmation: null, confirmed_at: null, link: 'explicit' } }));
  assert.equal(review.code, 'review');
  assert.deepEqual(review.actions, [{ kind: 'link', to: '/context/updates/CU-2026-0003?meeting=MQ-2026-0007', label: 'Review this meeting' }]);
  assert.match(review.detail ?? '', /Confirm or reject/);
  const apply = heldStep(held('approved'));
  assert.equal(apply.code, 'apply');
  assert.deepEqual(apply.actions, [{ kind: 'link', to: '/context/updates/CU-2026-0003?meeting=MQ-2026-0007', label: 'Apply' }]);
  assert.equal(heldStep(held('applying')).code, 'applying');
  assert.deepEqual(heldStep(held('applying')).actions, [{ kind: 'link', to: '/context/updates/CU-2026-0003?meeting=MQ-2026-0007', label: 'Open its update' }]);
  assert.deepEqual(heldStep(held('analyzing')).actions, [{ kind: 'link', to: '/context/updates/CU-2026-0003?meeting=MQ-2026-0007', label: 'Open its update' }]);
}

// A meeting whose id is not final yet (an imported record in review) keeps the whole-update link, by #488's own rule.
{
  for (const status of ['ready', 'analyzing', 'in_review', 'approved', 'applying'] as const) {
    const s = heldStep(held(status, { id: 'M-01', linkable: false, origin: 'update' }));
    assert.deepEqual(s.actions.map((a) => a.kind === 'link' ? a.to : a.kind), ['/context/updates/CU-2026-0003'], status);
  }
  // The meeting id goes into the link encoded.
  const odd = heldStep(held('in_review', { id: 'MQ 2026&7' }));
  assert.deepEqual(odd.actions.map((a) => a.kind === 'link' ? a.to : a.kind), ['/context/updates/CU-2026-0003?meeting=MQ+2026%267']);
}

// Reviewed: Create deliverable as the step itself, never offered twice.
{
  const s = heldStep(held('done', { record: { id: 'M-01', revision: 'r1', confirmation: 'confirmed', confirmed_at: '', link: 'explicit' } }));
  assert.equal(s.code, 'deliverable');
  assert.equal(kinds(s), 'deliverable');
  assert.equal(s.deliverable, false);
  assert.equal(heldStep(held('done', { deleted: { at: '', by: 'user', in_trash: true } })).code, 'in_trash');
  assert.equal(heldStep(held('done', { deleted: { at: '', by: 'user', in_trash: true } })).deliverable, false);
  // A record-only meeting whose id is not final yet cannot be linked to.
  const unlinkable = heldStep(held('done', { linkable: false }));
  assert.equal(unlinkable.code, 'reviewed');
  assert.equal(kinds(unlinkable), '');
}

// Create deliverable is offered wherever the list's eligibility check permits, also on queued meetings.
{
  assert.equal(step(queued({ files: recording('running') })).deliverable, true, 'a queued meeting, while it is transcribed');
  assert.equal(step(queued()).deliverable, true);
  assert.equal(step(queued({ in_digest: true })).deliverable, false, 'not while a digest takes it');
  assert.equal(step(queued({ status: 'draft' })).deliverable, false);
  assert.equal(heldStep(held('in_review')).deliverable, true, 'a held meeting with its own id, before its review is done');
  assert.equal(heldStep(held('in_review', { linkable: false })).deliverable, false);
}

// The states before the table: recording, interrupted, uploading, going into a digest, on hold, waiting its turn.
{
  const live = { generation: 'g', state: 'recording' as const, started_at: '', saved_bytes: 0, last_block_at: null };
  assert.equal(step(queued({ live }), facts({ recordingNow: () => true })).code, 'recording');
  const cut = step(queued({ live }));
  assert.equal(cut.code, 'finish_recording');
  assert.equal(kinds(cut), 'files');
  assert.equal(step(queued({ status: 'draft' })).code, 'uploading');
  assert.equal(step(queued({ in_digest: true })).code, 'going_into_digest');
  const hold = step(queued({ held: 'Its digest was deleted' }));
  assert.equal(hold.code, 'on_hold');
  assert.equal(kinds(hold), 'queue_again');
  assert.equal(hold.detail, 'Its digest was deleted');
  const waiting = queued({ files: recording('pending') });
  const other = queued({ id: 'MQ-2026-0008', files: recording('running', { generation: 'g1' }) });
  const w = step(waiting, facts({ queue: [other, waiting] }));
  assert.equal(w.code, 'waiting_transcription');
  assert.match(w.detail ?? '', /Transcribe next/, 'points to the ⋯ menu that can move it forward');
}

// Opening the meeting starts nothing: every action is something to click, and none is a run.
{
  const all = [
    step(queued({ files: recording('failed') })), step(queued()), heldStep(held('ready'), digest({ open_digest: 'CU-2026-0003', analyze_open_digest: 'yes' }, { auto_analyze: true })),
    heldStep(held('in_review')), heldStep(held('approved')), heldStep(held('done')),
  ];
  for (const s of all) for (const a of s.actions) assert.ok(['link', 'files', 'retry', 'accept', 'queue_again', 'make_digest', 'process_now', 'deliverable'].includes(a.kind));
}

// The tasks already made: from the record's action items (also archived or gone), and active tasks that mention it.
{
  const record = { action_items: [
    { description: 'Send the deck', owner: null, due_date: '', task_ref: 'TASK-2026-0002', task_found: true },
    { description: 'Book the room', owner: null, due_date: '', task_ref: 'TASK-2026-0001', task_found: false },
    { description: 'Nothing yet', owner: null, due_date: '', task_ref: null },
  ] };
  const tasks = [
    { id: 'TASK-2026-0002', title: 'Send the deck', body: '' },
    { id: 'TASK-2026-0003', title: 'Deliverable from Fictional review', body: 'Make a deliverable from this meeting:\n\n- [@Fictional review · 2026-10-27](/meetings/MQ-2026-0007)' },
    { id: 'TASK-2026-0004', title: 'Plain link only', body: 'See [Fictional review](/meetings/MQ-2026-0007)' },
    { id: 'TASK-2026-0005', title: 'Another meeting', body: '[@Other](/meetings/MQ-2026-0070)' },
    { id: 'TASK-2026-0006', title: 'Also mentions', body: '[@Again](/meetings/MQ-2026-0007) and the action TASK-2026-0002' },
  ];
  assert.deepEqual(tasksFromMeeting('MQ-2026-0007', record, tasks), [
    { id: 'TASK-2026-0002', title: 'Send the deck', gone: false, via: 'action' },
    { id: 'TASK-2026-0001', title: null, gone: true, via: 'action' },
    { id: 'TASK-2026-0003', title: 'Deliverable from Fictional review', gone: false, via: 'mention' },
    { id: 'TASK-2026-0006', title: 'Also mentions', gone: false, via: 'mention' },
  ]);
  assert.deepEqual(tasksFromMeeting('MQ-2026-0009', null, tasks), []);
}

// Review finding 1: an upload has no target of its own; the worker uses the model chosen in Settings, so a fresh
// installation without it says Download it in Settings, in the list badge and the Needs you count too.
{
  const upload = queued({ files: recording('pending') });
  const fresh = facts({ installed: [], chosen: 'whisper-turbo' });
  assert.equal(step(upload, fresh).code, 'download_model');
  assert.equal(queueProcessing(upload, fresh).detail, 'Waits for a model to download', 'the list badge agrees');
  assert.equal(needsYou(upload, [], {}, 'whisper-turbo'), true, 'and so does Needs you');
  assert.equal(missingModel({ status: 'pending' }, ['whisper-turbo'], {}, 'whisper-turbo'), null, 'downloaded: it just waits its turn');
  assert.equal(missingModel({ status: 'pending' }, ['cpu'], { 'gpu-model': 'cpu' }, 'gpu-model'), null, 'the chosen model runs as a downloaded one');
  assert.equal(missingModel({ status: 'pending' }, [], {}, null), null, 'the chosen model is not known: nothing is claimed');
  assert.equal(missingModel({ status: 'pending', target: { model: 'large', language: 'en' } }, ['whisper-turbo'], {}, 'whisper-turbo'), 'large', 'a target of its own wins over Settings');
  assert.equal(step(upload, facts({ installed: ['whisper-turbo'], chosen: 'whisper-turbo' })).code, 'waiting_transcription');
}

// Review finding 3: with automatic analysis on, Make digest now also starts the analysis, and the step says so.
{
  assert.doesNotMatch(step(queued()).detail ?? '', /assistant/);
  assert.match(step(queued(), facts({ digest: digest({}, { auto_analyze: true }) })).detail ?? '', /also tries to start the new digest's analysis with your AI assistant/);
  assert.match(step(queued(), facts({ nextDigest: null, digest: digest({}, { auto_analyze: true, enabled: false }) })).detail ?? '', /tries to start/, 'even while the schedule is paused');
}

// Review finding 4: a busy runner: the recorded attempt waited, so it says it is checked again, not that it starts now.
{
  const waiting = heldStep(held('ready'), digest({ open_digest: 'CU-2026-0003', analyze_open_digest: 'yes', analysis: { update_id: 'CU-2026-0003', status: 'waiting' } }, { auto_analyze: true }));
  assert.match(waiting.detail ?? '', /waits for another run of your assistant to end/);
  assert.match(waiting.detail ?? '', /checked again/);
  // A wait recorded for another digest says nothing about this one.
  const other = heldStep(held('ready'), digest({ open_digest: 'CU-2026-0003', analyze_open_digest: 'yes', analysis: { update_id: 'CU-2026-0001', status: 'waiting' } }, { auto_analyze: true }));
  assert.match(other.detail ?? '', /starts it by itself/);
}

// Review finding 5: only action items are "made from" the meeting; a mention is listed apart as a mention.
{
  const made = tasksFromMeeting('MQ-2026-0007', null, [{ id: 'TASK-2026-0009', title: 'Older task, mentions it as background', body: 'See [@Fictional review](/meetings/MQ-2026-0007)' }]);
  assert.deepEqual(made.map((t) => t.via), ['mention']);
}

// Review finding 6: with an open digest and a batch limit, only a meeting the next digest takes is told it goes in.
{
  const older = queued({ id: 'MQ-2026-0010', meeting_date: '2026-10-29', queued_at: '2026-10-29T10:00:00.000Z', files: recording('done') });
  const newer = queued({ id: 'MQ-2026-0011', meeting_date: '2026-10-30', queued_at: '2026-10-30T10:00:00.000Z', files: recording('done') });
  const one = facts({ queue: [newer, older], digest: digest({ open_digest: 'CU-2026-0004' }, { max_meetings: 1 }) });
  assert.equal(digestPlace(newer, one.queue), 2);
  assert.match(step(older, one).detail ?? '', /most likely goes into the next one/);
  const later = step(newer, one);
  assert.equal(later.code, 'blocked_by_digest');
  assert.doesNotMatch(later.detail ?? '', /goes into the next one\./);
  assert.match(later.detail ?? '', /#2 in line.*at most 1 meetings: it likely waits for a later digest, unless meetings before it are skipped/);
  const roomy = step(newer, { ...one, digest: digest({ open_digest: 'CU-2026-0004' }, { max_meetings: 10 }) });
  assert.match(roomy.detail ?? '', /#2 in line: it goes into the next one if the meetings before it leave room/);
  // A meeting still waiting for its transcript does not count ahead of it; one on hold neither.
  const transcribing = queued({ id: 'MQ-2026-0009', meeting_date: '2026-10-28', files: recording('pending') });
  const onHold = queued({ id: 'MQ-2026-0008', meeting_date: '2026-10-27', held: 'Its digest was deleted' });
  assert.equal(digestPlace(older, [transcribing, onHold, older, newer]), 1);
  // No digest open: Make digest now takes the oldest; a meeting past the limit is told it waits for a later one.
  assert.match(step(newer, facts({ queue: [newer, older], digest: digest({}, { max_meetings: 1 }) })).detail ?? '', /later digest/);
}

// Review finding 7: already first in line, Transcribe next is not offered, so it is not pointed to.
{
  const running = queued({ id: 'MQ-2026-0008', files: recording('running', { generation: 'g1' }) });
  const first = queued({ files: recording('pending'), transcribe_first_at: '2026-10-31T10:00:00.000Z' });
  const s = step(first, facts({ queue: [running, first] }));
  assert.equal(s.text, 'Next', 'the list badge: Next');
  assert.doesNotMatch(s.detail ?? '', /Transcribe next/);
  assert.match(s.detail ?? '', /starts when the transcription running now ends/);
  // Idle: nothing runs, so it does not speak of a running transcription; the badge Next says it.
  const idle = step(first, facts({ queue: [first] }));
  assert.equal(idle.text, 'Next');
  assert.equal(idle.detail, undefined);
}

// Review finding 8: a recording whose record cannot be read: said as the list says it, and only Files (Remove) offered.
{
  const damaged = queued({ live: { generation: 'g', state: 'damaged', started_at: '', saved_bytes: 0, last_block_at: null } });
  const s = step(damaged);
  assert.equal(s.code, 'recording_damaged');
  assert.match(s.text, /cannot be read/);
  assert.doesNotMatch(s.text, /finish it/i);
  assert.equal(kinds(s), 'files');
  assert.equal(queueProcessing(damaged, facts()).detail, 'Recording cannot be read', 'the list says the same');
}

console.log('meetingNextStep: all tests passed');
