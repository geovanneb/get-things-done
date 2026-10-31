/**
 * Whisper on the GPU: a client for gtd-whisper (native/whisper-helper), a small program that keeps one Whisper model
 * loaded and transcribes one speech part at a time. The worker starts it for a job and ends it with the job.
 *
 * It talks over its own stdin and stdout only: a one-line header and the part's samples in, one JSON line out.
 * Its stderr is whisper.cpp's log, kept short for an error message and never sent anywhere else.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';

/** Why the helper could not do its work. Only `gpu` means the GPU itself failed; the others are not about the GPU. */
export type HelperFailure = 'missing' | 'load' | 'gpu' | 'timeout' | 'protocol';

export class HelperError extends Error {
  constructor(readonly failure: HelperFailure, message: string) {
    super(message);
    this.name = 'HelperError';
  }
}

export interface HelperRecognizer {
  /** The device whisper.cpp said it uses at load, e.g. "MTL0"; "CPU" when there is none. */
  readonly backend: string;
  readonly loadMs: number;
  /** The helper's process, so whoever owns the job can make sure it is gone even if this process is killed. */
  readonly pid: number;
  /** One part at a time: a second call waits for the first. `language` is a code or "auto". */
  decode(samples: Float32Array, language: string): Promise<{ text: string; language: string }>;
  /** Ends the helper and resolves once it has exited. */
  close(): Promise<void>;
  /** Ends it at once, mid-part if need be, and resolves once it has exited. */
  abort(): Promise<void>;
}

export interface HelperOptions {
  threads: number;
  gpu?: boolean;
  /** A model loads in seconds; the first load on a Mac also builds the GPU code. */
  loadTimeoutMs?: number;
  /** A part is at most about 25 seconds; even on the CPU it takes far less than this. */
  partTimeoutMs?: number;
  /**
   * Called as soon as the helper process exists. It loads nothing until this resolves: whoever owns the job records
   * the process first, so no moment exists where it runs unknown to them. A rejection ends it.
   */
  beforeLoad?: (pid: number, abort: () => Promise<void>) => Promise<void>;
}

/** Longest stretch of stderr kept for an error message. */
const LOG_KEPT = 4000;
/** A reply line longer than this is not one the helper writes; nothing longer is held. */
const LONGEST_REPLY = 1 << 20;

/** The helper's path in this install, when there is one: the desktop app on a Mac that can run it sets it. */
export function whisperHelperPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const file = env['GTD_WHISPER_HELPER'];
  if (!file) return null;
  try {
    return fs.statSync(file).isFile() ? file : null;
  } catch {
    return null;
  }
}

type Reply = { type: 'ready'; backend: string; ms: number } | { type: 'text'; id: number; text: string; language: string } | { type: 'error'; id?: number; message: string };

function parseReply(line: string): Reply | null {
  try {
    const value = JSON.parse(line) as Record<string, unknown>;
    if (value['type'] === 'ready' && typeof value['backend'] === 'string' && typeof value['ms'] === 'number') return { type: 'ready', backend: value['backend'], ms: value['ms'] };
    if (value['type'] === 'text' && typeof value['id'] === 'number' && typeof value['text'] === 'string' && typeof value['language'] === 'string') {
      return { type: 'text', id: value['id'], text: value['text'], language: value['language'] };
    }
    if (value['type'] === 'error' && typeof value['message'] === 'string') return { type: 'error', message: value['message'], ...(typeof value['id'] === 'number' ? { id: value['id'] } : {}) };
  } catch { /* not JSON */ }
  return null;
}

/** Starts the helper with `model` and waits until it has loaded it. */
export async function startHelper(binary: string, model: string, options: HelperOptions): Promise<HelperRecognizer> {
  const args = ['--model', model, '--threads', String(Math.max(1, Math.floor(options.threads))), '--parent', String(process.pid)];
  if (options.gpu === false) args.push('--no-gpu');
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (err) {
    throw new HelperError('missing', `The GPU engine could not be started: ${(err as Error).message}`);
  }
  // The worker ends with its job, sometimes at once: the helper goes with it rather than waiting to notice.
  const killOnExit = () => child.kill('SIGKILL');
  process.once('exit', killOnExit);
  let log = '';
  child.stderr.on('data', (chunk: Buffer) => { log = (log + chunk.toString('utf-8')).slice(-LOG_KEPT); });
  // A write after the helper ended is reported through `exited`, not as an unhandled error.
  child.stdin.on('error', () => {});

  // One reply at a time, and only when one is due: anything else, or a line without end, ends the helper.
  const replies: Reply[] = [];
  let expecting = true;
  let violation: string | null = null;
  let waiting: (() => void) | null = null;
  const state = { exited: null as { code: number | null; signal: NodeJS.Signals | null } | null, spawnError: null as Error | null };
  const wake = () => { const w = waiting; waiting = null; w?.(); };
  const violate = (message: string) => { violation = message; child.kill('SIGKILL'); wake(); };
  // Bytes, not characters: the limit holds for whatever it sends.
  let partial = Buffer.alloc(0);
  child.stdout.on('data', (chunk: Buffer) => {
    if (violation) return;
    partial = Buffer.concat([partial, chunk]);
    for (let nl = partial.indexOf(10); nl >= 0; nl = partial.indexOf(10)) {
      const line = partial.subarray(0, nl);
      partial = partial.subarray(nl + 1);
      const reply = line.length <= LONGEST_REPLY ? parseReply(line.toString('utf-8')) : null;
      if (!reply) return violate('The GPU engine sent something it should not');
      if (!expecting) return violate('The GPU engine answered out of turn');
      expecting = false;
      replies.push(reply);
    }
    if (partial.length > LONGEST_REPLY) return violate('The GPU engine sent something it should not');
    wake();
  });
  const gone = new Promise<void>((resolve) => child.once('close', (code, signal) => { state.exited = { code, signal }; wake(); resolve(); }));
  child.once('error', (err) => { state.spawnError = err; wake(); });

  const endedMessage = () => {
    if (state.spawnError) return new HelperError('missing', `The GPU engine could not be started: ${state.spawnError.message}`);
    const how = state.exited?.signal ? `was stopped (${state.exited.signal})` : `ended (${state.exited?.code})`;
    const last = log.trim().split('\n').slice(-3).join(' | ');
    return new HelperError('gpu', `The GPU engine ${how}${last ? `: ${last}` : ''}`);
  };

  const next = async (timeoutMs: number, onTimeout: HelperFailure): Promise<Reply> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      // A broken stream fails even when a good reply came just before the bad output.
      if (violation) throw new HelperError('protocol', violation);
      const reply = replies.shift();
      if (reply) return reply;
      if (state.exited || state.spawnError) throw endedMessage();
      const left = deadline - Date.now();
      if (left <= 0) {
        child.kill('SIGKILL');
        throw new HelperError(onTimeout, onTimeout === 'timeout' ? 'The GPU engine took too long on a part' : 'The GPU engine took too long to load the model');
      }
      await new Promise<void>((resolve) => { waiting = resolve; setTimeout(resolve, Math.min(left, 1000)); });
    }
  };

  const close = async () => {
    if (!state.exited && !state.spawnError) {
      child.stdin.end();
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      await gone;
      clearTimeout(timer);
    }
    process.removeListener('exit', killOnExit);
  };
  const abort = async () => {
    if (!state.exited && !state.spawnError) {
      child.kill('SIGKILL');
      await gone;
    }
    process.removeListener('exit', killOnExit);
  };

  if (options.beforeLoad && child.pid) {
    try {
      await options.beforeLoad(child.pid, abort);
    } catch (err) {
      await abort();
      throw new HelperError('load', `The GPU engine was not started: ${(err as Error).message}`);
    }
  }
  child.stdin.write('start\n');
  const ready = await next(options.loadTimeoutMs ?? 120_000, 'load').catch(async (err: unknown) => { await close(); throw err; });
  if (ready.type !== 'ready') {
    await close();
    throw ready.type === 'error'
      ? new HelperError('load', `The GPU engine could not load the model: ${ready.message}`)
      : new HelperError('protocol', 'The GPU engine did not start as expected');
  }

  let id = 0;
  let queue: Promise<unknown> = Promise.resolve();
  const decodeOne = async (samples: Float32Array, language: string) => {
    if (!/^[a-z]{2,3}$|^auto$/.test(language)) throw new HelperError('protocol', `Not a language the GPU engine takes: ${language}`);
    const n = ++id;
    const body = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
    expecting = true;
    // The helper reads little-endian floats; every Mac it runs on is little-endian, so the samples go as they are.
    child.stdin.write(`${JSON.stringify({ id: n, language, samples: samples.length })}\n`);
    child.stdin.write(body);
    const reply = await next(options.partTimeoutMs ?? 120_000, 'timeout');
    if (reply.type === 'text' && reply.id === n) return { text: reply.text, language: reply.language };
    if (reply.type === 'error' && reply.id === n) throw new HelperError('gpu', `The GPU engine could not transcribe a part: ${reply.message}`);
    violate(reply.type === 'error' ? reply.message : 'The GPU engine answered out of turn');
    throw new HelperError('protocol', violation ?? 'The GPU engine answered out of turn');
  };

  return {
    backend: ready.backend,
    loadMs: ready.ms,
    pid: child.pid ?? 0,
    decode(samples, language) {
      const result = queue.then(() => decodeOne(samples, language));
      queue = result.catch(() => {});
      return result;
    },
    close,
    abort,
  };
}
