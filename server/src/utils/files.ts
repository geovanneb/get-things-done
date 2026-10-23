import * as path from 'path';
import { promises as fsp } from 'fs';
import { Response } from 'express';
import { atomicWrite } from './atomicWrite';
import { buildZip } from './zip';

/**
 * Resolves `relative` inside `dir` and returns the absolute path of an existing file.
 * Throws "Invalid path traversal" (400) for anything that escapes `dir`, and "File not found" (404)
 * when there is no such regular file.
 */
export async function fileInside(dir: string, relative: string): Promise<string> {
  const base = path.resolve(dir);
  const full = path.resolve(base, relative);
  if (!full.startsWith(base + path.sep)) throw new Error('Invalid path traversal');
  const realBase = await fsp.realpath(base);
  const realFull = await fsp.realpath(full).catch(() => null);
  if (realFull && !realFull.startsWith(realBase + path.sep)) throw new Error('Invalid path traversal');
  const stat = realFull ? await fsp.stat(realFull) : null;
  if (!stat?.isFile()) throw new Error(`File not found: ${relative}`);
  return realFull!;
}

/** Sends a file to open in the browser, or as a download when `download` is true. */
export function sendFile(res: Response, fullPath: string, download: boolean): void {
  // Attachments are untrusted documents, even when opened from the dashboard.
  res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (download) res.download(fullPath, path.basename(fullPath), { dotfiles: 'allow' });
  else res.sendFile(fullPath, { dotfiles: 'allow' });
}

/** Sends a generated ZIP as a download. */
export function sendZip(res: Response, archive: { name: string; data: Buffer }): void {
  res.attachment(archive.name);
  res.type('application/zip');
  res.send(archive.data);
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
  if (typeof name !== 'string' || !name || name.includes('\0') || name.includes(':') || /[. ]$/.test(name) || name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
    throw new Error('Invalid file name: only files at the top of the folder can be changed');
  }
  return name;
}

/** Largest folder the app zips in one request (sum of file sizes). */
export const MAX_ARCHIVE_BYTES = 200 * 1024 * 1024;

/**
 * A ZIP of a template's or a note's whole folder: its own .md and every listed file, under `<folderName>/`.
 * Throws "Invalid: folder too large" (400) above MAX_ARCHIVE_BYTES.
 */
export async function zipFolder(dir: string, ownMarkdown: string): Promise<{ name: string; data: Buffer }> {
  const folderName = path.basename(dir);
  const files = await listFolderFiles(dir);
  const total = files.reduce((n, f) => n + f.size, 0);
  if (total > MAX_ARCHIVE_BYTES) throw new Error('Invalid: folder too large to download as one file');
  const ordered = [...files.filter((f) => f.name === ownMarkdown), ...files.filter((f) => f.name !== ownMarkdown)];
  const entries = await Promise.all(ordered.map(async (f) => ({
    name: `${folderName}/${f.name}`,
    data: await fsp.readFile(path.join(dir, ...f.name.split('/'))),
    modified: new Date(f.modified),
  })));
  return { name: `${folderName}.zip`, data: buildZip(entries) };
}

/** Save attachments without following an existing file symlink or replacing entity metadata. */
export async function saveAttachment(dir: string, originalName: string, buffer: Buffer, reserved: string): Promise<FolderFile> {
  const name = topLevelName(path.basename(originalName).replace(/[^\w.\-]/g, '_'));
  if (name.startsWith('.') || name.toLowerCase() === reserved.toLowerCase()) {
    throw new Error('Invalid attachment name: reserved file');
  }
  const target = path.join(dir, name);
  await atomicWrite(target, buffer);
  const stat = await fsp.stat(target);
  return { name, size: stat.size, modified: stat.mtime.toISOString(), type: path.extname(name).slice(1).toLowerCase() || 'file' };
}
