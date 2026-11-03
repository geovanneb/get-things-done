import * as path from 'path';
import { constants as fsConstants, promises as fsp } from 'fs';
import { randomUUID } from 'crypto';
import type { ContextUpdate } from './contextUpdateService';
import { isMeetingId, isMeetingText, recordedHash, type HeldMeeting } from './meetingLibrary';
import { atomicWrite } from '../utils/atomicWrite';
import { hashFile } from '../utils/fileHash';
import { fileInside, workspaceEntry } from '../utils/files';
import { moveToTrash } from './trash';

/**
 * A meeting's own folder: where its text lives once its update is done, instead of the update's materials/.
 * `context-updates/` holds material waiting for review; a reviewed meeting is not that any more.
 *
 *   meetings/<meeting id>/meeting.json   which update it belongs to, its versions and the current one
 *   meetings/<meeting id>/v1/            the text as the review saw it: transcripts, readable copies, notes
 *   meetings/<meeting id>/audio/         its recordings, with Keep recordings on: evidence every version comes from
 *
 * The folder is private: git-ignored, never task input unless a task's pinned sources name a file in it, and never
 * part of anything shared. Its file names are the names the update records, so `heldMeetings` and the history's
 * sources stay as they are; only where a file is read from changes. Meetings kept before this folder existed stay in
 * their update's materials/, and every reader asks `meetingFile` for both.
 *
 * Versions follow the same rules as record corrections: a version counts only once it is written whole and listed in
 * meeting.json; nothing switches the current version by itself. This first version is only ever `v1`.
 */

export const MEETINGS_DIR = 'meetings';
const MANIFEST = 'meeting.json';
const FIRST_VERSION = 'v1';
const VERSION_ID = /^v\d{1,4}$/;
const SHA256 = /^[0-9a-f]{64}$/;
/** A folder being written that a crash left behind is removed after this long, never sooner: it may still be in use. */
const STALE_DRAFT_MS = 10 * 60 * 1000;

export interface FolderVersion {
  id: string;
  at: string;
  /**
   * What made it: `review`, the text its update was reviewed with; `transcription`, Transcribe again; `correction`, a
   * finished correction of the meeting that changed words of its transcript.
   */
  made_from: 'review' | 'transcription' | 'correction';
  files: { name: string; sha256: string }[];
  /** A transcription only: the model and language it was made with, and the recording it was made from. */
  model?: string;
  language?: string;
  from?: { name: string; sha256: string };
  /** A correction only: the correction update that changed it, and the version it changed. */
  correction?: string;
  base?: string;
  /**
   * A correction only: the receipt of what was finished (a hash its caller makes of the confirmed record, the base and
   * the changes), so finishing again after a crash finds this version instead of writing another. Absent on older ones.
   */
  receipt?: string;
}

/** Transcribe again: one recording of the meeting, waiting, being transcribed, or failed. At most one at a time. */
export interface TranscribeRequest {
  /** The recording, as the folder's audio lists it. */
  file: string;
  /** The transcript it replaces in the new version (the recording's readable copy). */
  transcript: string;
  model: string;
  language: string;
  speakers: boolean;
  status: 'pending' | 'running' | 'failed';
  requested_at: string;
  /** Names this request among others of the meeting: a claim must find the very one it chose. Absent on older ones. */
  request_id?: string;
  generation?: string;
  owner?: { pid: number; token: string };
  started_at?: string;
  error?: string;
}

export interface FolderManifest {
  schema: 1;
  id: string;
  /** The update that holds its record and that its v1 came from. */
  update_id: string;
  current: string;
  versions: FolderVersion[];
  /** Its recordings, kept with Keep recordings on. Not versioned: a new version is new text from the same audio. */
  audio: { name: string; sha256: string }[];
  /** A Transcribe again under way or failed; absent otherwise. */
  transcribe?: TranscribeRequest;
}

export type FolderState =
  | { state: 'none' }
  | { state: 'damaged'; reason: string }
  | { state: 'ok'; manifest: FolderManifest; dir: string; version: FolderVersion; versionDir: string; audioDir: string };

export function meetingsRoot(ws: string): string {
  return path.join(ws, MEETINGS_DIR);
}

function folderPath(ws: string, id: string): string {
  if (!isMeetingId(id)) throw new Error('Invalid meeting id');
  return path.join(meetingsRoot(ws), id);
}

function parseManifest(raw: string, id: string): FolderManifest | string {
  let data: unknown;
  try { data = JSON.parse(raw); } catch { return 'meeting.json is not valid JSON'; }
  const m = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  if (m['schema'] !== 1) return 'meeting.json has an unknown schema';
  if (m['id'] !== id) return 'meeting.json names another meeting';
  if (typeof m['update_id'] !== 'string' || !/^CU-\d{4}-\d{4}$/.test(m['update_id'])) return 'meeting.json names no update';
  if (!Array.isArray(m['versions'])) return 'meeting.json lists no versions';
  const versions: FolderVersion[] = [];
  for (const entry of m['versions']) {
    const v = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
    if (typeof v['id'] !== 'string' || !VERSION_ID.test(v['id']) || typeof v['at'] !== 'string') return 'a version in meeting.json is damaged';
    const files = fileList(v['files']);
    if (!files) return 'a file in meeting.json is damaged';
    if (v['made_from'] === 'transcription') {
      const from = fileList([v['from']]);
      if (!from || typeof v['model'] !== 'string' || typeof v['language'] !== 'string') return 'a version in meeting.json is damaged';
      versions.push({ id: v['id'], at: v['at'], made_from: 'transcription', files, model: v['model'], language: v['language'], from: from[0]! });
    } else if (v['made_from'] === 'correction') {
      if (typeof v['correction'] !== 'string' || !/^CU-\d{4}-\d{4}$/.test(v['correction']) || typeof v['base'] !== 'string' || !VERSION_ID.test(v['base'])) return 'a version in meeting.json is damaged';
      if (v['receipt'] !== undefined && (typeof v['receipt'] !== 'string' || !/^[0-9a-f]{64}$/.test(v['receipt']))) return 'a version in meeting.json is damaged';
      versions.push({ id: v['id'], at: v['at'], made_from: 'correction', files, correction: v['correction'], base: v['base'], ...(typeof v['receipt'] === 'string' ? { receipt: v['receipt'] } : {}) });
    } else versions.push({ id: v['id'], at: v['at'], made_from: 'review', files });
  }
  const audio = m['audio'] === undefined ? [] : fileList(m['audio']);
  if (!audio) return 'a recording in meeting.json is damaged';
  if (new Set(versions.map((v) => v.id)).size !== versions.length) return 'meeting.json lists a version twice';
  if (typeof m['current'] !== 'string' || !versions.some((v) => v.id === m['current'])) return 'meeting.json names no current version it lists';
  const transcribe = parseRequest(m['transcribe'], audio);
  return { schema: 1, id, update_id: m['update_id'], current: m['current'], versions, audio, ...(transcribe ? { transcribe } : {}) };
}

/** A request that cannot be read is left out: it is only work to do, never the meeting's text. */
function parseRequest(raw: unknown, audio: { name: string }[]): TranscribeRequest | null {
  const o = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null) as Record<string, unknown> | null;
  if (!o) return null;
  const str = (k: string) => (typeof o[k] === 'string' ? o[k] as string : null);
  const file = str('file'); const transcript = str('transcript'); const model = str('model'); const language = str('language'); const at = str('requested_at');
  const status = o['status'];
  if (!file || !audio.some((a) => a.name === file) || !transcript || path.basename(transcript) !== transcript || transcript.startsWith('.') || !isMeetingText(transcript)
    || !model || !language || !at || typeof o['speakers'] !== 'boolean' || (status !== 'pending' && status !== 'running' && status !== 'failed')) return null;
  const owner = o['owner'] && typeof o['owner'] === 'object' ? o['owner'] as Record<string, unknown> : null;
  return {
    file, transcript, model, language, speakers: o['speakers'], status, requested_at: at,
    ...(str('request_id') ? { request_id: str('request_id')! } : {}),
    ...(str('generation') ? { generation: str('generation')! } : {}),
    ...(owner && typeof owner['pid'] === 'number' && typeof owner['token'] === 'string' ? { owner: { pid: owner['pid'], token: owner['token'] } } : {}),
    ...(str('started_at') ? { started_at: str('started_at')! } : {}),
    ...(str('error') ? { error: str('error')! } : {}),
  };
}

/** Writes meeting.json whole, as one file: readers see the old or the new one. */
export async function writeManifest(folder: Extract<FolderState, { state: 'ok' }>, manifest: FolderManifest): Promise<void> {
  await atomicWrite(path.join(folder.dir, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
}

function fileList(raw: unknown): { name: string; sha256: string }[] | null {
  if (!Array.isArray(raw)) return null;
  const files: { name: string; sha256: string }[] = [];
  for (const f of raw) {
    const file = (f && typeof f === 'object' ? f : {}) as Record<string, unknown>;
    const name = file['name'];
    if (typeof name !== 'string' || !name || path.basename(name) !== name || name.startsWith('.') || typeof file['sha256'] !== 'string' || !SHA256.test(file['sha256'])) return null;
    files.push({ name, sha256: file['sha256'] });
  }
  return files;
}

/** A meeting's folder as it is now. A folder that cannot be read as one is `damaged`, never guessed at. */
export async function readFolder(ws: string, id: string): Promise<FolderState> {
  const dir = folderPath(ws, id);
  const safe = await workspaceEntry(ws, dir).catch((err: NodeJS.ErrnoException) => (err.code === 'ENOENT' ? null : err));
  if (safe === null) return { state: 'none' };
  if (safe instanceof Error) return { state: 'damaged', reason: 'its folder is a link, or cannot be read' };
  if (!(await fsp.lstat(dir)).isDirectory()) return { state: 'damaged', reason: 'it is not a folder' };
  const raw = await fsp.lstat(path.join(dir, MANIFEST)).then((st) => (st.isFile() ? fsp.readFile(path.join(dir, MANIFEST), 'utf-8') : null), () => null);
  if (raw === null) return { state: 'damaged', reason: 'meeting.json is missing' };
  const manifest = parseManifest(raw, id);
  if (typeof manifest === 'string') return { state: 'damaged', reason: manifest };
  const version = manifest.versions.find((v) => v.id === manifest.current)!;
  return { state: 'ok', manifest, dir, version, versionDir: path.join(dir, version.id), audioDir: path.join(dir, 'audio') };
}

/**
 * Where a meeting's text lives now: its own folder, when there is one that belongs to this update, or null when it is
 * still in the update's materials/. A folder of another update, or a damaged one, is reported apart: its files are
 * never read as this meeting's.
 */
export async function folderOf(ws: string, u: Pick<ContextUpdate, 'id'>, m: Pick<HeldMeeting, 'id'>): Promise<Extract<FolderState, { state: 'ok' }> | { state: 'damaged' | 'other'; reason: string } | null> {
  if (!isMeetingId(m.id)) return null;
  const folder = await readFolder(ws, m.id);
  if (folder.state === 'none') return null;
  if (folder.state === 'damaged') return folder;
  if (folder.manifest.update_id !== u.id) return { state: 'other', reason: `its folder belongs to ${folder.manifest.update_id}` };
  return folder;
}

/** Where a file the folder lists is: its recordings in audio/, its text in the current version. */
function placeOf(folder: Extract<FolderState, { state: 'ok' }>, name: string): string | null {
  if (folder.manifest.audio.some((f) => f.name === name)) return folder.audioDir;
  return folder.version.files.some((f) => f.name === name) ? folder.versionDir : null;
}

/** The plain files the folder lists (the current version's text and the recordings) that are there now, by name. */
export async function folderFiles(folder: Extract<FolderState, { state: 'ok' }>): Promise<Set<string>> {
  const present = new Set<string>();
  for (const f of [...folder.version.files, ...folder.manifest.audio]) {
    if (await fsp.lstat(path.join(placeOf(folder, f.name)!, f.name)).then((st) => st.isFile(), () => false)) present.add(f.name);
  }
  return present;
}

/** Where to read one file of a meeting now: its folder's current version when it lists it, else the update's materials. */
export interface MeetingFiles {
  /** The folder holding its text, or null when it has none (kept before meeting folders, or not done yet). */
  folder: Extract<FolderState, { state: 'ok' }> | null;
  /** Why the folder cannot be used, when it is damaged or another update's. Its text is then not shown. */
  problem: string | null;
  /** The meeting's files that are there now, wherever they are. */
  present: Set<string>;
  /** The full path of a file of the meeting, or null when it is not there. */
  path(name: string): Promise<string | null>;
  /** The file's path from the workspace root, with "/", for a file that is there. */
  relative(name: string): string;
}

export async function meetingFiles(ws: string, u: Pick<ContextUpdate, 'id'> & { material_files?: { name: string }[] }, m: Pick<HeldMeeting, 'id' | 'files'>, materialNames?: Set<string>): Promise<MeetingFiles> {
  const materials = path.join(ws, 'context-updates', u.id, 'materials');
  const found = await folderOf(ws, u, m);
  const folder = found && found.state === 'ok' ? found : null;
  const problem = found && found.state !== 'ok' ? found.reason : null;
  const inFolder = folder ? await folderFiles(folder) : new Set<string>();
  const listed = new Set(folder ? [...folder.version.files, ...folder.manifest.audio].map((f) => f.name) : []);
  const inMaterials = materialNames ?? new Set((u.material_files ?? []).map((f) => f.name));
  const present = new Set<string>();
  for (const f of m.files) if (inFolder.has(f) || (!listed.has(f) && inMaterials.has(f))) present.add(f);
  // A file the folder lists belongs to the folder: one of the same name left in materials/ is not read instead.
  const where = (name: string) => (folder && listed.has(name) ? placeOf(folder, name)! : materials);
  return {
    folder, problem, present,
    path: (name) => (m.files.includes(name) ? fileInside(where(name), name).catch(() => null) : Promise.resolve(null)),
    relative: (name) => path.relative(ws, path.join(where(name), name)).split(path.sep).join('/'),
  };
}

/**
 * Moves what a finished update keeps of its meetings (their text, and their recordings with Keep recordings) into their
 * own folders, and returns the names it may now remove from materials/: a file whose every meeting has it in a complete
 * folder. Anything not certain stays in materials/ as
 * before (a folder of another update, a damaged one, a copy that did not match), so nothing is lost.
 *
 * Each folder is written under a hidden name and renamed into place only once every file is copied, checked and listed,
 * so a folder that exists is complete. Run again after a crash, it finds the folder and only finishes the removal.
 */
export async function moveMeetingText(ws: string, u: ContextUpdate, meetings: HeldMeeting[], keep: Set<string>, now = new Date()): Promise<Set<string>> {
  const materials = path.join(ws, 'context-updates', u.id, 'materials');
  const root = await workspaceEntry(ws, meetingsRoot(ws), true).catch(() => null);
  if (!root) return new Set();
  const owners = new Map<string, string[]>();
  const done = new Set<string>();
  for (const m of meetings) {
    const files = m.files.filter((f) => keep.has(f));
    if (!files.length || !m.linkable) continue;
    for (const f of files) owners.set(f, [...(owners.get(f) ?? []), m.id]);
    const existing = await folderOf(ws, u, m);
    if (existing?.state === 'ok') {
      // Moved before: the folder is complete. A file it does not list stays where it is.
      const first = existing.manifest.versions.find((v) => v.id === FIRST_VERSION);
      for (const f of [...first?.files ?? [], ...existing.manifest.audio]) if (files.includes(f.name)) done.add(`${m.id}\0${f.name}`);
      continue;
    }
    if (existing) continue;
    const written = await writeFolder(ws, u, m, files, materials, now, (name) => recordedHash(u, name)).catch(() => null);
    if (written) for (const name of written) done.add(`${m.id}\0${name}`);
  }
  const removable = new Set<string>();
  for (const [file, ids] of owners) if (ids.every((id) => done.has(`${id}\0${file}`))) removable.add(file);
  return removable;
}

/** Writes one meeting's folder whole, or nothing. Returns the files it holds, or null when the folder was not made. */
async function writeFolder(ws: string, u: ContextUpdate, m: HeldMeeting, files: string[], materials: string, now: Date, recorded: (name: string) => string | null): Promise<string[] | null> {
  const root = meetingsRoot(ws);
  await fsp.mkdir(root, { recursive: true });
  await removeStaleDrafts(root, m.id, now);
  const draft = path.join(root, `.${m.id}.${randomUUID()}.draft`);
  try {
    await fsp.mkdir(path.join(draft, FIRST_VERSION), { recursive: true });
    await fsp.mkdir(path.join(draft, 'audio'), { recursive: true });
    const listed: FolderVersion['files'] = [];
    const audio: FolderManifest['audio'] = [];
    for (const name of files) {
      const from = path.join(materials, name);
      // Only a plain file of materials/, never a link or a folder with a kept name.
      if (!(await fsp.lstat(from).then((st) => st.isFile(), () => false))) continue;
      const text = isMeetingText(name);
      const sha256 = await place(from, path.join(draft, text ? FIRST_VERSION : 'audio', name), recorded(name), text ? 'copy' : 'link');
      if (!sha256) return null;
      (text ? listed : audio).push({ name, sha256 });
    }
    if (!listed.length && !audio.length) return null;
    const manifest: FolderManifest = {
      schema: 1, id: m.id, update_id: u.id, current: FIRST_VERSION,
      versions: [{ id: FIRST_VERSION, at: now.toISOString(), made_from: 'review', files: listed }], audio,
    };
    await atomicWrite(path.join(draft, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
    // Fails when a folder of that name appeared meanwhile: that one is left as it is, and nothing is removed.
    await fsp.rename(draft, folderPath(ws, m.id));
    return [...listed, ...audio].map((f) => f.name);
  } catch {
    return null;
  } finally {
    await fsp.rm(draft, { recursive: true, force: true });
  }
}

/**
 * Puts one file into the draft and returns its SHA-256, or null when the bytes are not certain: they differ from the
 * hash recorded for them (`recorded`), or a copy does not read back the same.
 *
 * Text is always its own copy (a copy-on-write clone where the disk can make one, so still cheap): versions of a
 * meeting must never share a file, or editing one version's file in place would change every other version too. Only a
 * recording may be hard-linked (`link`), when it moves out of materials/: it can be gigabytes, it is not versioned, and
 * its link in materials/ is removed once the folder is complete. Either way the bytes are hashed, and checked against
 * the recorded hash when there is one.
 */
export async function place(from: string, to: string, recorded: string | null, how: 'copy' | 'link' = 'copy'): Promise<string | null> {
  if (how === 'link' && await fsp.link(from, to).then(() => true, () => false)) {
    const { sha256 } = await hashFile(to);
    return !recorded || recorded === sha256 ? sha256 : null;
  }
  await fsp.copyFile(from, to, fsConstants.COPYFILE_EXCL | fsConstants.COPYFILE_FICLONE);
  const [a, b] = await Promise.all([hashFile(from), hashFile(to)]);
  return a.sha256 === b.sha256 && a.size === b.size && (!recorded || recorded === a.sha256) ? b.sha256 : null;
}

async function removeStaleDrafts(root: string, id: string, now: Date): Promise<void> {
  for (const name of await fsp.readdir(root).catch(() => [] as string[])) {
    if (!name.startsWith(`.${id}.`) || !name.endsWith('.draft')) continue;
    const st = await fsp.lstat(path.join(root, name)).catch(() => null);
    if (st?.isDirectory() && now.getTime() - st.mtimeMs > STALE_DRAFT_MS) await fsp.rm(path.join(root, name), { recursive: true, force: true });
  }
}

/** Moves the folders of an update's meetings to the trash with it, so none is left that no update lists. */
export async function trashFoldersOf(ws: string, u: ContextUpdate, meetings: HeldMeeting[], now = new Date()): Promise<string[]> {
  const moved: string[] = [];
  for (const m of meetings) {
    const folder = await folderOf(ws, u, m);
    if (folder?.state !== 'ok') continue;
    moved.push(await moveToTrash(ws, await workspaceEntry(ws, folder.dir), now));
  }
  return moved;
}

/**
 * The meeting folders an update's v1 came from, read from meeting.json alone: for System cleanup, which must not
 * remove an update while one of its meetings still keeps text, nor leave its emptied folders behind.
 */
export async function foldersOfUpdate(ws: string, updateId: string): Promise<{ dir: string; hasText: boolean }[]> {
  const root = await workspaceEntry(ws, meetingsRoot(ws)).catch(() => null);
  if (!root) return [];
  const out: { dir: string; hasText: boolean }[] = [];
  for (const name of await fsp.readdir(root).catch(() => [] as string[])) {
    if (!isMeetingId(name)) continue;
    const folder = await readFolder(ws, name);
    if (folder.state !== 'ok' || folder.manifest.update_id !== updateId) continue;
    out.push({ dir: folder.dir, hasText: (await folderFiles(folder)).size > 0 });
  }
  return out;
}
