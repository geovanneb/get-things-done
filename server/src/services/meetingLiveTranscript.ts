import * as fsp from 'fs/promises';
import * as path from 'path';
import { EventEmitter } from 'events';
import { constants as fsConstants } from 'fs';
import { MeetingDigestService, liveRecordingFile } from './meetingDigestService';
import { TranscriptionModelService } from './transcriptionModels';
import { FollowSession, Segment, TranscriptionEngine } from './transcription/engine';
import { withWorkspacePath } from './workspace';

/**
 * A live transcript while a meeting is recorded: the transcription worker follows the recording file as it grows and
 * transcribes each stretch of speech as it ends.
 *
 * It never costs the recording. The worker reads only audio the recording service reports as saved, and at Finish its
 * text becomes the recording's transcript only if the worker confirms it covered every saved byte. Otherwise, after a
 * crash, a restart, a Finish from another dashboard, or a computer that cannot keep up, the recording goes to the
 * queue as before and is transcribed after the meeting.
 *
 * Each stretch is written, numbered, to a hidden `.live-transcript-<generation>.jsonl` next to the recording, before
 * the page is told; a page that reloads or reconnects reads on from its last number. The job runs in the dashboard
 * that started the recording, holding the engine's one job at a time.
 */

const BYTES_PER_SECOND = 32_000;
/** At Finish, the worker gets this long to catch up, counted once per recording. */
const FINISH_MS = 2 * 60 * 1000;
/** Behind by more than this for longer than LAG_MS, the live transcript gives up; the recording goes on. */
const LAG_SECONDS = 60;
const LAG_MS = 30_000;
/** The live transcript of 8 hours is about 2 MB; this much means something is wrong. */
const MAX_JSONL_BYTES = 20 * 1024 * 1024;
/** Segments per catch-up page. */
const PAGE = 500;

export const liveTranscriptFile = (generation: string) => `.live-transcript-${generation}.jsonl`;

export type LiveStatus = 'loading' | 'live' | 'finishing' | 'stopped' | 'done';

export interface LiveSegment extends Segment { i: number }

export interface Job {
  meetingId: string;
  generation: string;
  workspace: string;
  model: string;
  language: string;
  /** The model chosen for transcripts, when the recording started: the live text is used as the transcript only with it. */
  mainModel: string;
  file: string;
  session: FollowSession | null;
  status: LiveStatus;
  /** Why it stopped while the recording went on. */
  reason: string | null;
  segments: LiveSegment[];
  /** How many segments are saved to the file: only those are shown or announced. */
  saved: number;
  /** Set while the job is starting; Finish waits for it. */
  starting: Promise<void> | null;
  /** Checks, every few seconds, that the recording is still this job's: a Finish or discard elsewhere ends it. */
  watch: ReturnType<typeof setInterval> | null;
  /** When the recording was first seen sealed without this dashboard finishing it. */
  sealedSince: number | null;
  bytes: number;
  writes: Promise<void>;
  writeFailed: boolean;
  committed: number;
  processed: number;
  behindSince: number | null;
  finishing: Promise<LiveResult | null> | null;
  deadline: number | null;
}

/** A live transcript that covered all of a sealed recording. */
export interface LiveResult { model: string; language: string; seconds: number; segments: Segment[]; mainModel: string }

/** Notices for the page: a recording's live transcript has more, or changed status. */
export const liveTranscriptEvents = new EventEmitter();

const jobs = new Map<string, Job>();

function emit(job: Job): void {
  liveTranscriptEvents.emit('change', { meeting: job.meetingId, generation: job.generation, next: job.saved, status: job.status });
}

/** Ends the live transcript early; the recording goes on, and is transcribed after the meeting. */
function stopJob(job: Job, reason: string): void {
  if (job.status === 'stopped' || job.status === 'done') return;
  job.status = 'stopped';
  job.reason = reason;
  if (job.watch) { clearInterval(job.watch); job.watch = null; }
  void job.session?.cancel();
  emit(job);
}

/** How often a running job checks its recording is still its own. */
const WATCH_MS = 5000;

export class MeetingLiveTranscriptService {
  constructor(
    private readonly queue = new MeetingDigestService(),
    private readonly models = new TranscriptionModelService(),
    private readonly engine = new TranscriptionEngine(),
  ) {}

  /**
   * Starts the live transcript of a recording that just started (or restarted in this dashboard), when Settings has
   * a live model. Returns at once; it never fails the recording.
   */
  async start(meetingId: string, generation: string, workspace: string, saved: number): Promise<void> {
    if (jobs.has(generation)) return;
    // Taken at once, before anything is awaited: a second start, a Finish or a discard always find this job.
    const job: Job = {
      meetingId, generation, workspace, model: '', language: 'auto', mainModel: '',
      file: '', session: null, status: 'loading', reason: null, segments: [], saved: 0, starting: null, watch: null, sealedSince: null, bytes: 0,
      writes: Promise.resolve(), writeFailed: false, committed: saved, processed: 0, behindSince: null, finishing: null, deadline: null,
    };
    jobs.set(generation, job);
    job.starting = this.open(job).catch(() => {});
    await job.starting;
  }

  private async open(job: Job): Promise<void> {
    const { meetingId, generation, workspace } = job;
    const settings = await this.models.readSettings().catch(() => null);
    if (!settings?.live_model || !await this.models.installedPath(settings.live_model).catch(() => null)) {
      jobs.delete(generation);
      return;
    }
    job.model = settings.live_model;
    job.language = settings.language;
    job.mainModel = settings.model;
    await withWorkspacePath(workspace, async () => {
      try {
        const folder = await this.queue.meetingFolder(meetingId);
        job.file = path.join(folder, liveTranscriptFile(generation));
        // Started again after a restart: what the stopped dashboard read is gone with it, so it is not resumed.
        const before = await fsp.readFile(job.file, 'utf-8').catch(() => '');
        if (before) { stopJob(job, 'The dashboard restarted during the recording; it is transcribed after the meeting.'); return; }
        const handle = await fsp.open(job.file, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
        await handle.close();
        const session = await this.engine.follow(path.join(folder, liveRecordingFile(generation)), {
          model: job.model, language: job.language,
          onSegment: (s) => this.add(job, s),
          onProgress: (done) => { job.processed = done; this.checkLag(job); },
        });
        // Finished, discarded or stopped while the model loaded: this worker has no recording to follow.
        if (job.status !== 'loading' || jobs.get(generation) !== job) { await session.cancel(); return; }
        job.session = session;
        session.committed(job.committed);
        job.status = 'live';
        job.watch = setInterval(() => { void this.watch(job); }, WATCH_MS);
        job.watch.unref();
        emit(job);
      } catch (err) {
        const busy = (err as { engineBusy?: boolean }).engineBusy;
        stopJob(job, busy ? 'Another transcription was running, so this recording is transcribed after the meeting.' : `The live transcript could not start: ${(err as Error).message}`);
      }
    }).catch(() => {});
  }

  /** The recording service saved audio up to `bytes`: the worker may read that far. */
  committed(generation: string, bytes: number): void {
    const job = jobs.get(generation);
    if (!job || job.status === 'stopped' || job.status === 'done') return;
    job.committed = Math.max(job.committed, bytes);
    job.session?.committed(job.committed);
    this.checkLag(job);
  }

  /**
   * Still this job's recording? Another dashboard may have finished or discarded it, or the dashboard may have
   * stopped receiving audio; then the worker would wait for audio that never comes, holding the engine.
   */
  async watch(job: Job): Promise<void> {
    if (job.status !== 'live') return;
    this.checkLag(job);
    const meeting = await withWorkspacePath(job.workspace, () => this.queue.loadMeeting(job.meetingId)).catch((err: { statusCode?: number }) => (err.statusCode === 404 ? null : undefined));
    if (meeting === undefined) return; // unreadable for a moment
    const live = meeting?.live;
    const mine = live?.generation === job.generation;
    // Sealed by a Finish this dashboard is not running (another dashboard's, which may have failed or stopped): its
    // live part never comes, so the job lets go after the time a Finish would have given it. This dashboard's own
    // Finish starts its part right after sealing, so it is never cut off.
    if (mine && live?.state === 'finalizing' && !job.finishing) job.sealedSince ??= Date.now();
    else job.sealedSince = null;
    const abandoned = job.sealedSince !== null && Date.now() - job.sealedSince > FINISH_MS + 30_000;
    if ((!mine || abandoned) && job.status === 'live') {
      stopJob(job, 'The recording was finished or removed elsewhere.');
      void this.close(job.generation);
    }
  }

  private checkLag(job: Job): void {
    if (job.status !== 'live') return;
    if (job.session?.failed) { stopJob(job, `The live transcript stopped: ${job.session.failed}`); return; }
    const behind = job.committed / BYTES_PER_SECOND - job.processed;
    if (behind <= LAG_SECONDS) { job.behindSince = null; return; }
    job.behindSince ??= Date.now();
    if (Date.now() - job.behindSince > LAG_MS) stopJob(job, 'This computer could not keep up with the live transcript, so the recording is transcribed after the meeting.');
  }

  /** A stretch of speech: written, numbered, before the page hears of it. */
  private add(job: Job, s: Segment): void {
    if (job.status === 'stopped' || job.status === 'done' || job.writeFailed) return;
    const segment: LiveSegment = { i: job.segments.length, start: s.start, end: s.end, text: s.text };
    const line = JSON.stringify(segment) + '\n';
    job.bytes += Buffer.byteLength(line);
    if (job.bytes > MAX_JSONL_BYTES) { stopJob(job, 'The live transcript grew too large; the recording is transcribed after the meeting.'); return; }
    job.segments.push(segment);
    job.writes = job.writes.then(async () => {
      if (job.writeFailed) return;
      try {
        await fsp.appendFile(job.file, line, { mode: 0o600, flag: 'a' });
        job.saved = segment.i + 1;
        emit(job);
      } catch (err) {
        // Shown and announced only up to here: a page never sees text that a reload could not show again.
        job.writeFailed = true;
        stopJob(job, `The live transcript could not be saved: ${(err as Error).message}`);
      }
    });
  }

  /**
   * At Finish, once the recording is sealed at `sealedBytes`: lets the worker read to there, and returns the live
   * transcript only if it covered every byte and every stretch was saved. Null means: transcribe after the meeting.
   * The same answer for every call of the same recording; the time it may take is counted once.
   */
  finalize(generation: string, sealedBytes: number): Promise<LiveResult | null> {
    const job = jobs.get(generation);
    if (!job) return Promise.resolve(null);
    job.finishing ??= (async () => {
      await job.starting;
      if (job.status === 'stopped' || !job.session) { await job.session?.cancel(); return null; }
      job.status = 'finishing';
      emit(job);
      job.deadline ??= Date.now() + FINISH_MS;
      job.session.committed(sealedBytes);
      const result = await job.session.end(sealedBytes, job.deadline - Date.now());
      await job.writes;
      if (!result.ok) { stopJob(job, `The live transcript did not finish: ${result.message}`); return null; }
      // It can have stopped while this waited (a failed write), so its status is read again.
      if (result.bytes !== sealedBytes || job.writeFailed || (job.status as LiveStatus) === 'stopped') {
        stopJob(job, 'The live transcript did not cover the whole recording.');
        return null;
      }
      job.status = 'done';
      emit(job);
      return { model: job.model, language: job.language, seconds: sealedBytes / BYTES_PER_SECOND, segments: job.segments.map(({ start, end, text }) => ({ start, end, text })), mainModel: job.mainModel };
    })();
    return job.finishing;
  }

  /** The recording was published or discarded: its live transcript goes. */
  async close(generation: string): Promise<void> {
    const job = jobs.get(generation);
    if (!job) return;
    jobs.delete(generation);
    if (job.status !== 'done') stopJob(job, 'Stopped.');
    if (job.watch) { clearInterval(job.watch); job.watch = null; }
    await job.session?.cancel().catch(() => {});
    await job.writes;
    if (job.file) await fsp.rm(job.file, { force: true }).catch(() => {});
  }

  /** A meeting was removed: its live transcript ends. */
  forget(meetingId: string): void {
    for (const job of jobs.values()) if (job.meetingId === meetingId) void this.close(job.generation);
  }

  /**
   * What the page shows: the live transcript from segment `from` on, and its status. A recording whose live transcript
   * runs in another dashboard, or not at all, says so.
   */
  async read(meetingId: string, from: number): Promise<{ generation: string | null; status: LiveStatus | 'unavailable'; reason: string | null; next: number; segments: LiveSegment[] }> {
    const meeting = await this.queue.loadMeeting(meetingId);
    const generation = meeting.live?.generation ?? null;
    const job = generation ? jobs.get(generation) : undefined;
    if (!generation || !job) {
      return { generation, status: 'unavailable', reason: generation ? 'The live text of this recording is only in the dashboard that records it.' : null, next: 0, segments: [] };
    }
    // Only what is saved to the file: the page never sees a stretch that a reload could not show again.
    const start = Math.max(0, Math.min(Number.isSafeInteger(from) ? from : 0, job.saved));
    const segments = job.segments.slice(start, Math.min(job.saved, start + PAGE));
    return { generation, status: job.status, reason: job.reason, next: start + segments.length, segments };
  }

  /** For tests: forgets every job without touching files. */
  static reset(): void {
    for (const job of jobs.values()) if (job.watch) clearInterval(job.watch);
    jobs.clear();
  }

  /** For tests: ends every job, and waits for its worker and its writes. */
  static async closeAll(): Promise<void> {
    const service = new MeetingLiveTranscriptService();
    await Promise.all([...jobs.keys()].map((generation) => service.close(generation)));
  }

  /** For tests: the job of a recording, to run its watch now. */
  static job(generation: string): Job | undefined {
    return jobs.get(generation);
  }
}
