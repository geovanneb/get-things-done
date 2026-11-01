import * as path from 'path';
import * as fsp from 'fs/promises';
import { ContextUpdateService, readableText, AUDIO_EXTENSIONS, type ContextUpdate, type MeetingRecord, type UpdateStatus } from './contextUpdateService';
import { MeetingDigestService } from './meetingDigestService';
import { heldMeetings, importedParts, isMeetingId, isMeetingText, QUEUED_MEETING_ID, retentionStart, type HeldMeeting, type RecordLink } from './meetingLibrary';
import { fileInside, topLevelName } from '../utils/files';
import { MAX_CONVERT_BYTES } from '../utils/transcript';

/**
 * The Meetings history: every meeting a context update holds (digests and updates imported by hand), read from what the
 * updates already record. Reading never changes anything; keeping, deleting and restoring go through the context update
 * service, which owns update.md. Queued meetings come from the meeting queue as before.
 */

export interface HistoryMeeting {
  id: string;
  update_id: string;
  origin: HeldMeeting['origin'];
  title: string;
  meeting_date: string;
  /** Who the record lists as attendees: the reviewed account, not who was expected. */
  people: string[];
  recorded: boolean;
  update: { id: string; title: string; status: UpdateStatus; created_at: string; analyzed_at: string | null; applied_at: string | null; context_changed: boolean };
  record: { id: string; confirmation: MeetingRecord['confirmation']; confirmed_at: string | null; link: RecordLink | null } | null;
  /** Records in the update that no meeting of it is linked to (a digest analyzed before records named their meeting). */
  unlinked_records: number;
  /** The user keeps it: System cleanup's Meetings rule skips it. */
  kept: boolean;
  /** Its text was deleted: in the trash (`in_trash`) or for good. */
  deleted: { at: string; by: 'user' | 'system-cleanup'; in_trash: boolean } | null;
  /** The day its retention counts from (see retentionStart). */
  retention_start: string;
  /** Its text is still here (kept after review, or the review is not done yet). */
  has_text: boolean;
}

/** One file of a meeting, as the Files tab and the reader show it. */
export interface MeetingSource {
  /** The file in the update's materials. */
  file: string;
  /** Its name as the user added it, without the digest's meeting prefix. */
  name: string;
  kind: 'transcript' | 'recording' | 'notes' | 'file';
  present: boolean;
  /** It can be read here as text (a transcript, notes), now or when it was present. */
  readable: boolean;
  /** Why it is not here, when it is not. */
  missing: string | null;
}

export interface MeetingDetail {
  meeting: HistoryMeeting;
  record: MeetingRecord | null;
  /** The update's records when none is linked to this meeting: shown with a note instead of guessing. */
  update_records: { id: string; title: string; meeting_date: string; confirmation: MeetingRecord['confirmation'] }[];
  sources: MeetingSource[];
}

function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode: status });
}

const contextUpdates = new ContextUpdateService();
const queue = new MeetingDigestService();

function summary(u: ContextUpdate, m: HeldMeeting, present: Set<string> | null): HistoryMeeting {
  const deleted = u.deleted_meetings.find((d) => d.meeting === m.key);
  const linked = new Set(heldMeetings(u).map((h) => h.record?.id).filter(Boolean));
  return {
    id: m.id,
    update_id: u.id,
    origin: m.origin,
    title: m.title,
    meeting_date: m.meeting_date,
    people: (m.record?.attendees ?? []).map((p) => p.name).filter(Boolean),
    recorded: m.recorded,
    update: {
      id: u.id, title: u.title, status: u.status, created_at: u.created_at, analyzed_at: u.analyzed_at, applied_at: u.applied_at,
      // Something reviewed in it was changed in the context. A digest changes the context as one update, not per meeting.
      context_changed: u.proposals.some((p) => p.decision === 'accepted' && (p.outcome === 'applied' || p.outcome === 'merged' || (p.action === 'remove' && Boolean(p.outcome) && p.outcome !== 'skipped'))),
    },
    record: m.record ? { id: m.record.id, confirmation: m.record.confirmation, confirmed_at: m.record.confirmed_at, link: m.link } : null,
    unlinked_records: m.origin === 'digest' ? u.meeting_records.filter((r) => !linked.has(r.id)).length : 0,
    kept: u.kept_meetings.includes(m.key),
    deleted: deleted ? { at: deleted.at, by: deleted.by, in_trash: Boolean(deleted.trash) } : null,
    retention_start: retentionStart(m, u),
    has_text: !deleted && (present ? m.files.some((f) => present.has(f) && isMeetingText(f)) : u.status !== 'done' || u.keep_materials || u.keep_meeting_text),
  };
}

export class MeetingHistoryService {
  /** Every meeting held by a context update, newest first. Updates that cannot be read are left out, as in Context. */
  async list(): Promise<HistoryMeeting[]> {
    const out: HistoryMeeting[] = [];
    for (const u of await contextUpdates.list()) {
      for (const m of heldMeetings(u)) out.push(summary(u, m, null));
    }
    return out.sort((a, b) => b.meeting_date.localeCompare(a.meeting_date) || b.update_id.localeCompare(a.update_id) || a.id.localeCompare(b.id));
  }

  /** The update holding a meeting, and the meeting in it. A queued id belongs to the newest digest that names it. */
  private async held(id: string): Promise<{ update: ContextUpdate; meeting: HeldMeeting }> {
    if (!isMeetingId(id)) throw httpError(400, 'Invalid meeting id');
    const imported = importedParts(id);
    const updates = imported ? [await contextUpdates.list().then((all) => all.find((u) => u.id === imported.update))] : await contextUpdates.list();
    for (const u of updates) {
      const meeting = u ? heldMeetings(u).find((m) => m.id === id) : undefined;
      if (u && meeting) return { update: u, meeting };
    }
    throw httpError(404, `Meeting not found: ${id}`);
  }

  async detail(id: string): Promise<MeetingDetail> {
    const { update: listed } = await this.held(id);
    // The detail read finishes a done update's cleanup, as opening it in Context does, and says which tasks still exist.
    const update = await contextUpdates.get(listed.id);
    const meeting = heldMeetings(update).find((m) => m.id === id);
    if (!meeting) throw httpError(404, `Meeting not found: ${id}`);
    const present = new Set(update.material_files.map((f) => f.name));
    const deleted = update.deleted_meetings.find((d) => d.meeting === meeting.key);
    const copies = new Map(update.transcripts.map((t) => [t.file, t]));
    const prefix = meeting.origin === 'digest' ? `${meeting.id}-` : '';
    const why = (): string => {
      if (deleted) return deleted.trash ? 'Deleted: it is in the trash.' : 'Deleted for good.';
      if (update.status !== 'done') return 'It is not in the update any more.';
      return update.applied_at
        ? `Removed when ${update.id} was done, on ${new Date(update.applied_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}${update.keep_meeting_text ? '' : ', before Meetings kept transcripts'}.`
        : `Removed when ${update.id} was done.`;
    };
    const sources: MeetingSource[] = meeting.files
      // A readable copy is how its original is read, not a file of its own; one whose original is gone stands alone.
      .filter((f) => !copies.has(f) || !meeting.files.includes(copies.get(f)!.source))
      .map((file) => {
        const ext = path.extname(file).toLowerCase();
        const copy = update.transcripts.find((t) => t.source === file);
        const kind = AUDIO_EXTENSIONS.has(ext) ? 'recording' as const
          : copy || ext === '.vtt' || copies.has(file) ? 'transcript' as const
            : isMeetingText(file) ? 'notes' as const : 'file' as const;
        const isPresent = present.has(file) || Boolean(copy && present.has(copy.file));
        return {
          file, name: file.startsWith(prefix) ? file.slice(prefix.length) : file, kind, present: isPresent,
          readable: kind === 'transcript' || kind === 'notes', missing: isPresent ? null : why(),
        };
      });
    // A recording whose audio left the queue without going into the digest (Keep recordings off).
    const digest = meeting.origin === 'digest' ? update.digest_meetings.find((m) => m.id === meeting.id) : undefined;
    for (const r of digest?.recordings ?? []) {
      if (r.file === null) sources.push({ file: r.source, name: r.source, kind: 'recording', present: false, readable: false, missing: 'Removed when it went into the digest (Keep recordings is off).' });
    }
    const order = { transcript: 0, notes: 1, recording: 2, file: 3 };
    sources.sort((a, b) => order[a.kind] - order[b.kind] || a.name.localeCompare(b.name));
    const record = meeting.record ? update.meeting_records.find((r) => r.id === meeting.record!.id) ?? null : null;
    const linked = new Set(heldMeetings(update).map((h) => h.record?.id).filter(Boolean));
    return {
      meeting: summary(update, meeting, present),
      record,
      update_records: record ? [] : update.meeting_records.filter((r) => !linked.has(r.id)).map((r) => ({ id: r.id, title: r.title, meeting_date: r.meeting_date, confirmation: r.confirmation })),
      sources,
    };
  }

  /**
   * A file of a meeting as text to read: a transcript as its readable copy, notes as they are. Only a file of this
   * meeting, and only text: never a way to read any file of the workspace.
   */
  async text(id: string, name: unknown): Promise<string> {
    const file = topLevelName(name as string);
    if (QUEUED_MEETING_ID.test(id)) {
      const inQueue = await queue.loadMeeting(id).catch(() => null);
      if (inQueue) {
        if (!inQueue.files.some((f) => f.name === file)) throw httpError(404, 'No such file in this meeting');
        return this.readAsText(await fileInside(await queue.meetingFolder(id), file), file);
      }
    }
    const { update, meeting } = await this.held(id);
    if (!meeting.files.includes(file)) throw httpError(404, 'No such file in this meeting');
    if (update.deleted_meetings.some((d) => d.meeting === meeting.key)) throw httpError(410, 'This meeting was deleted');
    const copy = update.transcripts.find((t) => t.source === file);
    const shown = copy ? await contextUpdates.materialPath(update.id, copy.file).catch(() => null) : null;
    if (shown) return this.readAsText(shown, copy!.file);
    const original = await contextUpdates.materialPath(update.id, file).catch(() => null);
    if (!original) throw httpError(410, 'This file is no longer kept');
    return this.readAsText(original, file);
  }

  private async readAsText(full: string, name: string): Promise<string> {
    if (!isMeetingText(name)) throw httpError(415, 'Only transcripts and notes can be read here; open the file instead');
    // A Word file is converted whole; anything over the limit is not read into memory at all.
    if ((await fsp.stat(full)).size > MAX_CONVERT_BYTES) throw httpError(413, 'The file is too large to show here; open the file instead');
    const text = readableText(name, await fsp.readFile(full));
    if (text === null) throw httpError(415, 'This file cannot be shown as text; open the file instead');
    return text;
  }

  // ---- keep, delete, restore: one meeting of an update ------------------------------------------------------------

  async keep(id: string, keep: unknown): Promise<HistoryMeeting> {
    const { update, meeting } = await this.held(id);
    const next = await contextUpdates.keepMeeting(update.id, meeting.key, keep);
    return summary(next, heldMeetings(next).find((m) => m.id === id)!, null);
  }

  async remove(id: string): Promise<void> {
    if (QUEUED_MEETING_ID.test(id) && await queue.loadMeeting(id).then(() => true, () => false)) {
      throw httpError(409, 'This meeting is still in the queue: remove it from the queue instead');
    }
    const { update, meeting } = await this.held(id);
    await contextUpdates.trashMeeting(update.id, meeting.key, 'user');
  }

  async restore(id: string): Promise<void> {
    const { update, meeting } = await this.held(id);
    await contextUpdates.restoreMeeting(update.id, meeting.key);
  }

  async purge(id: string): Promise<void> {
    const { update, meeting } = await this.held(id);
    await contextUpdates.purgeMeeting(update.id, meeting.key);
  }
}
