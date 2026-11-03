import * as path from 'path';
import * as fsp from 'fs/promises';
import * as crypto from 'crypto';
import { workspaceEntry } from '../utils/files';

/**
 * `.situation-board/trash/`: where soft deletes and the previous version of every overwritten file go.
 * Entries are named `<ISO time with - for : and .>-<uuid>-<original name>`, the format FileService has
 * always used. The name is the only reliable record of when an entry was trashed: a rename keeps the
 * file's own modification time.
 */
export function trashDir(workspacePath: string): string {
  return path.join(workspacePath, '.situation-board', 'trash');
}

/**
 * A new trash entry's name for `label`, in the format below. Chosen before anything moves when a record of the move
 * must be written first, so the record can name the entry.
 */
export function trashName(label: string, now = new Date()): string {
  return `${now.toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID()}-${path.basename(label)}`;
}

/** Moves a file or folder into the trash, as `name` when given. Returns the trash entry's workspace-relative path. */
export async function moveToTrash(workspacePath: string, target: string, now = new Date(), name?: string): Promise<string> {
  await workspaceEntry(workspacePath, target);
  const dir = await workspaceEntry(workspacePath, trashDir(workspacePath), true);
  await fsp.mkdir(dir, { recursive: true });
  const dest = path.join(dir, name !== undefined && trashedAt(name) ? name : trashName(path.basename(target), now));
  await fsp.rename(target, dest);
  return path.relative(workspacePath, dest).split(path.sep).join('/');
}

/**
 * Moves some plain files of one folder into a new trash folder named after `label` (or `name`, when given), so they can
 * be restored together. Returns the trash entry's name. A file that is not a plain file in `dir` (a link, a folder) is
 * refused before anything moves.
 */
export async function moveFilesToTrash(workspacePath: string, dir: string, files: string[], label: string, now = new Date(), name?: string): Promise<string> {
  const from = await workspaceEntry(workspacePath, dir);
  for (const name of files) {
    if (path.basename(name) !== name) throw new Error('Invalid path traversal');
    const st = await fsp.lstat(path.join(from, name));
    if (!st.isFile()) throw new Error(`${name} is not a plain file; left alone`);
  }
  const trash = await workspaceEntry(workspacePath, trashDir(workspacePath), true);
  await fsp.mkdir(trash, { recursive: true });
  const entryName = name !== undefined && trashedAt(name) ? name : trashName(label, now);
  const entry = path.join(trash, entryName);
  await fsp.mkdir(entry);
  for (const file of files) await fsp.rename(path.join(from, file), path.join(entry, file));
  return entryName;
}

/** The full path of a trash entry this app named, or null for any other name. */
export async function trashEntry(workspacePath: string, name: string): Promise<string | null> {
  if (path.basename(name) !== name || !trashedAt(name)) return null;
  return workspaceEntry(workspacePath, path.join(trashDir(workspacePath), name)).catch(() => null);
}

const ENTRY = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-.+$/;

/** When a trash entry was trashed, from its name, or null for a name this app did not write. */
export function trashedAt(name: string): Date | null {
  const m = name.match(ENTRY);
  if (!m) return null;
  const date = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${m[7]}Z`);
  return Number.isNaN(date.getTime()) || !name.startsWith(date.toISOString().replace(/[:.]/g, '-') + '-') ? null : date;
}
