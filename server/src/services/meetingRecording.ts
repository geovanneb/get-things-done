import * as fsp from 'fs/promises';
import * as path from 'path';
import { constants as fsConstants } from 'fs';
import { createHash, randomUUID } from 'crypto';
import { withWorkspacePath, WorkspaceService } from './workspace';
import { MeetingLiveTranscriptService } from './meetingLiveTranscript';
import { SPEAKER_MODEL, TranscriptionModelService } from './transcriptionModels';
import { knownLanguage, MAX_LANGUAGE_CHANGES, withLanguageChange, type LanguageChange } from './transcription/languages';
import { hasWords } from './transcription/repeats';
import { audioTranscriptMarkdown } from './meetingTranscription';
import { LiveRecording, liveRecordingFile, MAX_RECORDING_BYTES, MeetingDigestService, QueuedMeeting, SPARE_DISK_BYTES } from './meetingDigestService';

/**
 * A meeting recorded in the dashboard, saved as it happens.
 *
 * The page sends 16 kHz mono 16-bit audio every few seconds; each block is appended to a hidden file of its own session
 * in the draft meeting's folder and synced to disk before it is acknowledged. What the server acknowledged survives a
 * closed page, a crash of the dashboard or a restart. What the page has not sent yet does not.
 *
 * The session lives in the meeting's manifest, written before the file exists:
 * - `recording`: blocks are accepted from the page holding the writer token. An offset says where a block belongs, so
 *   a block sent again is compared with what is stored, never added twice; a mismatch is refused.
 * - `finalizing`: the audio is sealed and no block is accepted. Each step can be repeated, and none of them deletes
 *   audio: the header gets its sizes, the file is hashed and checked, renamed to its reserved name, then recorded.
 *
 * Nothing finishes on its own, so a laptop that wakes up can carry on. A recording whose page is gone stays, however
 * old, until the user chooses Finish or Discard, and a new one waits for that: one at a time on a workspace, across
 * dashboards. Acknowledged blocks are synced, which covers a crash of the dashboard or the computer's programs; the
 * folder entries of a rename are not, so a power cut during Finish is not covered: Finish can then be tried again.
 */

const HEADER_BYTES = 44;
const SAMPLE_RATE = 16_000;
const BYTES_PER_SECOND = SAMPLE_RATE * 2;
const MAX_FILES = 10;
/** Audio newer than this means a page is recording: blocks arrive every few seconds. An interrupted recording does not count. */
const RUNNING_MS = 30_000;

function httpError(status: number, message: string, details?: unknown): Error {
  return Object.assign(new Error(message), { statusCode: status, ...(details === undefined ? {} : { details }) });
}

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

/**
 * The workspace of each recording this dashboard started. Its blocks and its Finish stay there, whatever workspace is
 * selected meanwhile from any page, also after a long outage. After a restart of the dashboard the map is empty, and
 * they go to the workspace selected then, which is refused unless it is the same one: the page then says so.
 */
const pinned = new Map<string, string>();
const inWorkspaceOf = <T>(token: string | undefined, fn: () => Promise<T>): Promise<T> => {
  const workspace = token ? pinned.get(hashToken(token)) : undefined;
  return workspace ? withWorkspacePath(workspace, fn) : fn();
};

/** A 16 kHz mono 16-bit WAV header for this much audio. */
export function wavHeader(dataBytes: number): Buffer {
  const head = Buffer.alloc(HEADER_BYTES);
  head.write('RIFF', 0, 'ascii'); head.writeUInt32LE(36 + dataBytes, 4); head.write('WAVE', 8, 'ascii');
  head.write('fmt ', 12, 'ascii'); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22);
  head.writeUInt32LE(SAMPLE_RATE, 24); head.writeUInt32LE(SAMPLE_RATE * 2, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34);
  head.write('data', 36, 'ascii'); head.writeUInt32LE(dataBytes, 40);
  return head;
}

/** Writes all of `data` at `position`: one write call may store only part of it. */
async function writeAll(handle: fsp.FileHandle, data: Buffer, position: number): Promise<void> {
  for (let done = 0; done < data.length;) {
    const { bytesWritten } = await handle.write(data, done, data.length - done, position + done);
    done += bytesWritten;
  }
}

/** Opens the live file for writing, never through a link. */
async function openLive(file: string): Promise<fsp.FileHandle> {
  const handle = await fsp.open(file, fsConstants.O_RDWR | (fsConstants.O_NOFOLLOW ?? 0));
  const st = await handle.stat();
  if (!st.isFile() || st.nlink !== 1) {
    await handle.close();
    throw httpError(409, 'The recording file is not a plain file; it was not changed.');
  }
  return handle;
}

/** Creates the file if the session has none yet, and repairs what a crash left: a cut header or half a sample. */
async function liveFile(file: string): Promise<{ handle: fsp.FileHandle; saved: number }> {
  const created = await fsp.open(file, fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0), 0o600)
    .catch((err: NodeJS.ErrnoException) => { if (err.code === 'EEXIST') return null; throw err; });
  if (created) await created.close();
  const handle = await openLive(file);
  try {
    const { size } = await handle.stat();
    if (size < HEADER_BYTES) { await handle.truncate(0); await writeAll(handle, wavHeader(0), 0); return { handle, saved: 0 }; }
    const saved = (size - HEADER_BYTES) - ((size - HEADER_BYTES) % 2);
    if (size !== HEADER_BYTES + saved) await handle.truncate(HEADER_BYTES + saved);
    return { handle, saved };
  } catch (err) {
    await handle.close();
    throw err;
  }
}

/** No speech in more than this much audio makes a transcript suspicious, as in the queue's job. */
const EMPTY_AUDIO_SECONDS = 60;

export class MeetingRecordingService {
  constructor(
    private readonly queue = new MeetingDigestService(),
    private readonly live = new MeetingLiveTranscriptService(queue),
    private readonly models = new TranscriptionModelService(),
  ) {}

  /** Starts recording into a draft meeting. Starting again with the same token returns the same session. */
  async start(id: string, token: string, now = new Date()): Promise<{ generation: string; offset: number; language: string; language_changes: LanguageChange[] }> {
    if (typeof token !== 'string' || token.length < 16 || token.length > 200) throw httpError(400, 'A writer token is required');
    const language = (await this.models.readSettings().catch(() => null))?.language ?? 'auto';
    const opened = await this.queue.withQueue(async () => {
      const meeting = await this.queue.loadMeeting(id);
      if (meeting.status !== 'draft') throw httpError(409, 'A recording can only go into a meeting before it is queued');
      if (meeting.live) {
        if (meeting.live.token_sha256 !== hashToken(token) || meeting.live.state !== 'recording') throw httpError(409, 'This meeting already has a recording: finish or discard it first');
        return this.opened(meeting);
      }
      if (meeting.files.length >= MAX_FILES) throw httpError(409, `A meeting holds at most ${MAX_FILES} files`);
      // Not judged by how recent its audio is: a page that was only quiet for a while could carry on next to a new one.
      const running = (await this.queue.readQueue()).meetings.find((m) => m.live?.state === 'recording');
      if (running) throw httpError(409, `Another recording is open ("${running.title}"): finish or discard it first`);
      const two = (n: number) => String(n).padStart(2, '0');
      const stamp = `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}`;
      meeting.live = { generation: randomUUID(), token_sha256: hashToken(token), state: 'recording', started_at: now.toISOString(), name: `recording-${stamp}.wav`, language };
      // The session first: a file exists only with a session that protects it.
      await this.queue.saveMeeting(meeting);
      return this.opened(meeting);
    });
    const workspace = new WorkspaceService().getWorkspacePath();
    pinned.set(hashToken(token), workspace);
    // Never waited for, and never fails the recording.
    void this.live.start(id, opened.generation, workspace, opened.offset, opened.language, opened.language_changes).catch(() => {});
    return opened;
  }

  /**
   * The spoken language from now on, for this recording's transcripts: from what is saved so far, which is what
   * `at` in the reply says. Under the lock, so Finish and every block of audio are either before or after it.
   */
  async setLanguage(id: string, token: string, language: unknown): Promise<{ language: string; language_changes: LanguageChange[]; at: number }> {
    if (!knownLanguage(language)) throw httpError(400, 'Invalid language: use auto or the code of a language in Settings');
    return inWorkspaceOf(token, () => this.queue.withQueue(async () => {
      const meeting = await this.queue.loadMeeting(id);
      const live = meeting.live;
      if (live?.state !== 'recording' || live.token_sha256 !== hashToken(token ?? '')) throw httpError(409, 'This page no longer holds the recording: it was finished, discarded or taken over elsewhere.');
      const { handle, saved } = await liveFile(path.join(await this.queue.meetingFolder(id), liveRecordingFile(live.generation)));
      await handle.close();
      const at = saved / BYTES_PER_SECOND;
      const start = live.language ?? 'auto';
      const changes = withLanguageChange(start, live.language_changes ?? [], { at, language });
      if (changes.length > MAX_LANGUAGE_CHANGES) throw httpError(409, 'The language was changed too many times in this recording');
      const { language_changes: _old, ...rest } = live;
      meeting.live = { ...rest, language: start, ...(changes.length ? { language_changes: changes } : {}) };
      await this.queue.saveMeeting(meeting);
      this.live.language(live.generation, changes, { at, language });
      return { language, language_changes: changes, at };
    }));
  }

  /** The title of a recording audio arrived for just now. A workspace does not change under it, from any page. */
  async running(now = new Date()): Promise<string | null> {
    for (const m of (await this.queue.readQueue()).meetings) {
      if (m.live?.state !== 'recording') continue;
      const st = await fsp.lstat(path.join(await this.queue.meetingFolder(m.id), liveRecordingFile(m.live.generation))).catch(() => null);
      if (st && now.getTime() - st.mtime.getTime() < RUNNING_MS) return m.title;
    }
    return null;
  }

  private async opened(meeting: QueuedMeeting): Promise<{ generation: string; offset: number; language: string; language_changes: LanguageChange[] }> {
    const { handle, saved } = await liveFile(path.join(await this.queue.meetingFolder(meeting.id), liveRecordingFile(meeting.live!.generation)));
    await handle.close();
    return { generation: meeting.live!.generation, offset: saved, language: meeting.live!.language ?? 'auto', language_changes: meeting.live!.language_changes ?? [] };
  }

  /** Stores a block of audio at `offset` (bytes of audio, without the header) and says how much is safely stored. */
  async append(id: string, token: string, offset: number, block: Buffer): Promise<{ offset: number }> {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset % 2 !== 0) throw httpError(400, 'Invalid offset');
    if (!Buffer.isBuffer(block) || block.length === 0 || block.length % 2 !== 0) throw httpError(400, 'A block of audio is whole 16-bit samples');
    return inWorkspaceOf(token, () => this.queue.withQueue(async () => {
      const meeting = await this.queue.loadMeeting(id);
      if (meeting.live?.state !== 'recording' || meeting.live.token_sha256 !== hashToken(token ?? '')) {
        throw httpError(409, 'This page no longer holds the recording: it was finished, discarded or taken over elsewhere.');
      }
      const folder = await this.queue.meetingFolder(id);
      const { handle, saved } = await liveFile(path.join(folder, liveRecordingFile(meeting.live.generation)));
      try {
        if (offset > saved) throw httpError(409, 'Audio is missing before this block', { offset: saved });
        const overlap = Math.min(saved - offset, block.length);
        if (overlap > 0) {
          const stored = Buffer.alloc(overlap);
          await handle.read(stored, 0, overlap, HEADER_BYTES + offset);
          if (!stored.equals(block.subarray(0, overlap))) throw httpError(409, 'This block differs from the audio already stored', { offset: saved });
        }
        const rest = block.subarray(overlap);
        // Sent again after a crash: the block may be on the disk's way only, so it is synced before it is acknowledged.
        if (rest.length === 0) { await handle.datasync(); this.live.committed(meeting.live.generation, saved); return { offset: saved }; }
        const others = meeting.files.filter((f) => f.recording).reduce((sum, f) => sum + f.size, 0);
        if (others + HEADER_BYTES + saved + rest.length > MAX_RECORDING_BYTES) throw httpError(413, 'A meeting holds at most 4 GB of recordings');
        const disk = await fsp.statfs(folder).catch(() => null);
        if (disk && disk.bavail * disk.bsize < rest.length + SPARE_DISK_BYTES) throw httpError(507, 'The disk is nearly full: the recording stopped here, and what was saved is kept.');
        try {
          await writeAll(handle, rest, HEADER_BYTES + saved);
          await handle.datasync();
        } catch (err) {
          // Back to the last whole block: what was acknowledged stays, and the page can send this one again.
          await handle.truncate(HEADER_BYTES + saved).catch(() => {});
          if ((err as NodeJS.ErrnoException).code === 'ENOSPC') throw httpError(507, 'The disk is full: the recording stopped here, and what was saved is kept.');
          throw err;
        }
        // Saved and synced: the live transcript may read this far.
        this.live.committed(meeting.live.generation, saved + rest.length);
        return { offset: saved + rest.length };
      } finally {
        await handle.close();
      }
    }));
  }

  /**
   * Seals the recording and adds it to the meeting. With the token, `offset` must be what the server holds. With
   * `recover` (the user's Finish on an interrupted recording) what is stored is sealed, and any page still sending is
   * refused from then on; it needs the `generation` the user saw. Safe to repeat, and to run twice at once, also after
   * a lost reply or a crash at any step. With `queue`, the meeting is queued too, in the same workspace.
   */
  async finish(id: string, input: { token?: string; offset?: number; recover?: boolean; generation?: string; queue?: boolean }): Promise<QueuedMeeting> {
    return inWorkspaceOf(input.token, async () => {
      const meeting = await this.seal(id, input);
      if (input.token) pinned.delete(hashToken(input.token));
      return input.queue && !meeting.live ? this.queue.queue(id) : meeting;
    });
  }

  private async seal(id: string, input: { token?: string; offset?: number; recover?: boolean; generation?: string }): Promise<QueuedMeeting> {
    // Kept from the first look: if another Finish completes this one meanwhile, the next look must recognise it.
    let generation = input.generation;
    for (let attempt = 0; ; attempt++) {
      const sealed = await this.queue.withQueue(async () => {
        const meeting = await this.queue.loadMeeting(id);
        // The reply to an earlier call was lost: it is done, whatever came after it.
        if (generation && meeting.files.some((f) => f.capture === generation)) return null;
        const live = meeting.live;
        if (!live) throw httpError(409, 'This meeting has no recording to finish');
        if (live.state === 'damaged') throw httpError(409, 'The record of this recording cannot be read: its file is kept. Remove the meeting to discard it.');
        if (generation && live.generation !== generation) throw httpError(409, 'This meeting holds a different recording now');
        if (input.recover && !generation) throw httpError(400, 'Finishing an interrupted recording needs its generation');
        if (live.state === 'finalizing') return live;
        const folder = await this.queue.meetingFolder(id);
        const { handle, saved } = await liveFile(path.join(folder, liveRecordingFile(live.generation)));
        await handle.datasync().finally(() => handle.close());
        if (!input.recover) {
          if (live.token_sha256 !== hashToken(input.token ?? '')) throw httpError(409, 'This page no longer holds the recording: it was finished, discarded or taken over elsewhere.');
          if (input.offset !== saved) throw httpError(409, 'Audio is still on its way', { offset: saved });
        }
        if (saved === 0) throw httpError(409, 'Nothing was recorded; discard this meeting instead');
        // What to transcribe it with is fixed here, once: Settings may change before the queue gets to it.
        const settings = await this.models.readSettings().catch(() => null);
        const speakers = settings?.speakers === true && Boolean(await this.models.installedPath(SPEAKER_MODEL.id).catch(() => null));
        meeting.live = { ...live, state: 'finalizing', sealed_bytes: saved, ...(settings ? { target: { model: settings.model, language: live.language ?? settings.language, ...(live.language_changes ? { changes: live.language_changes } : {}), ...(speakers ? { speakers } : {}) } } : {}) };
        await this.queue.saveMeeting(meeting);
        return meeting.live;
      });
      if (!sealed) return this.queue.loadMeeting(id);
      generation = sealed.generation;
      try {
        // The live transcript reads to the seal and lets go of the file before anything changes it. Without the lock.
        const live = await this.live.finalize(sealed.generation, sealed.sealed_bytes!).catch(() => null);
        // Hashing gigabytes runs without the lock; nothing can change a sealed recording.
        const checked = await this.checkSealed(id, sealed);
        // Its own text is the transcript when it is the chosen model and found speech; otherwise the queue transcribes it.
        // Covered everything and found words: its text is kept, as the transcript when it is the target model and
        // language, else as a draft while the target model transcribes again.
        const usable = live && !(!hasWords(live.segments.map((x) => x.text)) && live.seconds > EMPTY_AUDIO_SECONDS) ? live : null;
        const target = sealed.target;
        // Speakers come from the transcript after the meeting, so a live text stays a draft when they are wanted.
        const final = Boolean(usable && target && !target.speakers && usable.model === target.model && usable.asked === target.language && !usable.lateLanguage
          && JSON.stringify(usable.askedChanges) === JSON.stringify(target.changes ?? []));
        const published = await this.queue.withQueue(async () => {
          const meeting = await this.queue.loadMeeting(id);
          if (meeting.live?.generation !== sealed.generation || meeting.live.state !== 'finalizing') return meeting;
          await this.queue.publishRecording(meeting, checked, usable ? {
            content: (recordingName) => Buffer.from(audioTranscriptMarkdown(recordingName, checked.sha256, usable.model, usable.language, usable.seconds, usable.segments, true, usable.changes, usable.lateLanguage), 'utf-8'),
            model: usable.model, language: usable.language, seconds: usable.seconds, as: final ? 'transcript' : 'draft',
          } : undefined);
          return this.queue.loadMeeting(id);
        });
        await this.live.close(sealed.generation);
        return published;
      } catch (err) {
        // Another Finish moved the file while this one read it: look again at where things stand.
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT' || attempt >= 2) throw err;
      }
    }
  }

  /** Reads a sealed recording under whichever name it has now: exactly the sealed audio, in a plain file, or it stays. */
  private async checkSealed(id: string, live: LiveRecording): Promise<{ size: number; sha256: string }> {
    const folder = await this.queue.meetingFolder(id);
    const hidden = path.join(folder, liveRecordingFile(live.generation));
    const inPlace = await fsp.lstat(hidden).then(() => true, () => false);
    const handle = await openLive(inPlace ? hidden : path.join(folder, live.name));
    try {
      const want = HEADER_BYTES + live.sealed_bytes!;
      const { size } = await handle.stat();
      if (inPlace && size < want) throw httpError(409, 'The recording is shorter than what was saved: its file is kept.');
      if (!inPlace && size !== want) throw httpError(409, 'The finished recording is not the one that was saved: its file is kept.');
      if (inPlace) {
        // Only what was sealed: a block written before the seal was acknowledged is cut here, never after.
        if (size > want) await handle.truncate(want);
        await writeAll(handle, wavHeader(live.sealed_bytes!), 0);
        await handle.sync();
      }
      const head = Buffer.alloc(HEADER_BYTES);
      await handle.read(head, 0, HEADER_BYTES, 0);
      if (!head.equals(wavHeader(live.sealed_bytes!))) throw httpError(409, 'The finished recording is not the one that was saved: its file is kept.');
      const hash = createHash('sha256');
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      for (let position = 0; position < want;) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, want - position), position);
        if (bytesRead === 0) throw httpError(409, 'The recording is shorter than what was saved: its file is kept.');
        hash.update(buffer.subarray(0, bytesRead));
        position += bytesRead;
      }
      return { size: want, sha256: hash.digest('hex') };
    } finally {
      await handle.close();
    }
  }
}

export type { LiveRecording };
