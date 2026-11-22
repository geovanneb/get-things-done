import { tr } from '@/i18n/current';
import type { HistoryMeeting, MeetingRecord, QueuedMeeting, Task } from '@/types';
import { canMakeDeliverable, mentionsMeeting } from './meetingDeliverable';
import { queueProcessing, reviewHref, transcribeChoices, transcribeLine, type QueueFacts } from './meetingHistory';
import { missingModel } from './meetingQueue';
import { processNowState } from './processNow';

/**
 * The one thing to do next on a meeting (#483), shown at the top of its dialog. Worked out only from what the page
 * already reads (the queue, the meeting history and the Meeting digest's settings), so every state's wording can be
 * tested without a page. It never starts anything: each action is a click the user makes.
 */

export type NextStepCode =
  | 'recording' | 'finish_recording' | 'recording_damaged' | 'uploading' | 'going_into_digest' | 'on_hold'
  | 'download_model' | 'transcription_failed' | 'transcription_stopped' | 'partial_transcript'
  | 'transcribing' | 'waiting_transcription' | 'make_digest' | 'blocked_by_digest'
  | 'analyze' | 'analyzing' | 'review' | 'apply' | 'applying' | 'deliverable' | 'in_trash' | 'reviewed';

export type NextStepAction =
  /** Opens a page of the dashboard. */
  | { kind: 'link'; to: string; label: string }
  /** Shows the meeting's Files tab, where the full set of actions for its files is. */
  | { kind: 'files'; label: string }
  | { kind: 'retry'; file: string; label: string }
  | { kind: 'accept'; file: string; label: string }
  | { kind: 'queue_again'; label: string }
  | { kind: 'make_digest'; label: string }
  /** Process this meeting now (#487): a digest of this meeting alone, after its own confirmation. Offered only when it can run. */
  | { kind: 'process_now'; label: string }
  | { kind: 'deliverable'; label: string };

export interface NextStep {
  code: NextStepCode;
  /** What to do now, or what the app is doing, in the user's words. */
  text: string;
  detail?: string;
  tone: 'info' | 'warning' | 'success' | 'muted';
  /** The main action first. Empty when there is nothing to do but wait. */
  actions: NextStepAction[];
  /** A running transcription's bar, as in the Meetings list. */
  progress?: { percent: number | null; spoken: string };
  /** Whether Create deliverable is offered too (the list's own eligibility check), next to the main action. */
  deliverable: boolean;
}

/** What the page knows of the Meeting digest, from GET /api/routines/meeting-digest. */
export interface DigestFacts {
  open_digest: string | null;
  analyze_open_digest: 'yes' | 'no' | 'maybe';
  settings: { enabled: boolean; auto_analyze: boolean; after_each_meeting: boolean; max_meetings: number };
  /** The last automatic analysis attempt the digest recorded (`state.analysis`): `waiting` while another run held the runner. */
  analysis?: { update_id: string; status: 'started' | 'waiting' | 'not_started' } | null;
}

export interface NextStepFacts extends QueueFacts {
  digest: DigestFacts;
  /** The queue, for the meeting's place in line and for Transcribe next. */
  queue: QueuedMeeting[];
}

export type NextStepMeeting = { queued: QueuedMeeting; held?: undefined } | { held: HistoryMeeting; queued?: undefined };

const update = (id: string) => `/context/updates/${id}`;
const open = (id: string, label: string): NextStepAction => ({ kind: 'link', to: update(id), label });
/** The meeting's own update, opened at this meeting when its id is final, else the whole update (#488's rule). */
const openAt = (h: HistoryMeeting, label: string): NextStepAction => ({ kind: 'link', to: reviewHref(h), label });

/** The next step for a meeting in the queue, or one held by a context update. */
export function meetingNextStep(meeting: NextStepMeeting, facts: NextStepFacts): NextStep {
  if (meeting.queued) {
    const m = meeting.queued;
    return { ...queuedStep(m, facts), deliverable: canMakeDeliverable({ inTrash: false, queued: m }) };
  }
  const h = meeting.held;
  const step = heldStep(h, facts.digest);
  const inTrash = Boolean(h.deleted?.in_trash);
  return { ...step, deliverable: step.code !== 'deliverable' && canMakeDeliverable({ inTrash, held: h }) };
}

type Step = Omit<NextStep, 'deliverable'>;

function queuedStep(m: QueuedMeeting, facts: NextStepFacts): Step {
  if (m.live) {
    if (facts.recordingNow(m)) return { code: 'recording', text: tr('meetingNextStep.recording'), tone: 'info', actions: [] };
    // As the list says: a recording whose record cannot be read cannot be finished; it can only be removed (in Files).
    if (m.live.state === 'damaged') return { code: 'recording_damaged', text: tr('meetingNextStep.recordingDamaged'), tone: 'warning', actions: [{ kind: 'files', label: tr('meetingNextStep.openFiles') }] };
    return { code: 'finish_recording', text: tr('meetingNextStep.finishRecording'), tone: 'warning', actions: [{ kind: 'files', label: tr('meetingNextStep.openFiles') }] };
  }
  if (m.status === 'draft') return { code: 'uploading', text: tr('meetingNextStep.uploading'), tone: 'warning', actions: [{ kind: 'files', label: tr('meetingNextStep.openFiles') }] };
  if (m.in_digest) return { code: 'going_into_digest', text: tr('meetingNextStep.goingIntoDigest'), tone: 'info', actions: [] };
  if (m.held) return { code: 'on_hold', text: tr('meetingNextStep.onHold'), detail: m.held, tone: 'warning', actions: [{ kind: 'queue_again', label: tr('queuedMeetingActions.queueAgain') }] };
  // The same order as the list's status (queueProcessing): the first recording that needs the user decides.
  for (const f of m.files) {
    const r = f.recording;
    if (!r) continue;
    // The model the worker will use: the recording's own target, or the one chosen in Settings for an upload.
    if (missingModel(r, facts.installed, facts.runnable, facts.chosen ?? null)) {
      return { code: 'download_model', text: tr('meetingNextStep.downloadModel'), tone: 'warning', actions: [{ kind: 'link', to: '/settings#transcription', label: tr('meetingNextStep.downloadInSettings') }] };
    }
    if (r.status === 'failed') {
      return { code: 'transcription_failed', text: tr('meetingNextStep.transcriptionFailed'), ...(r.error ? { detail: r.error } : {}), tone: 'warning', actions: [{ kind: 'retry', file: f.name, label: tr('retry') }] };
    }
    if (r.status === 'stopped') return { code: 'transcription_stopped', text: tr('meetingNextStep.transcriptionStopped'), tone: 'warning', actions: [{ kind: 'retry', file: f.name, label: tr('retry') }] };
    if (r.status === 'partial' && !r.accepted) {
      return { code: 'partial_transcript', text: tr('meetingNextStep.partialTranscript'), tone: 'warning',
        actions: [{ kind: 'accept', file: f.name, label: tr('queuedMeetingActions.useThisTranscript') }, { kind: 'retry', file: f.name, label: tr('retry') }] };
    }
  }
  const line = facts.line ?? transcribeLine(facts.queue);
  const processing = queueProcessing(m, { ...facts, line });
  if (m.files.some((f) => f.recording?.status === 'running')) {
    // The list's own wording, step and time left (#480).
    return { code: 'transcribing', text: processing.label, ...(processing.detail ? { detail: processing.detail } : {}), tone: 'info', actions: [], ...(processing.progress ? { progress: processing.progress } : {}) };
  }
  if (m.files.some((f) => f.recording?.status === 'pending')) {
    const choices = transcribeChoices(m, facts.queue, facts.progress);
    // Transcribe next only while it is offered: a meeting already first in line starts when the running one ends.
    const first = line[0] === m.id;
    // "Starts when the running one ends" only while one runs; idle, the list's Next says it all.
    const detail = choices.next ? tr('meetingNextStep.transcribeNextHint') : first && choices.now ? tr('meetingNextStep.nextInLineDetail') : undefined;
    return { code: 'waiting_transcription', text: processing.label, ...(detail ? { detail } : {}), tone: 'info', actions: [] };
  }
  const digest = facts.digest;
  if (digest.open_digest) {
    return { code: 'blocked_by_digest', text: tr('meetingNextStep.blockedByDigest', { id: digest.open_digest }), detail: placeInDigests(m, facts.queue, digest.settings.max_meetings), tone: 'info', actions: [open(digest.open_digest, tr('meetingNextStep.openIt'))] };
  }
  const s = digest.settings;
  const place = digestPlace(m, facts.queue);
  const when = !s.enabled ? tr('meetingNextStep.digestPaused')
    : s.after_each_meeting ? tr('meetingNextStep.digestWithinAMinute')
      : facts.nextDigest ? tr('meetingNextStep.orNextDigest', { when: facts.nextDigest }) : null;
  const detail = [
    place > 1 ? placeInDigests(m, facts.queue, s.max_meetings, false) : null,
    when,
    // Make digest now is a click of the user's own: with automatic analysis on, the server analyzes the new digest
    // straight away, even while the schedule is paused.
    s.auto_analyze ? tr('meetingNextStep.makeDigestAnalyzes') : null,
  ].filter(Boolean).join(' ');
  // Process this meeting now, next to Make digest now, by #487's own rule (it also checks what Make digest now does not:
  // a digest being made, a transcript gone missing). The workspace is only for its request, which its button builds.
  const now = processNowState(m, { open_digest: digest.open_digest, queue: facts.queue, workspace: '', settings: s });
  const actions: NextStepAction[] = [{ kind: 'make_digest', label: tr('meetingDigest.makeDigestNow') }];
  if (now.kind === 'ready') actions.push({ kind: 'process_now', label: tr('processNow.action') });
  return { code: 'make_digest', text: tr('meetingNextStep.makeDigest'), ...(detail ? { detail } : {}), tone: 'info', actions };
}

/** Ready for a digest as the server reads it (`readyForDigest`): queued, not on hold, every recording transcribed. */
const readyForDigest = (m: QueuedMeeting) => m.status === 'queued' && !m.held && !m.in_digest
  && m.files.every((f) => !f.recording || f.recording.status === 'done' || (f.recording.status === 'partial' && f.recording.accepted === true));

/**
 * The meeting's place among those a digest can take, in the server's order (meeting date, then when it was queued, then
 * id): 1 goes first. 0 when it is not ready for a digest.
 */
export function digestPlace(m: QueuedMeeting, queue: QueuedMeeting[]): number {
  const ready = queue.filter(readyForDigest)
    .sort((a, b) => a.meeting_date.localeCompare(b.meeting_date) || (a.queued_at ?? a.created_at).localeCompare(b.queued_at ?? b.created_at) || a.id.localeCompare(b.id));
  return ready.findIndex((q) => q.id === m.id) + 1;
}

/**
 * Which digest the meeting likely goes into, as far as the page can tell. A digest takes the oldest meetings first, up
 * to its number of meetings and of characters (the text sizes are not known here), and always at least one; a meeting
 * whose files changed since it was queued is skipped without counting. So it is never a promise.
 */
function placeInDigests(m: QueuedMeeting, queue: QueuedMeeting[], max: number, blocked = true): string {
  const place = digestPlace(m, queue);
  if (place <= 1) return tr('meetingNextStep.blockedByDigestDetail');
  if (place > max) return tr('meetingNextStep.laterDigest', { place, max });
  return blocked ? tr('meetingNextStep.nextDigestIfRoom', { place }) : tr('meetingNextStep.digestIfRoom', { place });
}

/** Whether automatic analysis will start this update's analysis, in words; null when it will not (the user starts it). */
function autoAnalysis(updateId: string, digest: DigestFacts): string | null {
  if (!digest.settings.auto_analyze || digest.open_digest !== updateId) return null;
  if (digest.analyze_open_digest === 'yes') {
    if (!digest.settings.enabled) return tr('meetingNextStep.autoAnalysisResumed');
    // Tried already, while another run held the runner: it is checked again and starts once the assistant is free.
    const waiting = digest.analysis?.update_id === updateId && digest.analysis.status === 'waiting';
    return waiting ? tr('meetingNextStep.autoAnalysisWaiting') : tr('meetingNextStep.autoAnalysisNext');
  }
  if (digest.analyze_open_digest === 'maybe') return tr('meetingNextStep.autoAnalysisMaybe');
  return null;
}

function heldStep(h: HistoryMeeting, digest: DigestFacts): Step {
  const id = h.update_id;
  switch (h.update.status) {
    case 'ready': {
      const auto = autoAnalysis(id, digest);
      return { code: 'analyze', text: auto ? tr('meetingNextStep.analysisStartsByItself', { id }) : tr('meetingNextStep.analyze', { id }),
        detail: auto ?? tr('meetingNextStep.analyzeDetail'), tone: 'info', actions: [openAt(h, tr('meetingNextStep.openItsUpdate'))] };
    }
    case 'analyzing':
      return { code: 'analyzing', text: tr('meetingNextStep.analyzing', { id }), tone: 'info', actions: [openAt(h, tr('meetingNextStep.openItsUpdate'))] };
    case 'in_review': {
      const toConfirm = h.record && h.record.confirmation === null;
      return { code: 'review', text: tr('meetingNextStep.review', { id }), ...(toConfirm ? { detail: tr('meetingNextStep.reviewDetail') } : {}), tone: 'warning',
        actions: [openAt(h, tr('meetingNextStep.reviewThisMeeting'))] };
    }
    case 'approved':
      return { code: 'apply', text: tr('meetingNextStep.apply', { id }), tone: 'warning', actions: [openAt(h, tr('meetingNextStep.applyIt'))] };
    case 'applying':
      return { code: 'applying', text: tr('meetingNextStep.applying', { id }), tone: 'info', actions: [openAt(h, tr('meetingNextStep.openItsUpdate'))] };
    default:
      break;
  }
  if (h.deleted?.in_trash) return { code: 'in_trash', text: tr('meetingNextStep.inTrash'), tone: 'muted', actions: [] };
  if (canMakeDeliverable({ inTrash: false, held: h })) {
    const rejected = h.record?.confirmation === 'rejected';
    return { code: 'deliverable', text: rejected ? tr('meetingNextStep.deliverableRejected') : tr('meetingNextStep.deliverable'), tone: 'success', actions: [{ kind: 'deliverable', label: tr('meetingsList.createDeliverable') }] };
  }
  return { code: 'reviewed', text: tr('meetingNextStep.reviewed'), tone: 'muted', actions: [] };
}

export interface MeetingTask {
  id: string; title: string | null; gone: boolean;
  /** `action`: made from one of the record's action items (it says so itself, active or archived). `mention`: an active
   * task whose Objective mentions the meeting; Create deliverable writes such a mention, but so can anyone, so it is
   * not proof the task was made from it. */
  via: 'action' | 'mention';
}

/**
 * The tasks that use a meeting: those made from its record's action items (active or archived, from the record), then
 * the active tasks whose Objective mentions it. Each once, in that order.
 */
export function tasksFromMeeting(meetingId: string, record: Pick<MeetingRecord, 'action_items'> | null, tasks: Pick<Task, 'id' | 'title' | 'body'>[]): MeetingTask[] {
  const found: MeetingTask[] = [];
  const add = (id: string, gone: boolean, via: MeetingTask['via']) => {
    if (found.some((t) => t.id === id)) return;
    found.push({ id, title: tasks.find((t) => t.id === id)?.title ?? null, gone, via });
  };
  for (const a of record?.action_items ?? []) if (a.task_ref) add(a.task_ref, a.task_found === false, 'action');
  for (const t of tasks) if (mentionsMeeting(t.body ?? '', meetingId)) add(t.id, false, 'mention');
  return found;
}
