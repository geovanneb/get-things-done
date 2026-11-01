import type { HistoryMeeting, QueuedMeeting, TranscriptionProgress } from '@/types';
import { meetingPeriod, needsYou } from '@/utils/meetingQueue';

/**
 * The Meetings list: queued meetings and meetings held by a context update, as one list. Each row says two separate
 * things: how far the app got with it (processing), and how far the user got with it (review). "Reviewed with no
 * context changes" is never shown as "in context".
 */

export type StatusTone = 'critical' | 'info' | 'warning' | 'accent' | 'muted' | 'success';
export interface RowStatus { label: string; tone: StatusTone | null; detail?: string; update?: string; progress?: number }

export interface MeetingRow {
  id: string;
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
  progress: TranscriptionProgress | null;
  /** When the next digest runs, as shown ("Mon 18:00"); null when it waits for something else. */
  nextDigest: string | null;
  /** The meeting is being recorded now, here or in another page. */
  recordingNow: (m: QueuedMeeting) => boolean;
}

const people = (m: QueuedMeeting) => (m.participants ?? []).map((p) => p.name);

/** Where a queued meeting stands, in the user's words. */
export function queueProcessing(m: QueuedMeeting, facts: QueueFacts): RowStatus {
  if (m.live) {
    if (facts.recordingNow(m)) return { label: 'Recording', tone: 'critical' };
    return { label: 'Needs you', tone: 'warning', detail: m.live.state === 'damaged' ? 'Recording cannot be read' : 'Recording interrupted' };
  }
  if (m.status === 'draft') return { label: 'Not queued yet', tone: 'warning', detail: 'Upload stopped or under way' };
  if (m.in_digest) return { label: 'Going into a digest', tone: 'info' };
  if (m.held) return { label: 'Needs you', tone: 'warning', detail: 'On hold: queue it again' };
  for (const f of m.files) {
    const r = f.recording;
    if (!r) continue;
    const target = r.target ? facts.runnable[r.target.model] ?? r.target.model : null;
    if (r.status === 'pending' && facts.installed && target && !facts.installed.includes(target)) return { label: 'Needs you', tone: 'warning', detail: 'Waits for a model to download' };
    if (r.status === 'failed') return { label: 'Needs you', tone: 'warning', detail: 'Transcription failed' };
    if (r.status === 'stopped') return { label: 'Needs you', tone: 'warning', detail: 'Transcription stopped' };
    if (r.status === 'partial' && !r.accepted) return { label: 'Needs you', tone: 'warning', detail: 'Partial transcript' };
  }
  const running = m.files.find((f) => f.recording?.status === 'running');
  if (running) {
    const p = facts.progress && facts.progress.meeting === m.id && facts.progress.file === running.name && facts.progress.total > 0
      ? Math.min(99, Math.floor((facts.progress.done / facts.progress.total) * 100)) : undefined;
    return { label: p === undefined ? 'Transcribing' : `Transcribing ${p}%`, tone: 'info', ...(p === undefined ? {} : { progress: p }) };
  }
  if (m.files.some((f) => f.recording?.status === 'pending')) return { label: 'Waiting for transcription', tone: 'info' };
  return { label: 'Waiting for digest', tone: 'accent', ...(facts.nextDigest ? { detail: `Next digest ${facts.nextDigest}` } : {}) };
}

/** How far the user got with a meeting an update holds. */
export function historyReview(h: HistoryMeeting): RowStatus {
  const status = h.update.status;
  if (status === 'ready' || status === 'analyzing') return { label: 'Waiting for analysis', tone: 'info' };
  if (status === 'in_review') {
    const toConfirm = h.record && h.record.confirmation === null;
    return { label: 'Waiting for review', tone: 'warning', ...(toConfirm ? { detail: 'Record to confirm' } : {}) };
  }
  if (status === 'approved' || status === 'applying') return { label: 'Approved', tone: 'info', detail: 'Being applied' };
  const context = h.update.context_changed ? 'Context updated' : 'No context changes';
  if (h.record?.confirmation === 'confirmed') return { label: 'Record confirmed', tone: 'success', detail: context };
  if (h.record?.confirmation === 'rejected') return { label: 'Record rejected', tone: 'muted', detail: context };
  return { label: 'Reviewed', tone: 'muted', detail: context };
}

export function historyProcessing(h: HistoryMeeting): RowStatus {
  return h.origin === 'digest'
    ? { label: 'In a digest', tone: 'muted', update: h.update_id }
    : { label: 'Added as an update', tone: 'muted', update: h.update_id };
}

/** Both lists as one, newest first. A meeting being handed to a digest is in both for a moment: the queue shows it. */
export function meetingRows(queue: QueuedMeeting[], history: HistoryMeeting[], facts: QueueFacts): MeetingRow[] {
  const queued = new Set(queue.map((m) => m.id));
  const rows: MeetingRow[] = [
    ...queue.map((m): MeetingRow => {
      const processing = queueProcessing(m, facts);
      return {
        id: m.id, title: m.title, date: m.meeting_date, time: meetingPeriod(m), people: people(m),
        source: m.files.some((f) => f.recording) ? 'Recorded' : 'Uploaded files',
        processing, review: { label: 'Not yet', tone: null },
        needsYou: processing.label === 'Needs you' || needsYou(m, facts.installed, facts.runnable),
        textGone: false, inTrash: false, queued: m,
      };
    }),
    ...history.filter((h) => !queued.has(h.id)).map((h): MeetingRow => ({
      id: h.id, title: h.title, date: h.meeting_date, time: null, people: h.people,
      source: h.origin === 'update' ? 'Imported as an update' : h.recorded ? 'Recorded' : 'Uploaded files',
      processing: historyProcessing(h), review: historyReview(h), needsYou: false,
      textGone: !h.has_text && !h.deleted?.in_trash, inTrash: Boolean(h.deleted?.in_trash), held: h,
    })),
  ];
  return rows.sort((a, b) => b.date.localeCompare(a.date) || (b.time ?? '').localeCompare(a.time ?? '') || b.id.localeCompare(a.id));
}

export type MeetingFilter = 'all' | 'you' | 'progress' | 'review' | 'reviewed';

export function inFilter(row: MeetingRow, filter: MeetingFilter): boolean {
  if (row.inTrash) return false;
  if (filter === 'all') return true;
  if (filter === 'you') return row.needsYou;
  if (filter === 'progress') return Boolean(row.queued) && !row.needsYou;
  const done = row.held?.update.status === 'done';
  return Boolean(row.held) && (filter === 'reviewed' ? done : !done);
}

/** Rows whose title, date, source or people hold every word of `query`. */
export function matchingRows(rows: MeetingRow[], query: string): MeetingRow[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return rows;
  return rows.filter((r) => {
    const text = [r.title, r.date, r.id, ...r.people].join(' ').toLowerCase();
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
    if (date === today) return 'Today';
    if (date === yesterday) return 'Yesterday';
    if (date >= weekAgo && date < today) return 'This week';
    if (date > today) return 'Coming up';
    const [y, m] = date.split('-').map(Number);
    if (!y || !m) return 'No date';
    return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
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
  if (!y || !m || !d) return row.date || 'No date';
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(y !== now.getFullYear() ? { year: 'numeric' } : {}) });
}
