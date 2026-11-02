import * as path from 'path';
import * as fsp from 'fs/promises';
import { ContextUpdateService, readableText, AUDIO_EXTENSIONS, CORRECTION_KIND, type ContextUpdate, type MeetingRecord, type UpdateStatus } from './contextUpdateService';
import { MeetingDigestService } from './meetingDigestService';
import { heldMeetings, importedParts, isMeetingId, isMeetingText, QUEUED_MEETING_ID, recordedHash, retentionStart, reviewState, type HeldMeeting, type RecordLink, type ReviewState } from './meetingLibrary';
import { fileInside, topLevelName } from '../utils/files';
import { correctionChain, type ChainState, type CorrectionChain } from './meetingCorrections';
import { MAX_CONVERT_BYTES } from '../utils/transcript';
import { MAX_QUERY, MIN_QUERY, queryWords, searchMeeting, type SearchHit } from './meetingSearch';

/**
 * The Meetings history: every meeting a context update holds (digests and updates imported by hand), read from what the
 * updates already record. Reading never changes anything; keeping, deleting and restoring go through the context update
 * service, which owns update.md. Queued meetings come from the meeting queue as before.
 */

export interface HistoryMeeting {
  /** Use it as a link only when `linkable`: see HeldMeeting.linkable. */
  id: string;
  /** Its id is final: the API answers for it and other features may link to it. False for a record-only meeting until its update is done. */
  linkable: boolean;
  /** Provisional while its update is reviewed, final once it is done. See ReviewState. */
  review_state: ReviewState;
  /**
   * `linked`: a record is shown as this meeting's. `ambiguous`: its update has records, but which one is this meeting's
   * is not certain, so none is shown as its own. `none`: no record (not analyzed yet, or none was written).
   */
  record_state: 'linked' | 'ambiguous' | 'none';
  update_id: string;
  origin: HeldMeeting['origin'];
  title: string;
  meeting_date: string;
  /** Who the record lists as attendees: the reviewed account, not who was expected. */
  people: string[];
  recorded: boolean;
  update: { id: string; title: string; status: UpdateStatus; created_at: string; analyzed_at: string | null; applied_at: string | null; context_changed: boolean };
  /** `revision` is the record's version: it changes whenever its content does. */
  record: { id: string; revision: string; confirmation: MeetingRecord['confirmation']; confirmed_at: string | null; link: RecordLink | null } | null;
  /**
   * Whose record is shown: the original update's, or a correction's once one counts. The files are always
   * `update_id`'s: keep, delete, restore and retention stay with it.
   */
  record_owner: { update_id: string; record_id: string } | null;
  /**
   * The record's versions, when it has any beyond the original or one is being made: `corrected`, or `conflict` and
   * `broken`, where the record shown is the last version reached from the original and no correction can build on it.
   */
  correction: { state: ChainState; head_at: string | null; original: { update_id: string; record_id: string }; open: string[]; head_changed?: boolean } | null;
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
  /**
   * `present`: here. `unavailable`: not here now but can come back (its meeting is in the trash). `missing`: gone for
   * good (removed when its update was done, deleted for good, or never kept).
   */
  state: 'present' | 'unavailable' | 'missing';
  /** The SHA-256 the update recorded for it; null when none was recorded (a file imported by hand). */
  sha256: string | null;
  /** It can be read here as text (a transcript, notes, or a recording through its transcript), now or when it was present. */
  readable: boolean;
  /** A recording whose audio is here to play (`GET /api/meetings/:id/audio/:file`). False when only its transcript is kept. */
  playable: boolean;
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

/**
 * Text already read for a search, by file, size and time it was changed: typing a query searches every meeting again,
 * and most transcripts have not changed since the last key. Bounded, so it never holds more than a few hundred files.
 */
const searchCache = new Map<string, { stamp: string; text: string }>();
const SEARCH_CACHE_FILES = 300;

const contextUpdates = new ContextUpdateService();
const queue = new MeetingDigestService();

/**
 * The chain of a meeting's record, when it has a final confirmed one: corrections can only build on that. Null for a
 * meeting without such a record, whose record is simply the one its update holds.
 */
function chainOf(u: ContextUpdate, m: HeldMeeting, all: ContextUpdate[]): CorrectionChain | null {
  // No record linked to it any more, yet corrections claim it: their chain, broken, so they are never hidden.
  if (!m.record) {
    const claim = all.find((c) => c.kind === CORRECTION_KIND && c.correction?.meeting === m.id);
    return claim?.correction ? correctionChain(m.id, claim.correction.root, all) : null;
  }
  // Also for an original that is not final or not confirmed (any more): corrections that build on it show it broken.
  return correctionChain(m.id, { update_id: u.id, record_id: m.record.id }, all);
}

/**
 * A meeting known only from its corrections: its original update is gone. Listed as broken, with no record of its
 * own, linking to its latest correction, so the corrections are never lost from sight.
 */
function orphan(meeting: string, corrections: ContextUpdate[]): HistoryMeeting {
  const latest = corrections[0]!;
  const r = latest.meeting_records[0];
  return {
    id: meeting, linkable: false, review_state: 'final', record_state: 'none', update_id: latest.id, origin: 'update',
    title: r?.title || meeting, meeting_date: r?.meeting_date ?? '', people: [], recorded: false,
    update: { id: latest.id, title: latest.title, status: latest.status, created_at: latest.created_at, analyzed_at: latest.analyzed_at, applied_at: latest.applied_at, context_changed: false },
    record: null, record_owner: null, unlinked_records: 0, kept: false, deleted: null,
    correction: { state: 'broken', head_at: null, original: latest.correction!.root, open: corrections.filter((u) => u.status !== 'done').map((u) => u.id) },
    retention_start: r?.meeting_date || latest.created_at.slice(0, 10), has_text: false,
  };
}

function summary(u: ContextUpdate, m: HeldMeeting, present: Set<string> | null, chain: CorrectionChain | null = null): HistoryMeeting {
  const deleted = u.deleted_meetings.find((d) => d.meeting === m.key);
  const linked = new Set(heldMeetings(u).map((h) => h.record?.id).filter(Boolean));
  const unlinked = m.origin === 'digest' ? u.meeting_records.filter((r) => !linked.has(r.id)).length : 0;
  // The record shown is the current version: a correction's, once one counts. The files stay the original update's.
  const current = chain?.head && chain.head.update_id !== u.id ? chain.head_record : null;
  const record = current ?? m.record;
  return {
    id: m.id,
    linkable: m.linkable,
    review_state: reviewState(u),
    record_state: m.record ? 'linked' : unlinked ? 'ambiguous' : 'none',
    update_id: u.id,
    origin: m.origin,
    // A correction's values whenever one counts, also an emptied date: never the original's behind it.
    title: current ? current.title : m.title,
    meeting_date: current ? current.meeting_date : m.meeting_date,
    people: (record?.attendees ?? []).map((p) => p.name).filter(Boolean),
    recorded: m.recorded,
    update: {
      id: u.id, title: u.title, status: u.status, created_at: u.created_at, analyzed_at: u.analyzed_at, applied_at: u.applied_at,
      // Something reviewed in it was changed in the context. A digest changes the context as one update, not per meeting.
      context_changed: u.proposals.some((p) => p.decision === 'accepted' && (p.outcome === 'applied' || p.outcome === 'merged' || (p.action === 'remove' && Boolean(p.outcome) && p.outcome !== 'skipped'))),
    },
    record: record ? { id: record.id, revision: record.revision, confirmation: record.confirmation, confirmed_at: record.confirmed_at, link: m.link } : null,
    record_owner: record ? { update_id: current ? chain!.head!.update_id : u.id, record_id: record.id } : null,
    correction: chain && chain.state !== 'original'
      ? { state: chain.state, head_at: chain.head?.at ?? null, original: chain.root, open: chain.open, head_changed: chain.head_changed }
      : chain?.open.length ? { state: 'original', head_at: null, original: chain.root, open: chain.open } : null,
    unlinked_records: unlinked,
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
    const all = await contextUpdates.list();
    for (const u of all) {
      for (const m of heldMeetings(u)) out.push(summary(u, m, null, chainOf(u, m, all)));
    }
    // Corrections whose meeting is no longer held by any update: shown, broken, rather than lost.
    const orphans = new Map<string, ContextUpdate[]>();
    for (const u of all) {
      if (u.kind !== CORRECTION_KIND || !u.correction || out.some((m) => m.id === u.correction!.meeting)) continue;
      orphans.set(u.correction.meeting, [...(orphans.get(u.correction.meeting) ?? []), u]);
    }
    for (const [meeting, corrections] of orphans) out.push(orphan(meeting, corrections));
    return out.sort((a, b) => b.meeting_date.localeCompare(a.meeting_date) || b.update_id.localeCompare(a.update_id) || a.id.localeCompare(b.id));
  }

  /** The update holding a meeting, and the meeting in it. A queued id belongs to the newest digest that names it. */
  private async held(id: string): Promise<{ update: ContextUpdate; meeting: HeldMeeting }> {
    if (!isMeetingId(id)) throw httpError(400, 'Invalid meeting id');
    const imported = importedParts(id);
    const updates = imported ? [await contextUpdates.list().then((all) => all.find((u) => u.id === imported.update))] : await contextUpdates.list();
    for (const u of updates) {
      const meeting = u ? heldMeetings(u).find((m) => m.id === id) : undefined;
      // A record id can still change while its update is reviewed: no feature may hold on to it until it is done.
      if (u && meeting && !meeting.linkable) throw httpError(409, `This meeting waits for the review of ${u.id}: open it in Context > Updates`);
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
    if (!meeting.linkable) throw httpError(409, `This meeting waits for the review of ${update.id}: open it in Context > Updates`);
    const present = new Set(update.material_files.map((f) => f.name));
    const deleted = update.deleted_meetings.find((d) => d.meeting === meeting.key);
    const copies = new Map(update.transcripts.map((t) => [t.file, t]));
    const prefix = meeting.origin === 'digest' ? `${meeting.id}-` : '';
    // Only the files its deletion moved: an audio file or photo was removed when the update was done, not with the meeting.
    const movedWith = (names: string[]) => Boolean(deleted && names.some((n) => deleted.files.includes(n)));
    const why = (names: string[]): string => {
      if (deleted && movedWith(names)) return deleted.trash ? 'Deleted: it is in the trash.' : 'Deleted for good.';
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
        const names = copy ? [file, copy.file] : [file];
        return {
          file, name: file.startsWith(prefix) ? file.slice(prefix.length) : file, kind, present: isPresent,
          state: isPresent ? 'present' as const : deleted?.trash && movedWith(names) ? 'unavailable' as const : 'missing' as const,
          sha256: recordedHash(update, file),
          // A kept recording is read through its transcript, like any original with a readable copy.
          readable: kind === 'transcript' || kind === 'notes' || (kind === 'recording' && Boolean(copy)),
          playable: kind === 'recording' && !deleted && present.has(file),
          missing: isPresent ? null : why(names),
        };
      });
    // A recording whose audio left the queue without going into the digest (Keep recordings off).
    const digest = meeting.origin === 'digest' ? update.digest_meetings.find((m) => m.id === meeting.id) : undefined;
    for (const r of digest?.recordings ?? []) {
      if (r.file === null) sources.push({ file: r.source, name: r.source, kind: 'recording', present: false, state: 'missing', sha256: r.source_sha256 || null, readable: false, playable: false, missing: 'Removed when it went into the digest (Keep recordings is off).' });
    }
    const order = { transcript: 0, notes: 1, recording: 2, file: 3 };
    sources.sort((a, b) => order[a.kind] - order[b.kind] || a.name.localeCompare(b.name));
    const original = meeting.record ? update.meeting_records.find((r) => r.id === meeting.record!.id) ?? null : null;
    const chain = chainOf(update, meeting, await contextUpdates.list());
    // The current version of the record: a correction's once one counts, else the original.
    const record = chain?.head && chain.head.update_id !== update.id ? chain.head_record : original;
    const linked = new Set(heldMeetings(update).map((h) => h.record?.id).filter(Boolean));
    return {
      meeting: summary(update, meeting, present, chain),
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
    const asked = topLevelName(name as string);
    // From here on, the name as the meeting stores it, never the one from the request: a converted transcript holds
    // its file's name, and a response should not echo what the request sent.
    if (QUEUED_MEETING_ID.test(id)) {
      const inQueue = await queue.loadMeeting(id).catch(() => null);
      if (inQueue) {
        const stored = inQueue.files.find((f) => f.name === asked)?.name;
        if (!stored) throw httpError(404, 'No such file in this meeting');
        return this.readAsText(await fileInside(await queue.meetingFolder(id), stored), stored);
      }
    }
    const { update, meeting } = await this.held(id);
    const file = meeting.files.find((f) => f === asked);
    if (!file) throw httpError(404, 'No such file in this meeting');
    if (update.deleted_meetings.some((d) => d.meeting === meeting.key)) throw httpError(410, 'This meeting was deleted');
    const copy = update.transcripts.find((t) => t.source === file);
    const shown = copy ? await contextUpdates.materialPath(update.id, copy.file).catch(() => null) : null;
    if (shown) return this.readAsText(shown, copy!.file);
    const original = await contextUpdates.materialPath(update.id, file).catch(() => null);
    if (!original) throw httpError(410, 'This file is no longer kept');
    return this.readAsText(original, file);
  }

  /**
   * A recording of a meeting, to play: only an audio file of this meeting, never any other file of the workspace. A
   * queued meeting's recording is refused while it is still being recorded.
   */
  async audio(id: string, name: unknown): Promise<string> {
    const asked = topLevelName(name as string);
    if (!AUDIO_EXTENSIONS.has(path.extname(asked).toLowerCase())) throw httpError(415, 'Only a recording can be played here; open the file instead');
    if (QUEUED_MEETING_ID.test(id)) {
      const inQueue = await queue.loadMeeting(id).catch(() => null);
      if (inQueue) {
        const stored = inQueue.files.find((f) => f.name === asked)?.name;
        if (!stored) throw httpError(404, 'No such recording in this meeting');
        if (inQueue.live?.name === stored) throw httpError(409, 'This recording is still being made');
        return fileInside(await queue.meetingFolder(id), stored);
      }
    }
    const { update, meeting } = await this.held(id);
    const file = meeting.files.find((f) => f === asked);
    if (!file) throw httpError(404, 'No such recording in this meeting');
    if (update.deleted_meetings.some((d) => d.meeting === meeting.key)) throw httpError(410, 'This meeting was deleted');
    const full = await contextUpdates.materialPath(update.id, file).catch(() => null);
    if (!full) throw httpError(410, 'This recording is no longer kept');
    return full;
  }

  /**
   * Meetings whose own transcripts and notes hold every word of `query`, with where. Only text the reader can show:
   * queued meetings and meetings an update holds, never one in the trash, never audio or other files.
   */
  async search(query: unknown): Promise<{ results: SearchHit[]; searched: number }> {
    if (typeof query !== 'string' || query.trim().length < MIN_QUERY || query.length > MAX_QUERY) {
      throw httpError(400, `Search for ${MIN_QUERY} to ${MAX_QUERY} characters`);
    }
    const words = queryWords(query);
    const results: SearchHit[] = [];
    let searched = 0;
    const seen = new Set<string>();
    const { meetings: queued } = await queue.readQueue();
    for (const m of queued) {
      // Each recording's transcript (or its live draft), and transcripts or notes added as files: what its reader shows.
      const shown = new Set(m.files.flatMap((f) => [f.recording?.transcript, f.recording?.draft?.transcript].filter((n): n is string => Boolean(n))));
      const names = [...shown, ...m.files.filter((f) => !f.recording && !shown.has(f.name) && isMeetingText(f.name)).map((f) => f.name)];
      const folder = await queue.meetingFolder(m.id).catch(() => null);
      const texts = folder ? await this.searchTexts(names.map((name) => ({ file: name, read: () => fileInside(folder, name) }))) : [];
      seen.add(m.id);
      if (!texts.length) continue;
      searched++;
      const hit = searchMeeting(m.id, texts, words);
      if (hit) results.push(hit);
    }
    for (const u of await contextUpdates.list()) {
      for (const m of heldMeetings(u)) {
        // A meeting being handed to a digest is listed by the queue; one in the trash is not searched.
        if (seen.has(m.id) || u.deleted_meetings.some((d) => d.meeting === m.key)) continue;
        seen.add(m.id);
        const copies = new Map(u.transcripts.map((t) => [t.source, t.file]));
        // An original with a readable copy is read as that copy, named by the original, as the reader does.
        const files = m.files.filter((f) => !u.transcripts.some((t) => t.file === f && m.files.includes(t.source)));
        const texts = await this.searchTexts(files.flatMap((f) => {
          const read = copies.get(f) ?? f;
          return isMeetingText(read) ? [{ file: f, read: () => contextUpdates.materialPath(u.id, read) }] : [];
        }));
        if (!texts.length) continue;
        searched++;
        const hit = searchMeeting(m.id, texts, words);
        if (hit) results.push(hit);
      }
    }
    return { results, searched };
  }

  /** The text of each file that can still be read; one that is gone, too large or not text is left out. */
  private async searchTexts(files: { file: string; read: () => Promise<string> }[]): Promise<{ file: string; text: string }[]> {
    const out: { file: string; text: string }[] = [];
    for (const { file, read } of files) {
      const full = await read().catch(() => null);
      const stat = full ? await fsp.stat(full).catch(() => null) : null;
      if (!full || !stat || stat.size > MAX_CONVERT_BYTES) continue;
      const stamp = `${stat.size}:${stat.mtimeMs}`;
      let text = searchCache.get(full)?.stamp === stamp ? searchCache.get(full)!.text : null;
      if (text === null) {
        text = readableText(path.basename(full), await fsp.readFile(full).catch(() => Buffer.alloc(0)));
        if (text === null) continue;
        searchCache.delete(full);
        searchCache.set(full, { stamp, text });
        if (searchCache.size > SEARCH_CACHE_FILES) searchCache.delete(searchCache.keys().next().value!);
      }
      out.push({ file, text });
    }
    return out;
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
