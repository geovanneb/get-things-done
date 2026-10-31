import * as fsp from 'fs/promises';
import * as path from 'path';
import { EventEmitter } from 'events';
import { constants as fsConstants } from 'fs';
import { MeetingDigestService, liveRecordingFile } from './meetingDigestService';
import { CATALOG, languageFor, languagesFor, TranscriptionModelService } from './transcriptionModels';
import { languageAt, withLanguageChange, type LanguageChange } from './transcription/languages';
import { LanguageEvidence, type HeardPart, type Suggestion } from './transcription/languageSuggestion';
import { randomUUID } from 'crypto';
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
/**
 * No audio for this long: the page that records has gone (closed, crashed, offline), so the live transcript lets go
 * of the engine and the other meetings are transcribed. The page calls such a recording interrupted after 30 seconds.
 */
const NO_AUDIO_MS = 60_000;
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
  /** What this recording's language was asked to be; `language` is what the live model can do of it. */
  asked: string;
  language: string;
  /** The changes of language told to the worker, as asked. Never the recording's list: that is what they are checked against. */
  changes: LanguageChange[];
  /** The recording holds a change this job was never told of. */
  missedLanguage: boolean;
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
  /** When audio last arrived, or the job started. */
  audioAt: number;
  processed: number;
  behindSince: number | null;
  finishing: Promise<LiveResult | null> | null;
  deadline: number | null;
  /**
   * What the parts sounded like, for a suggestion of the spoken language. Kept in this dashboard only: the page that
   * records, and the menu bar, are its users.
   */
  evidence: LanguageEvidence | null;
  /** Parts from before the last change of language, or at it, say nothing about it. */
  heardFrom: number;
}

/** A live transcript that covered all of a sealed recording. */
export interface LiveResult {
  model: string;
  /** What it was made with. */
  language: string;
  changes: LanguageChange[];
  /** What was asked for, to compare with the recording's target. */
  asked: string;
  askedChanges: LanguageChange[];
  /** A change came after a part it applies to was transcribed, or never came. */
  lateLanguage: boolean;
  seconds: number;
  segments: Segment[];
  mainModel: string;
}

/** Whether a catalog model has a language. */
function modelHas(model: string, language: string): boolean {
  return Boolean(CATALOG.find((m) => m.id === model)?.language_options?.some((o) => o.id === language));
}

/** Notices for the page: a recording's live transcript has more, or changed status. */
export const liveTranscriptEvents = new EventEmitter();

const jobs = new Map<string, Job>();

function emit(job: Job): void {
  liveTranscriptEvents.emit('change', { meeting: job.meetingId, generation: job.generation, next: job.saved, status: job.status, suggestion: job.evidence?.suggestion ?? null });
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
  async start(meetingId: string, generation: string, workspace: string, saved: number, language = 'auto', changes: LanguageChange[] = []): Promise<void> {
    if (jobs.has(generation)) return;
    // Taken at once, before anything is awaited: a second start, a Finish or a discard always find this job.
    const job: Job = {
      meetingId, generation, workspace, model: '', asked: language, language, changes, missedLanguage: false, mainModel: '',
      file: '', session: null, status: 'loading', reason: null, segments: [], saved: 0, starting: null, watch: null, sealedSince: null, bytes: 0,
      writes: Promise.resolve(), writeFailed: false, committed: saved, audioAt: Date.now(), processed: 0, behindSince: null, finishing: null, deadline: null, evidence: null, heardFrom: -Infinity,
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
    job.language = languageFor(settings.live_model, job.asked);
    job.mainModel = settings.model;
    // Offered only in a language of the model that transcribes after the meeting: the one in Settings now (see `watch`).
    job.evidence = new LanguageEvidence((language) => modelHas(job.mainModel, language), () => randomUUID());
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
          onPart: (part) => this.heard(job, part),
          onProgress: (done) => { job.processed = done; this.checkLag(job); },
        });
        // Finished, discarded or stopped while the model loaded: this worker has no recording to follow.
        if (job.status !== 'loading' || jobs.get(generation) !== job) { await session.cancel(); return; }
        job.session = session;
        // Changes made while the model loaded, before any audio they apply to.
        for (const change of job.changes) session.language(change.at, languageFor(job.model, change.language));
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
    if (bytes > job.committed) job.audioAt = Date.now();
    job.committed = Math.max(job.committed, bytes);
    job.session?.committed(job.committed);
    this.checkLag(job);
  }

  /** The spoken language changed: `changes` is the recording's whole list now, and `change` the one to tell the worker. */
  language(generation: string, changes: LanguageChange[], change: LanguageChange): void {
    const job = jobs.get(generation);
    if (!job || job.status === 'stopped' || job.status === 'done') return;
    job.changes = withLanguageChange(job.asked, job.changes, change);
    // What was heard before says nothing about the language set now; a suggestion it made goes.
    job.heardFrom = Math.max(job.heardFrom, change.at);
    if (job.evidence?.suggestion) { job.evidence.reset(); emit(job); } else job.evidence?.reset();
    if (JSON.stringify(job.changes) !== JSON.stringify(changes)) job.missedLanguage = true;
    job.session?.language(change.at, languageFor(job.model, change.language));
  }

  /**
   * Still this job's recording? Another dashboard may have finished or discarded it, or the dashboard may have
   * stopped receiving audio; then the worker would wait for audio that never comes, holding the engine.
   */
  async watch(job: Job): Promise<void> {
    if (job.status !== 'live') return;
    this.checkLag(job);
    // The model that will transcribe after the meeting is the one in Settings at Finish: a suggestion follows it, and
    // one from long ago goes.
    const settings = await this.models.readSettings().catch(() => null);
    if (settings?.model) job.mainModel = settings.model;
    if (job.evidence) {
      const before = job.evidence.suggestion?.id ?? null;
      let after = job.evidence.expire(Math.max(job.processed, 0))?.id ?? null;
      if (after && !modelHas(job.mainModel, job.evidence.suggestion!.language)) { job.evidence.reset(); after = null; }
      if (after !== before) emit(job);
    }
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
    // Still recording, but no audio comes: a sealed recording has its own wait above, for the Finish under way.
    if (mine && live?.state === 'recording' && job.status === 'live' && Date.now() - job.audioAt > NO_AUDIO_MS) {
      stopJob(job, 'No audio arrived for a minute, so the live transcript stopped and other meetings can be transcribed. The recording is kept: finish it to have it transcribed.');
      return;
    }
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

  /** A decoded part: evidence for the language suggestion. */
  private heard(job: Job, part: HeardPart): void {
    if (job.status !== 'live' || !job.evidence || part.start <= job.heardFrom) return;
    const asked = languageAt(job.asked, job.changes, part.start);
    // A language the live model does not have: it hears that speech as something else, so it says nothing about it.
    if (languageFor(job.model, asked) !== asked) return;
    const before = job.evidence.suggestion?.id ?? null;
    const after = job.evidence.add(part, asked)?.id ?? null;
    if (after !== before) emit(job);
  }

  /** The suggestion of a recording's live job, as the page and the menu bar show it; null when there is none. */
  suggestion(generation: string): Suggestion | null {
    const job = jobs.get(generation);
    return job?.status === 'live' ? job.evidence?.suggestion ?? null : null;
  }

  /** "Keep": the suggestion `id` goes, and its language is not offered again in this recording. */
  keep(generation: string, id: string): boolean {
    const job = jobs.get(generation);
    if (!job?.evidence?.keep(id)) return false;
    emit(job);
    return true;
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
      return { model: job.model, language: job.language, changes: languagesFor(job.model, job.asked, job.changes).changes, asked: job.asked, askedChanges: job.changes, lateLanguage: result.lateLanguage || job.missedLanguage, seconds: sealedBytes / BYTES_PER_SECOND, segments: job.segments.map(({ start, end, text }) => ({ start, end, text })), mainModel: job.mainModel };
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
  async read(meetingId: string, from: number): Promise<{ generation: string | null; status: LiveStatus | 'unavailable'; reason: string | null; next: number; segments: LiveSegment[]; suggestion?: Suggestion | null }> {
    const meeting = await this.queue.loadMeeting(meetingId);
    const generation = meeting.live?.generation ?? null;
    const job = generation ? jobs.get(generation) : undefined;
    if (!generation || !job) {
      // No live job here: the live transcript is off, or it runs in the dashboard that records.
      const off = generation ? !(await this.models.readSettings().catch(() => null))?.live_model : false;
      const reason = !generation ? null : off ? 'The live transcript is off (Settings > Transcription); the recording is transcribed after the meeting.'
        : 'The live text of this recording is only in the dashboard that records it.';
      return { generation, status: 'unavailable', reason, next: 0, segments: [] };
    }
    // Only what is saved to the file: the page never sees a stretch that a reload could not show again.
    const start = Math.max(0, Math.min(Number.isSafeInteger(from) ? from : 0, job.saved));
    const segments = job.segments.slice(start, Math.min(job.saved, start + PAGE));
    return { generation, status: job.status, reason: job.reason, next: start + segments.length, segments, suggestion: this.suggestion(generation) };
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
