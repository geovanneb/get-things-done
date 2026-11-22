import { currentLocale, tr } from '@/i18n/current';
import type { HistoryMeeting, MeetingFolder, QueuedMeeting, TranscriptionProgress } from '@/types';
import { meetingPeriod, missingModel, needsYou } from '@/utils/meetingQueue';
import { transcriptionView } from '@/utils/transcriptionProgress';
import { meetingReviewHref } from '@/utils/meetingFocus';

/**
 * The Meetings list: queued meetings and meetings held by a context update, as one list. Each row says two separate
 * things: how far the app got with it (processing), and how far the user got with it (review). "Reviewed with no
 * context changes" is never shown as "in context".
 */

export type StatusTone = 'critical' | 'info' | 'warning' | 'accent' | 'muted' | 'success';
export interface RowStatus { label: string; tone: StatusTone | null; detail?: string; update?: string;
  /** Where `update` opens: its review at this meeting. */
  href?: string;
  /** A way to the meeting's review, at this meeting (`?meeting=`). */
  link?: { label: string; href: string };
  /** A running transcription's bar (percent null: not known yet) and what a screen reader says of the status. */
  progress?: { percent: number | null; spoken: string } }

export interface MeetingRow {
  id: string;
  /** Where the row opens: the meeting's own dialog, or its update while a record-only meeting's id is not final. */
  href: string;
  title: string;
  /** YYYY-MM-DD */
  date: string;
  /** `14:58–15:01` for a recording made here, when known. */
  time: string | null;
  people: string[];
  source: string;
  processing: RowStatus;
  review: RowStatus;
  needsYou: boolean;
  /** Its transcript is gone: removed with its update before meetings were kept, or deleted for good. */
  textGone: boolean;
  /** Its text is in the trash: listed apart, with restore. */
  inTrash: boolean;
  queued?: QueuedMeeting;
  held?: HistoryMeeting;
}

export interface QueueFacts {
  installed: string[] | null;
  runnable: Record<string, string>;
  /** The model chosen in Settings now: what a recording without a target of its own is transcribed with. */
  chosen?: string | null;
  progress: TranscriptionProgress | null;
  /** When the next digest runs, as shown ("Mon 18:00"); null when it waits for something else. */
  nextDigest: string | null;
  /** The meeting is being recorded now, here or in another page. */
  recordingNow: (m: QueuedMeeting) => boolean;
  /** Now, in ms, for how long a transcription step has run and the time left; the current time when absent. */
  now?: number;
  /** Meetings moved to the front for transcription, next first (`transcribeLine`); worked out from the queue when absent. */
  line?: string[];
}

const waitsForTurn = (m: QueuedMeeting) => m.status === 'queued' && !m.held && !m.in_digest && !m.live
  && m.files.some((f) => f.recording?.status === 'pending') && !m.files.some((f) => f.recording?.status === 'running');

/**
 * The meetings moved to the front with "Transcribe next" that still wait, in the order the server takes them: the latest
 * choice first. One being transcribed is no longer in line.
 */
export function transcribeLine(queue: QueuedMeeting[]): string[] {
  return queue.filter((m) => m.transcribe_first_at && waitsForTurn(m))
    .sort((a, b) => b.transcribe_first_at!.localeCompare(a.transcribe_first_at!) || a.id.localeCompare(b.id))
    .map((m) => m.id);
}

/** The transcription running now, as the page can tell: a queued recording (any dashboard), or this dashboard's job. */
/** `generation` names the job, so a confirmation left open never stops another one that started meanwhile. */
export interface RunningTranscription { title: string | null; percent: number | null; generation: string }

/** What can be done about a meeting's place in line: Transcribe next, Transcribe now (with what it stops), Move back. */
export function transcribeChoices(m: QueuedMeeting, queue: QueuedMeeting[], progress: TranscriptionProgress | null):
  { next: boolean; now: RunningTranscription | null; moveBack: boolean } {
  if (!waitsForTurn(m)) return { next: false, now: null, moveBack: false };
  const percent = (p: TranscriptionProgress | null) => (p && p.total > 0 ? Math.min(99, Math.floor((p.done / p.total) * 100)) : null);
  let now: RunningTranscription | null = null;
  for (const q of queue) {
    const f = q.id === m.id ? undefined : q.files.find((x) => x.recording?.status === 'running' && x.recording.generation);
    if (!f) continue;
    const mine = progress?.meeting === q.id && progress.file === f.name ? progress : null;
    now = { title: q.title, percent: percent(mine), generation: f.recording!.generation! };
    break;
  }
  // A Transcribe again of a reviewed meeting runs here: it gives way too.
  if (!now && progress?.generation && !queue.some((q) => q.id === progress.meeting)) now = { title: null, percent: percent(progress), generation: progress.generation };
  return { next: transcribeLine(queue)[0] !== m.id, now, moveBack: Boolean(m.transcribe_first_at) };
}

const people = (m: QueuedMeeting) => (m.participants ?? []).map((p) => p.name);

/** Where a queued meeting stands, in the user's words. */
export function queueProcessing(m: QueuedMeeting, facts: QueueFacts): RowStatus {
  if (m.live) {
    if (facts.recordingNow(m)) return { label: tr('queuedMeetingActions.recording'), tone: 'critical' };
    return { label: tr('meetingHistory.needsYou'), tone: 'warning', detail: m.live.state === 'damaged' ? tr('meetingHistory.recordingCannotBeRead') : tr('meetingHistory.recordingInterrupted') };
  }
  if (m.status === 'draft') return { label: tr('meetingHistory.notQueuedYet'), tone: 'warning', detail: tr('meetingHistory.uploadStoppedOrUnderWay') };
  if (m.in_digest) return { label: tr('meetingHistory.goingIntoADigest'), tone: 'info' };
  if (m.held) return { label: tr('meetingHistory.needsYou'), tone: 'warning', detail: tr('meetingHistory.onHoldQueueItAgain') };
  for (const f of m.files) {
    const r = f.recording;
    if (!r) continue;
    if (missingModel(r, facts.installed, facts.runnable, facts.chosen ?? null)) return { label: tr('meetingHistory.needsYou'), tone: 'warning', detail: tr('meetingHistory.waitsForAModelTo') };
    if (r.status === 'failed') return { label: tr('meetingHistory.needsYou'), tone: 'warning', detail: tr('meetingHistory.transcriptionFailed') };
    if (r.status === 'stopped') return { label: tr('meetingHistory.needsYou'), tone: 'warning', detail: tr('meetingHistory.transcriptionStopped') };
    if (r.status === 'partial' && !r.accepted) return { label: tr('meetingHistory.needsYou'), tone: 'warning', detail: tr('meetingHistory.partialTranscript') };
  }
  const running = m.files.find((f) => f.recording?.status === 'running');
  if (running) {
    const view = transcriptionView(facts.progress?.meeting === m.id && facts.progress.file === running.name ? facts.progress : null, facts.now ?? Date.now());
    return { label: view.badge, tone: 'info', ...(view.detail ? { detail: view.detail } : {}), progress: { percent: view.percent, spoken: view.spoken } };
  }
  if (m.files.some((f) => f.recording?.status === 'pending')) {
    const place = facts.line?.indexOf(m.id) ?? -1;
    const label = place === 0 ? tr('meetingHistory.nextInLine') : place > 0 ? tr('meetingHistory.inLine', { n: place + 1 }) : tr('meetingHistory.waitingForTranscription');
    return { label, tone: 'info' };
  }
  return { label: tr('meetingHistory.waitingForDigest'), tone: 'accent', ...(facts.nextDigest ? { detail: tr('meetingHistory.nextDigest', { nextDigest: facts.nextDigest }) } : {}) };
}

/**
 * Where a meeting's review opens: at the meeting when its id is final, else the whole update. A record-only meeting's id
 * names a record id the analysis wrote, which a new analysis may give to another meeting before the update is done.
 */
export function reviewHref(h: Pick<HistoryMeeting, 'id' | 'update_id' | 'linkable'>): string {
  return h.linkable ? meetingReviewHref(h.update_id, h.id) : `/context/updates/${encodeURIComponent(h.update_id)}`;
}

/** How far the user got with a meeting an update holds. */
export function historyReview(h: HistoryMeeting): RowStatus {
  const status = h.update.status;
  if (status === 'ready' || status === 'analyzing') return { label: tr('meetingHistory.waitingForAnalysis'), tone: 'info' };
  const href = reviewHref(h);
  if (status === 'in_review') {
    const toConfirm = h.record && h.record.confirmation === null;
    return { label: tr('meetingHistory.waitingForReview'), tone: 'warning', ...(toConfirm ? { detail: tr('meetingHistory.recordToConfirm') } : {}), link: { label: tr('meetingHistory.reviewThisMeeting'), href } };
  }
  const see = { label: tr('meetingHistory.seeTheReview'), href };
  if (status === 'approved' || status === 'applying') return { label: tr('format.approved'), tone: 'info', detail: tr('meetingHistory.beingApplied'), link: see };
  const context = h.update.context_changed ? tr('meetingHistory.contextUpdated') : tr('meetingHistory.noContextChanges');
  if (h.record?.confirmation === 'confirmed') return { label: tr('meetingHistory.recordConfirmed'), tone: 'success', detail: context, link: see };
  if (h.record?.confirmation === 'rejected') return { label: tr('meetingHistory.recordRejected'), tone: 'muted', detail: context, link: see };
  return { label: tr('taskMeetingSources.reviewed'), tone: 'muted', detail: context, link: see };
}

export function historyProcessing(h: HistoryMeeting): RowStatus {
  return h.origin === 'digest'
    ? { label: tr('meetingHistory.inADigest'), tone: 'muted', update: h.update_id, href: reviewHref(h) }
    : { label: tr('meetingHistory.addedAsAnUpdate'), tone: 'muted', update: h.update_id, href: reviewHref(h) };
}

/** Both lists as one, newest first. A meeting being handed to a digest is in both for a moment: the queue shows it. */
export function meetingRows(queue: QueuedMeeting[], history: HistoryMeeting[], facts: QueueFacts): MeetingRow[] {
  const queued = new Set(queue.map((m) => m.id));
  const inLine = facts.line ? facts : { ...facts, line: transcribeLine(queue) };
  const rows: MeetingRow[] = [
    ...queue.map((m): MeetingRow => {
      const processing = queueProcessing(m, inLine);
      return {
        id: m.id, href: `/meetings/${m.id}`, title: m.title, date: m.meeting_date, time: meetingPeriod(m), people: people(m),
        source: m.files.some((f) => f.recording) ? tr('meetingHistory.recorded') : tr('meetingHistory.uploadedFiles'),
        processing, review: { label: tr('meetingHistory.notYet'), tone: null },
        // Being recorded right now is under way, not waiting: only an interrupted or unreadable recording needs you.
        needsYou: !(m.live && facts.recordingNow(m)) && needsYou(m, facts.installed, facts.runnable, facts.chosen ?? null),
        textGone: false, inTrash: false, queued: m,
      };
    }),
    ...history.filter((h) => !queued.has(h.id)).map((h): MeetingRow => ({
      id: h.id, href: h.linkable ? `/meetings/${h.id}` : reviewHref(h), title: h.title, date: h.meeting_date, time: null, people: h.people,
      source: h.origin === 'update' ? tr('meetingHistory.importedAsAnUpdate') : h.recorded ? tr('meetingHistory.recorded') : tr('meetingHistory.uploadedFiles'),
      processing: historyProcessing(h), review: historyReview(h), needsYou: false,
      textGone: !h.has_text && !h.deleted?.in_trash, inTrash: Boolean(h.deleted?.in_trash), held: h,
    })),
  ];
  return rows.sort((a, b) => b.date.localeCompare(a.date) || (b.time ?? '').localeCompare(a.time ?? '') || b.id.localeCompare(a.id));
}

export const MEETING_FILTERS = ['all', 'you', 'progress', 'review', 'reviewed'] as const;
export type MeetingFilter = typeof MEETING_FILTERS[number];

/** The filter a link asks for (`/meetings?show=you`); anything else shows all meetings. */
export function filterFromQuery(show: string | null): MeetingFilter {
  return (MEETING_FILTERS as readonly string[]).includes(show ?? '') ? show as MeetingFilter : 'all';
}

export function inFilter(row: MeetingRow, filter: MeetingFilter): boolean {
  if (row.inTrash) return false;
  if (filter === 'all') return true;
  if (filter === 'you') return row.needsYou;
  if (filter === 'progress') return Boolean(row.queued) && !row.needsYou;
  const done = row.held?.update.status === 'done';
  return Boolean(row.held) && (filter === 'reviewed' ? done : !done);
}

/**
 * How many meetings the page's Needs you and In progress filters hold, for the sidebar. Counted with the page's own rows
 * and filters, so the two always agree. Only queued meetings can be in either, so the held ones are not needed.
 */
export function meetingCounts(queue: QueuedMeeting[], facts: Pick<QueueFacts, 'installed' | 'runnable' | 'chosen' | 'recordingNow'>): { needsYou: number; inProgress: number } {
  const rows = meetingRows(queue, [], { ...facts, progress: null, nextDigest: null });
  return { needsYou: rows.filter((r) => inFilter(r, 'you')).length, inProgress: rows.filter((r) => inFilter(r, 'progress')).length };
}

/**
 * Rows whose title, date, source or people hold every word of `query`, and the rows found by what was said in them
 * (`said`, the ids the server found in their transcripts and notes).
 */
export function matchingRows(rows: MeetingRow[], query: string, said: ReadonlySet<string> = new Set()): MeetingRow[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return rows;
  return rows.filter((r) => {
    if (said.has(r.id)) return true;
    const text = [r.title, r.date, r.held?.linkable === false ? '' : r.id, ...r.people].join(' ').toLowerCase();
    return words.every((w) => text.includes(w));
  });
}

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** The rows by when they took place: Today, Yesterday, This week, then by month. Kept in order. */
export function groupRows(rows: MeetingRow[], now: Date): { label: string; rows: MeetingRow[] }[] {
  const today = iso(now);
  const yesterday = iso(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
  const weekAgo = iso(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6));
  const label = (date: string): string => {
    if (date === today) return tr('meetingHistory.today');
    if (date === yesterday) return tr('meetingHistory.yesterday');
    if (date >= weekAgo && date < today) return tr('meetingHistory.thisWeek');
    if (date > today) return tr('meetingHistory.comingUp');
    const [y, m] = date.split('-').map(Number);
    if (!y || !m) return tr('meetingHistory.noDate');
    return new Date(y, m - 1, 1).toLocaleDateString(currentLocale(), { month: 'long', year: 'numeric' });
  };
  const groups: { label: string; rows: MeetingRow[] }[] = [];
  for (const row of rows) {
    const l = label(row.date);
    const last = groups[groups.length - 1];
    if (last?.label === l) last.rows.push(row);
    else groups.push({ label: l, rows: [row] });
  }
  return groups;
}

/** The time of a row as the list shows it: the hour of a recording made today, else the day. */
export function whenLabel(row: MeetingRow, now: Date): string {
  if (row.date === iso(now) && row.time) return row.time.split('–')[0]!;
  const [y, m, d] = row.date.split('-').map(Number);
  if (!y || !m || !d) return row.date || tr('meetingHistory.noDate');
  return new Date(y, m - 1, d).toLocaleDateString(currentLocale(), { month: 'short', day: 'numeric', ...(y !== now.getFullYear() ? { year: 'numeric' } : {}) });
}

/** Whether a row offers Open folder: a meeting with its own dialog whose files are still on this computer. */
export function canOpenFolder(row: MeetingRow): boolean {
  return row.href.startsWith('/meetings/') && !row.inTrash && !row.textGone;
}

/**
 * Where Open folder goes for a meeting: its own folder, or its first file in an update's shared materials/ (shown
 * selected, so the update's other meetings are not what the user sees first), and what to say about it.
 */
export function meetingFolderTarget(f: MeetingFolder): { path: string; note: string | null } {
  const notes: string[] = [];
  if (f.shared && f.first_file) notes.push(tr('meetingFolder.sharedFolder', { update: f.path.split('/')[1] ?? '' }));
  if (f.stage === 'reviewed' && f.recorded && !f.has_audio) notes.push(tr('meetingFolder.recordingNotKept'));
  return { path: f.shared && f.first_file ? f.first_file : f.path, note: notes.length ? notes.join(' ') : null };
}
