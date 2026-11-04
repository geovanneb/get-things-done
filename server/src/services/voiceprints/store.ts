import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { atomicWrite } from '../../utils/atomicWrite';
import { lock, unlock } from '../../utils/fileLock';
import { centroid, isEmbedding } from '../transcription/voices';

/**
 * The voices remembered on this computer: biometric data, so they live outside the workspace (which goes to git and
 * often to a sync folder), readable only by this user, and are part of nothing else. See docs/voiceprints.md.
 *
 *   ~/.gtd/voiceprints/<binding>/binding.json   the workspace folder these prints belong to, and the forget counter
 *   ~/.gtd/voiceprints/<binding>/STK-0001.json  one person's print: model, consent, samples
 *   ~/.gtd/voiceprints/<binding>/.lock          one change at a time, across dashboards
 *
 * A binding is named after the workspace folder's path, like the workspace picture. Moving the workspace leaves its
 * prints under the old path until the user relinks them (Settings); a copy of the workspace never gets them, because
 * a copy may hold other stakeholders under the same ids. Nothing here is ever read by agents, the digest, search or
 * exports.
 */

/** The wording a person agreed to. A new wording gets a new number; prints keep the one they were given under. */
export const CONSENT_VERSION = 1;
export const consentText = (person: string) => `${person} agreed that their voice is remembered on this computer, to suggest their name in transcripts. It stays on this computer and can be forgotten at any time.`;

/** One sample per confirmed speaker of a recording; the oldest go first. */
export const MAX_PRINT_SAMPLES = 20;
export const VOICE_REF = /^(STK-\d{4}|me)$/;
const BINDING_KEY = /^[0-9a-f]{32}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const LOCK_WAIT_MS = 5000;

function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode: status });
}

/** Where a sample came from: the very recording, transcript and label the user confirmed. */
export interface SampleSource {
  /** A recording in the meeting queue, or a version of a kept meeting's folder. */
  kind: 'queue' | 'folder';
  meeting: string;
  file: string;
  version?: string;
  audio_sha256: string;
  transcript_sha256: string;
  label: string;
}
/** The mean embedding of one speaker's clean speech in one recording, and how much speech that was. */
export interface VoiceSample { embedding: number[]; seconds: number; source: SampleSource; at: string }
/** Who agreed, to which wording, recorded by whom and when. */
export interface Consent { version: number; person: string; recorded_by: string; at: string }
export interface Voiceprint {
  schema: 1;
  ref: string;
  /** The person's name when the voice was last remembered: shown when the stakeholder is gone. */
  name: string;
  /** The embedding model the samples were made with: another model makes them meaningless. */
  model: { id: string; sha256: string };
  consent: Consent;
  samples: VoiceSample[];
  /** Changes with every write: an enrollment that started on another revision is refused. */
  revision: number;
  updated_at: string;
}
interface Binding { schema: 1; workspace: string; created_at: string; epoch: number }

/** A print file that cannot be read: kept listed so it can be forgotten, never used. */
export interface DamagedPrint { ref: string; damaged: true }

/** What an enrollment saw when it started: saving is refused if any of it changed meanwhile. */
export interface Snapshot { epoch: number; revision: number | null }

export function voiceprintsRoot(): string {
  return process.env['ESB_VOICEPRINTS_PATH'] || path.join(os.homedir(), '.gtd', 'voiceprints');
}

/** The binding of a workspace folder: a hash of its path keeps request values out of file names. */
export function bindingKey(workspace: string): string {
  return createHash('sha256').update(path.resolve(workspace)).digest('hex').slice(0, 32);
}

function checkRef(ref: string): string {
  if (!VOICE_REF.test(ref)) throw httpError(400, 'Invalid person: a stakeholder id like STK-0001, or me');
  return ref;
}

/**
 * A person's file in a binding: `me.json`, or the stakeholder's id rebuilt from its digits. Nothing of the request's
 * text reaches the path, whatever checks ran before (and CodeQL cannot follow those through calls).
 */
function printFile(dir: string, ref: string): string {
  if (ref === 'me') return path.join(dir, 'me.json');
  const id = /^STK-(\d{4})$/.exec(ref);
  if (!id) throw httpError(400, 'Invalid person: a stakeholder id like STK-0001, or me');
  return path.join(dir, `STK-${String(Number(id[1])).padStart(4, '0')}.json`);
}

/** A folder of the store: a plain folder, never a link, private to this user. */
async function privateDir(dir: string): Promise<void> {
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  const st = await fsp.lstat(dir);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`${dir} is not a plain folder, so no voice is kept there.`);
  if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) await fsp.chmod(dir, 0o700);
}

async function writePrivate(file: string, value: unknown): Promise<void> {
  await atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`);
  if (process.platform !== 'win32') await fsp.chmod(file, 0o600);
}

async function readJson(file: string): Promise<unknown | undefined> {
  const st = await fsp.lstat(file).catch(() => null);
  if (!st) return undefined;
  if (!st.isFile()) return null;
  try { return JSON.parse(await fsp.readFile(file, 'utf-8')); } catch { return null; }
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
const text = (v: unknown, max = 200): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;

function parseSource(v: unknown): SampleSource | null {
  const o = obj(v);
  if ((o['kind'] !== 'queue' && o['kind'] !== 'folder') || !text(o['meeting'], 40) || !text(o['file'], 255) || !text(o['label'], 20)
    || !text(o['audio_sha256']) || !SHA256.test(o['audio_sha256']) || !text(o['transcript_sha256']) || !SHA256.test(o['transcript_sha256'])) return null;
  if (o['version'] !== undefined && (!text(o['version'], 8) || !/^v\d{1,4}$/.test(o['version']))) return null;
  return { kind: o['kind'], meeting: o['meeting'], file: o['file'], label: o['label'], audio_sha256: o['audio_sha256'], transcript_sha256: o['transcript_sha256'], ...(typeof o['version'] === 'string' ? { version: o['version'] } : {}) };
}

/** A print exactly as it should be, or null: one damaged sample makes the whole print unusable rather than half-trusted. */
export function parsePrint(raw: unknown, ref: string): Voiceprint | null {
  const o = obj(raw);
  const model = obj(o['model']);
  const consent = obj(o['consent']);
  if (o['schema'] !== 1 || o['ref'] !== ref || !text(o['name'], 120) || !text(model['id'], 80) || !text(model['sha256']) || !SHA256.test(model['sha256'])) return null;
  if (!Number.isSafeInteger(consent['version']) || !text(consent['person'], 120) || !text(consent['recorded_by'], 120) || !text(consent['at'], 40)) return null;
  if (!Array.isArray(o['samples']) || o['samples'].length > MAX_PRINT_SAMPLES || !Number.isSafeInteger(o['revision']) || !text(o['updated_at'], 40)) return null;
  const samples: VoiceSample[] = [];
  let dim: number | undefined;
  for (const entry of o['samples']) {
    const s = obj(entry);
    const source = parseSource(s['source']);
    if (!isEmbedding(s['embedding'], dim) || typeof s['seconds'] !== 'number' || !(s['seconds'] > 0) || !source || !text(s['at'], 40)) return null;
    dim = s['embedding'].length;
    samples.push({ embedding: s['embedding'], seconds: s['seconds'], source, at: s['at'] });
  }
  return {
    schema: 1, ref, name: o['name'], model: { id: model['id'], sha256: model['sha256'] },
    consent: { version: consent['version'] as number, person: consent['person'], recorded_by: consent['recorded_by'], at: consent['at'] },
    samples, revision: o['revision'] as number, updated_at: o['updated_at'],
  };
}

/** The print as one voice: the mean of its samples, and how much clean speech they hold. */
export function printVoice(print: Voiceprint): { centroid: number[] | null; seconds: number } {
  return { centroid: centroid(print.samples.map((s) => s.embedding)), seconds: Math.round(print.samples.reduce((n, s) => n + s.seconds, 0) * 10) / 10 };
}

/** A sample's id in the API: a short hash of where it came from (unique within a print, since a source has one sample). */
export function sampleKey(s: SampleSource): string {
  return createHash('sha256').update(JSON.stringify([s.kind, s.meeting, s.file, s.version ?? '', s.transcript_sha256, s.label])).digest('hex').slice(0, 16);
}
export const SAMPLE_KEY = /^[0-9a-f]{16}$/;

const sameSource = (a: SampleSource, b: SampleSource) =>
  a.kind === b.kind && a.meeting === b.meeting && a.file === b.file && a.version === b.version && a.transcript_sha256 === b.transcript_sha256 && a.label === b.label;

/** Another workspace folder's prints, whose folder is gone: probably a moved workspace, to relink or forget. */
export interface MovedBinding { key: string; workspace: string; prints: { ref: string; name: string }[] }

export class VoiceprintStore {
  constructor(private readonly root: () => string = voiceprintsRoot) {}

  private dir(workspace: string): string {
    return path.join(this.root(), bindingKey(workspace));
  }

  /** One change to a workspace's prints at a time, across dashboards. The binding is made on first use. */
  private async locked<T>(workspace: string, fn: (dir: string, binding: Binding) => Promise<T>): Promise<T> {
    const dir = this.dir(workspace);
    await privateDir(this.root());
    await privateDir(dir);
    const held = await lock(path.join(dir, '.lock'), LOCK_WAIT_MS, () => httpError(409, 'The remembered voices are being changed in another window; try again'));
    try {
      return await fn(dir, await this.binding(dir, workspace));
    } finally {
      await unlock(held);
    }
  }

  private async binding(dir: string, workspace: string): Promise<Binding> {
    const o = obj(await readJson(path.join(dir, 'binding.json')));
    if (o['schema'] === 1 && typeof o['workspace'] === 'string' && Number.isSafeInteger(o['epoch']) && typeof o['created_at'] === 'string') {
      return { schema: 1, workspace: o['workspace'], created_at: o['created_at'], epoch: o['epoch'] as number };
    }
    const fresh: Binding = { schema: 1, workspace: path.resolve(workspace), created_at: new Date().toISOString(), epoch: 0 };
    await writePrivate(path.join(dir, 'binding.json'), fresh);
    return fresh;
  }

  /** Every print of the workspace, and those that cannot be read. Read only; nothing is made. */
  async list(workspace: string): Promise<(Voiceprint | DamagedPrint)[]> {
    const dir = this.dir(workspace);
    const names = await fsp.readdir(dir).catch(() => [] as string[]);
    const out: (Voiceprint | DamagedPrint)[] = [];
    for (const name of names.sort()) {
      const ref = name.endsWith('.json') ? name.slice(0, -5) : '';
      if (!VOICE_REF.test(ref)) continue;
      out.push(parsePrint(await readJson(path.join(dir, name)), ref) ?? { ref, damaged: true });
    }
    return out;
  }

  async read(workspace: string, ref: string): Promise<Voiceprint | null> {
    return parsePrint(await readJson(printFile(this.dir(workspace), ref)), ref);
  }

  /** What an enrollment checks again right before it saves. */
  async snapshot(workspace: string, ref: string): Promise<Snapshot> {
    const o = obj(await readJson(path.join(this.dir(workspace), 'binding.json')));
    return { epoch: Number.isSafeInteger(o['epoch']) ? o['epoch'] as number : 0, revision: (await this.read(workspace, ref))?.revision ?? null };
  }

  /**
   * Adds a sample, under the lock, only if nothing was forgotten and the print did not change since `expect`, and only
   * when `stillConfirmed` says the user's naming still stands (checked here, inside the lock, so a Forget or a
   * correction that came during the extraction always wins). A first sample needs the person's consent. A sample of
   * the same speaker of the same transcript replaces the earlier one; a print made with another model starts over.
   */
  async addSample(workspace: string, input: {
    ref: string; name: string; model: { id: string; sha256: string }; sample: VoiceSample; consent: Consent | null;
    expect: Snapshot; stillConfirmed: () => Promise<boolean>;
  }): Promise<Voiceprint> {
    checkRef(input.ref);
    return this.locked(workspace, async (dir, binding) => {
      const file = printFile(dir, input.ref);
      const raw = await readJson(file);
      const current = raw === undefined ? null : parsePrint(raw, input.ref);
      if (raw !== undefined && !current) throw httpError(409, 'The remembered voice of this person cannot be read: forget it in Settings, then try again');
      if (binding.epoch !== input.expect.epoch || (current?.revision ?? null) !== input.expect.revision) {
        throw httpError(409, 'The remembered voices changed while this one was being read; nothing was saved');
      }
      if (!await input.stillConfirmed()) throw httpError(409, 'The speaker\'s name changed meanwhile; nothing was saved');
      const consent = current?.consent ?? input.consent;
      if (!consent) throw httpError(400, 'Remembering a voice for the first time needs that person\'s consent');
      const sameModel = current?.model.sha256 === input.model.sha256;
      const kept = (sameModel ? current!.samples : []).filter((s) => !sameSource(s.source, input.sample.source));
      const next: Voiceprint = {
        schema: 1, ref: input.ref, name: input.name, model: input.model, consent,
        samples: [...kept, input.sample].slice(-MAX_PRINT_SAMPLES),
        revision: (current?.revision ?? 0) + 1, updated_at: new Date().toISOString(),
      };
      await writePrivate(file, next);
      return next;
    });
  }

  /**
   * Removes the samples a confirmation added, when the name it confirmed is taken back or changed. A print left with
   * no samples goes, consent and all: remembering the voice again asks again.
   */
  async dropSamples(workspace: string, match: (s: SampleSource, printRef: string) => boolean): Promise<number> {
    // Nothing remembered for this workspace: nothing to drop, and no folder is made for it.
    if (!await fsp.stat(this.dir(workspace)).then(() => true, () => false)) return 0;
    return this.locked(workspace, async (dir) => {
      let dropped = 0;
      for (const p of await this.list(workspace)) {
        if ('damaged' in p) continue;
        const samples = p.samples.filter((s) => !match(s.source, p.ref));
        if (samples.length === p.samples.length) continue;
        dropped += p.samples.length - samples.length;
        const file = printFile(dir, p.ref);
        if (samples.length === 0) await fsp.rm(file, { force: true });
        else await writePrivate(file, { ...p, samples, revision: p.revision + 1, updated_at: new Date().toISOString() });
      }
      return dropped;
    });
  }

  /**
   * Removes one sample of a person's voice, chosen by the user. The last one takes the print with it, consent and all.
   * Returns whether the print is left.
   */
  async removeSample(workspace: string, ref: string, key: string): Promise<{ left: boolean }> {
    checkRef(ref);
    if (!SAMPLE_KEY.test(key)) throw httpError(400, 'Invalid sample');
    const print = await this.read(workspace, ref);
    if (!print || !print.samples.some((s) => sampleKey(s.source) === key)) throw httpError(404, 'No such sample of this voice');
    const dropped = await this.dropSamples(workspace, (s, printRef) => printRef === ref && sampleKey(s) === key);
    if (!dropped) throw httpError(404, 'No such sample of this voice');
    return { left: Boolean(await this.read(workspace, ref)) };
  }

  /** Forgets one person's voice. Any enrollment still under way for anyone is refused when it tries to save. */
  async forget(workspace: string, ref: string): Promise<boolean> {
    checkRef(ref);
    return this.locked(workspace, async (dir, binding) => {
      const file = printFile(dir, ref);
      const existed = await fsp.lstat(file).then(() => true, () => false);
      await fsp.rm(file, { force: true });
      await writePrivate(path.join(dir, 'binding.json'), { ...binding, epoch: binding.epoch + 1 });
      return existed;
    });
  }

  /** Forgets every voice remembered for this workspace. */
  async forgetAll(workspace: string): Promise<number> {
    return this.locked(workspace, async (dir, binding) => {
      let removed = 0;
      for (const name of await fsp.readdir(dir)) {
        if (!VOICE_REF.test(name.replace(/\.json$/, '')) || !name.endsWith('.json')) continue;
        await fsp.rm(path.join(dir, name), { force: true });
        removed++;
      }
      await writePrivate(path.join(dir, 'binding.json'), { ...binding, epoch: binding.epoch + 1 });
      return removed;
    });
  }

  /** Prints of workspace folders that no longer exist, other than this one: a workspace that was moved. */
  async moved(workspace: string): Promise<MovedBinding[]> {
    const own = bindingKey(workspace);
    const out: MovedBinding[] = [];
    for (const key of await fsp.readdir(this.root()).catch(() => [] as string[])) {
      if (!BINDING_KEY.test(key) || key === own) continue;
      const dir = path.join(this.root(), key);
      const b = obj(await readJson(path.join(dir, 'binding.json')));
      if (typeof b['workspace'] !== 'string' || await fsp.stat(b['workspace']).then(() => true, () => false)) continue;
      const prints = (await this.listDir(dir)).map((p) => ({ ref: p.ref, name: 'damaged' in p ? p.ref : p.name }));
      if (prints.length) out.push({ key, workspace: b['workspace'], prints });
    }
    return out;
  }

  private async listDir(dir: string): Promise<(Voiceprint | DamagedPrint)[]> {
    const out: (Voiceprint | DamagedPrint)[] = [];
    for (const name of (await fsp.readdir(dir).catch(() => [] as string[])).sort()) {
      const ref = name.endsWith('.json') ? name.slice(0, -5) : '';
      if (VOICE_REF.test(ref)) out.push(parsePrint(await readJson(path.join(dir, name)), ref) ?? { ref, damaged: true });
    }
    return out;
  }

  /** Serialize moves and deletes before reading their source; also exclude enrollment in that source. */
  private async withMoved<T>(workspace: string, key: string, fn: (source: string) => Promise<T>): Promise<T> {
    await privateDir(this.root());
    const held = await lock(path.join(this.root(), '.moves.lock'), LOCK_WAIT_MS, () => httpError(409, 'Moved voices are being changed in another window; try again'));
    try {
      const from = (await this.moved(workspace)).find((m) => m.key === key);
      if (!from) throw httpError(404, 'No voices of a moved workspace by that name');
      return await this.locked(from.workspace, async (source) => {
        if (await fsp.stat(from.workspace).then(() => true, () => false)) throw httpError(409, 'The original workspace is available again; leave its voices there');
        return fn(source);
      });
    } finally {
      await unlock(held);
    }
  }

  /**
   * Relinks a moved workspace's prints to this folder. Only from a folder that is gone (a move, not a copy), and only
   * while this workspace remembers no voice of its own, so nothing is merged by guessing.
   */
  async relink(workspace: string, key: string): Promise<void> {
    if (!BINDING_KEY.test(key)) throw httpError(400, 'Invalid voices to relink');
    await this.withMoved(workspace, key, async (source) => {
      // Check every print before publishing any: damaged data stays recoverable at its original location.
      const prints = await this.listDir(source);
      if (prints.some((p) => 'damaged' in p)) throw httpError(409, 'Some moved voices cannot be read; recover their files or forget them before relinking');
      await this.locked(workspace, async (dir, binding) => {
        if ((await this.listDir(dir)).length) throw httpError(409, 'This workspace already remembers voices: forget them first, or keep the moved ones apart');
        for (const print of prints) await writePrivate(printFile(dir, print.ref), print);
        await writePrivate(path.join(dir, 'binding.json'), { ...binding, epoch: binding.epoch + 1 });
        await fsp.rm(source, { recursive: true, force: true });
      });
    });
  }

  /** Forgets a moved workspace's prints; never races a relink still publishing them. */
  async forgetMoved(workspace: string, key: string): Promise<void> {
    if (!BINDING_KEY.test(key)) throw httpError(400, 'Invalid voices to forget');
    await this.withMoved(workspace, key, async (source) => { await fsp.rm(source, { recursive: true, force: true }); });
  }
}
