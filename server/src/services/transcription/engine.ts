import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ChildProcess, fork } from 'child_process';
import { EventEmitter } from 'events';
import { CATALOG, SPEAKER_MODEL, TranscriptionModelService, VAD } from '../transcriptionModels';
import { readWavFormat } from './wav';
import { whisperHelperPath } from './whisperHelper';
import type { LanguageChange } from './languages';
import type { SpeakerTurn } from './parts';
import type { EngineModel, WorkerControl, WorkerReply, WorkerRequest } from './protocol';

/**
 * Runs the transcription worker (worker.ts) for one job at a time: a model check, or a WAV file to transcribe.
 * Each job gets a fresh process that ends with it, so memory comes back and a crash of the native engine never
 * takes the dashboard down. The worker is plain Node: from `gtd start` it is forked with the same Node, and in the
 * desktop app with Electron's own binary running as Node.
 */

export interface Segment { start: number; end: number; text: string; speaker?: number }
export interface TranscriptResult { segments: Segment[]; seconds: number; load_ms: number | null }
export interface TranscribeOptions { model?: string; language?: string; changes?: LanguageChange[]; turns?: SpeakerTurn[]; onSegment?: (s: Segment) => void; onProgress?: (done: number, total: number) => void; signal?: AbortSignal }
/** `gpu`: the GPU engine (gtd-whisper) is part of this install. Whether it works here is for the speed test to show. */
export interface EngineStatus { available: boolean; version: string | null; error: string | null; gpu: boolean }

export type WorkerLauncher = () => ChildProcess;

/** A live transcript's job, while its recording is made. */
export interface FollowSession {
  /** Audio saved so far, in bytes after the header. Only this much is read. */
  committed(bytes: number): void;
  /** From `at` seconds of audio on, this language. Sent before the audio it applies to. */
  language(at: number, language: string): void;
  /** The recording is sealed at `bytes`: reads to there, and resolves once the worker has exited. */
  end(bytes: number, deadlineMs: number): Promise<{ ok: true; bytes: number; seconds: number; segments: number; lateLanguage: boolean } | { ok: false; message: string }>;
  /** Ends the job without a result; resolves once the worker has exited. */
  cancel(): Promise<void>;
  /** Why the job stopped early, while the recording goes on; null while it runs. */
  readonly failed: string | null;
}

/** Starts the worker as a Node process: the built worker.js next to this file, or worker.ts when run from source. */
export const launchWorker: WorkerLauncher = () => {
  const built = path.join(__dirname, 'worker.js');
  const file = fs.existsSync(built) ? built : path.join(__dirname, 'worker.ts');
  const env: NodeJS.ProcessEnv = { ...process.env };
  // In the desktop app process.execPath is Electron; this makes it run the worker as plain Node.
  if (process.versions['electron']) env['ELECTRON_RUN_AS_NODE'] = '1';
  return fork(file, [], {
    env,
    execArgv: file.endsWith('.ts') ? process.execArgv : [],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
};

/**
 * A worker that was killed may leave its GPU engine running for a moment: the engine ends itself when its worker is
 * gone (within about 3 seconds). Until then it holds the model's memory, so the slot waits. Only waits, never kills:
 * by now the number may belong to another process, which is also why the wait has an end.
 */
const HELPER_EXIT_MS = 30_000;
async function helperGone(pid: number | null): Promise<void> {
  if (!pid) return;
  const until = Date.now() + HELPER_EXIT_MS;
  for (;;) {
    try { process.kill(pid, 0); } catch { return; }
    if (Date.now() > until) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** A check loads the model and stops; a model that takes this long to load is reported as failed. */
const CHECK_TIMEOUT_MS = 5 * 60 * 1000;
/** A transcription may take as long as the recording plus a margin: far more than the slowest model needs. */
const transcriptionTimeout = (seconds: number) => Math.max(10 * 60 * 1000, seconds * 1000 * 6);
/** Finding speakers takes about a tenth of the recording; a job at its length is stuck. */
const speakerTimeout = (seconds: number) => Math.max(10 * 60 * 1000, seconds * 1000);
/** Longest recording whose speakers are looked for: its audio is held in memory whole. */
const MAX_SPEAKER_SECONDS = 4 * 3600;

let busy = false;
/** `free`: the one-job slot was given back, so whatever waited for it can start. */
export const engineEvents = new EventEmitter();
function free(): void {
  busy = false;
  engineEvents.emit('free');
}
/** Workers still running, so the dashboard can end them when it shuts down. */
const running = new Set<ChildProcess>();
/** After asking a worker to stop, how long it gets before it is killed outright. */
const STOP_GRACE_MS = 3000;

/** True once the shutdown began: no new job starts after that, not even one that was still preparing. */
let closing = false;

/** Workers that never started (a failed spawn emits `error` and `close`, never `exit`). */
const neverStarted = new WeakSet<ChildProcess>();
function watchSpawn(child: ChildProcess): void {
  child.once('error', () => { if (child.pid === undefined) neverStarted.add(child); });
}
const hasExited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null || neverStarted.has(child);

/**
 * Ends a worker: a polite signal first, then a forced kill. Waits a bounded time and says whether it has exited;
 * a worker that has not is still tracked, and whatever waits for its exit keeps waiting.
 */
async function stop(child: ChildProcess): Promise<boolean> {
  if (hasExited(child)) return true;
  const exited = new Promise<'exited'>((resolve) => child.once('exit', () => resolve('exited')));
  try { if (child.connected) child.disconnect(); } catch { /* already closed */ }
  child.kill('SIGTERM');
  // Kept referenced: these waits are short and bounded, and an unreferenced timer could let the process (or a test)
  // end while it still waits for the worker.
  const timeout = (ms: number) => new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), ms));
  if (await Promise.race([exited, timeout(STOP_GRACE_MS)]) === 'timeout') {
    child.kill('SIGKILL');
    await Promise.race([exited, timeout(STOP_GRACE_MS)]);
  }
  return hasExited(child);
}

function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode: status });
}

export class TranscriptionEngine {
  /** Closes the door to new jobs, then ends every running worker; called when the dashboard shuts down. */
  static async stopAll(): Promise<void> {
    closing = true;
    await Promise.all([...running].map((child) => stop(child)));
  }

  /** True while a job holds the one-job slot in this dashboard, such as a live transcript during a meeting. */
  static isBusy(): boolean {
    return busy;
  }

  /** For tests: opens the door again after stopAll(). */
  static reopen(): void {
    closing = false;
  }

  constructor(private readonly models = new TranscriptionModelService(), private readonly launcher: WorkerLauncher = launchWorker) {}

  /** Whether the engine loads on this computer (no model needed). */
  async status(): Promise<EngineStatus> {
    try {
      let version: string | null = null;
      await this.run({ type: 'version' }, 60_000, (reply) => { if (reply.type === 'version') version = reply.version; });
      return { available: true, version, error: null, gpu: whisperHelperPath() !== null };
    } catch (err) {
      return { available: false, version: null, error: (err as Error).message, gpu: whisperHelperPath() !== null };
    }
  }

  /** Loads an installed model in the worker: it works, and how long it took. */
  async check(id: string): Promise<{ ok: boolean; load_ms: number | null; message: string }> {
    // The lease is handed to the job, which gives it back only once the worker has really exited.
    const release = await this.models.lease(id);
    let model: EngineModel;
    try { model = await this.engineModel(id); } catch (err) { await release(); throw err; }
    let loadMs: number | null = null;
    try {
      await this.run({ type: 'check', model }, CHECK_TIMEOUT_MS, (reply) => { if (reply.type === 'loaded') loadMs = reply.ms; }, undefined, release);
      return { ok: true, load_ms: loadMs, message: `Works: loaded in ${((loadMs ?? 0) / 1000).toFixed(1)} s.` };
    } catch (err) {
      return { ok: false, load_ms: null, message: (err as Error).message };
    }
  }

  /** Transcribes a WAV file with the chosen model and language. Segments and progress arrive as they are ready. */
  async transcribe(wav: string, options: TranscribeOptions = {}): Promise<TranscriptResult> {
    const settings = await this.models.readSettings();
    const id = options.model ?? settings.model;
    // Held until the worker has really exited, so the model cannot be removed while it is in use, from any dashboard.
    const release = await this.models.lease(id);
    let prepared: Awaited<ReturnType<TranscriptionEngine['prepare']>>;
    try {
      prepared = await this.prepare(wav, id);
    } catch (err) {
      await release();
      throw err;
    }
    return this.recognize(wav, prepared, options.language ?? settings.language, options, release, false);
  }

  /**
   * Finds who spoke when, in a worker of its own, then transcribes with what it found. One job: the slot and both models
   * are held from start to end, so nothing gets in between and no detection is done twice. If finding speakers
   * fails the transcript is still made, and `speaker_note` says why they are missing; only a Stop ends the job.
   */
  async transcribeWithSpeakers(wav: string, options: TranscribeOptions = {}): Promise<TranscriptResult & { speaker_note: string | null }> {
    if (closing) throw httpError(503, 'The dashboard is shutting down');
    if (busy) throw Object.assign(httpError(409, 'A transcription is already running; wait for it to finish'), { engineBusy: true });
    busy = true;
    const leases: (() => Promise<void>)[] = [];
    const giveBack = async () => { for (const release of leases.splice(0)) await release().catch(() => {}); };
    try {
      const settings = await this.models.readSettings();
      const id = options.model ?? settings.model;
      leases.push(await this.models.lease(id));
      const prepared = await this.prepare(wav, id);
      let turns: SpeakerTurn[] = [];
      let note: string | null = null;
      if (prepared.format.duration > MAX_SPEAKER_SECONDS) note = 'the recording is too long for speaker detection';
      else {
        try {
          leases.push(await this.models.lease(SPEAKER_MODEL.id));
          const dir = await this.models.installedPath(SPEAKER_MODEL.id);
          if (!dir) throw new Error('The speaker model is not downloaded');
          await this.run({
            type: 'speakers', wav, segmentation: path.join(dir, SPEAKER_MODEL.files[0]!.name), embedding: path.join(dir, SPEAKER_MODEL.files[1]!.name),
            threads: Math.max(1, Math.min(8, os.availableParallelism() - 1)),
          }, speakerTimeout(prepared.format.duration), (reply) => { if (reply.type === 'turns') turns = reply.turns; }, options.signal, undefined, true);
        } catch (err) {
          if (options.signal?.aborted || closing) throw err;
          console.error(`[transcription] Speakers: ${(err as Error).message}`);
          note = 'speaker detection failed';
        }
      }
      const result = await this.recognize(wav, prepared, options.language ?? settings.language, { ...options, turns }, undefined, true);
      return { ...result, speaker_note: note };
    } finally {
      free();
      await giveBack();
    }
  }

  private async prepare(wav: string, id: string): Promise<{ id: string; model: EngineModel; format: Awaited<ReturnType<typeof readWavFormat>> }> {
    return { id, model: await this.engineModel(id), format: await readWavFormat(wav) };
  }

  private async recognize(wav: string, { model, format }: Awaited<ReturnType<TranscriptionEngine['prepare']>>, language: string, options: TranscribeOptions, release: (() => Promise<void>) | undefined, held: boolean): Promise<TranscriptResult> {
    const segments: Segment[] = [];
    let loadMs: number | null = null;
    let seconds = format.duration;
    await this.run({ type: 'transcribe', model, wav, language, ...(options.changes?.length ? { changes: options.changes } : {}), ...(options.turns?.length ? { turns: options.turns } : {}) }, transcriptionTimeout(format.duration), (reply) => {
      if (reply.type === 'loaded') loadMs = reply.ms;
      if (reply.type === 'segment') {
        const segment = { start: reply.start, end: reply.end, text: reply.text, ...(reply.speaker ? { speaker: reply.speaker } : {}) };
        segments.push(segment);
        options.onSegment?.(segment);
      }
      if (reply.type === 'progress') options.onProgress?.(reply.done, reply.total);
      if (reply.type === 'done') seconds = reply.seconds;
    }, options.signal, release, held);
    return { segments, seconds, load_ms: loadMs };
  }

  /**
   * Follows a recording as it is made (worker `follow`), for a live transcript. It takes the one-job slot and the
   * model's lease like any job, until its worker has really exited. Segments arrive as speech ends. `committed` passes
   * on how much audio is saved; `end` seals it and resolves with exactly how much was read; `cancel` ends it, and
   * resolves once the worker has exited.
   */
  async follow(wav: string, options: { model: string; language: string; onSegment: (s: Segment) => void; onProgress?: (done: number, total: number) => void }): Promise<FollowSession> {
    if (closing) throw httpError(503, 'The dashboard is shutting down');
    if (busy) throw Object.assign(httpError(409, 'A transcription is already running; wait for it to finish'), { engineBusy: true });
    const release = await this.models.lease(options.model);
    let model: EngineModel;
    try { model = await this.engineModel(options.model); } catch (err) { await release(); throw err; }
    if (busy || closing) { await release(); throw Object.assign(httpError(409, 'A transcription is already running; wait for it to finish'), { engineBusy: true }); }
    busy = true;
    let child: ChildProcess;
    try {
      child = this.launcher();
    } catch (err) {
      free();
      await release();
      throw new Error(`The transcription engine could not start: ${(err as Error).message}`, { cause: err });
    }
    running.add(child);
    watchSpawn(child);
    let stderr = '';
    child.stderr?.on('data', (d: Buffer) => { if (stderr.length < 4000) stderr += d.toString(); });
    // The slot and the lease go back only once the worker has really exited, whatever ended it.
    // `close` also comes after a failed spawn, which has no `exit`.
    const exited = new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
      child.once('close', () => { if (neverStarted.has(child)) resolve(); });
    });
    void exited.then(async () => { running.delete(child); free(); await release().catch(() => {}); });

    let outcome: { ok: true; bytes: number; seconds: number; segments: number; lateLanguage: boolean } | { ok: false; message: string } | null = null;
    const settle = (value: NonNullable<typeof outcome>) => { if (!outcome) { outcome = value; for (const w of waiting) w(); } };
    const waiting: (() => void)[] = [];
    const ended = () => new Promise<void>((resolve) => { if (outcome) resolve(); else waiting.push(resolve); });
    let loaded = false;
    const loadTimer = setTimeout(() => { if (!loaded) { settle({ ok: false, message: 'The model took too long to load.' }); void stop(child); } }, CHECK_TIMEOUT_MS);
    child.on('message', (reply: WorkerReply) => {
      if (outcome) return;
      if (reply.type === 'loaded') { loaded = true; clearTimeout(loadTimer); }
      if (reply.type === 'segment') options.onSegment({ start: reply.start, end: reply.end, text: reply.text });
      if (reply.type === 'progress') options.onProgress?.(reply.done, reply.total);
      if (reply.type === 'error') settle({ ok: false, message: reply.message });
      if (reply.type === 'done') settle({ ok: true, bytes: reply.bytes ?? -1, seconds: reply.seconds, segments: reply.segments, lateLanguage: reply.late_language === true });
    });
    child.on('error', (err) => settle({ ok: false, message: `The transcription engine could not start: ${err.message}` }));
    child.once('exit', (code, sig) => {
      clearTimeout(loadTimer);
      settle({ ok: false, message: `The transcription engine stopped (${sig ?? `exit code ${code}`}).${stderr.trim() ? ` ${stderr.trim().split('\n').slice(-1)[0]}` : ''}` });
    });
    const sendControl = (control: WorkerControl) => { if (child.connected && !outcome) child.send(control, () => {}); };
    if (child.connected) child.send({ type: 'follow', model, wav, language: options.language } satisfies WorkerRequest, () => {});
    else settle({ ok: false, message: 'The transcription engine could not start.' });

    return {
      committed: (bytes: number) => sendControl({ type: 'committed', bytes }),
      language: (at: number, language: string) => sendControl({ type: 'language', at, language }),
      end: async (bytes: number, deadlineMs: number) => {
        sendControl({ type: 'end', bytes });
        let deadline: ReturnType<typeof setTimeout> | undefined;
        const timer = new Promise<'late'>((r) => { deadline = setTimeout(() => r('late'), Math.max(0, deadlineMs)); });
        const result = await Promise.race([ended().then(() => 'ended' as const), timer]);
        clearTimeout(deadline);
        if (result === 'late') settle({ ok: false, message: 'The live transcript did not finish in time.' });
        await stop(child);
        await exited;
        return outcome!;
      },
      cancel: async () => {
        settle({ ok: false, message: 'Stopped.' });
        await stop(child);
        await exited;
      },
      get failed() { return outcome && !outcome.ok ? outcome.message : null; },
    };
  }

  /** The worker's view of an installed model: full paths of its files and the VAD model. */
  private async engineModel(id: string): Promise<EngineModel> {
    const entry = CATALOG.find((m) => m.id === id);
    if (!entry?.engine) throw httpError(404, `Unknown model: ${id}`);
    const dir = await this.models.installedPath(id);
    if (!dir) throw httpError(409, `${entry.name} is not downloaded yet: download it in Settings > Transcription`);
    const vad = await this.models.installedPath(VAD.id);
    if (!vad) throw httpError(409, 'The voice-activity model is missing: download it in Settings > Transcription');
    return {
      kind: entry.engine.kind,
      files: Object.fromEntries(Object.entries(entry.engine.files).map(([role, name]) => [role, path.join(dir, name)])),
      vad: path.join(vad, VAD.files[0]!.name),
      // Leave a core for the dashboard and the rest of the computer.
      threads: Math.max(1, Math.min(8, os.availableParallelism() - 1)),
      ...(entry.engine.noArena ? { noArena: true } : {}),
    };
  }

  /**
   * One job in a fresh worker. Ends it on success, error, timeout or cancel. The one-job slot and `afterExit` (a
   * model lease) are given back only once the worker has really exited, even when that takes longer than the job.
   */
  private async run(request: WorkerRequest, timeoutMs: number, onReply: (reply: WorkerReply) => void, signal?: AbortSignal, afterExit?: () => Promise<void>, held = false): Promise<void> {
    const giveBack = async () => { await afterExit?.().catch(() => {}); };
    if (closing) { await giveBack(); throw httpError(503, 'The dashboard is shutting down'); }
    // `held`: part of a job that already has the slot, and keeps it after this worker.
    if (busy && !held) { await giveBack(); throw Object.assign(httpError(409, 'A transcription is already running; wait for it to finish'), { engineBusy: true }); }
    busy = true;
    let child: ChildProcess;
    try {
      child = this.launcher();
    } catch (err) {
      if (!held) free();
      await giveBack();
      throw new Error(`The transcription engine could not start: ${(err as Error).message}`, { cause: err });
    }
    running.add(child);
    let helper: number | null = null;
    let stderr = '';
    child.stderr?.on('data', (d: Buffer) => { if (stderr.length < 4000) stderr += d.toString(); });
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (err?: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          if (err) reject(err); else resolve();
        };
        const timer = setTimeout(() => finish(new Error('The transcription took too long and was stopped.')), timeoutMs);
        const onAbort = () => finish(new Error('Cancelled.'));
        if (signal?.aborted) { onAbort(); return; }
        signal?.addEventListener('abort', onAbort, { once: true });
        child.on('message', (reply: WorkerReply) => {
          // The worker closes its GPU engine before it says the job ended; until then the engine may still run.
          if (reply.type === 'helper') {
            helper = reply.pid;
            if (child.connected) child.send({ type: 'helper-known' } satisfies WorkerControl);
          }
          if (reply.type === 'done' || reply.type === 'error') helper = null;
          // Once the job has ended (done, failed, cancelled, timed out), whatever the worker still sends is ignored.
          if (settled) return;
          if (reply.type === 'error') { finish(new Error(reply.message)); return; }
          try { onReply(reply); } catch (err) { finish(err as Error); return; }
          if (reply.type === 'done' || reply.type === 'version') finish();
        });
        child.on('error', (err) => finish(new Error(`The transcription engine could not start: ${err.message}`)));
        child.on('exit', (code, sig) => finish(new Error(
          `The transcription engine stopped unexpectedly (${sig ?? `exit code ${code}`}).${stderr.trim() ? ` ${stderr.trim().split('\n').slice(-3).join(' ')}` : ''}`,
        )));
        if (!child.connected) { finish(new Error('The transcription engine could not start.')); return; }
        child.send(request, (err) => { if (err) finish(new Error(`The transcription engine could not start: ${err.message}`)); });
      });
    } finally {
      // The next job starts only once this worker has really exited, so two never hold a model's memory at once.
      const done = async () => { await helperGone(helper); running.delete(child); if (!held) free(); await giveBack(); };
      if (await stop(child)) await done();
      else if (held) await new Promise<void>((resolve) => { child.once('exit', () => { void done().finally(resolve); }); });
      else child.once('exit', () => { void done(); });
    }
  }
}
