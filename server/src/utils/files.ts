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
