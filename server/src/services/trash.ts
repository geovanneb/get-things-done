import * as path from 'path';
import * as fsp from 'fs/promises';
import * as crypto from 'crypto';

/**
 * `.situation-board/trash/`: where soft deletes and the previous version of every overwritten file go.
 * Entries are named `<ISO time with - for : and .>-<uuid>-<original name>`, the format FileService has
 * always used. The name is the only reliable record of when an entry was trashed: a rename keeps the
 * file's own modification time.
 */
export function trashDir(workspacePath: string): string {
  return path.join(workspacePath, '.situation-board', 'trash');
}

/** Moves a file or folder into the trash. Returns the trash entry's workspace-relative path. */
export async function moveToTrash(workspacePath: string, target: string, now = new Date()): Promise<string> {
  const dir = trashDir(workspacePath);
  await fsp.mkdir(dir, { recursive: true });
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const dest = path.join(dir, `${stamp}-${crypto.randomUUID()}-${path.basename(target)}`);
  await fsp.rename(target, dest);
  return path.relative(workspacePath, dest).split(path.sep).join('/');
}

const ENTRY = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-/;

/** When a trash entry was trashed, from its name, or null for a name this app did not write. */
export function trashedAt(name: string): Date | null {
  const m = name.match(ENTRY);
  if (!m) return null;
  const date = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${m[7]}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}
