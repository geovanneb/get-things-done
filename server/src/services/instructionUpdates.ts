import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { createHash } from 'crypto';
import { appFileVersions, getAppVersion, MANIFEST_RELATIVE_PATH, newerVersion, readManifest, removeNewCopy, sameAppFile, writeManifest } from './scaffold';
import { agentRunning } from './workspaceRefresh';
import { workspaceEntry } from '../utils/files';
import { hashFile } from '../utils/fileHash';
import { tryLock, unlock } from '../utils/fileLock';

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

async function rows(workspace: string): Promise<{ update: InstructionUpdate; app: Buffer }[]> {
  // Read only when it is plain: a link, a folder or a pipe in its place is never followed. Without it nothing is the
  // app's copy, so every row is shown and none offers the actions.
  const manifest = await metadataIsPlain(workspace) ? readManifest(workspace) : null;
  const tracked = manifest?.newCopiesTracked ? manifest.files : [];
  const out: { update: InstructionUpdate; app: Buffer }[] = [];
  for (const [relPath, app] of appFileVersions(workspace)) {
    const mine = await plainFileHash(workspace, relPath);
    if (!mine || await sameAsApp(workspace, relPath, mine, app)) continue;
    const entry = tracked.find((f) => f.path === relPath);
    if (entry?.merged_sha256 === app.sha256) continue;
    const copy = await plainFileHash(workspace, `${relPath}.new`);
    const state: InstructionUpdateState = copy === null
      ? (fs.existsSync(path.join(workspace, `${relPath}.new`)) ? 'edited' : 'no_copy')
      : copy.sha256 === app.sha256 && entry?.new_sha256 === app.sha256 ? 'ready' : 'edited';
    out.push({ update: { path: relPath, state, mine_sha256: mine.sha256, app_sha256: app.sha256 }, app: app.content });
  }
  return out.sort((a, b) => a.update.path.localeCompare(b.update.path));
}

export async function listInstructionUpdates(workspace: string): Promise<InstructionUpdate[]> {
  return (await rows(workspace)).map((r) => r.update);
}

/** Both versions as text, for the dashboard's comparison. Only a listed file; refused when too large to show. */
export async function compareInstructionUpdate(workspace: string, relPath: unknown): Promise<InstructionUpdate & { mine: string; app: string }> {
  const row = (await rows(workspace)).find((r) => r.update.path === relPath);
  if (!row) throw httpError(404, 'No newer app version is waiting for that file.');
  if (row.app.length > MAX_COMPARE_BYTES) throw httpError(413, 'The file is too large to compare here. Compare it with its .new file in an editor.');
  const mine = await plainFileText(workspace, row.update.path);
  // Read after listing: what is shown must be what was hashed, or the user compares again.
  if (sha(mine) !== row.update.mine_sha256) throw httpError(409, 'The file changed while it was read. Compare again.');
  return { ...row.update, mine: mine.toString('utf-8'), app: row.app.toString('utf-8') };
}

/**
 * "I merged it": records that the user took this exact app version into their own file, so no `.new` is written for
 * it again, then removes the app's own `.new` of it. Holds the upgrade lock and checks again under it: refused (409)
 * when an upgrade or an agent is working, when the app that last upgraded is newer, or when the file or the app version
 * is not what the user compared. The record is written before the `.new` goes, so an interruption leaves only a `.new`
 * the next upgrade removes. A `.new` the user changed is never removed. An editor saving the `.new` at the very moment
 * of removal is the one case no lock covers.
 */
export async function acknowledgeInstructionUpdate(workspace: string, body: unknown): Promise<InstructionUpdate[]> {
  const b = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const relPath = b['path'];
  if (typeof relPath !== 'string') throw httpError(400, 'Say which file.');
  // The lock and the manifest are written: never through a link out of the workspace.
  if (!(await metadataIsPlain(workspace))) throw httpError(409, 'The workspace\'s .situation-board folder or its manifest is a link or missing. Restart the app once, then try again.');
  const folder = path.join(workspace, '.situation-board');
  const held = await tryLock(path.join(folder, 'upgrade.lock'));
  if (typeof held === 'string') throw httpError(409, 'The app is bringing the files up to date. Try again in a moment.');
  try {
    if (await agentRunning(workspace)) throw httpError(409, 'An agent is working in the workspace. Try again when it has finished.');
    const manifest = readManifest(workspace);
    if (!manifest?.newCopiesTracked) throw httpError(409, 'Restart the app once so it brings the files up to date, then try again.');
    if (newerVersion(manifest.appVersion, getAppVersion())) throw httpError(409, 'A newer version of the app last upgraded this workspace. Use that version.');
    const row = (await rows(workspace)).find((r) => r.update.path === relPath);
    if (!row) throw httpError(404, 'No newer app version is waiting for that file.');
    if (row.update.state === 'edited') throw httpError(409, `Its .new file was changed. Finish with it and delete it, or restore it, first.`);
    if (row.update.mine_sha256 !== b['mine_sha256'] || row.update.app_sha256 !== b['app_sha256']) {
      throw httpError(409, 'The file or the app version changed since you compared them. Compare again.');
    }
    const files = manifest.files.map((f) => (f.path === relPath ? { ...f, merged_sha256: row.update.app_sha256 } : f));
    if (!files.some((f) => f.path === relPath)) throw httpError(409, 'Restart the app once so it brings the files up to date, then try again.');
    writeManifest(workspace, files);
    if (row.update.state === 'ready') {
      const newPath = path.join(workspace, `${relPath}.new`);
      if (removeNewCopy(newPath, row.update.app_sha256)) {
        writeManifest(workspace, files.map((f) => (f.path === relPath ? (({ new_sha256: _drop, ...rest }) => rest)(f) : f)));
      }
    }
    return listInstructionUpdates(workspace);
  } finally {
    await unlock(held);
  }
}
