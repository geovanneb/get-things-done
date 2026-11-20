import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import { APP_FILES_RELATIVE_PATH, appFileVersion, getAppVersion, MANIFEST_RELATIVE_PATH, newerVersion, readManifest, sameAppFile, storeAppFile } from './scaffold';
import { agentRunning } from './workspaceRefresh';
import { acknowledgeInManifest, clearJournal, plainFileBytes, plainProfile, recoverInstructionReplace, renderedAppFiles, writeJournal, type ReplaceJournal } from './instructionReplace';
import { moveToTrash, trashName } from './trash';
import { workspaceEntry } from '../utils/files';
import { hashFile } from '../utils/fileHash';
import { tryLock, unlock, type HeldLock } from '../utils/fileLock';

/**
 * App files the user changed while the app ships a newer version of them ("instruction updates"): listed for the
 * dashboard, compared, and acknowledged as merged. Only files the app ships to this workspace are ever touched, never a
 * path from a request or the manifest alone; no link is followed; the user's own file is never written here.
 *
 * `ready`: the app's `.new` beside it is exactly the current version, as the app wrote it. `edited`: a `.new` is there
 * but is not the app's copy of this version (the user may be merging in it): shown, never removed. `no_copy`: no `.new`.
 */
export type InstructionUpdateState = 'ready' | 'edited' | 'no_copy';

export interface InstructionUpdate {
  path: string;
  state: InstructionUpdateState;
  mine_sha256: string;
  app_sha256: string;
  /** A file that allows or denies what agents may do: compared and kept here, never replaced from the dashboard. */
  permission_file: boolean;
  /**
   * The app installed this file here: it is in the workspace's manifest as well as in what the app ships now. Only such
   * a file can be replaced with the app's version; a file of the same name the app never installed stays the user's.
   */
  installed: boolean;
  /** The workspace this row was read from: a resolution sends it back and is refused in any other workspace. */
  workspace: string;
}

/**
 * What the app changed in a file since the version the user last had untouched or resolved (its base): `changed` (the
 * base is known and verified, `base` holds its text), `unchanged` (the app ships the very base again: the differences
 * are all the user's), or `unknown` (no base recorded, as for a workspace set up by an older version, or its copy is
 * missing or damaged).
 */
export type ReleaseChange = 'changed' | 'unchanged' | 'unknown';

export interface InstructionComparison extends InstructionUpdate {
  mine: string;
  app: string;
  release: ReleaseChange;
  base: string | null;
  base_sha256: string | null;
}

/**
 * Files the app ships that decide what agents may do (allow and deny rules). A change to them stays the user's own
 * edit: the dashboard offers the comparison and "Keep my version" only, and the server refuses to replace them.
 */
export function isPermissionFile(relPath: string): boolean {
  const p = relPath.split(path.sep).join('/');
  const name = path.posix.basename(p);
  return name === 'settings.json' || name === 'settings.local.json' || p.startsWith('.codex/');
}

export type ReplaceStep = 'journal' | 'backup' | 'staged' | 'committing' | 'renamed' | 'replaced' | 'acknowledged';

/**
 * Test hook: called after each step of "Use the app's version". An error it throws stands for a crash at that exact
 * point: nothing is cleaned up after it, as if the process had stopped there.
 */
export const replaceSteps: { after: ((step: ReplaceStep) => void | Promise<void>) | null } = { after: null };

const CRASH = Symbol('crash');

async function step(name: ReplaceStep): Promise<void> {
  try {
    await replaceSteps.after?.(name);
  } catch (err) {
    throw Object.assign(err instanceof Error ? err : new Error(String(err)), { [CRASH]: true });
  }
}

/**
 * The check right before the rename, on the selected file alone (no other template is read meanwhile): the app version
 * rendered now, the manifest's record of the file and its `.new`, the `.new` itself, and last the user's file. Refused
 * (409) when any of them is not as previewed.
 */
async function unchangedAtCommit(workspace: string, relPath: string, row: Row, previewedState: unknown): Promise<void> {
  const stale = () => httpError(409, 'The file or the app version changed since you compared them. Compare again.');
  const app = appFileVersion(workspace, relPath, await plainProfile(workspace));
  if (!app || app.sha256 !== row.update.app_sha256) throw stale();
  const entry = readManifest(workspace)?.files.find((f) => f.path === relPath);
  if (!entry) throw stale();
  const copy = await plainFileHash(workspace, `${relPath}.new`);
  const copyThere = copy !== null
    || await fsp.lstat(path.join(workspace, `${relPath}.new`)).then(() => true, (err: NodeJS.ErrnoException) => err.code !== 'ENOENT');
  const state: InstructionUpdateState = !copyThere ? 'no_copy'
    : copy?.sha256 === app.sha256 && entry.new_sha256 === app.sha256 ? 'ready' : 'edited';
  if (state !== previewedState) throw stale();
  const mine = await plainFileHash(workspace, relPath);
  if (mine?.sha256 !== row.update.mine_sha256) throw stale();
}

/** A comparison is shown whole only up to this size; larger files are compared outside the app. */
const MAX_COMPARE_BYTES = 512 * 1024;

const sha = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');

function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode: status });
}

/**
 * A plain file reached through no link below the workspace: its hash (streamed, so any size is fine) and size.
 * Null when it is missing, a link, a folder, or cannot be read.
 */
async function plainFileHash(workspace: string, relPath: string): Promise<{ sha256: string; size: number } | null> {
  const full = path.join(workspace, relPath);
  try {
    await workspaceEntry(workspace, full);
    if (!(await fsp.lstat(full)).isFile()) return null;
    return await hashFile(full);
  } catch {
    return null;
  }
}

/** The text of a plain file, read only after checking its size: never more than the comparison can show. */
async function plainFileText(workspace: string, relPath: string): Promise<Buffer> {
  const full = path.join(workspace, relPath);
  await workspaceEntry(workspace, full);
  const stat = await fsp.lstat(full);
  if (!stat.isFile()) throw httpError(409, 'The file changed. Compare again.');
  if (stat.size > MAX_COMPARE_BYTES) throw httpError(413, 'The file is too large to compare here. Compare it with its .new file in an editor.');
  return fsp.readFile(full);
}

/** The workspace's own metadata folder and manifest, refused when either is reached through a link or is not plain. */
async function metadataIsPlain(workspace: string): Promise<boolean> {
  try {
    const folder = path.join(workspace, '.situation-board');
    await workspaceEntry(workspace, folder);
    if (!(await fsp.lstat(folder)).isDirectory()) return false;
    const manifest = path.join(workspace, MANIFEST_RELATIVE_PATH);
    await workspaceEntry(workspace, manifest);
    return (await fsp.lstat(manifest)).isFile();
  } catch {
    return false;
  }
}

/** Equal, or JSON that only differs in order; a large file is compared by hash only. */
async function sameAsApp(workspace: string, relPath: string, mine: { sha256: string; size: number }, app: { content: Buffer; sha256: string }): Promise<boolean> {
  if (mine.sha256 === app.sha256) return true;
  if (!relPath.endsWith('.json') || mine.size > MAX_COMPARE_BYTES) return false;
  return sameAppFile(relPath, await plainFileText(workspace, relPath).catch(() => Buffer.alloc(0)), app.content);
}

interface Row { update: InstructionUpdate; app: Buffer; base_sha256: string | null }

async function rows(workspace: string): Promise<Row[]> {
  // Read only when it is plain: a link, a folder or a pipe in its place is never followed. Without it nothing is the
  // app's copy, so every row is shown and none offers the actions.
  const manifest = await metadataIsPlain(workspace) ? readManifest(workspace) : null;
  const tracked = manifest?.newCopiesTracked ? manifest.files : [];
  const out: Row[] = [];
  for (const [relPath, app] of await renderedAppFiles(workspace)) {
    const mine = await plainFileHash(workspace, relPath);
    if (!mine || await sameAsApp(workspace, relPath, mine, app)) continue;
    const entry = tracked.find((f) => f.path === relPath);
    if (entry?.merged_sha256 === app.sha256) continue;
    const copy = await plainFileHash(workspace, `${relPath}.new`);
    const state: InstructionUpdateState = copy === null
      ? (await fsp.lstat(path.join(workspace, `${relPath}.new`)).then(() => true, (err: NodeJS.ErrnoException) => err.code !== 'ENOENT') ? 'edited' : 'no_copy')
      : copy.sha256 === app.sha256 && entry?.new_sha256 === app.sha256 ? 'ready' : 'edited';
    const base = entry?.base_sha256;
    out.push({
      update: { path: relPath, state, mine_sha256: mine.sha256, app_sha256: app.sha256, permission_file: isPermissionFile(relPath), installed: entry !== undefined, workspace },
      app: app.content,
      base_sha256: typeof base === 'string' && /^[0-9a-f]{64}$/.test(base) ? base : null,
    });
  }
  return out.sort((a, b) => a.update.path.localeCompare(b.update.path));
}

export async function listInstructionUpdates(workspace: string): Promise<InstructionUpdate[]> {
  return (await rows(workspace)).map((r) => r.update);
}

/**
 * The exact app version kept as a file's base, verified by its hash; null when it is missing, damaged, reached through a
 * link, or too large to show.
 */
async function storedAppFile(workspace: string, hash: string): Promise<Buffer | null> {
  const full = path.join(workspace, APP_FILES_RELATIVE_PATH, hash);
  try {
    await workspaceEntry(workspace, full);
    const stat = await fsp.lstat(full);
    if (!stat.isFile() || stat.size > MAX_COMPARE_BYTES) return null;
    const bytes = await fsp.readFile(full);
    return sha(bytes) === hash ? bytes : null;
  } catch {
    return null;
  }
}

/**
 * The versions as text, for the dashboard's comparison: the user's file, the app version, and when it is known the
 * version the user's file was based on, so the dashboard can show what the app itself changed. Only a listed file;
 * refused when too large to show.
 */
export async function compareInstructionUpdate(workspace: string, relPath: unknown): Promise<InstructionComparison> {
  const row = (await rows(workspace)).find((r) => r.update.path === relPath);
  if (!row) throw httpError(404, 'No newer app version is waiting for that file.');
  if (row.app.length > MAX_COMPARE_BYTES) throw httpError(413, 'The file is too large to compare here. Compare it with its .new file in an editor.');
  const mine = await plainFileText(workspace, row.update.path);
  // Read after listing: what is shown must be what was hashed, or the user compares again.
  if (sha(mine) !== row.update.mine_sha256) throw httpError(409, 'The file changed while it was read. Compare again.');
  let release: ReleaseChange = 'unknown';
  let base: Buffer | null = null;
  if (row.base_sha256 === row.update.app_sha256) release = 'unchanged';
  else if (row.base_sha256 && (base = await storedAppFile(workspace, row.base_sha256))) release = 'changed';
  return {
    ...row.update,
    mine: mine.toString('utf-8'),
    app: row.app.toString('utf-8'),
    release,
    base: release === 'changed' && base ? base.toString('utf-8') : null,
    base_sha256: release === 'unknown' ? null : row.base_sha256,
  };
}

/**
 * A resolution belongs to the workspace it was compared in: refused (409, `other_workspace`) when it names another one,
 * before anything is read or written. Every resolution must say it: a confirmation left open while another workspace
 * was opened elsewhere never settles that one.
 */
function sameWorkspace(workspace: string, named: unknown): void {
  if (named === undefined) {
    // A page loaded before the app was updated sends none: it must be reloaded.
    throw Object.assign(httpError(409, 'This page is out of date. Reload the page, then try again.'), { details: { code: 'other_workspace' } });
  }
  if (typeof named !== 'string' || path.resolve(named) !== path.resolve(workspace)) {
    throw Object.assign(httpError(409, 'This comparison is from another workspace. Switch to it, then compare again.'), { details: { code: 'other_workspace' } });
  }
}

function bodyOf(body: unknown): Record<string, unknown> {
  return body && typeof body === 'object' ? body as Record<string, unknown> : {};
}

/**
 * Takes the upgrade lock and checks what every resolution needs under it: the metadata folder is plain, no upgrade or
 * agent works, the app that last upgraded is not newer, and an interrupted "Use the app's version" is finished first.
 */
async function resolving<T>(workspace: string, work: () => Promise<T>): Promise<T> {
  // The lock and the manifest are written: never through a link out of the workspace.
  if (!(await metadataIsPlain(workspace))) throw httpError(409, 'The workspace\'s .situation-board folder or its manifest is a link or missing. Restart the app once, then try again.');
  const folder = path.join(workspace, '.situation-board');
  const held: HeldLock | string = await tryLock(path.join(folder, 'upgrade.lock'));
  if (typeof held === 'string') throw httpError(409, 'The app is bringing the files up to date. Try again in a moment.');
  try {
    if (await agentRunning(workspace)) throw httpError(409, 'An agent is working in the workspace. Try again when it has finished.');
    const manifest = readManifest(workspace);
    if (!manifest?.newCopiesTracked) throw httpError(409, 'Restart the app once so it brings the files up to date, then try again.');
    if (newerVersion(manifest.appVersion, getAppVersion())) throw httpError(409, 'A newer version of the app last upgraded this workspace. Use that version.');
    // Nothing is resolved past an unfinished replace that cannot be settled now.
    try {
      await recoverInstructionReplace(workspace);
    } catch {
      throw httpError(503, 'An earlier Use the app\'s version could not be checked or finished (.situation-board/instruction-replace.json). Try again in a moment; if it keeps happening, restart the app.');
    }
    return await work();
  } finally {
    await unlock(held);
  }
}

/**
 * "Keep my version" (formerly "I merged it"): records that the user resolved this exact app version in their own file,
 * so no `.new` is written for it again, and makes it the file's base: the next release is compared from it. Then
 * removes the app's own `.new` of it. Holds the upgrade lock and checks again under it: refused (409) when an upgrade
 * or an agent is working, when the app that last upgraded is newer, or when the file or the app version is not what
 * the user compared. The record is written before the `.new` goes, so an interruption leaves only a `.new` the next
 * upgrade removes. A `.new` the user changed is never removed. An editor saving the `.new` at the very moment of
 * removal is the one case no lock covers.
 */
export async function acknowledgeInstructionUpdate(workspace: string, body: unknown): Promise<InstructionUpdate[]> {
  const b = bodyOf(body);
  const relPath = b['path'];
  if (typeof relPath !== 'string') throw httpError(400, 'Say which file.');
  sameWorkspace(workspace, b['workspace']);
  return resolving(workspace, async () => {
    const row = (await rows(workspace)).find((r) => r.update.path === relPath);
    if (!row) throw httpError(404, 'No newer app version is waiting for that file.');
    if (!row.update.installed) throw httpError(409, 'The app did not install this file in this workspace yet. Restart the app once so it brings the files up to date, then try again.');
    if (row.update.state === 'edited') throw httpError(409, `Its .new file was changed. Finish with it and delete it, or restore it, first.`);
    if (row.update.mine_sha256 !== b['mine_sha256'] || row.update.app_sha256 !== b['app_sha256']) {
      throw httpError(409, 'The file or the app version changed since you compared them. Compare again.');
    }
    // The release is the base from now on only once its text is kept: otherwise nothing is settled.
    if (!storeAppFile(workspace, row.app)) throw httpError(500, 'The app version could not be saved in .situation-board/app-files. Nothing was changed; try again.');
    if (!acknowledgeInManifest(workspace, relPath, row.app, row.update.state === 'ready')) {
      throw httpError(409, 'Restart the app once so it brings the files up to date, then try again.');
    }
    return listInstructionUpdates(workspace);
  });
}

/** A plain file's bytes opened without following a link at its own name (where the system offers that). */
async function readNoFollow(full: string): Promise<Buffer> {
  const handle = await fsp.open(full, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    if (!(await handle.stat()).isFile()) throw httpError(409, 'The file changed. Compare again.');
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

/**
 * "Use the app's version": replaces the user's file with the app version they previewed. Only a listed file the app
 * installed here (in the manifest) and ships now, never a permission file, never through a link, both sides within the
 * comparison limit, only in the workspace the preview came from, and only while the user's file, its `.new` and the
 * app version are exactly what the preview showed (`mine_sha256`, `app_sha256`, `state`): refused otherwise, and while
 * an upgrade or an agent works. Under the upgrade lock, in this order:
 * 1. the app version's text is kept (it becomes the file's base), and a journal is written;
 * 2. a copy of the user's file is made in `.situation-board/`, checked against `mine_sha256`, and moved into the
 *    workspace trash (the backup, restorable as it was, byte for byte);
 * 3. right before the replace, everything is checked again (the file, its `.new` and who owns it, the app version);
 *    then the app version replaces the file whole, and the journal records that it did;
 * 4. the manifest records the version as resolved and as the file's base, then the app's own `.new` is removed.
 * An interruption before 3 leaves the file as it was; after 3 the next resolution or start finishes 4, even when the
 * user edited the file since (their edits are kept). Returns the remaining updates and the backup's workspace path.
 */
export async function useAppVersion(workspace: string, body: unknown): Promise<{ updates: InstructionUpdate[]; backup: string }> {
  const b = bodyOf(body);
  const relPath = b['path'];
  if (typeof relPath !== 'string') throw httpError(400, 'Say which file.');
  sameWorkspace(workspace, b['workspace']);
  const stillAsPreviewed = (row: Row | undefined): Row => {
    if (!row) throw httpError(404, 'No newer app version is waiting for that file.');
    if (row.update.permission_file) throw httpError(403, 'This file decides what agents may do. Change it yourself, then choose Keep my version.');
    if (!row.update.installed) throw httpError(409, 'The app did not install this file in this workspace, so it is not replaced. Change it yourself, then choose Keep my version.');
    if (row.update.state === 'edited') throw httpError(409, 'Its .new file was changed. Finish with it and delete it, or restore it, first.');
    if (row.update.mine_sha256 !== b['mine_sha256'] || row.update.app_sha256 !== b['app_sha256'] || row.update.state !== b['state']) {
      throw httpError(409, 'The file or the app version changed since you compared them. Compare again.');
    }
    return row;
  };
  return resolving(workspace, async () => {
    const row = stillAsPreviewed((await rows(workspace)).find((r) => r.update.path === relPath));
    const full = path.join(workspace, relPath);
    await workspaceEntry(workspace, full);
    const stat = await fsp.lstat(full);
    if (!stat.isFile()) throw httpError(409, 'The file changed. Compare again.');
    // What the user could not preview is never replaced: the same limit as the comparison, on both sides.
    if (stat.size > MAX_COMPARE_BYTES || row.app.length > MAX_COMPARE_BYTES) {
      throw httpError(413, 'The file is too large to compare here. Compare it with its .new file in an editor.');
    }

    const folder = path.join(workspace, '.situation-board');
    const staging = `.instruction-backup-${randomUUID()}.tmp`;
    const backupName = trashName(path.basename(relPath));
    const trash = path.posix.join('.situation-board', 'trash', backupName);
    // 1. The app version is kept as the file's next base before anything changes; without it nothing is replaced.
    if (!storeAppFile(workspace, row.app)) throw httpError(500, 'The app version could not be saved in .situation-board/app-files. Nothing was changed; try again.');
    const journal: ReplaceJournal = { path: relPath, mine_sha256: row.update.mine_sha256, app_sha256: row.update.app_sha256, staging, trash, phase: 'backup', started_at: new Date().toISOString() };
    await writeJournal(workspace, journal);
    await step('journal');

    // 2. The backup: a copy, verified, moved into the trash under the file's own name. The user's file is still there.
    const mine = await readNoFollow(full);
    if (sha(mine) !== row.update.mine_sha256) {
      await clearJournal(workspace);
      throw httpError(409, 'The file changed while it was read. Compare again.');
    }
    const stagingPath = path.join(folder, staging);
    await workspaceEntry(workspace, stagingPath, true);
    await fsp.writeFile(stagingPath, mine, { flag: 'wx', mode: stat.mode & 0o777 });
    const backup = await moveToTrash(workspace, stagingPath, new Date(), backupName);
    const saved = await plainFileBytes(workspace, backup);
    if (!saved || sha(saved) !== row.update.mine_sha256) {
      await clearJournal(workspace);
      throw httpError(500, 'The backup of your file could not be saved and checked. Nothing was replaced.');
    }
    await step('backup');

    // 3. The replace: the app version is staged beside the file and the journal names it, so a crash at any point can
    // be told apart: a staged copy still there was never renamed into place. Right before the rename, this one file,
    // its `.new` (and who owns it) and the app version are checked again, the user's file last; anything changed
    // leaves the file as it is and the update waiting (the verified backup stays in the trash).
    const tempName = `.${path.basename(full)}.${randomUUID()}.tmp`;
    const temp = path.join(path.dirname(full), tempName);
    let replacing = false;
    let renamed = false;
    try {
      await workspaceEntry(workspace, temp, true);
      await fsp.writeFile(temp, row.app, { flag: 'wx', mode: stat.mode & 0o777 });
      await writeJournal(workspace, { ...journal, phase: 'replacing', temp: tempName });
      replacing = true;
      await step('staged');
      await unchangedAtCommit(workspace, relPath, row, b['state']);
      await workspaceEntry(workspace, full);
      await step('committing');
      await fsp.rename(temp, full);
      renamed = true;
    } catch (err) {
      // A crash keeps everything as it is, for recovery. Otherwise the journal goes before the staged copy does, so a
      // journal saying `replacing` never outlives its staged copy unless the rename took it.
      if (!renamed && replacing && !(err as Record<symbol, unknown>)[CRASH]) {
        await clearJournal(workspace);
        replacing = false;
      }
      throw err;
    } finally {
      if (!replacing && !renamed) await fsp.rm(temp, { force: true });
    }
    await step('renamed');
    await writeJournal(workspace, { ...journal, phase: 'replaced' });
    await step('replaced');

    // 4. Resolved: the record first, then the app's own `.new`. A failure leaves the journal, which finishes it later.
    if (!acknowledgeInManifest(workspace, relPath, row.app, row.update.state === 'ready')) {
      throw httpError(500, 'Your file was replaced, but the app could not record it yet. It finishes when the workspace opens next.');
    }
    await step('acknowledged');
    await clearJournal(workspace);
    return { updates: await listInstructionUpdates(workspace), backup };
  });
}
