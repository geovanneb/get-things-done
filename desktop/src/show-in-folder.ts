// Kept apart from the bridge (no Electron here), so the checks can be tested on their own.
import * as path from 'path';
import { promises as fsp } from 'fs';

/**
 * Show in folder: the page names a file or folder by its path inside the open workspace, never a path on the computer.
 * The app resolves it against the workspace the server reports, follows any link to where it really is, and acts only
 * when that is still inside the workspace.
 *
 * It only ever reveals, never opens: every case ends in `showItemInFolder`, which selects an item in Finder or Explorer
 * and cannot launch it. Opening (`openPath`) would launch a file, and on macOS also an app bundle, which is a folder.
 * So a folder is shown from inside, with its first visible entry selected; an empty one is selected in its parent; a
 * bundle (an app, plug-in, package...) is selected like a file, never entered. Since nothing is opened, a swap after
 * the checks can at most reveal a different item; it can never run anything.
 */

/** The one shell call used. A test shell can also carry `openPath` to prove it is never called. */
export interface FolderShell {
  showItemInFolder(full: string): void;
}

export type ShowResult = { opened: true } | { opened: false; error: string };

/** Folders the system shows and launches as one item: revealed like a file, never entered. */
const BUNDLE = /\.(app|bundle|framework|plugin|kext|pkg|mpkg)$/i;

/** A workspace-relative path with "/" from the page, or null: never absolute, never `..`, never a drive or NUL. */
export function parseRelativePath(value: unknown): string | null {
  if (typeof value !== 'string' || !value || value.length > 1024 || value.includes('\0')) return null;
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value) || /^[a-zA-Z]:/.test(value)) return null;
  const parts = value.split(/[\\/]/);
  if (parts.some((p) => p === '..')) return null;
  const clean = parts.filter((p) => p && p !== '.');
  return clean.length ? clean.join('/') : null;
}

/** Whether `full` (already real) is inside the real workspace `root`, and not the workspace itself. */
function inside(root: string, full: string): boolean {
  const rel = path.relative(root, full);
  return Boolean(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/** A directory the system treats as one item: by its name, or by holding Contents/Info.plist as macOS packages do. */
export async function isBundle(full: string): Promise<boolean> {
  if (BUNDLE.test(path.basename(full))) return true;
  return fsp.lstat(path.join(full, 'Contents', 'Info.plist')).then((st) => st.isFile(), () => false);
}

/** Where a path really is (links followed), when it exists inside the workspace; null otherwise. */
async function real(root: string, full: string): Promise<{ full: string; folder: boolean } | null> {
  const resolved = await fsp.realpath(full).catch(() => null);
  if (!resolved || !inside(root, resolved)) return null;
  const stat = await fsp.stat(resolved).catch(() => null);
  if (!stat || (!stat.isFile() && !stat.isDirectory())) return null;
  return { full: resolved, folder: stat.isDirectory() };
}

/**
 * The item to reveal for a relative path: a file or bundle itself; for a folder, its first visible entry by name that
 * is not a link (checked the same way), or the folder itself when only links or dotfiles are left.
 */
export async function revealTarget(workspace: string, relative: string): Promise<{ full: string } | { error: string }> {
  const root = await fsp.realpath(workspace).catch(() => null);
  if (!root) return { error: 'The workspace folder was not found.' };
  const asked = path.join(root, ...relative.split('/'));
  if (!(await fsp.lstat(asked).then(() => true, () => false))) return { error: 'It is not there any more: it may have been moved or removed.' };
  const target = await real(root, asked);
  if (!target) return { error: 'It is outside the workspace, so it is not shown.' };
  if (!target.folder || (await isBundle(target.full))) return { full: target.full };
  const names = (await fsp.readdir(target.full).catch(() => [] as string[])).filter((n) => !n.startsWith('.')).sort((a, b) => a.localeCompare(b));
  for (const name of names) {
    // A link is never chosen, even one that stays inside: the reveal always lands inside the asked folder.
    const own = path.join(target.full, name);
    if (await fsp.lstat(own).then((st) => st.isSymbolicLink(), () => true)) continue;
    const entry = await real(root, own);
    if (entry) return { full: entry.full };
  }
  return { full: target.full };
}

/** Reveals a file or folder of the workspace in Finder or Explorer. Never opens or launches anything. */
export async function showInFolder(workspace: string, value: unknown, shell: FolderShell): Promise<ShowResult> {
  const relative = parseRelativePath(value);
  if (!relative) return { opened: false, error: 'Only a file or folder inside the workspace can be shown.' };
  const target = await revealTarget(workspace, relative);
  if ('error' in target) return { opened: false, error: target.error };
  shell.showItemInFolder(target.full);
  return { opened: true };
}
