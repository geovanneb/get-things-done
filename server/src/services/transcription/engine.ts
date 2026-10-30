import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ChildProcess, fork } from 'child_process';
import { CATALOG, TranscriptionModelService, VAD } from '../transcriptionModels';
import { readWavFormat } from './wav';
import type { EngineModel, WorkerReply, WorkerRequest } from './protocol';

/**
 * Runs the transcription worker (worker.ts) for one job at a time: a model check, or a WAV file to transcribe.
 * Each job gets a fresh process that ends with it, so memory comes back and a crash of the native engine never
 * takes the dashboard down. The worker is plain Node: from `gtd start` it is forked with the same Node, and in the
 * desktop app with Electron's own binary running as Node.
 */

export interface Segment { start: number; end: number; text: string }
export interface TranscriptResult { segments: Segment[]; seconds: number; load_ms: number | null }
export interface EngineStatus { available: boolean; version: string | null; error: string | null }

export type WorkerLauncher = () => ChildProcess;

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

/** A check loads the model and stops; a model that takes this long to load is reported as failed. */
const CHECK_TIMEOUT_MS = 5 * 60 * 1000;
/** A transcription may take as long as the recording plus a margin: far more than the slowest model needs. */
const transcriptionTimeout = (seconds: number) => Math.max(10 * 60 * 1000, seconds * 1000 * 1.5);

let busy = false;
/** Workers still running, so the dashboard can end them when it shuts down. */
const running = new Set<ChildProcess>();
/** After asking a worker to stop, how long it gets before it is killed outright. */
const STOP_GRACE_MS = 3000;

/** True once the shutdown began: no new job starts after that, not even one that was still preparing. */
let closing = false;

const hasExited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null;

/**
 * Ends a worker: a polite signal first, then a forced kill. Waits a bounded time and says whether it has exited;
 * a worker that has not is still tracked, and whatever waits for its exit keeps waiting.
 */
async function stop(child: ChildProcess): Promise<boolean> {
  if (hasExited(child)) return true;
  const exited = new Promise<'exited'>((resolve) => child.once('exit', () => resolve('exited')));
  try { if (child.connected) child.disconnect(); } catch { /* already closed */ }
  child.kill('SIGTERM');
  const timeout = (ms: number) => new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), ms).unref());
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
      return { available: true, version, error: null };
    } catch (err) {
      return { available: false, version: null, error: (err as Error).message };
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
  async transcribe(
    wav: string,
    options: { model?: string; language?: string; onSegment?: (s: Segment) => void; onProgress?: (done: number, total: number) => void; signal?: AbortSignal } = {},
  ): Promise<TranscriptResult> {
    const settings = await this.models.readSettings();
    const id = options.model ?? settings.model;
    const language = options.language ?? settings.language;
    // Held until the worker has really exited, so the model cannot be removed while it is in use, from any dashboard.
    const release = await this.models.lease(id);
    let model: EngineModel;
    let format: Awaited<ReturnType<typeof readWavFormat>>;
    try {
      model = await this.engineModel(id);
      format = await readWavFormat(wav);
    } catch (err) {
      await release();
      throw err;
    }
    const segments: Segment[] = [];
    let loadMs: number | null = null;
    let seconds = format.duration;
    await this.run({ type: 'transcribe', model, wav, language }, transcriptionTimeout(format.duration), (reply) => {
      if (reply.type === 'loaded') loadMs = reply.ms;
      if (reply.type === 'segment') {
        const segment = { start: reply.start, end: reply.end, text: reply.text };
        segments.push(segment);
        options.onSegment?.(segment);
      }
      if (reply.type === 'progress') options.onProgress?.(reply.done, reply.total);
      if (reply.type === 'done') seconds = reply.seconds;
    }, options.signal, release);
    return { segments, seconds, load_ms: loadMs };
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
    };
  }

  /**
   * One job in a fresh worker. Ends it on success, error, timeout or cancel. The one-job slot and `afterExit` (a
   * model lease) are given back only once the worker has really exited, even when that takes longer than the job.
   */
  private async run(request: WorkerRequest, timeoutMs: number, onReply: (reply: WorkerReply) => void, signal?: AbortSignal, afterExit?: () => Promise<void>): Promise<void> {
    const giveBack = async () => { await afterExit?.().catch(() => {}); };
    if (closing) { await giveBack(); throw httpError(503, 'The dashboard is shutting down'); }
    if (busy) { await giveBack(); throw httpError(409, 'A transcription is already running; wait for it to finish'); }
    busy = true;
    let child: ChildProcess;
    try {
      child = this.launcher();
    } catch (err) {
      busy = false;
      await giveBack();
      throw new Error(`The transcription engine could not start: ${(err as Error).message}`, { cause: err });
    }
    running.add(child);
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
      const done = async () => { running.delete(child); busy = false; await giveBack(); };
      if (await stop(child)) await done();
      else child.once('exit', () => { void done(); });
    }
  }
}
