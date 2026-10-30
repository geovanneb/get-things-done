import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { createHash, Hash, randomUUID } from 'crypto';
import { finished } from 'stream/promises';
import { EventEmitter } from 'events';
import { atomicWrite } from '../utils/atomicWrite';
import { readSpeeds, type SpeedResult } from './transcription/speedTest';
import { processAlive } from './runState';
import { HeldLock, ownsToken, readLock, tryLock, unlock } from '../utils/fileLock';

/**
 * Speech-to-text models for offline transcription: a fixed catalog, downloaded on request from Settings.
 *
 * Models are large (up to about 1 GB) and the same for every workspace, so they live in the home config,
 * `~/.gtd/models/` (or ESB_MODELS_PATH), never in a workspace. Every file is pinned by URL, size and SHA-256:
 * a download is written to `<file>.part`, resumed with a range request when interrupted, checked byte for byte,
 * and only then renamed into place. A model counts as installed once `installed.json` records every file and
 * each file is there with its size. One download runs at a time, across dashboards, under `download.lock`.
 *
 *   ~/.gtd/models/settings.json              the model and language used for transcription
 *   ~/.gtd/models/download.lock              held while a download runs, by any dashboard
 *   ~/.gtd/models/<model id>/<file>          the model's files
 *   ~/.gtd/models/<model id>/installed.json  written last, after every file was verified
 */

export interface ModelFile { name: string; url: string; size: number; sha256: string }

export interface CatalogModel {
  id: string;
  name: string;
  /** Short and plain, shown on the model's card. */
  summary: string;
  languages: string;
  pros: string[];
  cons: string[];
  /** Memory while transcribing, roughly, in GB. */
  memory_gb: number;
  files: ModelFile[];
  /** How the transcription engine uses the files: which kind of model, and which file plays which part. */
  engine?: { kind: 'whisper' | 'sensevoice'; files: Record<string, string> };
}

export type TranscriptionLanguage = 'auto' | 'en' | 'ja';
export const LANGUAGES: TranscriptionLanguage[] = ['auto', 'en', 'ja'];

export interface TranscriptionSettings {
  model: string;
  language: TranscriptionLanguage;
  /** Keep a recording after its complete transcript went into a digest. Off: the recording goes with the queue. */
  keep_recordings: boolean;
  /** The model for a live transcript while recording; null: no live transcript. */
  live_model: string | null;
  updated_at: string | null;
}

export interface DownloadProgress {
  model: string;
  status: 'downloading' | 'verifying' | 'failed' | 'cancelled';
  received: number;
  total: number;
  file: string;
  message?: string;
}

export interface ModelView extends Omit<CatalogModel, 'files' | 'engine'> {
  size: number;
  installed: boolean;
  /** Bytes already on disk from an interrupted download; it resumes from there. */
  partial: number;
  download: DownloadProgress | null;
  /** How fast it transcribed on this computer, when tested. */
  speed: SpeedResult | null;
}

export interface TranscriptionView {
  models: ModelView[];
  settings: TranscriptionSettings;
  defaults: TranscriptionSettings;
  /** The voice-activity model every transcription needs; downloaded with the first model. */
  vad_installed: boolean;
  vad_size: number;
  /** Another dashboard on this computer is downloading: its progress shows there. */
  downloading_elsewhere: boolean;
  models_dir: string;
  total_memory_gb: number;
  /** Set when this computer has little memory for the default model. */
  memory_hint: string | null;
}

const HF = 'https://huggingface.co';
const SENSEVOICE_REPO = 'csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17';
const SENSEVOICE_COMMIT = '2365baeacb507f821a0c8120fcee3d484dba7a07';
const WHISPER_REPO = 'csukuangfj/sherpa-onnx-whisper-turbo';
const WHISPER_COMMIT = '2ca6ff69fc878651b770880507669577ac41c2ff';

/**
 * The models on offer. Speeds and memory were measured on an Apple Silicon Mac, CPU only, with fictional English
 * and Japanese meetings; other computers may be slower. The 2024-07-17 SenseVoice is pinned on purpose: the
 * 2025-09-09 release drops kana from Japanese.
 */
export const CATALOG: CatalogModel[] = [
  {
    id: 'whisper-large-v3-turbo',
    name: 'Whisper large-v3-turbo',
    summary: 'Most accurate. Takes longer.',
    languages: '99 languages, including English and Japanese',
    pros: ['The most accurate transcripts, in English and Japanese alike', 'Full punctuation', '99 languages'],
    cons: ['Slower: about 4 times faster than real time, so an 8-hour meeting takes about 2 hours', 'Needs about 4 GB of memory while transcribing', 'A 1 GB download'],
    memory_gb: 4,
    engine: { kind: 'whisper', files: { encoder: 'turbo-encoder.int8.onnx', decoder: 'turbo-decoder.int8.onnx', tokens: 'turbo-tokens.txt' } },
    files: [
      { name: 'turbo-encoder.int8.onnx', url: `${HF}/${WHISPER_REPO}/resolve/${WHISPER_COMMIT}/turbo-encoder.int8.onnx`, size: 674716297, sha256: 'b02dcdf54f348741e93fe732b67d933c8dcb6735655f710640143081db38878b' },
      { name: 'turbo-decoder.int8.onnx', url: `${HF}/${WHISPER_REPO}/resolve/${WHISPER_COMMIT}/turbo-decoder.int8.onnx`, size: 361080764, sha256: '20accd02388482eb3a46bd615631adfdc85e1eb2c7db9ea3f02a40ffe6b81547' },
      { name: 'turbo-tokens.txt', url: `${HF}/${WHISPER_REPO}/resolve/${WHISPER_COMMIT}/turbo-tokens.txt`, size: 816730, sha256: 'b34b360dbb493e781e479794586d661700670d65564001f23024971d1f2fa126' },
    ],
  },
  {
    id: 'sensevoice-2024-07-17',
    name: 'SenseVoice',
    summary: 'Very fast and light. A little less accurate.',
    languages: 'English, Japanese, Chinese, Korean and Cantonese',
    pros: ['Very fast: about 80 times faster than real time, so an 8-hour meeting takes about 6 minutes', 'Light: under 1 GB of memory', 'A 240 MB download'],
    cons: ['A little less accurate: small slips and less punctuation', 'Five languages only'],
    memory_gb: 1,
    engine: { kind: 'sensevoice', files: { model: 'model.int8.onnx', tokens: 'tokens.txt' } },
    files: [
      { name: 'model.int8.onnx', url: `${HF}/${SENSEVOICE_REPO}/resolve/${SENSEVOICE_COMMIT}/model.int8.onnx`, size: 239233841, sha256: 'c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51' },
      { name: 'tokens.txt', url: `${HF}/${SENSEVOICE_REPO}/resolve/${SENSEVOICE_COMMIT}/tokens.txt`, size: 315894, sha256: 'f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc' },
    ],
  },
];

/** Silero VAD splits a recording into speech segments; every model needs it. */
export const VAD: CatalogModel = {
  id: 'silero-vad',
  name: 'Silero VAD',
  summary: 'Finds the speech in a recording.',
  languages: 'Any',
  pros: [],
  cons: [],
  memory_gb: 0,
  files: [
    { name: 'silero_vad.onnx', url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx', size: 643854, sha256: '9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6' },
  ],
};

const DEFAULTS: TranscriptionSettings = { model: 'whisper-large-v3-turbo', language: 'auto', keep_recordings: false, live_model: null, updated_at: null };
/** Below this much memory the default model leaves little room, and the lighter one is suggested. */
const LOW_MEMORY_BYTES = 8.5 * 1024 ** 3;
const STALL_MS = 60_000;
/** At most this much downloaded data waits in memory for the disk (a setting only tests change). */
export const downloadLimits = { maxQueuedBytes: 64 * 1024 * 1024 };
const ATTEMPTS = 3;

function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode: status });
}

export function modelsDir(): string {
  return process.env['ESB_MODELS_PATH'] || path.join(os.homedir(), '.gtd', 'models');
}

/** Validates settings from a request or the file, filling anything missing from `base`. */
export function parseTranscriptionSettings(input: unknown, base: TranscriptionSettings = DEFAULTS, catalog: CatalogModel[] = CATALOG): TranscriptionSettings {
  const o = (input && typeof input === 'object' && !Array.isArray(input) ? input : {}) as Record<string, unknown>;
  if (o['model'] !== undefined && !catalog.some((m) => m.id === o['model'])) throw httpError(400, 'Invalid model');
  if (o['language'] !== undefined && !LANGUAGES.includes(o['language'] as TranscriptionLanguage)) throw httpError(400, 'Invalid language: use auto, en or ja');
  if (o['keep_recordings'] !== undefined && typeof o['keep_recordings'] !== 'boolean') throw httpError(400, 'Invalid keep_recordings: use true or false');
  if (o['live_model'] !== undefined && o['live_model'] !== null && !catalog.some((m) => m.id === o['live_model'])) throw httpError(400, 'Invalid live_model: a catalog model, or null for no live transcript');
  return {
    model: (o['model'] as string | undefined) ?? base.model,
    language: (o['language'] as TranscriptionLanguage | undefined) ?? base.language,
    keep_recordings: (o['keep_recordings'] as boolean | undefined) ?? base.keep_recordings,
    live_model: o['live_model'] === undefined ? base.live_model : (o['live_model'] as string | null),
    updated_at: typeof o['updated_at'] === 'string' ? o['updated_at'] : base.updated_at,
  };
}

/** Throttled change notices for the dashboard: at most one every half second, and always one at the end. */
export const transcriptionEvents = new EventEmitter();
let pendingNotice: NodeJS.Timeout | null = null;
function notify(now = false): void {
  if (now) {
    if (pendingNotice) clearTimeout(pendingNotice);
    pendingNotice = null;
    transcriptionEvents.emit('change');
    return;
  }
  if (pendingNotice) return;
  pendingNotice = setTimeout(() => {
    pendingNotice = null;
    transcriptionEvents.emit('change');
  }, 500);
}

/** A running download: its progress, how to stop it, the bytes on disk per file, and the lock it holds. */
interface Job { progress: DownloadProgress; abort: AbortController; bytes: Map<string, number>; lock: HeldLock | null }
/** The download this dashboard runs (claimed before anything is awaited), and how the last one of each model ended. */
let active: Job | null = null;
/** True while this dashboard removes a model: claimed before anything is awaited, like a download. */
let removing = false;
const lastOutcome = new Map<string, DownloadProgress>();

const { O_WRONLY, O_CREAT, O_TRUNC, O_APPEND, O_RDONLY } = fs.constants;
/** Not on Windows, which has no symbolic links of this kind; the lstat checks cover it there. */
const O_NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;

export class TranscriptionModelService {
  constructor(private readonly catalog: CatalogModel[] = CATALOG, private readonly vad: CatalogModel = VAD, private readonly fetchImpl: typeof fetch = fetch) {}

  private dir(): string { return modelsDir(); }
  private modelDir(id: string): string { return path.join(this.dir(), id); }

  private find(id: string): CatalogModel {
    const model = id === this.vad.id ? this.vad : this.catalog.find((m) => m.id === id);
    if (!model) throw httpError(404, `Unknown model: ${id}`);
    return model;
  }

  /**
   * A model's folder, made when needed: a real folder directly in the models folder, never a link. The models
   * folder itself may be a link (to another disk, say); nothing below it may.
   */
  private async ownDir(id: string, create: boolean): Promise<string> {
    const dir = this.modelDir(id);
    if (create) {
      await fsp.mkdir(this.dir(), { recursive: true });
      await fsp.mkdir(dir).catch((err: NodeJS.ErrnoException) => { if (err.code !== 'EEXIST') throw err; });
    }
    const st = await fsp.lstat(dir);
    if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`${dir} is not a plain folder, so nothing is written there.`);
    return dir;
  }

  async readSettings(): Promise<TranscriptionSettings> {
    try {
      return parseTranscriptionSettings(JSON.parse(await fsp.readFile(path.join(this.dir(), 'settings.json'), 'utf-8')), DEFAULTS, this.catalog);
    } catch {
      return { ...DEFAULTS };
    }
  }

  /**
   * Whether recordings are kept. Unlike readSettings, which falls back to the defaults, settings that exist but
   * cannot be read count as keeping them: audio is removed only on a clear "not kept".
   */
  async keepRecordings(): Promise<boolean> {
    let raw: string;
    try {
      raw = await fsp.readFile(path.join(this.dir(), 'settings.json'), 'utf-8');
    } catch (err) {
      return (err as NodeJS.ErrnoException).code !== 'ENOENT';
    }
    try {
      return parseTranscriptionSettings(JSON.parse(raw), DEFAULTS, this.catalog).keep_recordings;
    } catch {
      return true;
    }
  }

  async updateSettings(input: unknown, now = new Date()): Promise<TranscriptionView> {
    const next = parseTranscriptionSettings(input, await this.readSettings(), this.catalog);
    next.updated_at = now.toISOString();
    await fsp.mkdir(this.dir(), { recursive: true });
    await atomicWrite(path.join(this.dir(), 'settings.json'), JSON.stringify(next, null, 2));
    notify(true);
    return this.view();
  }

  /** Installed: `installed.json` lists exactly the catalog's files and hashes, and each is there as a plain file of its size. */
  async installed(id: string): Promise<boolean> {
    const model = this.find(id);
    try {
      const dir = await this.ownDir(id, false);
      const record = JSON.parse(await fsp.readFile(path.join(dir, 'installed.json'), 'utf-8')) as { files?: { name: string; sha256: string }[] };
      const recorded = new Map((record.files ?? []).map((f) => [f.name, f.sha256]));
      for (const file of model.files) {
        if (recorded.get(file.name) !== file.sha256) return false;
        const st = await fsp.lstat(path.join(dir, file.name));
        if (!st.isFile() || st.size !== file.size) return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  /** The folder holding an installed model's files, or null. The transcription worker reads them from here. */
  async installedPath(id: string): Promise<string | null> {
    return await this.installed(id) ? this.modelDir(id) : null;
  }

  private async partialBytes(model: CatalogModel): Promise<number> {
    let total = 0;
    for (const file of model.files) {
      const done = await fsp.lstat(path.join(this.modelDir(model.id), file.name)).then((s) => (s.isFile() && s.size === file.size ? s.size : 0), () => 0);
      const part = await fsp.lstat(path.join(this.modelDir(model.id), `${file.name}.part`)).then((s) => (s.isFile() ? s.size : 0), () => 0);
      total += done || part;
    }
    return total;
  }

  /** Who holds the download lock, when it is another live dashboard. */
  private async otherHolder(): Promise<boolean> {
    const holder = await readLock(this.lockFile());
    return Boolean(holder && !holder.incomplete && !ownsToken(this.lockFile(), holder.token!) && processAlive(holder.pid) && holder.pid !== process.pid);
  }

  async view(): Promise<TranscriptionView> {
    const settings = await this.readSettings();
    const speeds = await readSpeeds();
    const vadInstalled = await this.installed(this.vad.id);
    const models: ModelView[] = [];
    for (const m of this.catalog) {
      const { files, engine: _engine, ...rest } = m;
      const installed = await this.installed(m.id);
      models.push({
        ...rest,
        size: files.reduce((sum, f) => sum + f.size, 0),
        installed,
        partial: installed ? 0 : await this.partialBytes(m),
        download: active?.progress.model === m.id ? active.progress : lastOutcome.get(m.id) ?? null,
        speed: installed ? speeds[m.id] ?? null : null,
      });
    }
    const total = os.totalmem();
    const light = this.catalog.find((m) => m.memory_gb <= 1);
    const heavy = this.catalog.find((m) => m.id === settings.model);
    return {
      models,
      settings,
      defaults: { ...DEFAULTS },
      vad_installed: vadInstalled,
      vad_size: this.vad.files.reduce((sum, f) => sum + f.size, 0),
      downloading_elsewhere: !active && await this.otherHolder(),
      models_dir: this.dir(),
      total_memory_gb: Math.round((total / 1024 ** 3) * 10) / 10,
      memory_hint: total < LOW_MEMORY_BYTES && heavy && heavy.memory_gb > 2 && light
        ? `This computer has ${Math.round(total / 1024 ** 3)} GB of memory. ${heavy.name} needs about ${heavy.memory_gb} GB while it transcribes; ${light.name} needs under 1 GB.`
        : null,
    };
  }

  /**
   * Starts downloading a model, and the voice-activity model when it is missing: only what is not installed yet.
   * Returns at once; progress arrives as change events and in the view. One download at a time, across dashboards.
   */
  async download(id: string): Promise<TranscriptionView> {
    const model = this.find(id);
    if (model.id === this.vad.id) throw httpError(400, 'The voice-activity model is downloaded with a transcription model');
    if (active) throw httpError(409, active.progress.model === id ? 'This model is already downloading' : `Another model is downloading (${active.progress.model}); wait for it or cancel it first`);
    if (removing) throw httpError(409, 'A model is being removed; try again in a moment');
    // Claimed before the first await, so two requests can never both start.
    const job: Job = { progress: { model: id, status: 'downloading', received: 0, total: 0, file: '' }, abort: new AbortController(), bytes: new Map(), lock: null };
    active = job;
    try {
      const parts: CatalogModel[] = [];
      for (const m of [this.vad, model]) if (!await this.installed(m.id)) parts.push(m);
      if (parts.length === 0) {
        active = null;
        return this.view();
      }
      await fsp.mkdir(this.dir(), { recursive: true });
      job.lock = await this.lock();
      job.progress.total = parts.reduce((sum, m) => sum + m.files.reduce((s, f) => s + f.size, 0), 0);
      lastOutcome.delete(id);
      notify(true);
      void this.run(job, parts).finally(() => this.finish(job));
    } catch (err) {
      if (active === job) active = null;
      if (job.lock) await this.unlock(job.lock);
      throw err;
    }
    return this.view();
  }

  private async finish(job: Job): Promise<void> {
    try {
      if (job.lock) await this.unlock(job.lock);
    } catch (err) {
      console.error(`[transcription] Could not release the download lock: ${(err as Error).message}`);
    } finally {
      if (active === job) active = null;
      notify(true);
    }
  }

  async cancel(id: string): Promise<TranscriptionView> {
    if (!active || active.progress.model !== id) throw httpError(409, 'Nothing is downloading for this model');
    active.abort.abort();
    return this.view();
  }

  /** Removes a model's files, verified or partial. Not while any dashboard downloads. */
  async remove(id: string): Promise<TranscriptionView> {
    const model = this.find(id);
    if (model.id === this.vad.id) throw httpError(400, 'The voice-activity model is kept for every transcription model');
    if (active) throw httpError(409, active.progress.model === id ? 'Cancel the download first' : 'Wait for the download to finish first');
    if (removing) throw httpError(409, 'A model is being removed; try again in a moment');
    // Claimed before the first await, like a download.
    removing = true;
    try {
      await fsp.mkdir(this.dir(), { recursive: true });
      const lock = await this.lock('Another dashboard is downloading a model; wait for it to finish first');
      try {
        if (await this.inUse(id)) throw httpError(409, 'This model is in use by a transcription or a check; try again when it has finished');
        const st = await fsp.lstat(this.modelDir(id)).catch(() => null);
        // A link is removed as a link: its target is never touched.
        if (st?.isSymbolicLink()) await fsp.unlink(this.modelDir(id));
        else if (st) await fsp.rm(this.modelDir(id), { recursive: true, force: true });
      } finally {
        await this.unlock(lock);
      }
    } finally {
      removing = false;
    }
    lastOutcome.delete(id);
    notify(true);
    return this.view();
  }

  /**
   * Marks an installed model as in use until the returned function is called, so it cannot be removed meanwhile,
   * from this or another dashboard. A lease is a small file in the model's folder naming the process; it is taken
   * under the download lock (which removal also holds), and one left by a process that is gone does not count.
   */
  async lease(id: string): Promise<() => Promise<void>> {
    const model = this.find(id);
    if (active || removing) throw httpError(409, 'A model is being downloaded or removed; try again when that has finished');
    await fsp.mkdir(this.dir(), { recursive: true });
    const lock = await this.lock('A model is being downloaded or removed; try again when that has finished');
    let file: string;
    try {
      if (!await this.installed(model.id)) throw httpError(409, `${model.name} is not downloaded yet: download it in Settings > Transcription`);
      file = path.join(await this.ownDir(model.id, false), `.lease-${process.pid}-${randomUUID()}`);
      const handle = await fsp.open(file, O_WRONLY | O_CREAT | fs.constants.O_EXCL | O_NOFOLLOW, 0o600);
      try { await handle.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() })); } finally { await handle.close(); }
    } finally {
      await this.unlock(lock);
    }
    return async () => { await fsp.rm(file, { force: true }); };
  }

  /** True when a live process holds a lease on the model. */
  private async inUse(id: string): Promise<boolean> {
    const names = await fsp.readdir(this.modelDir(id)).catch(() => [] as string[]);
    for (const name of names) {
      const m = /^\.lease-(\d+)-/.exec(name);
      if (m && processAlive(Number(m[1]))) return true;
    }
    return false;
  }

  private async run(job: Job, parts: CatalogModel[]): Promise<void> {
    try {
      for (const model of parts) {
        const dir = await this.ownDir(model.id, true);
        // A new install starts without the record, so a half-replaced model never counts as installed.
        await fsp.rm(path.join(dir, 'installed.json'), { force: true });
        for (const file of model.files) await this.fetchFile(job, dir, file);
        this.check(job);
        await atomicWrite(path.join(dir, 'installed.json'), JSON.stringify({ id: model.id, files: model.files.map((f) => ({ name: f.name, sha256: f.sha256 })), installed_at: new Date().toISOString() }, null, 2));
      }
      lastOutcome.delete(job.progress.model);
    } catch (err) {
      const cancelled = job.abort.signal.aborted;
      const outcome: DownloadProgress = {
        ...job.progress,
        status: cancelled ? 'cancelled' : 'failed',
        message: cancelled ? 'Cancelled. What was downloaded is kept, and the next download continues from there.' : `${(err as Error).message} What was downloaded is kept; try again to continue.`,
      };
      job.progress = outcome;
      lastOutcome.set(outcome.model, outcome);
    }
  }

  private check(job: Job): void {
    if (job.abort.signal.aborted) throw new Error('Cancelled.');
  }

  /** Downloads one file into place: resumed from `<file>.part`, checked by size and SHA-256, then renamed. */
  private async fetchFile(job: Job, dir: string, file: ModelFile): Promise<void> {
    const target = path.join(dir, file.name);
    const part = `${target}.part`;
    const done = await fsp.lstat(target).catch(() => null);
    if (done && !done.isFile()) throw new Error(`${file.name} is not a plain file in the models folder, so nothing is written there.`);
    if (done?.size === file.size) {
      this.setBytes(job, file.name, file.size, 'verifying');
      if (await hashFile(target, job.abort.signal) === file.sha256) return;
    }
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      this.check(job);
      try {
        await this.fetchInto(job, file, part);
        this.setBytes(job, file.name, file.size, 'verifying');
        const got = await fsp.lstat(part);
        if (!got.isFile() || got.size !== file.size) throw new Error(`${file.name} has ${got.size} bytes instead of ${file.size}.`);
        if (await hashFile(part, job.abort.signal) !== file.sha256) {
          await fsp.rm(part, { force: true });
          throw new Error(`${file.name} does not match its checksum, so it was removed.`);
        }
        this.check(job);
        const now = await fsp.lstat(target).catch(() => null);
        if (now && !now.isFile()) throw new Error(`${file.name} is not a plain file in the models folder, so nothing is written there.`);
        await fsp.rename(part, target);
        return;
      } catch (err) {
        lastError = err as Error;
        if (job.abort.signal.aborted || /checksum|plain file|not a plain/.test(lastError.message)) throw lastError;
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }
    throw lastError ?? new Error(`${file.name} could not be downloaded.`);
  }

  /**
   * Writes the rest of a file to `part`, from where it stopped. The part is opened without following links and
   * must be a plain file with one name; a server that ignores the range starts it over. Every write error, a full
   * disk included, ends the attempt cleanly.
   */
  private async fetchInto(job: Job, file: ModelFile, part: string): Promise<void> {
    const existing = await fsp.lstat(part).catch(() => null);
    if (existing && (!existing.isFile() || existing.nlink !== 1)) throw new Error(`${path.basename(part)} is not a plain file in the models folder, so nothing is written there.`);
    let have = existing?.size ?? 0;
    if (have > file.size) {
      await fsp.rm(part, { force: true });
      have = 0;
    }
    this.setBytes(job, file.name, have);
    if (have === file.size) return;
    const stall = new AbortController();
    let timer = setTimeout(() => stall.abort(), STALL_MS);
    const signal = AbortSignal.any([job.abort.signal, stall.signal]);
    try {
      const res = await this.fetchImpl(file.url, { headers: have ? { Range: `bytes=${have}-` } : {}, redirect: 'follow', signal });
      const refuse = async (message: string) => { await res.body?.cancel().catch(() => {}); return new Error(message); };
      if (res.status === 416) {
        // The part is not a prefix the server recognizes: start over.
        await fsp.rm(part, { force: true });
        throw await refuse(`${file.name}: the download could not be continued and starts over.`);
      }
      let append = false;
      if (res.status === 206) {
        const range = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(res.headers.get('content-range') ?? '');
        const valid = range && Number(range[1]) === have && Number(range[2]) === file.size - 1 && (range[3] === '*' || Number(range[3]) === file.size);
        if (!valid) throw await refuse(`${file.name}: the server sent a different part of the file.`);
        append = true;
      } else if (res.status !== 200) {
        throw await refuse(`${file.name}: the download failed (HTTP ${res.status}).`);
      }
      if (!res.body) throw new Error(`${file.name}: the server sent no data.`);
      // The network is read eagerly, from the moment the answer arrives, into a queue that a writer drains: a stream
      // that fails throws away what it still holds, so everything that arrived reaches the disk before the error, and
      // the next attempt continues there.
      const queue: Uint8Array[] = [];
      let queued = 0;
      let readError: unknown = null;
      let ended = false;
      // Set when the writer stops (done, failed or cancelled): the reader then stops waiting for room.
      let stopped = false;
      let wake: (() => void) | null = null;
      const signalWriter = () => { const w = wake; wake = null; w?.(); };
      job.abort.signal.addEventListener('abort', signalWriter, { once: true });
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      const reading = (async () => {
        try {
          for (;;) {
            while (queued > downloadLimits.maxQueuedBytes && !stopped) await new Promise((r) => setTimeout(r, 10));
            if (stopped) break;
            const { value, done } = await reader.read();
            if (done) break;
            clearTimeout(timer);
            timer = setTimeout(() => stall.abort(), STALL_MS);
            queue.push(value);
            queued += value.length;
            signalWriter();
          }
        } catch (err) {
          readError = err;
        } finally {
          ended = true;
          signalWriter();
        }
      })();
      const handle = await fsp.open(part, O_WRONLY | O_CREAT | O_NOFOLLOW | (append ? O_APPEND : O_TRUNC), 0o600).catch(async (err: unknown) => {
        stopped = true;
        await reader.cancel().catch(() => {});
        await reading;
        throw err;
      });
      // Once the stream exists it owns the handle and closes it; before that, the handle is closed here.
      let stream: fs.WriteStream | null = null;
      try {
        const st = await handle.stat();
        if (!st.isFile() || st.nlink !== 1) throw new Error(`${path.basename(part)} is not a plain file in the models folder, so nothing is written there.`);
        let written = append ? have : 0;
        this.setBytes(job, file.name, written);
        const out = handle.createWriteStream();
        stream = out;
        let writeError: Error | null = null;
        out.on('error', (err) => { writeError = err; });
        try {
          for (;;) {
            if (job.abort.signal.aborted) throw new Error('Cancelled.');
            const chunk = queue.shift();
            if (!chunk) {
              if (ended) break;
              await new Promise<void>((r) => { wake = r; });
              continue;
            }
            queued -= chunk.length;
            written += chunk.length;
            if (written > file.size) throw new Error(`${file.name} is larger than expected.`);
            if (writeError) throw writeError;
            await new Promise<void>((resolve, reject) => out.write(chunk, (err) => (err ? reject(err) : resolve())));
            this.setBytes(job, file.name, written);
          }
        } finally {
          stopped = true;
          if (!ended) await reader.cancel().catch(() => {});
          await reading;
        }
        if (readError) throw readError;
        if (writeError) throw writeError;
      } finally {
        stopped = true;
        if (!ended) await reader.cancel().catch(() => {});
        await reading;
        if (!stream) await handle.close().catch(() => {});
        else {
          stream.end();
          await finished(stream).catch(() => {});
        }
      }
    } catch (err) {
      if (stall.signal.aborted && !job.abort.signal.aborted) throw new Error(`${file.name}: no data for a minute, so the download stopped.`, { cause: err });
      if (job.abort.signal.aborted) throw new Error('Cancelled.', { cause: err });
      if ((err as NodeJS.ErrnoException).code === 'ELOOP') throw new Error(`${path.basename(part)} is not a plain file in the models folder, so nothing is written there.`, { cause: err });
      if ((err as NodeJS.ErrnoException).code === 'ENOSPC') throw new Error(`The disk is full while writing ${file.name}.`, { cause: err });
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Records how much of one file is on disk, and the job's total progress from that. */
  private setBytes(job: Job, name: string, bytes: number, status: DownloadProgress['status'] = 'downloading'): void {
    job.bytes.set(name, bytes);
    let received = 0;
    for (const n of job.bytes.values()) received += n;
    job.progress = { ...job.progress, status, received, file: name };
    notify();
  }

  private lockFile(): string { return path.join(this.dir(), 'download.lock'); }

  /** One download or removal at a time across every dashboard using this folder; busy is refused at once (409). */
  private async lock(busy = 'Another dashboard is downloading a model; wait for it to finish'): Promise<HeldLock> {
    const result = await tryLock(this.lockFile());
    if (result === 'starting') throw httpError(409, 'Another dashboard is starting a download; try again in a moment');
    if (result === 'stuck') throw httpError(409, 'The download lock could not be taken; try again');
    if (result === 'held') throw httpError(409, busy);
    return result;
  }

  private async unlock(held: HeldLock): Promise<void> {
    await unlock(held);
  }

  /** For tests: waits until no download runs in this process. */
  static async settled(): Promise<void> {
    while (active) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** The SHA-256 of a plain file, read without following links; stops when the download is cancelled. */
async function hashFile(file: string, signal?: AbortSignal): Promise<string> {
  const hash: Hash = createHash('sha256');
  const handle = await fsp.open(file, O_RDONLY | O_NOFOLLOW);
  try {
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      if (signal?.aborted) throw new Error('Cancelled.');
      hash.update(chunk as Buffer);
    }
  } finally {
    await handle.close().catch(() => {});
  }
  return hash.digest('hex');
}
