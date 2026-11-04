import * as path from 'path';
import { promises as fsp } from 'fs';
import { createHash, randomUUID } from 'crypto';
import { meetingsRoot, place, readFolder, writeManifest, type FolderManifest, type FolderState, type FolderVersion, type TranscribeRequest, type VersionSpeakers } from './meetingFolder';
import { MAX_SPEAKER_NAMES, parseSpeakerNames, SPEAKER_LABEL, type SpeakerName, type SpeakerSuggestion } from './speakerData';
import { isMeetingId } from './meetingLibrary';
import { hashFile } from '../utils/fileHash';
import { fileInside, workspaceEntry } from '../utils/files';
import { lock, unlock } from '../utils/fileLock';
import { processAlive } from './runState';
import { applyChanges } from './transcriptChanges';
import { decodeText } from '../utils/transcript';

/**
 * The versions of a meeting's text in its folder, and Transcribe again: everything that changes meeting.json after
 * the folder was made goes through here, one change at a time per meeting, across dashboards
 * (`meetings/.<id>.lock`).
 *
 * The rules, the same as for record corrections:
 * - a version counts only once it is written whole and listed in meeting.json (a folder `v3/` it does not list is a
 *   leftover of a crash, removed by recovery);
 * - nothing switches the current version by itself: a new transcription is added, and the user chooses it;
 * - an older version stays as it was, so what was made from it (a task's pinned sources, a correction) still holds.
 */

type Folder = Extract<FolderState, { state: 'ok' }>;
const LOCK_WAIT_MS = 5000;
const STALE_DRAFT_MS = 10 * 60 * 1000;

function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode: status });
}

/** One change to a meeting's folder at a time, in this process and across dashboards. */
const chains = new Map<string, Promise<unknown>>();
async function withFolder<T>(ws: string, id: string, fn: (folder: Folder) => Promise<T>): Promise<T> {
  if (!isMeetingId(id)) throw httpError(400, 'Invalid meeting id');
  const key = path.join(meetingsRoot(ws), id);
  const before = chains.get(key) ?? Promise.resolve();
  const run = before.catch(() => {}).then(async () => {
    const root = await workspaceEntry(ws, meetingsRoot(ws));
    const held = await lock(path.join(root, `.${id}.lock`), LOCK_WAIT_MS, () => httpError(409, 'This meeting is being changed in another window; try again'));
    try {
      const folder = await readFolder(ws, id);
      if (folder.state === 'none') throw httpError(404, 'This meeting has no folder of its own: only meetings reviewed with their text kept have one');
      if (folder.state === 'damaged') throw httpError(409, `This meeting's folder cannot be used: ${folder.reason}`);
      return await fn(folder);
    } finally {
      await unlock(held);
    }
  });
  chains.set(key, run);
  try { return await run; } finally { if (chains.get(key) === run) chains.delete(key); }
}

/** A request's identity: its id, or for one asked before requests had ids, when it was asked and for what. */
export const requestIdentity = (t: TranscribeRequest) => t.request_id ?? `${t.requested_at}|${t.file}|${t.transcript}`;

/**
 * The transcriptions this process runs now, from the moment one is claimed until its job ends: recovery under a
 * meeting's lock reads it, so a job started while another recovery was scanning is never taken for an orphan.
 */
const runningHere = new Set<string>();

/** The job of `generation` has ended in this process: from now on, a running request of it left on disk is an orphan. */
export function endTranscriptionJob(generation: string): void {
  runningHere.delete(generation);
}

const nextVersionId = (m: FolderManifest) => `v${Math.max(...m.versions.map((v) => Number(v.id.slice(1)))) + 1}`;

/** Asks for one recording of the meeting to be transcribed again. Refused while another one waits or runs. */
export async function requestTranscription(ws: string, id: string, input: Omit<TranscribeRequest, 'status' | 'requested_at'>): Promise<FolderManifest> {
  return withFolder(ws, id, async (folder) => {
    const m = folder.manifest;
    const t = m.transcribe;
    if (t && t.status !== 'failed') throw httpError(409, 'A transcription of this meeting already waits or runs: stop it first');
    const audio = m.audio.find((a) => a.name === input.file);
    if (!audio) throw httpError(404, 'No such recording kept in this meeting');
    const full = await fileInside(folder.audioDir, audio.name).catch(() => null);
    if (!full) throw httpError(410, 'This recording is no longer kept');
    const next: FolderManifest = { ...m, transcribe: { ...input, status: 'pending', requested_at: new Date().toISOString(), request_id: randomUUID() } };
    await writeManifest(folder, next);
    return next;
  });
}

/** Stops a transcription that waits or runs, or clears one that failed. Nothing it made is kept. */
export async function cancelTranscription(ws: string, id: string): Promise<FolderManifest> {
  return withFolder(ws, id, async (folder) => {
    if (!folder.manifest.transcribe) throw httpError(409, 'No transcription of this meeting waits or runs');
    const { transcribe: _gone, ...rest } = folder.manifest;
    await writeManifest(folder, rest);
    return rest;
  });
}

/** Makes `version` the meeting's current text. Only a version it lists; the record stays as it was reviewed. */
export async function chooseVersion(ws: string, id: string, version: unknown): Promise<FolderManifest> {
  if (typeof version !== 'string') throw httpError(400, 'Invalid version: use one the meeting lists, like v2');
  return withFolder(ws, id, async (folder) => {
    if (!folder.manifest.versions.some((v) => v.id === version)) throw httpError(404, `This meeting has no version ${version}`);
    const next = { ...folder.manifest, current: version };
    await writeManifest(folder, next);
    return next;
  });
}

/** The meetings with a transcription waiting, oldest first. A folder that cannot be read is left out. */
export async function waitingTranscriptions(ws: string): Promise<{ id: string; request: TranscribeRequest; audio: string; dir: string }[]> {
  const root = await workspaceEntry(ws, meetingsRoot(ws)).catch(() => null);
  if (!root) return [];
  const out: { id: string; request: TranscribeRequest; audio: string; dir: string }[] = [];
  for (const name of await fsp.readdir(root).catch(() => [] as string[])) {
    if (!isMeetingId(name)) continue;
    const folder = await readFolder(ws, name);
    if (folder.state === 'ok' && folder.manifest.transcribe?.status === 'pending') {
      out.push({ id: name, request: folder.manifest.transcribe, audio: path.join(folder.audioDir, folder.manifest.transcribe.file), dir: folder.dir });
    }
  }
  return out.sort((a, b) => a.request.requested_at.localeCompare(b.request.requested_at));
}

/**
 * Marks a waiting transcription as this job's, if it is still the very request chosen (`identity`): one stopped and
 * asked for again in between is another request, never claimed on the first one's behalf. Returns the request as
 * claimed, which the job is built from; null when it no longer waits.
 */
export async function claimTranscription(ws: string, id: string, identity: string, job: { generation: string; token: string; model: string; language: string }): Promise<TranscribeRequest | null> {
  return withFolder(ws, id, async (folder) => {
    const t = folder.manifest.transcribe;
    if (t?.status !== 'pending' || requestIdentity(t) !== identity) return null;
    // The recording must still be the one kept: a changed one fails on its own, the others go on.
    const audio = folder.manifest.audio.find((a) => a.name === t.file);
    const full = audio ? await fileInside(folder.audioDir, audio.name).catch(() => null) : null;
    const sha = full ? (await hashFile(full).catch(() => null))?.sha256 : null;
    if (!audio || sha !== audio.sha256) {
      await writeManifest(folder, { ...folder.manifest, transcribe: { ...t, status: 'failed', error: 'The recording changed or went missing since it was kept.' } });
      return null;
    }
    const claimed: TranscribeRequest = { ...t, status: 'running', model: job.model, language: job.language, generation: job.generation, owner: { pid: process.pid, token: job.token }, started_at: new Date().toISOString() };
    runningHere.add(job.generation);
    try {
      await writeManifest(folder, { ...folder.manifest, transcribe: claimed });
    } catch (err) {
      runningHere.delete(job.generation);
      throw err;
    }
    return claimed;
  }).catch(() => null);
}

/** A folder that is gone (the meeting deleted) means the job is no longer its: nothing to write, not an error. */
const unlessGone = (err: { statusCode?: number }) => { if (err.statusCode === 404) return false; throw err; };

const ours = (t: TranscribeRequest | undefined, job: { generation: string; token: string }) =>
  t?.status === 'running' && t.generation === job.generation && t.owner?.token === job.token;

/** False once the transcription is no longer this job's: stopped, or the meeting deleted. */
export async function stillTranscribing(ws: string, id: string, job: { generation: string; token: string }): Promise<boolean> {
  const folder = await readFolder(ws, id).catch(() => null);
  if (!folder) return true; // unreadable for a moment: keep going, publishing checks again
  return folder.state === 'ok' && ours(folder.manifest.transcribe, job);
}

/**
 * Puts this job's transcription back in line, as it was before it started (the engine was needed elsewhere). False
 * when it is no longer this job's; an error when that could not be saved, so the caller never takes it as done.
 */
export async function giveBackTranscription(ws: string, id: string, job: { generation: string; token: string }): Promise<boolean> {
  return withFolder(ws, id, async (folder) => {
    const t = folder.manifest.transcribe;
    if (!t || !ours(t, job)) return false;
    const { generation: _g, owner: _o, started_at: _s, ...rest } = t;
    await writeManifest(folder, { ...folder.manifest, transcribe: { ...rest, status: 'pending' } });
    return true;
  }).catch(unlessGone);
}

/**
 * Records why this job's transcription failed, if it is still this job's. False when it is not; an error when that
 * could not be saved (the folder locked or unwritable), so the job is set aside instead of tried again at once.
 */
export async function failTranscription(ws: string, id: string, job: { generation: string; token: string }, error: string): Promise<boolean> {
  return withFolder(ws, id, async (folder) => {
    const t = folder.manifest.transcribe;
    if (!t || !ours(t, job)) return false;
    const { generation: _g, owner: _o, ...rest } = t;
    await writeManifest(folder, { ...folder.manifest, transcribe: { ...rest, status: 'failed', error } });
    return true;
  }).catch(unlessGone);
}

/**
 * Adds the new transcript as the meeting's next version, if the transcription is still this job's and the recording is
 * unchanged: copies of the current version's other files and the new transcript in place of the old one.
 * Written under a draft name and renamed into place, then listed; the current version stays as it is.
 */
export async function publishTranscription(ws: string, id: string, job: { generation: string; token: string }, result: {
  content: Buffer; model: string; language: string;
  /** Speakers told apart: where each speaks alone, and suggestions from remembered voices. */
  speakers?: Pick<VersionSpeakers, 'voices' | 'suggestions'>;
}): Promise<string | null> {
  return withFolder(ws, id, async (folder) => {
    const m = folder.manifest;
    const t = m.transcribe;
    if (!t || !ours(t, job)) return null;
    const audio = m.audio.find((a) => a.name === t.file);
    const full = audio ? await fileInside(folder.audioDir, audio.name).catch(() => null) : null;
    if (!audio || !full || (await hashFile(full)).sha256 !== audio.sha256) {
      await writeManifest(folder, { ...m, transcribe: { ...t, status: 'failed', error: 'The recording changed or went missing while it was being transcribed.' } });
      return null;
    }
    const base = m.versions.find((v) => v.id === m.current)!;
    const id_ = nextVersionId(m);
    const draft = path.join(folder.dir, `.${id_}.${randomUUID()}.draft`);
    try {
      await fsp.mkdir(draft);
      const files: FolderVersion['files'] = [];
      for (const f of base.files) {
        if (f.name === t.transcript) continue;
        const sha = await place(path.join(folder.versionDir, f.name), path.join(draft, f.name), f.sha256);
        if (!sha) throw new Error(`${f.name} could not be carried over to the new version`);
        files.push({ name: f.name, sha256: sha });
      }
      await fsp.writeFile(path.join(draft, t.transcript), result.content, { flag: 'wx' });
      const transcriptSha = (await hashFile(path.join(draft, t.transcript))).sha256;
      files.push({ name: t.transcript, sha256: transcriptSha });
      const speakers: VersionSpeakers | undefined = result.speakers?.voices.length
        ? { transcript: t.transcript, transcript_sha256: transcriptSha, voices: result.speakers.voices, ...(result.speakers.suggestions?.items.length ? { suggestions: result.speakers.suggestions } : {}) }
        : undefined;
      // A folder of that name the manifest does not list is a leftover of a crash: it never counts, and goes now.
      const target = path.join(folder.dir, id_);
      await fsp.rm(target, { recursive: true, force: true });
      await fsp.rename(draft, target);
      const { transcribe: _done, ...rest } = m;
      await writeManifest(folder, {
        ...rest,
        versions: [...m.versions, { id: id_, at: new Date().toISOString(), made_from: 'transcription', model: result.model, language: result.language, from: { name: audio.name, sha256: audio.sha256 }, files, ...(speakers ? { speakers } : {}) }],
      });
      return id_;
    } finally {
      await fsp.rm(draft, { recursive: true, force: true }).catch(() => {});
    }
  });
}

/**
 * After a crash or another dashboard's end: a transcription left running by nobody goes back in line, and drafts,
 * version folders the manifest does not list and converted audio of jobs that are gone are removed. Whether a job of
 * this process still runs is read when the meeting's lock is held, never from a value taken earlier.
 */
export async function recoverTranscriptions(ws: string): Promise<void> {
  const orphaned = (t: TranscribeRequest | undefined) => t?.status === 'running'
    && (t.owner?.pid === process.pid ? !(t.generation && runningHere.has(t.generation)) : !(t.owner && processAlive(t.owner.pid)));
  const root = await workspaceEntry(ws, meetingsRoot(ws)).catch(() => null);
  if (!root) return;
  for (const name of await fsp.readdir(root).catch(() => [] as string[])) {
    if (!isMeetingId(name)) continue;
    const folder = await readFolder(ws, name);
    if (folder.state !== 'ok') continue;
    const t = folder.manifest.transcribe;
    const listed = new Set(folder.manifest.versions.map((v) => v.id));
    const leftovers = (await fsp.readdir(folder.dir).catch(() => [] as string[])).filter((n) => /^v\d{1,4}$/.test(n) && !listed.has(n));
    const drafts = (await fsp.readdir(folder.dir).catch(() => [] as string[])).filter((n) => /^\.v\d{1,4}\..+\.draft$/.test(n));
    const converted = await fsp.readdir(path.join(folder.dir, '.transcribing')).catch(() => [] as string[]);
    if (!orphaned(t) && !leftovers.length && !drafts.length && !converted.length) continue;
    await withFolder(ws, name, async (now) => {
      const r = now.manifest.transcribe;
      if (orphaned(r)) {
        const { generation: _g, owner: _o, started_at: _s, ...rest } = r!;
        await writeManifest(now, { ...now.manifest, transcribe: { ...rest, status: 'pending' } });
      }
      // Converted audio of a job that is no longer running anywhere (as the queue's recovery does for its own).
      const work = path.join(now.dir, '.transcribing');
      const st = await fsp.lstat(work).catch(() => null);
      if (st?.isDirectory() && !st.isSymbolicLink()) {
        for (const n of await fsp.readdir(work)) {
          const m = /^([0-9a-f-]{36})-(\d+)\.wav$/.exec(n);
          const pid = m ? Number(m[2]) : 0;
          const running = pid === process.pid ? runningHere.has(m![1]!) : pid > 0 && processAlive(pid);
          if (!running) await fsp.rm(path.join(work, n), { force: true });
        }
      }
      const known = new Set(now.manifest.versions.map((v) => v.id));
      for (const n of await fsp.readdir(now.dir)) {
        const full = path.join(now.dir, n);
        if (/^v\d{1,4}$/.test(n) && !known.has(n)) await fsp.rm(full, { recursive: true, force: true });
        else if (/^\.v\d{1,4}\..+\.draft$/.test(n)) {
          const st = await fsp.lstat(full).catch(() => null);
          if (st && Date.now() - st.mtimeMs > STALE_DRAFT_MS) await fsp.rm(full, { recursive: true, force: true });
        }
      }
    }).catch(() => {});
  }
}

/** A version's text files, read as text; null for a file it does not list or that is not text. */
function versionReader(folder: Folder, version: FolderVersion): (name: string) => Promise<string | null> {
  return async (name) => {
    const listed = version.files.find((f) => f.name === name);
    if (!listed) return null;
    const full = await fileInside(path.join(folder.dir, version.id), name).catch(() => null);
    if (!full) return null;
    // Only the bytes the version lists: a file changed on disk since is never corrected as if it were that text.
    const bytes = await fsp.readFile(full);
    if (createHash('sha256').update(bytes).digest('hex') !== listed.sha256) throw httpError(409, `${name} in ${version.id} changed since it was kept, so its words cannot be corrected`);
    return decodeText(bytes);
  };
}

/**
 * Whether corrections to the words of a version's transcripts fit, each one in order: null, or why not (turn not
 * found, old text not there, there more than once, across two lines, an original that cannot change with its copy).
 * Reads only: for the review of a correction, before it is approved.
 */
export async function checkTranscriptChanges(ws: string, id: string, version: unknown, changes: unknown): Promise<(string | null)[]> {
  const folder = await readFolder(ws, id);
  if (folder.state !== 'ok') throw httpError(folder.state === 'none' ? 404 : 409, folder.state === 'none' ? 'This meeting has no folder of its own' : `This meeting's folder cannot be used: ${folder.reason}`);
  const v = folder.manifest.versions.find((x) => x.id === version);
  if (!v) throw httpError(404, `This meeting has no version ${String(version)}`);
  return (await applyChanges(changes, versionReader(folder, v))).problems;
}

/**
 * Writes the next version of a meeting's text: `from_version` with exactly these changes (the originals and their
 * readable copies together), and makes it the current one, since approving the correction is the choice. Refused, with
 * nothing written, when `from_version` is not the current version any more or any change does not fit.
 *
 * Finishing again is safe: `receipt` names what is being finished (its caller hashes the confirmed record, the base and
 * the changes). A version this correction already wrote with the same receipt is returned as it is, nothing written and
 * the current version left alone, whatever was chosen since; the same correction with another receipt is refused.
 */
export async function writeCorrectedVersion(ws: string, id: string, input: { from_version: unknown; correction: unknown; changes: unknown; receipt: unknown }): Promise<string> {
  if (typeof input.correction !== 'string' || !/^CU-\d{4}-\d{4}$/.test(input.correction)) throw httpError(400, 'Invalid correction: the id of the correction update');
  if (typeof input.receipt !== 'string' || !/^[0-9a-f]{64}$/.test(input.receipt)) throw httpError(400, 'Invalid receipt: a SHA-256 of what is being finished');
  return withFolder(ws, id, async (folder) => {
    const m = folder.manifest;
    // Written before (a crash between this and the correction's finish, a lost reply): the same, or refused.
    const written = m.versions.find((v) => v.made_from === 'correction' && v.correction === input.correction);
    if (written) {
      if (written.receipt === input.receipt) return written.id;
      // Marked, so a caller never takes it for "nothing was written": a version of this correction exists.
      throw Object.assign(httpError(409, `${input.correction as string} already wrote ${written.id}, from something else than what is finished now: nothing was written`), { written: written.id });
    }
    // Refused after looking: marked `unwritten`, the only refusal that shows no version of this correction exists.
    const unwritten = (err: Error) => Object.assign(err, { unwritten: true });
    if (input.from_version !== m.current) throw unwritten(httpError(409, `This meeting's text changed since the correction started (${m.current} is in use now): start the correction again`));
    const base = m.versions.find((v) => v.id === m.current)!;
    const { files, problems } = await applyChanges(input.changes, versionReader(folder, base)).catch((err: Error & { statusCode?: number }) => {
      throw err.statusCode === 409 ? unwritten(err) : err;
    });
    const wrong = problems.map((p, i) => (p ? `change ${i + 1}: ${p}` : null)).filter(Boolean);
    if (wrong.length) throw unwritten(httpError(409, `These changes no longer fit, so nothing was written: ${wrong.join('; ')}`));
    const next = nextVersionId(m);
    const draft = path.join(folder.dir, `.${next}.${randomUUID()}.draft`);
    try {
      await fsp.mkdir(draft);
      const listed: FolderVersion['files'] = [];
      for (const f of base.files) {
        const changed = files.get(f.name);
        if (changed === undefined) {
          const sha = await place(path.join(folder.versionDir, f.name), path.join(draft, f.name), f.sha256);
          if (!sha) throw new Error(`${f.name} could not be carried over to the new version`);
          listed.push({ name: f.name, sha256: sha });
        } else {
          await fsp.writeFile(path.join(draft, f.name), changed, { flag: 'wx' });
          listed.push({ name: f.name, sha256: (await hashFile(path.join(draft, f.name))).sha256 });
        }
      }
      const target = path.join(folder.dir, next);
      await fsp.rm(target, { recursive: true, force: true });
      await fsp.rename(draft, target);
      await writeManifest(folder, {
        ...m, current: next,
        versions: [...m.versions, { id: next, at: new Date().toISOString(), made_from: 'correction', correction: input.correction as string, base: base.id, receipt: input.receipt as string, files: listed }],
      });
      return next;
    } finally {
      await fsp.rm(draft, { recursive: true, force: true }).catch(() => {});
    }
  });
}

/**
 * Whether a record's speaker names hold for a transcript as it was pinned (`pinned`, its SHA-256). The names were
 * confirmed on one transcript, whose hash the record keeps (`confirmedOn`, from `speakers_evidence`): they hold for
 * that very text, and for a version made from it by correcting words (which keeps the speaker labels), never for a
 * new transcription, which numbers its speakers anew. Decided by hashes, not by which version is current, so another
 * window choosing a version meanwhile changes nothing; listed versions never change. A meeting with no folder never
 * had other versions; a record with no evidence (confirmed before it was kept) is taken at the reviewed text.
 */
export function speakerNamesHold(manifest: FolderManifest | null, file: string, pinned: string, confirmedOn: string | undefined): boolean {
  if (confirmedOn !== undefined && pinned === confirmedOn) return true;
  if (!manifest) return confirmedOn === undefined;
  const sha = (v: FolderVersion | undefined) => v?.files.find((f) => f.name === file)?.sha256;
  const byId = new Map(manifest.versions.map((v) => [v.id, v]));
  const confirmed = (v: FolderVersion) => (confirmedOn !== undefined ? sha(v) === confirmedOn : v.made_from === 'review');
  // From each version holding the pinned text, back through corrections only, to the text the names were confirmed on.
  return manifest.versions.filter((v) => sha(v) === pinned).some((start) => {
    const seen = new Set<string>();
    for (let v: FolderVersion | undefined = start; v && !seen.has(v.id); v = v.made_from === 'correction' && v.base ? byId.get(v.base) : undefined) {
      seen.add(v.id);
      if (confirmed(v)) return true;
    }
    return false;
  });
}

/**
 * Whether a record's speaker names hold for its speakers' transcript `source` in the version a pin came from: the
 * pin's path names the version (`meetings/<id>/vN/…`); that version's own hash of `source` is what is judged, so a
 * readable copy pinned for a WebVTT original is judged by the original. True for a meeting with no folder.
 */
export function speakerNamesHoldForPin(manifest: FolderManifest | null, pinPath: string | undefined, source: string, confirmedOn: string | undefined): boolean {
  // A pin in a meeting's folder needs that folder to judge it: one that could not be read never takes the no-folder way.
  if (!manifest) return !pinPath?.startsWith('meetings/');
  const versionId = pinPath ? /^meetings\/[^/]+\/(v\d{1,4})\//.exec(pinPath)?.[1] : undefined;
  const version = versionId ? manifest.versions.find((v) => v.id === versionId) : undefined;
  const sha = version?.files.find((f) => f.name === source)?.sha256;
  return sha !== undefined && speakerNamesHold(manifest, source, sha, confirmedOn);
}

/**
 * One text file of a meeting's version, read as text, only as the version lists it (its hash is checked). Null when the
 * meeting has no folder, the version or file is not listed, or it is not text. Read only.
 */
export async function readVersionFile(ws: string, id: string, version: string, name: string): Promise<string | null> {
  const folder = await readFolder(ws, id);
  if (folder.state !== 'ok') return null;
  const v = folder.manifest.versions.find((x) => x.id === version);
  return v ? versionReader(folder, v)(name) : null;
}

/** What a click on a version's speakers was made on: refused when any of it changed meanwhile. */
export interface VersionSpeakersTarget { version: unknown; transcript_sha256: unknown }

/** The Transcribe again version whose speakers a click names, as the page saw it. */
function speakersOf(folder: Folder, target: VersionSpeakersTarget): { version: FolderVersion; speakers: VersionSpeakers } {
  if (typeof target.version !== 'string') throw httpError(400, 'Invalid version: use one the meeting lists, like v2');
  const version = folder.manifest.versions.find((v) => v.id === target.version);
  if (!version) throw httpError(404, `This meeting has no version ${target.version}`);
  if (version.made_from !== 'transcription' || !version.speakers) throw httpError(409, 'The speakers of this version were not told apart, so they cannot be named here');
  if (target.transcript_sha256 !== version.speakers.transcript_sha256) throw httpError(409, 'The transcript changed meanwhile; look again');
  return { version, speakers: version.speakers };
}

async function saveSpeakers(folder: Folder, version: FolderVersion, speakers: VersionSpeakers): Promise<FolderManifest> {
  const next = { ...folder.manifest, versions: folder.manifest.versions.map((v) => (v.id === version.id ? { ...v, speakers } : v)) };
  await writeManifest(folder, next);
  return next;
}

/**
 * Names the speakers of a Transcribe again version: `{ "Speaker 2": { name, ref } }`, null to take a name back. The
 * confirm path of a kept meeting, apart from the queue's: only labels that version's transcript has, only for the
 * transcript the page showed. `suggestion`: the click was "Use" on a suggestion, which must still be there, for that
 * person, made with that speaker model; otherwise it is refused as stale.
 */
export async function nameVersionSpeakers(ws: string, id: string, target: VersionSpeakersTarget, names: Record<string, unknown>,
  suggestion?: { label: string; ref: string; model_sha256: string }): Promise<{ manifest: FolderManifest; version: FolderVersion; before: SpeakerName[]; after: SpeakerName[] }> {
  return withFolder(ws, id, async (folder) => {
    const { version, speakers } = speakersOf(folder, target);
    if (suggestion) {
      const open = speakers.suggestions?.model_sha256 === suggestion.model_sha256 && speakers.suggestions.items.some((i) => i.label === suggestion.label && i.ref === suggestion.ref);
      if (!open) throw httpError(409, 'This suggestion is no longer there; look again');
    }
    const labels = new Set(speakers.voices.map((v) => v.label));
    const before = speakers.names ?? [];
    const named = new Map(before.map((n) => [n.label, n] as const));
    for (const [label, value] of Object.entries(names)) {
      if (!SPEAKER_LABEL.test(label) || !labels.has(label)) throw httpError(400, `This transcript has no ${label}`);
      if (value === null) { named.delete(label); continue; }
      const [person] = parseSpeakerNames([{ ...(value && typeof value === 'object' ? value : {}), label }]);
      if (!person) throw httpError(400, `Invalid name for ${label}`);
      named.set(label, person);
    }
    if (named.size > MAX_SPEAKER_NAMES) throw httpError(400, `At most ${MAX_SPEAKER_NAMES} speakers can be named in one transcript`);
    const after = [...named.values()];
    const { names: _old, ...rest } = speakers;
    const manifest = await saveSpeakers(folder, version, after.length ? { ...rest, names: after } : rest);
    return { manifest, version: manifest.versions.find((v) => v.id === version.id)!, before, after };
  });
}

/** "Not them": hides one suggestion of a version. Nothing about the voice is kept or learned from it. */
export async function dismissVersionSuggestion(ws: string, id: string, target: VersionSpeakersTarget, label: unknown): Promise<FolderManifest> {
  return withFolder(ws, id, async (folder) => {
    const { version, speakers } = speakersOf(folder, target);
    if (!speakers.suggestions?.items.some((i) => i.label === label)) throw httpError(409, 'This suggestion is no longer there; look again');
    const items: SpeakerSuggestion[] = speakers.suggestions.items.filter((i) => i.label !== label);
    const { suggestions: _s, ...rest } = speakers;
    return saveSpeakers(folder, version, items.length ? { ...rest, suggestions: { model_sha256: speakers.suggestions.model_sha256, items } } : rest);
  });
}

/** The speakers of a version, read only, with the open suggestions (not for a label already named). */
export function openSuggestions(speakers: VersionSpeakers | undefined): SpeakerSuggestion[] {
  const named = new Set((speakers?.names ?? []).map((n) => n.label));
  return (speakers?.suggestions?.items ?? []).filter((i) => !named.has(i.label));
}
