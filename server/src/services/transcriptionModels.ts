import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { createHash, Hash } from 'crypto';
import { EventEmitter } from 'events';
import { atomicWrite } from '../utils/atomicWrite';
import { processAlive } from './runState';

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
}

export type TranscriptionLanguage = 'auto' | 'en' | 'ja';
export const LANGUAGES: TranscriptionLanguage[] = ['auto', 'en', 'ja'];

export interface TranscriptionSettings { model: string; language: TranscriptionLanguage; updated_at: string | null }

export interface DownloadProgress {
  model: string;
  status: 'downloading' | 'verifying' | 'failed' | 'cancelled';
  received: number;
  total: number;
  file: string;
  message?: string;
}

export interface ModelView extends Omit<CatalogModel, 'files'> {
  size: number;
  installed: boolean;
  /** Bytes already on disk from an interrupted download; it resumes from there. */
  partial: number;
  download: DownloadProgress | null;
}

export interface TranscriptionView {
  models: ModelView[];
  settings: TranscriptionSettings;
  defaults: TranscriptionSettings;
  /** The voice-activity model every transcription needs; downloaded with the first model. */
  vad_installed: boolean;
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
    cons: ['Slower: about 4 times real time, so an 8-hour meeting takes about 2 hours', 'Needs about 4 GB of memory while transcribing', 'A 1 GB download'],
    memory_gb: 4,
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
    pros: ['Very fast: about 80 times real time, so an 8-hour meeting takes about 6 minutes', 'Light: under 1 GB of memory', 'A 240 MB download'],
    cons: ['A little less accurate: small slips and less punctuation', 'Five languages only'],
    memory_gb: 1,
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

const DEFAULTS: TranscriptionSettings = { model: 'whisper-large-v3-turbo', language: 'auto', updated_at: null };
/** Below this much memory the default model leaves little room, and the lighter one is suggested. */
const LOW_MEMORY_BYTES = 8.5 * 1024 ** 3;
const STALL_MS = 60_000;
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
  return {
    model: (o['model'] as string | undefined) ?? base.model,
    language: (o['language'] as TranscriptionLanguage | undefined) ?? base.language,
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

/** A running download: its progress, how to stop it, and the bytes on disk per file. */
interface Job { progress: DownloadProgress; abort: AbortController; bytes: Map<string, number> }
/** The download this dashboard runs, and how the last one of each model ended. */
let active: Job | null = null;
const lastOutcome = new Map<string, DownloadProgress>();

export class TranscriptionModelService {
  constructor(private readonly catalog: CatalogModel[] = CATALOG, private readonly vad: CatalogModel = VAD, private readonly fetchImpl: typeof fetch = fetch) {}

  private dir(): string { return modelsDir(); }
  private modelDir(id: string): string { return path.join(this.dir(), id); }

  private find(id: string): CatalogModel {
    const model = id === this.vad.id ? this.vad : this.catalog.find((m) => m.id === id);
    if (!model) throw httpError(404, `Unknown model: ${id}`);
    return model;
  }

  async readSettings(): Promise<TranscriptionSettings> {
    try {
      return parseTranscriptionSettings(JSON.parse(await fsp.readFile(path.join(this.dir(), 'settings.json'), 'utf-8')), DEFAULTS, this.catalog);
    } catch {
      return { ...DEFAULTS };
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

  /** Installed: `installed.json` lists exactly the catalog's files and hashes, and each file is there with its size. */
  async installed(id: string): Promise<boolean> {
    const model = this.find(id);
    try {
      const record = JSON.parse(await fsp.readFile(path.join(this.modelDir(id), 'installed.json'), 'utf-8')) as { files?: { name: string; sha256: string }[] };
      const recorded = new Map((record.files ?? []).map((f) => [f.name, f.sha256]));
      for (const file of model.files) {
        if (recorded.get(file.name) !== file.sha256) return false;
        const st = await fsp.lstat(path.join(this.modelDir(id), file.name));
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
      const done = await fsp.lstat(path.join(this.modelDir(model.id), file.name)).then((s) => (s.size === file.size ? s.size : 0), () => 0);
      const part = await fsp.lstat(path.join(this.modelDir(model.id), `${file.name}.part`)).then((s) => s.size, () => 0);
      total += done || part;
    }
    return total;
  }

  async view(): Promise<TranscriptionView> {
    const settings = await this.readSettings();
    const models: ModelView[] = [];
    for (const m of this.catalog) {
      const { files, ...rest } = m;
      const installed = await this.installed(m.id);
      models.push({
        ...rest,
        size: files.reduce((sum, f) => sum + f.size, 0),
        installed,
        partial: installed ? 0 : await this.partialBytes(m),
        download: active?.progress.model === m.id ? active.progress : lastOutcome.get(m.id) ?? null,
      });
    }
    const total = os.totalmem();
    const light = this.catalog.find((m) => m.memory_gb <= 1);
    const heavy = this.catalog.find((m) => m.id === settings.model);
    return {
      models,
      settings,
      defaults: { ...DEFAULTS },
      vad_installed: await this.installed(this.vad.id),
      models_dir: this.dir(),
      total_memory_gb: Math.round((total / 1024 ** 3) * 10) / 10,
      memory_hint: total < LOW_MEMORY_BYTES && heavy && heavy.memory_gb > 2 && light
        ? `This computer has ${Math.round(total / 1024 ** 3)} GB of memory. ${heavy.name} needs about ${heavy.memory_gb} GB while it transcribes; ${light.name} needs under 1 GB.`
        : null,
    };
  }

  /**
   * Starts downloading a model, and the voice-activity model when it is missing. Returns at once; progress
   * arrives as change events and in the view. One download at a time, across dashboards.
   */
  async download(id: string): Promise<TranscriptionView> {
    const model = this.find(id);
    if (model.id === this.vad.id) throw httpError(400, 'The voice-activity model is downloaded with a transcription model');
    if (active) throw httpError(409, active.progress.model === id ? 'This model is already downloading' : `Another model is downloading (${active.progress.model}); wait for it or cancel it first`);
    if (await this.installed(id) && await this.installed(this.vad.id)) return this.view();
    await fsp.mkdir(this.dir(), { recursive: true });
    await this.lock();
    const parts = [...(await this.installed(this.vad.id) ? [] : [this.vad]), model];
    const total = parts.reduce((sum, m) => sum + m.files.reduce((s, f) => s + f.size, 0), 0);
    const job: Job = { progress: { model: id, status: 'downloading', received: 0, total, file: '' }, abort: new AbortController(), bytes: new Map() };
    active = job;
    lastOutcome.delete(id);
    notify(true);
    void this.run(job, parts).finally(async () => {
      if (active === job) active = null;
      await this.unlock();
      notify(true);
    });
    return this.view();
  }

  async cancel(id: string): Promise<TranscriptionView> {
    if (!active || active.progress.model !== id) throw httpError(409, 'Nothing is downloading for this model');
    active.abort.abort();
    return this.view();
  }

  /** Removes a model's files, verified or partial. Not while it downloads. */
  async remove(id: string): Promise<TranscriptionView> {
    const model = this.find(id);
    if (model.id === this.vad.id) throw httpError(400, 'The voice-activity model is kept for every transcription model');
    if (active?.progress.model === id) throw httpError(409, 'Cancel the download first');
    await fsp.rm(this.modelDir(id), { recursive: true, force: true });
    lastOutcome.delete(id);
    notify(true);
    return this.view();
  }

  private async run(job: Job, parts: CatalogModel[]): Promise<void> {
    try {
      for (const model of parts) {
        if (await this.installed(model.id)) continue;
        const dir = this.modelDir(model.id);
        await fsp.mkdir(dir, { recursive: true });
        // A new install starts without the record, so a half-replaced model never counts as installed.
        await fsp.rm(path.join(dir, 'installed.json'), { force: true });
        for (const file of model.files) await this.fetchFile(job, dir, file);
        job.progress = { ...job.progress, status: 'verifying', file: '' };
        notify();
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

  /** Downloads one file into place: resumed from `<file>.part`, checked by size and SHA-256, then renamed. */
  private async fetchFile(job: Job, dir: string, file: ModelFile): Promise<void> {
    const target = path.join(dir, file.name);
    const done = await fsp.lstat(target).catch(() => null);
    if (done?.isFile() && done.size === file.size && await hashFile(target) === file.sha256) {
      this.setBytes(job, file.name, file.size);
      return;
    }
    const part = `${target}.part`;
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      if (job.abort.signal.aborted) throw new Error('Cancelled.');
      try {
        await this.fetchInto(job, file, part);
        const got = await fsp.lstat(part);
        if (got.size !== file.size) throw new Error(`${file.name} has ${got.size} bytes instead of ${file.size}.`);
        if (await hashFile(part) !== file.sha256) {
          await fsp.rm(part, { force: true });
          throw new Error(`${file.name} does not match its checksum, so it was removed.`);
        }
        await fsp.rename(part, target);
        return;
      } catch (err) {
        lastError = err as Error;
        if (job.abort.signal.aborted || /checksum/.test(lastError.message)) throw lastError;
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }
    throw lastError ?? new Error(`${file.name} could not be downloaded.`);
  }

  /** Appends the rest of a file to `part`, from where it stopped. A server that ignores the range starts it over. */
  private async fetchInto(job: Job, file: ModelFile, part: string): Promise<void> {
    let have = await fsp.lstat(part).then((s) => s.size, () => 0);
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
      if (res.status === 416) {
        // The part is not a prefix the server recognizes: start over.
        await fsp.rm(part, { force: true });
        throw new Error(`${file.name}: the download could not be continued and starts over.`);
      }
      let append = false;
      if (res.status === 206) {
        const range = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(res.headers.get('content-range') ?? '');
        if (!range || Number(range[1]) !== have) throw new Error(`${file.name}: the server sent a different part of the file.`);
        append = true;
      } else if (res.status !== 200) {
        throw new Error(`${file.name}: the download failed (HTTP ${res.status}).`);
      }
      if (!res.body) throw new Error(`${file.name}: the server sent no data.`);
      if (!append) this.setBytes(job, file.name, 0);
      const out = fs.createWriteStream(part, { flags: append ? 'a' : 'w', mode: 0o600 });
      const done = new Promise<void>((resolve, reject) => { out.on('finish', resolve); out.on('error', reject); });
      let written = append ? have : 0;
      try {
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          clearTimeout(timer);
          timer = setTimeout(() => stall.abort(), STALL_MS);
          written += chunk.length;
          if (written > file.size) throw new Error(`${file.name} is larger than expected.`);
          if (!out.write(chunk)) await new Promise<void>((r) => out.once('drain', () => r()));
          this.setBytes(job, file.name, written);
        }
      } finally {
        out.end();
        await done;
      }
    } catch (err) {
      if (stall.signal.aborted && !job.abort.signal.aborted) throw new Error(`${file.name}: no data for a minute, so the download stopped.`, { cause: err });
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Records how much of one file is on disk, and the job's total progress from that. */
  private setBytes(job: Job, name: string, bytes: number): void {
    job.bytes.set(name, bytes);
    let received = 0;
    for (const n of job.bytes.values()) received += n;
    job.progress = { ...job.progress, status: 'downloading', received, file: name };
    notify();
  }

  private lockFile(): string { return path.join(this.dir(), 'download.lock'); }

  /** One download across every dashboard using this folder; a lock left by a process that is gone is taken over. */
  private async lock(): Promise<void> {
    const file = this.lockFile();
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await fsp.writeFile(file, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { flag: 'wx' });
        return;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        const holder = await fsp.readFile(file, 'utf-8').then((t) => JSON.parse(t) as { pid?: number }, () => ({} as { pid?: number }));
        if (holder.pid && holder.pid !== process.pid && processAlive(holder.pid)) throw httpError(409, 'Another dashboard is downloading a model; wait for it to finish');
        await fsp.rm(file, { force: true });
      }
    }
    throw httpError(409, 'The download lock could not be taken; try again');
  }

  private async unlock(): Promise<void> {
    const holder = await fsp.readFile(this.lockFile(), 'utf-8').then((t) => JSON.parse(t) as { pid?: number }, () => null);
    if (holder?.pid === process.pid) await fsp.rm(this.lockFile(), { force: true });
  }

  /** For tests: waits until no download runs in this process. */
  static async settled(): Promise<void> {
    while (active) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function hashFile(file: string): Promise<string> {
  const hash: Hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}
