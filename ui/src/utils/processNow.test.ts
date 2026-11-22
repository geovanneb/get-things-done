/**
 * Unit tests for "Process this meeting now" (#487): when it is offered, and what its confirmation says.
 * Run with `npm run test:process-now --workspace=ui`.
 */
import { processNowConfirmation, processNowOutcome, processNowRequest, processNowState, type ProcessNowJob } from './processNow';
import type { QueuedMeeting } from '@/types';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
}

const meeting = (over: Partial<QueuedMeeting> = {}): QueuedMeeting => ({
  id: 'MQ-2026-0001', title: 'Weekly sync', meeting_date: '2026-10-27', status: 'queued', created_at: '', updated_at: '', queued_at: '2026-10-27T10:00:00.000Z',
  files: [{ name: 'notes.md', size: 10, sha256: 'a'.repeat(64) }], held: null, in_digest: false, ...over,
});
const job = (over: Partial<ProcessNowJob> = {}, auto_analyze = false, enabled = true): ProcessNowJob => ({ open_digest: null, queue: [], workspace: '/tmp/fictional-workspace', settings: { auto_analyze, enabled }, ...over });
const recording = (status: 'pending' | 'running' | 'done' | 'partial' | 'failed' | 'stopped', accepted = false) => ({ name: 'r.wav', size: 1, sha256: 'b'.repeat(64), recording: { status, ...(accepted ? { accepted } : {}) } });

const ready = processNowState(meeting(), job());
check('a queued, transcribed meeting with no digest open is ready', ready.kind === 'ready' && ready.analysis === 'manual');
const auto = processNowState(meeting(), job({}, true));
check('it carries what the analysis does: on', auto.kind === 'ready' && auto.analysis === 'auto');
const paused = processNowState(meeting(), job({}, true, false));
check('it carries what the analysis does: on, routine paused', paused.kind === 'ready' && paused.analysis === 'auto_paused');

const open = processNowState(meeting(), job({ open_digest: 'CU-2026-0012' }));
check('an open digest blocks it, naming the update to review', open.kind === 'blocked' && open.block === 'open_digest' && open.open_digest === 'CU-2026-0012' && /Waiting for CU-2026-0012 to be reviewed/.test(open.reason), JSON.stringify(open));

const other = meeting({ id: 'MQ-2026-0002', in_digest: true });
const busy = processNowState(meeting(), job({ queue: [other] }));
check('another meeting going into a digest right now blocks it', busy.kind === 'blocked' && busy.block === 'digest_busy');

const state = (m: QueuedMeeting) => { const s = processNowState(m, job({ open_digest: 'CU-2026-0012' })); return s.kind === 'blocked' ? s.block : 'ready'; };
check('its own state comes first: going into a digest', state(meeting({ in_digest: true })) === 'in_digest');
check('a draft is not ready', state(meeting({ status: 'draft' })) === 'draft');
check('a meeting being recorded is not ready', state(meeting({ live: { generation: 'g', state: 'recording', started_at: '', saved_bytes: 0, last_block_at: null } })) === 'draft');
check('on hold is not ready', state(meeting({ held: 'Its digest was removed.' })) === 'held');
for (const s of ['pending', 'running', 'failed', 'stopped', 'partial'] as const) {
  check(`a recording ${s} waits for its transcript`, state(meeting({ files: [recording(s)] })) === 'transcript');
}
const withTranscript = (status: 'done' | 'partial', accepted = false, sha = 'c'.repeat(64)) => [
  { name: 'r.wav', size: 1, sha256: 'b'.repeat(64), recording: { status, ...(accepted ? { accepted } : {}), transcript: 'r.transcript.md', transcript_sha256: 'c'.repeat(64) } },
  { name: 'r.transcript.md', size: 1, sha256: sha },
];
check('a done or accepted partial transcript is ready (then the open digest blocks it)', state(meeting({ files: withTranscript('done') })) === 'open_digest' && state(meeting({ files: withTranscript('partial', true) })) === 'open_digest');
check('a recording marked done without its transcript is not ready, as the server says', state(meeting({ files: [recording('done')] })) === 'transcript_missing');
check('a transcript whose hash differs is not ready either', state(meeting({ files: withTranscript('done', false, 'd'.repeat(64)) })) === 'transcript_missing');
const missing = processNowState(meeting({ files: [recording('done')] }), job());
check('it says why', missing.kind === 'blocked' && /transcript is missing/.test(missing.reason), JSON.stringify(missing));

const on = processNowConfirmation(meeting(), 'auto');
check('confirmation, analysis on: tries to start it with the assistant, and costs a little more', on.lines.some((l) => /tries to start the analysis with your AI assistant/.test(l)) && on.lines.some((l) => /more AI usage than a batch/.test(l)) && /Weekly sync/.test(on.title), JSON.stringify(on));
const off = processNowConfirmation(meeting(), 'manual');
check('confirmation, analysis off: the user starts it from the update', off.lines.some((l) => /start the analysis from the update/.test(l)) && !off.lines.some((l) => /tries to start/.test(l)), JSON.stringify(off));

const pausedText = processNowConfirmation(meeting(), 'auto_paused');
check('confirmation, analysis on but paused: never promises it starts after the other run', pausedText.lines.some((l) => /routine is paused/.test(l) && /start it from the update/.test(l)) && !pausedText.lines.some((l) => /starts after it/.test(l)), JSON.stringify(pausedText));

const request = processNowRequest(meeting(), job(), 'auto_paused');
check('the request is bound to the workspace shown (body and header) and to what the confirmation said',
  request.workspace === '/tmp/fictional-workspace' && request.body.workspace === '/tmp/fictional-workspace' && request.body.meeting === 'MQ-2026-0001' && request.body.expect_analysis === 'auto_paused', JSON.stringify(request));

const outcome = (analysis?: 'started' | 'waiting' | 'paused_waiting' | 'not_started', status: 'ok' | 'error' = 'ok') => processNowOutcome({ status, message: 'server says', context_update: 'CU-2026-0013', ...(analysis ? { analysis } : {}) }, 'Weekly sync');
check('toast: made, no analysis', outcome().tone === 'success' && /Made CU-2026-0013 from Weekly sync\.$/.test(outcome().text));
check('toast: analysis started', /analysis started/.test(outcome('started').text));
check('toast: waits for the run going now', /starts after the run going now/.test(outcome('waiting').text));
check('toast: paused and busy: the user must act', outcome('paused_waiting').tone === 'warning' && /start it from the update when that run ends, or resume the routine/.test(outcome('paused_waiting').text));
check('toast: could not start: the server says why', outcome('not_started', 'error').tone === 'warning' && outcome('not_started', 'error').text === 'server says');
check('toast: nothing made is an error', processNowOutcome({ status: 'error', message: 'failed' }, 'x').tone === 'error');

if (failures) { console.error(`${failures} failed`); process.exit(1); }
console.log('All process-now checks passed.');
