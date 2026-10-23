import * as path from 'path';
import { promises as fsp } from 'fs';
import { Response } from 'express';

/**
 * Resolves `relative` inside `dir` and returns the absolute path of an existing file.
 * Throws "Invalid path traversal" (400) for anything that escapes `dir`, and "File not found" (404)
 * when there is no such regular file.
 */
export async function fileInside(dir: string, relative: string): Promise<string> {
  const base = path.resolve(dir);
  const full = path.resolve(base, relative);
  if (!full.startsWith(base + path.sep)) throw new Error('Invalid path traversal');
  const stat = await fsp.stat(full).catch(() => null);
  if (!stat?.isFile()) throw new Error(`File not found: ${relative}`);
  return full;
}

/** Sends a file to open in the browser, or as a download when `download` is true. */
export function sendFile(res: Response, fullPath: string, download: boolean): void {
  if (download) res.download(fullPath, path.basename(fullPath), { dotfiles: 'allow' });
  else res.sendFile(fullPath, { dotfiles: 'allow' });
}

export interface FolderFile { name: string; size: number; modified: string; type: string; }

const MAX_DEPTH = 4;
const MAX_FILES = 500;

/**
 * Every file in `dir` and its subfolders, as POSIX paths relative to `dir` (e.g. "assets/logo.png").
 * Hidden files and folders are skipped, and so are `exclude` names at the top level (the folder's own .md).
 * Top-level files come first, newest first; then subfolder files by path.
 */
export async function listFolderFiles(dir: string, exclude: string[] = []): Promise<FolderFile[]> {
  const top: FolderFile[] = [];
  const nested: FolderFile[] = [];
  async function walk(current: string, prefix: string, depth: number): Promise<void> {
    const entries = await fsp.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (top.length + nested.length >= MAX_FILES) return;
      if (entry.name.startsWith('.')) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (depth < MAX_DEPTH) await walk(full, rel, depth + 1);
        continue;
      }
      if (!entry.isFile() || (!prefix && exclude.includes(entry.name))) continue;
      const stat = await fsp.stat(full);
      (prefix ? nested : top).push({
        name: rel,
        size: stat.size,
        modified: stat.mtime.toISOString(),
        type: path.extname(entry.name).slice(1).toLowerCase() || 'file',
      });
    }
  }
  await walk(dir, '', 1);
  top.sort((a, b) => b.modified.localeCompare(a.modified));
  nested.sort((a, b) => a.name.localeCompare(b.name));
  return [...top, ...nested];
}

/** A plain top-level file name for upload or delete; names with folders are refused. */
export function topLevelName(name: string): string {
  if (!name || name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
    throw new Error('Invalid file name: only files at the top of the folder can be changed');
  }
  return name;
}
