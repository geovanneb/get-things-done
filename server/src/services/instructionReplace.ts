import * as fsp from 'fs/promises';
import * as path from 'path';
import { createHash } from 'crypto';
import { APP_FILES_RELATIVE_PATH, REPLACE_JOURNAL_RELATIVE_PATH, appFilesInUse, appFileVersions, getAppVersion, newerVersion, pruneAppFiles, readManifest, readWorkspaceProfile, removeNewCopy, storeAppFile, writeManifest, type ManifestEntry, type WorkspaceProfile } from './scaffold';
import { workspaceEntry, writeWorkspaceFile } from '../utils/files';

/**
 * The record of a "Use the app's version" in progress, written before anything else, so a replace interrupted at any
 * step (a crash, a full disk, the app quit) is finished or left harmless the next time the files are brought up to date
 * or an instruction update is resolved. Every caller holds the upgrade lock.
 */
export { REPLACE_JOURNAL_RELATIVE_PATH };

/**
 * Test hook: called at points of recovery. An error it throws stands for a failure there (a disk error, a crash): the
 * journal stays as it was written last, for the next attempt.
 */
export const recoverySteps: { after: ((step: 'rolled-back' | 'acknowledging') => void | Promise<void>) | null } = { after: null };

export interface ReplaceJournal {
  /** The app file, workspace-relative, as the app ships it. */
  path: string;
  /** The user's file that was replaced, and the app version that replaces it. */
  mine_sha256: string;
  app_sha256: string;
  /** The backup copy while it is made, in `.situation-board/` (a name this app chose), then its trash entry. */
  staging: string;
  trash: string;
  /**
   * `backup` while the backup is made; `replacing` once the app version is staged beside the file as `temp`, right
   * before the rename that puts it in place; `replaced` after it. The rename consumes `temp`: when a journal says
   * `replacing`, a `temp` still there means the rename never happened, and a `temp` gone means it did. `rolled_back`:
   * recovery found the rename never happened and recorded so before removing `temp`, so a retry never reads the
   * missing `temp` as a rename.
   */
  phase: 'backup' | 'replacing' | 'replaced' | 'rolled_back';
  /** The staged app version, beside the file: `.<name>.<uuid>.tmp`. */
  temp?: string;
  started_at: string;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;
/** The backup's staging copy: only ever this name, directly in `.situation-board/`. */
export const STAGING_NAME = /^\.instruction-backup-[0-9a-f-]{36}\.tmp$/;
const sha = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The name of the app version staged beside `relPath` before the rename: `.<name>.<uuid>.tmp`, nothing else. */
export function stagedName(relPath: string): RegExp {
  return new RegExp(`^\\.${escapeRegExp(path.basename(relPath))}\\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.tmp$`);
}

/** A plain file's bytes, reached through no link below the workspace; null when it is missing or anything else. */
export async function plainFileBytes(workspace: string, relPath: string): Promise<Buffer | null> {
  const full = path.join(workspace, relPath);
  try {
    await workspaceEntry(workspace, full);
    if (!(await fsp.lstat(full)).isFile()) return null;
    return await fsp.readFile(full);
  } catch {
    return null;
  }
}

/**
 * The app's current version of each file it ships here, rendered with the profile only when the profile is a plain
 * file below the workspace: template interpolation obeys the same no-link boundary as the files compared.
 */
export async function renderedAppFiles(workspace: string): Promise<Map<string, { content: Buffer; sha256: string }>> {
  return appFileVersions(workspace, await plainProfile(workspace));
}

/** The profile the templates are rendered with: read only when it is a plain file below the workspace. */
export async function plainProfile(workspace: string): Promise<WorkspaceProfile> {
  const profilePath = path.join(workspace, 'profile', 'executive-profile.md');
  const profileIsPlain = await workspaceEntry(workspace, profilePath)
    .then(() => fsp.lstat(profilePath)).then((stat) => stat.isFile(), () => false);
  return profileIsPlain ? readWorkspaceProfile(workspace) : { name: '', role: '', organization: '' };
}

export async function writeJournal(workspace: string, journal: ReplaceJournal): Promise<void> {
  await writeWorkspaceFile(workspace, path.join(workspace, REPLACE_JOURNAL_RELATIVE_PATH), JSON.stringify(journal, null, 2));
}

export async function clearJournal(workspace: string): Promise<void> {
  const file = path.join(workspace, REPLACE_JOURNAL_RELATIVE_PATH);
  await workspaceEntry(workspace, file).then(() => fsp.rm(file, { force: true }), () => {});
}

const PHASES: ReadonlySet<string> = new Set(['backup', 'replacing', 'replaced', 'rolled_back']);

/** Why recovery cannot tell what an unfinished replace needs: the journal is kept, and nothing moves past it. */
function unsettled(reason: string): Error {
  return new Error(`An earlier "Use the app's version" cannot be settled yet: ${reason}. ${REPLACE_JOURNAL_RELATIVE_PATH.split(path.sep).join('/')} is kept and tried again next time.`);
}

/**
 * The journal, or null only when it is confirmed absent. Anything else that cannot be read or understood (a link, a
 * folder, a permission or disk error, text that is not a journal this app wrote, a phase it does not know) throws.
 */
async function readJournal(workspace: string): Promise<ReplaceJournal | null> {
  const file = path.join(workspace, REPLACE_JOURNAL_RELATIVE_PATH);
  let st;
  try {
    st = await fsp.lstat(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  if (!st.isFile()) throw unsettled('the journal is not a plain file');
  await workspaceEntry(workspace, file);
  let j: Record<string, unknown> | null = null;
  try { j = JSON.parse((await fsp.readFile(file)).toString('utf-8')) as Record<string, unknown>; } catch { /* below */ }
  const valid = j !== null && typeof j === 'object'
    && typeof j['path'] === 'string' && typeof j['staging'] === 'string' && typeof j['trash'] === 'string'
    && typeof j['mine_sha256'] === 'string' && SHA256_HEX.test(j['mine_sha256'])
    && typeof j['app_sha256'] === 'string' && SHA256_HEX.test(j['app_sha256'])
    && typeof j['phase'] === 'string' && PHASES.has(j['phase'])
    && (j['phase'] !== 'replacing' || (typeof j['temp'] === 'string' && stagedName(j['path']).test(j['temp'])));
  if (!valid) throw unsettled('the journal is not one this app can read');
  return j as unknown as ReplaceJournal;
}

/**
 * Records in the manifest that the user resolved `relPath` with the app version `app`, which is its base from now on.
 * Only once that version's text is kept and verified: otherwise nothing is recorded or removed, and false says so.
 */
export function acknowledgeInManifest(workspace: string, relPath: string, app: Buffer, removeCopy: boolean): boolean {
  // The `.new` is removed only when nothing on its way below the workspace is a link (checked in removeNewCopy).
  const manifest = readManifest(workspace);
  if (!manifest?.newCopiesTracked) return false;
  const hash = sha(app);
  if (!storeAppFile(workspace, app)) return false;
  let files: ManifestEntry[] = manifest.files.map((f) => (f.path === relPath ? { ...f, merged_sha256: hash, base_sha256: hash } : f));
  if (!files.some((f) => f.path === relPath)) return false;
  writeManifest(workspace, files);
  // The record is written before the `.new` goes: an interruption leaves only a `.new` the next upgrade removes.
  const ownCopy = manifest.files.find((f) => f.path === relPath)?.new_sha256 === hash;
  if (removeCopy && ownCopy && removeNewCopy(path.join(workspace, `${relPath}.new`), hash, workspace)) {
    files = files.map((f) => (f.path === relPath ? (({ new_sha256: _drop, ...rest }) => rest)(f) : f));
    writeManifest(workspace, files);
  }
  pruneAppFiles(workspace, appFilesInUse(files));
  return true;
}

/** A kept app version, verified by its hash; null when it is not there as written. */
async function keptAppFile(workspace: string, hash: string): Promise<Buffer | null> {
  const bytes = await plainFileBytes(workspace, path.join(APP_FILES_RELATIVE_PATH, hash));
  return bytes && sha(bytes) === hash ? bytes : null;
}

/**
 * Whether the interrupted replace put the app version in place. Only a positive answer either way; anything unclear (the
 * staged copy reached through a link, a disk error) throws. Every path is checked for links below the workspace first.
 */
async function wasApplied(workspace: string, journal: ReplaceJournal): Promise<boolean> {
  if (journal.phase === 'replaced') return true;
  const live = await plainFileBytes(workspace, journal.path);
  if (live && sha(live) === journal.app_sha256) return true;
  if (journal.phase !== 'replacing' || !journal.temp) return false;
  const temp = path.join(workspace, path.dirname(journal.path), journal.temp);
  try {
    await workspaceEntry(workspace, temp);
  } catch (err) {
    // Gone: the rename took it, so the app version was put in place (the user may have edited it since).
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw unsettled('its staged copy cannot be reached without a link');
  }
  // Still there: the rename never happened. That is recorded first, then the staged copy (the app's own) goes.
  await writeJournal(workspace, { ...journal, phase: 'rolled_back' });
  const st = await fsp.lstat(temp);
  if (st.isFile()) await fsp.rm(temp);
  await recoverySteps.after?.('rolled-back');
  return false;
}

/**
 * Finishes or drops a "Use the app's version" that was interrupted, under one rule: the journal is cleared only on a
 * positive answer, and anything unreadable or unclear throws and keeps it (callers then move nothing past it: a start
 * skips its upgrade and pruning, a resolution is refused). The journal is trusted for nothing but hashes and the app's
 * own names. Positive answers: the file is not in the manifest (never the app's to replace: dropped); the rename never
 * happened (dropped, the file stays the user's); or it happened (the journal says so, the staged copy was consumed, or
 * the file is the app version), and the release is acknowledged, with the app's own `.new` removed (never through a
 * link), even when the user edited the file since; their file is never touched. The backup, if made, stays in the trash
 * either way. The caller holds the upgrade lock.
 */
export async function recoverInstructionReplace(workspace: string): Promise<'none' | 'finished' | 'dropped'> {
  // The app's own folder as a link or missing: nothing of this app's is there (resolutions are refused elsewhere).
  const folder = path.join(workspace, '.situation-board');
  const folderStat = await fsp.lstat(folder).catch((err: NodeJS.ErrnoException) => { if (err.code === 'ENOENT') return null; throw err; });
  if (!folderStat || folderStat.isSymbolicLink() || !folderStat.isDirectory()) return 'none';
  const journal = await readJournal(workspace);
  if (journal === null) return 'none';
  const manifest = readManifest(workspace);
  if (!manifest) throw unsettled('the app manifest cannot be read');
  // An older app never rewrites the record of a newer one: that version finishes it.
  if (newerVersion(manifest.appVersion, getAppVersion())) return 'none';
  if (STAGING_NAME.test(journal.staging)) {
    const staging = path.join(folder, journal.staging);
    await workspaceEntry(workspace, staging).then(() => fsp.lstat(staging)).then((st) => (st.isFile() ? fsp.rm(staging) : undefined), () => {});
  }
  let outcome: 'finished' | 'dropped' = 'dropped';
  if (manifest.files.some((f) => f.path === journal.path) && await wasApplied(workspace, journal)) {
    const rendered = (await renderedAppFiles(workspace)).get(journal.path);
    // The journal's release text is kept while a journal names it (pruning keeps it), so this can always be finished.
    const app = rendered?.sha256 === journal.app_sha256 ? rendered.content : await keptAppFile(workspace, journal.app_sha256);
    await recoverySteps.after?.('acknowledging');
    if (!app || !acknowledgeInManifest(workspace, journal.path, app, true)) throw unsettled('the applied release cannot be recorded');
    outcome = 'finished';
  }
  await clearJournal(workspace);
  return outcome;
}
