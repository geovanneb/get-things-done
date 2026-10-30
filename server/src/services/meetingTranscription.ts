import * as fsp from 'fs/promises';
import * as path from 'path';
import { execFile } from 'child_process';
import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import { MeetingDigestService, QueuedMeeting, RecordingState } from './meetingDigestService';
import { TranscriptionModelService, CATALOG } from './transcriptionModels';
import { TranscriptionEngine, Segment } from './transcription/engine';
import { hashFile } from '../utils/fileHash';
import { HeldLock, tryLock, unlock } from '../utils/fileLock';
import { processAlive } from './runState';
import { atomicWrite } from '../utils/atomicWrite';
import { clock } from '../utils/transcript';
import { fileInside } from '../utils/files';

/**
 * Transcribes the recordings in the meeting queue, one at a time, on this computer.
 *
 * A meeting with a recording waits in the queue until its transcript is made. On each routine check (once a
 * minute, also when the digest is switched off) and right after a meeting is queued, the job picks the oldest
 * queued recording that waits and transcribes it with the model chosen in Settings > Transcription:
 *
 * - **Claim**, under the queue lock: the meeting is queued, not on hold and not held by a digest being made; the
 *   recording still has its hash; it becomes `running` with a new generation and this process as its owner.
 * - **Work**, without the lock: a recording that is not WAV is converted first (on a Mac, with its own
 *   `afconvert`), then the engine transcribes it in its worker.
 * - **Publish**, under the queue lock: only if the meeting is still there, not held by a digest, and the recording
 *   is still `running` with the same generation and owner and the same hash. The transcript becomes a file of the
 *   meeting (`<name>.transcript.md`), and the recording `done`, or `partial` when the job stopped part way or found
 *   no speech in more than a minute of audio: a partial transcript waits for "Use this transcript" or "Try again".
 *
 * One job runs across every dashboard on this workspace (`.situation-board/routines/transcription.lock`, held for
 * the whole job). Stop revokes the job's generation, so whatever it finds is never published. A recording left
 * `running` by a dashboard that is gone goes back to `pending`. The recording itself is always kept.
 */

/** No speech in more than this much audio makes a transcript suspicious: it is kept as partial, not used. */
const EMPTY_AUDIO_SECONDS = 60;
const MAC_CONVERTER = '/usr/bin/afconvert';
/** Progress reaches the dashboard at most this often. */
const NOTIFY_MS = 1000;
/** How often a running job checks it is still wanted: a Stop or a removal from another dashboard ends it. Tests shorten it. */
export const transcriptionTimings = { ownerCheckMs: 15_000 };

export interface TranscriptionProgress { meeting: string; file: string; done: number; total: number; started_at: string }

/** Notices for the dashboard when a transcription starts, moves or ends. */
export const meetingTranscriptionEvents = new EventEmitter();

interface Job { meeting: string; file: string; generation: string; token: string; abort: AbortController; progress: TranscriptionProgress; lock: HeldLock }
/** The job this dashboard runs; null when none. */
let active: Job | null = null;
/** Checks still choosing a job; tests wait for them too. */
let ticking = 0;

const digest = new MeetingDigestService();

function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode: status });
}

/** A readable transcript of a recording, in the same shape as the copies of WebVTT transcripts. */
export function audioTranscriptMarkdown(source: string, hash: string, model: string, language: string, seconds: number, segments: Segment[], complete: boolean): string {
  const body = segments.map((s) => `[${clock(s.start)} → ${clock(s.end)}]\n  ${s.text.replace(/\n+/g, ' ')}`).join('\n\n');
  let longest = 2;
  for (const m of body.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  const fence = '`'.repeat(longest + 1);
  const name = CATALOG.find((c) => c.id === model)?.name ?? model;
  return [
    `# Transcript: ${source}`,
    '',
    `Made on this computer from the recording \`${source}\` with ${name} (language: ${language === 'auto' ? 'detected for each part' : language}). Source SHA-256: \`${hash}\`.`,
    '',
    `- Length: ${clock(seconds)}, ${segments.length} parts with speech`,
    '- Speakers are not told apart: each part is what was said, in order.',
    '',
    complete
      ? '**Complete.** Every part of the recording with speech is below.'
      : '**Partial.** The transcription stopped part way, or found little speech. Listen to the recording for what is missing.',
    '',
    'Each part starts with a line `[start → end]`; what was said follows, indented by two spaces.',
    '',
    `${fence}text`,
    body,
    fence,
    '',
  ].join('\n');
}

export class MeetingTranscriptionService {
  constructor(
    private readonly queue = digest,
    private readonly models = new TranscriptionModelService(),
    private readonly engine = new TranscriptionEngine(),
  ) {}

  /** The transcription running in this dashboard, with its progress. */
  progress(): TranscriptionProgress | null {
    return active ? { ...active.progress } : null;
  }

  /**
   * Starts the next transcription, if one waits and none runs. Returns at once: the job runs in the background.
   * Also puts back recordings left running by a dashboard that is gone. Safe to call often.
   */
  async tick(): Promise<void> {
    ticking++;
    try { await this.next(); } finally { ticking--; }
  }

  private async next(): Promise<void> {
    if (active) return;
    await this.recover().catch((err: Error) => console.error(`[transcription] Recovery: ${err.message}`));
    const settings = await this.models.readSettings();
    if (!await this.models.installedPath(settings.model)) return;
    const routines = await this.queue.routinesFolder();
    const held = await tryLock(path.join(routines, 'transcription.lock'));
    if (typeof held === 'string') return;
    let job: Job | null = null;
    try {
      job = await this.claim(settings.model, settings.language, held);
    } finally {
      if (!job) await unlock(held);
    }
    if (!job) return;
    active = job;
    meetingTranscriptionEvents.emit('change');
    const claimed = job;
    // The job runs on its own: whatever happens in it is caught here, and it always gives back its lock.
    void (async () => {
      try {
        await this.run(claimed, settings.model, settings.language);
      } catch (err) {
        console.error(`[transcription] ${claimed.meeting}/${claimed.file}: ${(err as Error).message}`);
      } finally {
        if (active === claimed) active = null;
        await unlock(claimed.lock).catch(() => {});
        meetingTranscriptionEvents.emit('change');
      }
    })();
  }

  /** Starts the next job without waiting; a failure is logged, never thrown at nobody. */
  private kick(): void {
    this.tick().catch((err: Error) => console.error(`[transcription] ${err.message}`));
  }

  /** Stops a recording's transcription: it is never published, and the recording waits for "Try again". */
  async stop(meetingId: string, file: string): Promise<QueuedMeeting> {
    const meeting = await this.change(meetingId, file, (r) => {
      if (r.status !== 'running' && r.status !== 'pending') throw httpError(409, 'This recording is not being transcribed');
      const { owner: _owner, generation: _generation, ...rest } = r;
      return { ...rest, status: 'stopped' };
    });
    if (active && active.meeting === meetingId && active.file === file) active.abort.abort();
    return meeting;
  }

  /** Puts a stopped, failed or partial recording back in line for transcription. */
  async retry(meetingId: string, file: string): Promise<QueuedMeeting> {
    let dropped: string | undefined;
    const meeting = await this.change(meetingId, file, (r, m) => {
      if (!['stopped', 'failed', 'partial'].includes(r.status)) throw httpError(409, 'Only a stopped, failed or partial transcription can be tried again');
      // A partial transcript gives way to the new one, so a digest never gets both.
      if (r.transcript) { dropped = r.transcript; m.files = m.files.filter((f) => f.name !== r.transcript); }
      return { status: 'pending' };
    });
    if (dropped) {
      const file = await fileInside(await this.queue.meetingFolder(meetingId), dropped).catch(() => null);
      if (file) await fsp.rm(file, { force: true }).catch(() => {});
    }
    this.kick();
    return meeting;
  }

  /** Ends this dashboard's job for a meeting that was removed from the queue. */
  forget(meetingId: string): void {
    if (active?.meeting === meetingId) active.abort.abort();
  }

  /** Uses a partial transcript as it is: the meeting can then go into a digest. The recording is kept. */
  async accept(meetingId: string, file: string): Promise<QueuedMeeting> {
    return this.change(meetingId, file, (r) => {
      if (r.status !== 'partial' || !r.transcript) throw httpError(409, 'Only a partial transcript can be used as it is');
      return { ...r, accepted: true };
    });
  }

  /** Changes one recording's state under the queue lock; never one held by a digest being made. */
  private async change(meetingId: string, file: string, next: (r: RecordingState, meeting: QueuedMeeting) => RecordingState): Promise<QueuedMeeting> {
    return this.queue.withQueue(async () => {
      if ((await this.queue.reserved()).includes(meetingId)) throw httpError(409, 'A digest is being made from this meeting; try again in a moment');
      const meeting = await this.queue.loadMeeting(meetingId);
      const entry = meeting.files.find((f) => f.name === file);
      if (!entry?.recording) throw httpError(404, `No recording ${file} in this meeting`);
      entry.recording = next(entry.recording, meeting);
      await this.queue.saveMeeting(meeting);
      return this.queue.loadMeeting(meetingId);
    });
  }

  /**
   * Recordings left running by a dashboard that is gone go back to pending. Files a dashboard wrote but never
   * recorded in the manifest (a transcript, before a crash) are removed, and so are work files whose job is over:
   * each is named after its job and the dashboard that runs it, which keeps it while that dashboard lives.
   */
  private async recover(): Promise<void> {
    await this.queue.withQueue(async () => {
      const reserved = await this.queue.reserved().catch(() => null);
      if (reserved === null) return; // a damaged batch: change nothing until it is resolved
      for (const meeting of (await this.queue.readQueue()).meetings) {
        if (reserved.includes(meeting.id)) continue;
        // One meeting that cannot be recovered (a link where a folder belongs) never holds up the others.
        await this.recoverMeeting(meeting).catch((err: Error) => console.error(`[transcription] ${meeting.id}: ${err.message}`));
      }
    });
  }

  private async recoverMeeting(meeting: QueuedMeeting): Promise<void> {
    let changed = false;
    for (const f of meeting.files) {
      const r = f.recording;
      if (r?.status !== 'running') continue;
      const ours = r.owner?.pid === process.pid;
      const owned = ours ? active?.generation === r.generation : r.owner && processAlive(r.owner.pid);
      if (owned) continue;
      f.recording = { status: 'pending' };
      changed = true;
    }
    if (changed) await this.queue.saveMeeting(meeting);
    const folder = await this.queue.meetingFolder(meeting.id);
    await this.queue.dropUnrecorded(meeting, folder);
    const work = await workFolder(folder, false);
    for (const name of work ? await fsp.readdir(work) : []) {
      const m = /^([0-9a-f-]{36})-(\d+)\.wav$/.exec(name);
      const pid = m ? Number(m[2]) : 0;
      const running = pid === process.pid ? active?.generation === m![1] : pid > 0 && processAlive(pid);
      if (!running) await fsp.rm(path.join(work!, name), { force: true });
    }
  }

  /** Picks the oldest waiting recording and marks it running for this job, under the queue lock. */
  private async claim(model: string, language: string, lock: HeldLock): Promise<Job | null> {
    return this.queue.withQueue(async () => {
      const reserved = await this.queue.reserved();
      for (const meeting of (await this.queue.readQueue()).meetings) {
        if (meeting.status !== 'queued' || meeting.held || reserved.includes(meeting.id)) continue;
        const folder = await this.queue.meetingFolder(meeting.id).catch(() => null);
        if (!folder) continue;
        // A recording that cannot be read fails on its own; the queue goes on with the next one.
        let entry: QueuedMeeting['files'][number] | undefined;
        for (const candidate of meeting.files.filter((f) => f.recording?.status === 'pending')) {
          const read = await fileInside(folder, candidate.name).then(hashFile).catch((err: Error) => err);
          const problem = read instanceof Error ? `The recording cannot be read (${read.message}); remove the meeting and add it again.`
            : read.sha256 !== candidate.sha256 ? 'The recording changed since it was added; remove the meeting and add it again.' : null;
          if (!problem) { entry = candidate; break; }
          candidate.recording = { status: 'failed', error: problem };
          await this.queue.saveMeeting(meeting);
        }
        if (!entry) continue;
        const generation = randomUUID();
        const token = randomUUID();
        entry.recording = { status: 'running', generation, owner: { pid: process.pid, token }, started_at: new Date().toISOString(), model, language };
        await this.queue.saveMeeting(meeting);
        return {
          meeting: meeting.id, file: entry.name, generation, token, abort: new AbortController(), lock,
          progress: { meeting: meeting.id, file: entry.name, done: 0, total: 0, started_at: new Date().toISOString() },
        };
      }
      return null;
    });
  }

  /** Converts and transcribes outside the lock, then publishes or records the failure. */
  private async run(job: Job, model: string, language: string): Promise<void> {
    let wav: string | null = null;
    let converted = false;
    const segments: Segment[] = [];
    let seconds = 0;
    let error: Error | null = null;
    let notified = 0;
    // Checked on its own clock, through conversion and model loading too: a Stop or a removal from another
    // dashboard ends the job even while it reports no progress.
    const owner = setInterval(() => {
      this.stillOurs(job).then((ours) => { if (!ours) job.abort.abort(); }, () => {});
    }, transcriptionTimings.ownerCheckMs);
    try {
      const folder = await this.queue.meetingFolder(job.meeting);
      const source = await fileInside(folder, job.file);
      wav = source;
      if (path.extname(job.file).toLowerCase() !== '.wav') {
        converted = true;
        wav = path.join((await workFolder(folder, true))!, `${job.generation}-${process.pid}.wav`);
        await convert(source, wav, job.abort.signal);
      }
      const result = await this.engine.transcribe(wav, {
        model, language, signal: job.abort.signal,
        onSegment: (s) => { segments.push(s); },
        onProgress: (done, total) => {
          job.progress = { ...job.progress, done, total };
          const now = Date.now();
          if (now - notified >= NOTIFY_MS) { notified = now; meetingTranscriptionEvents.emit('change'); }
        },
      });
      seconds = result.seconds;
    } catch (err) {
      error = err as Error;
    } finally {
      clearInterval(owner);
      // A work file that cannot be removed now is removed by a later recovery; the result still counts.
      if (converted && wav) await fsp.rm(wav, { force: true }).catch(() => {});
    }
    try {
      await this.publish(job, model, language, segments, seconds || job.progress.total, error);
    } catch (err) {
      console.error(`[transcription] ${job.meeting}/${job.file}: ${(err as Error).message}`);
    }
  }

  /** False once the recording is no longer this job's: stopped or removed, possibly from another dashboard. */
  private async stillOurs(job: Job): Promise<boolean> {
    const meeting = await this.queue.loadMeeting(job.meeting).catch((err: { statusCode?: number }) => (err.statusCode === 404 ? null : undefined));
    if (meeting === undefined) return true; // unreadable for a moment: keep going, publish checks again
    const r = meeting?.files.find((f) => f.name === job.file)?.recording;
    return Boolean(r && r.status === 'running' && r.generation === job.generation && r.owner?.token === job.token);
  }

  /** Keeps the result only if the recording is still this job's; otherwise it is dropped. */
  private async publish(job: Job, model: string, language: string, segments: Segment[], seconds: number, error: Error | null): Promise<void> {
    await this.queue.withQueue(async () => {
      if ((await this.queue.reserved()).includes(job.meeting)) return;
      const meeting = await this.queue.loadMeeting(job.meeting).catch(() => null);
      const entry = meeting?.files.find((f) => f.name === job.file);
      const r = entry?.recording;
      if (!meeting || !entry || r?.status !== 'running' || r.generation !== job.generation || r.owner?.token !== job.token) return;
      const folder = await this.queue.meetingFolder(job.meeting);
      if ((await fileInside(folder, entry.name).then(hashFile).catch(() => null))?.sha256 !== entry.sha256) {
        entry.recording = { status: 'failed', error: 'The recording changed or went missing while it was being transcribed.' };
        await this.queue.saveMeeting(meeting);
        return;
      }
      if (error && segments.length === 0) {
        entry.recording = { status: 'failed', model, language, error: error.message };
        await this.queue.saveMeeting(meeting);
        return;
      }
      const complete = !error && !(segments.length === 0 && seconds > EMPTY_AUDIO_SECONDS);
      const stem = entry.name.replace(/\.[^.]+$/, '') || 'recording';
      let name = `${stem}.transcript.md`;
      for (let n = 2; meeting.files.some((f) => f.name.toLowerCase() === name.toLowerCase())
        || await fsp.lstat(path.join(folder, name)).then(() => true, () => false); n++) name = `${stem}-${n}.transcript.md`;
      const content = Buffer.from(audioTranscriptMarkdown(entry.name, entry.sha256, model, language, seconds, segments, complete), 'utf-8');
      const target = path.join(folder, name);
      await atomicWrite(target, content);
      try {
        const { sha256 } = await hashFile(target);
        meeting.files.push({ name, size: content.length, sha256 });
        entry.recording = {
          status: complete ? 'done' : 'partial', model, language, transcript: name, transcript_sha256: sha256, seconds,
          ...(error ? { error: error.message } : !complete ? { error: 'No speech was found in more than a minute of audio.' } : {}),
        };
        await this.queue.saveMeeting(meeting);
      } catch (err) {
        // Not recorded, so not kept; a crash right here leaves it to recovery, which removes unrecorded files.
        await fsp.rm(target, { force: true }).catch(() => {});
        throw err;
      }
    });
  }

  /** For tests: waits until no transcription runs in this process. */
  static async settled(): Promise<void> {
    while (active || ticking) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 20));
  }
}

/**
 * The meeting's work folder for converted audio, `.transcribing`: a real folder, never a link. Made when `make`
 * is set; otherwise null when there is none.
 */
async function workFolder(folder: string, make: boolean): Promise<string | null> {
  const work = path.join(folder, '.transcribing');
  if (make) await fsp.mkdir(work).catch((err: NodeJS.ErrnoException) => { if (err.code !== 'EEXIST') throw err; });
  const st = await fsp.lstat(work).catch(() => null);
  if (!st) return null;
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('The meeting\'s .transcribing folder is not a plain folder; remove it.');
  return work;
}

/** Converts a recording to 16 kHz mono WAV with the Mac's own converter. Stops with the job. */
function convert(source: string, target: string, signal: AbortSignal): Promise<void> {
  if (process.platform !== 'darwin') return Promise.reject(new Error('This recording format can be converted on a Mac only; use WAV on this computer.'));
  return new Promise((resolve, reject) => {
    execFile(MAC_CONVERTER, ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', source, target], { signal, timeout: 60 * 60 * 1000 }, (err, _stdout, stderr) => {
      if (err) reject(new Error(signal.aborted ? 'Cancelled.' : `The recording could not be converted: ${String(stderr || err.message).trim().split('\n').pop()}`));
      else resolve();
    });
  });
}
