import * as path from 'path';
import type { ContextUpdate, MeetingRecord } from './contextUpdateService';

/**
 * The meetings a context update holds, worked out from what the update already records. Pure functions: nothing here
 * reads or writes files. Used by the Meetings history (what to list and read) and by meeting retention (which files
 * of a finished update are meeting text, and which belong to one meeting).
 *
 * A meeting's id says where it lives:
 *   MQ-2026-0007        a meeting from the queue, held by a meeting digest
 *   CU-2026-0005-M-01   a meeting record of an update imported by hand (pasted or uploaded)
 *   CU-2026-0005        an imported transcript that is not analyzed yet, so it has no record
 */

export const QUEUED_MEETING_ID = /^MQ-\d{4}-\d{4}$/;
const IMPORTED_MEETING_ID = /^(CU-\d{4}-\d{4})(?:-(M-\d{2,3}))?$/;

/** Whether a value is a meeting id in one of the three forms above. */
export function isMeetingId(value: unknown): value is string {
  return typeof value === 'string' && (QUEUED_MEETING_ID.test(value) || IMPORTED_MEETING_ID.test(value));
}

/**
 * A meeting id rebuilt from its numbers, or null when the value is not one. What comes back holds no character of the
 * value itself, so it can go into a path even where a check made elsewhere cannot be seen (CodeQL's path rules).
 */
export function canonicalMeetingId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const n = (s: string, width: number) => String(Number(s)).padStart(width, '0');
  const queued = /^MQ-(\d{4})-(\d{4})$/.exec(value);
  if (queued) return `MQ-${n(queued[1]!, 4)}-${n(queued[2]!, 4)}`;
  const imported = /^CU-(\d{4})-(\d{4})(?:-M-(\d{2,3}))?$/.exec(value);
  if (!imported) return null;
  return `CU-${n(imported[1]!, 4)}-${n(imported[2]!, 4)}${imported[3] ? `-M-${n(imported[3], imported[3].length)}` : ''}`;
}

/** An imported meeting's update and record; null for a queued meeting's id. */
export function importedParts(id: string): { update: string; record: string | null } | null {
  const m = IMPORTED_MEETING_ID.exec(id);
  return m ? { update: m[1]!, record: m[2] ?? null } : null;
}

/** Text a meeting leaves: transcripts, their readable copies, notes. Never audio, images or decks. */
const TEXT_EXTENSIONS = new Set(['.vtt', '.txt', '.md', '.docx']);
export function isMeetingText(name: string): boolean {
  return TEXT_EXTENSIONS.has(path.extname(name).toLowerCase());
}

/**
 * How a record is tied to a meeting of a digest: `explicit` when the record names it (`meeting: MQ-…`), `source` when
 * the record's source is a file of that meeting only, `only` when the digest holds one meeting and one record.
 * `saved` when the link was saved on the record once its update was done (see meetingLinks), in any update.
 */
export type RecordLink = 'explicit' | 'source' | 'only' | 'saved';

/**
 * How far the review of a meeting's update got: `waiting` before the analysis wrote a record, `provisional` while the
 * update is in review, approved or being applied (a re-analysis may still change its records), `final` once it is done.
 */
export type ReviewState = 'waiting' | 'provisional' | 'final';

export function reviewState(u: ContextUpdate): ReviewState {
  if (u.status === 'done') return 'final';
  return u.status === 'ready' || u.status === 'analyzing' ? 'waiting' : 'provisional';
}

export interface HeldMeeting {
  id: string;
  /** What identifies it inside its update: the queue id, the record id, or '' for an import with no record yet. */
  key: string;
  update_id: string;
  origin: 'digest' | 'update';
  title: string;
  meeting_date: string;
  record: MeetingRecord | null;
  link: RecordLink | null;
  /** Its files in the update's materials, as recorded: originals and readable copies. Some may be gone. */
  files: string[];
  /** It came from a recording made or uploaded into the queue. */
  recorded: boolean;
  /**
   * Its id is final, so other features may link to it and the API answers for it. A queued meeting's MQ id always is.
   * A record id (`M-01`) is written by the analysis and may be renumbered when the update is analyzed again, so a
   * record-only meeting's id is final only once its update is done.
   */
  linkable: boolean;
}

/** Updates the dashboard or a person opened about something other than meetings. */
function aboutMeetings(u: ContextUpdate): boolean {
  // A correction is a later version of a meeting's record, and its follow-up looks at the context: neither is a meeting.
  if (u.origin === 'system-cleanup' || u.kind === 'kaizen' || u.kind === 'memory-review' || u.kind === 'meeting-correction' || u.kind === 'correction-follow-up') return false;
  return true;
}

const withCopies = (u: ContextUpdate, names: string[]): string[] => {
  const all = new Set(names);
  for (const t of u.transcripts) if (all.has(t.source)) all.add(t.file);
  return [...all];
};

/**
 * Every meeting this update holds, in the order it lists them. Once the update is done and its links are saved
 * (`meetings_linked_at`), the saved links are read as they are: a later change in how links are worked out never moves
 * a meeting, its record or its files. Before that, they are worked out from what the update records.
 */
export function heldMeetings(u: ContextUpdate): HeldMeeting[] {
  if (!aboutMeetings(u)) return [];
  const records = u.meeting_records.filter((r) => /^M-\d{2,3}$/.test(r.id));
  if (u.digest_meetings.length) return digestMeetings(u, records);
  const base = { update_id: u.id, origin: 'update' as const, recorded: false, linkable: u.status === 'done' };
  if (u.meetings_linked_at) {
    // A record keeps the id saved on it; the files are the ones saved with that id.
    return records.filter((r) => r.meeting_id === `${u.id}-${r.id}`).map((r) => ({
      ...base, id: r.meeting_id!, key: r.id, title: r.title || u.title, meeting_date: r.meeting_date || u.source_date, record: r, link: 'saved' as const,
      files: withCopies(u, u.materials.filter((m) => m.meetings.includes(r.meeting_id!)).map((m) => m.name)),
    }));
  }
  if (records.length) {
    const materials = u.materials.map((m) => m.name);
    return records.map((r) => {
      const named = materials.filter((name) => name === r.source || r.speakers.some((s) => s.source === name));
      const files = records.length === 1 ? withCopies(u, materials) : withCopies(u, [...named, ...u.transcripts.filter((t) => t.file === r.source).map((t) => t.source)]);
      return { ...base, id: `${u.id}-${r.id}`, key: r.id, title: r.title || u.title, meeting_date: r.meeting_date || u.source_date, record: r, link: null, files };
    });
  }
  // Not analyzed yet: an imported transcript is a meeting waiting for its record. Anything else is not known to be one.
  const transcript = u.transcripts.some((t) => t.kind === 'webvtt');
  if (transcript && (u.status === 'ready' || u.status === 'analyzing')) {
    return [{ ...base, linkable: false, id: u.id, key: '', title: u.title, meeting_date: u.source_date, record: null, link: null, files: withCopies(u, u.materials.map((m) => m.name)) }];
  }
  return [];
}

function digestMeetings(u: ContextUpdate, records: MeetingRecord[]): HeldMeeting[] {
  const filesOf = new Map(u.digest_meetings.map((m) => [m.id, withCopies(u, [
    ...m.files.map((f) => f.file),
    ...(m.recordings ?? []).flatMap((r) => [r.transcript, ...(r.file ? [r.file] : [])]),
  ])]));
  const linked = new Map<string, { record: MeetingRecord; link: RecordLink }>();
  if (u.meetings_linked_at) {
    for (const r of records) if (r.meeting_id && filesOf.has(r.meeting_id) && !linked.has(r.meeting_id)) linked.set(r.meeting_id, { record: r, link: 'saved' });
    return digestRows(u, filesOf, linked);
  }
  // Which meetings each record could be: by the id it names, else by the files it names. Only a one-to-one match counts.
  const candidates = new Map<MeetingRecord, { ids: string[]; link: RecordLink }>();
  for (const r of records) {
    if (r.meeting && filesOf.has(r.meeting)) { candidates.set(r, { ids: [r.meeting], link: 'explicit' }); continue; }
    const named = [r.source, ...r.speakers.map((s) => s.source)].filter(Boolean);
    const ids = [...filesOf].filter(([, files]) => named.some((n) => files.includes(n))).map(([id]) => id);
    if (ids.length) candidates.set(r, { ids, link: 'source' });
  }
  const claims = new Map<string, number>();
  for (const { ids } of candidates.values()) if (ids.length === 1) claims.set(ids[0]!, (claims.get(ids[0]!) ?? 0) + 1);
  for (const [record, { ids, link }] of candidates) {
    if (ids.length === 1 && claims.get(ids[0]!) === 1) linked.set(ids[0]!, { record, link });
  }
  if (!linked.size && u.digest_meetings.length === 1 && records.length === 1) linked.set(u.digest_meetings[0]!.id, { record: records[0]!, link: 'only' });
  return digestRows(u, filesOf, linked);
}

function digestRows(u: ContextUpdate, filesOf: Map<string, string[]>, linked: Map<string, { record: MeetingRecord; link: RecordLink }>): HeldMeeting[] {
  return u.digest_meetings.map((m) => {
    const found = linked.get(m.id);
    return {
      id: m.id, key: m.id, update_id: u.id, origin: 'digest' as const, title: m.title || m.id, meeting_date: m.meeting_date || u.source_date,
      record: found?.record ?? null, link: found?.link ?? null, files: filesOf.get(m.id) ?? [], recorded: Boolean(m.recordings?.length), linkable: true,
    };
  });
}

/**
 * What to save on an update once it is done, when its record ids are final: the meeting each record is about, and the
 * meetings each material file belongs to (one file can belong to two meetings). A record whose meeting is not certain
 * gets none, so an unclear link stays unclear. Pure: the context update service writes it.
 */
export function meetingLinks(u: ContextUpdate): { records: Map<string, string>; files: Map<string, string[]> } {
  const records = new Map<string, string>();
  const files = new Map<string, string[]>();
  for (const m of heldMeetings({ ...u, status: 'done', meetings_linked_at: null })) {
    if (m.record) records.set(m.record.id, m.id);
    for (const f of m.files) files.set(f, [...(files.get(f) ?? []), m.id]);
  }
  return { records, files };
}

/**
 * The SHA-256 the update recorded for a material file: a digest file, a recording or its transcript, or a readable copy
 * and its original. Null for a file whose hash was never recorded (a file imported by hand, before any copy was made).
 */
export function recordedHash(u: ContextUpdate, file: string): string | null {
  for (const m of u.digest_meetings) {
    const f = m.files.find((x) => x.file === file);
    if (f?.sha256) return f.sha256;
    for (const r of m.recordings ?? []) {
      if (r.transcript === file && r.transcript_sha256) return r.transcript_sha256;
      if (r.file === file && r.source_sha256) return r.source_sha256;
    }
  }
  for (const t of u.transcripts) {
    if (t.file === file && t.sha256) return t.sha256;
    if (t.source === file && t.source_sha256) return t.source_sha256;
  }
  return null;
}

/**
 * The files of one meeting that are its alone: a file the digest saved once for two meetings (the same bytes) also
 * belongs to the other, and stays while that one is kept.
 */
export function ownFiles(u: ContextUpdate, key: string, gone: Set<string> = new Set()): string[] {
  const meetings = heldMeetings(u);
  const mine = meetings.find((m) => m.key === key);
  if (!mine) return [];
  const others = new Set(meetings.filter((m) => m.key !== key && !gone.has(m.key)).flatMap((m) => m.files));
  return mine.files.filter((f) => !others.has(f));
}

/** The material files a finished update keeps when meeting text is kept: the text of meetings not deleted. */
export function meetingTextToKeep(u: ContextUpdate, deleted: Set<string>): Set<string> {
  return new Set(heldMeetings(u).filter((m) => !deleted.has(m.key)).flatMap((m) => m.files).filter(isMeetingText));
}

/**
 * The day a meeting's retention starts: the later of the day it took place and the day it was added, so an old
 * transcript imported today is not removed at once.
 */
export function retentionStart(m: HeldMeeting, u: ContextUpdate): string {
  const added = (u.created_at || '').slice(0, 10);
  const held = m.meeting_date || u.source_date;
  return [held, added].filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().pop() ?? '';
}
