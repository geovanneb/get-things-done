import * as path from 'path';
import { promises as fsp } from 'fs';
import { createHash } from 'crypto';
import { TaskService } from './taskService';
import { OutputService } from './outputService';
import { WorkspaceService } from './workspace';
import { MAX_ARCHIVE_BYTES, workspaceEntry } from '../utils/files';
import { buildZip, type ZipEntry } from '../utils/zip';

/**
 * A share pack (#81): selected deliverables and attachments from several tasks, in the user's order, with an edited
 * README, downloaded as one ZIP. Only what was selected goes in, and only from the chosen task's own folder: never a
 * task.md, an execution log, a backup, an agent's notes, pinned sources, or anything reached through a link. Confidentiality
 * is shown as information, never as permission. The download is built only from the list the user previewed: a file
 * changed, grown or gone since the preview is refused, so a pack never holds what was not seen.
 */

export interface ShareItem { task: string; kind: 'deliverable' | 'attachment'; ref: string }

export interface ShareRow {
  task: string;
  task_title: string;
  confidentiality: string | null;
  kind: ShareItem['kind'];
  ref: string;
  /** The output template's name, for a deliverable that has one. */
  template: string | null;
  /** The file's own name, and its name in the pack: numbered in reading order, so names never collide. */
  source_name: string;
  zip_name: string;
  size: number | null;
  sha256: string | null;
  /** Why it cannot go in, when it cannot (missing file, outside the task, too large, …). */
  problem: string | null;
}

export interface SharePreview { rows: ShareRow[]; readme: string; total_bytes: number; token: string; ready: boolean }

const MAX_ITEMS = 200;
const MAX_README = 64 * 1024;
const TASK_ID = /^TASK-\d{4}-\d{4}$/;
/** Inside a task's folder, what is never shared: the task itself and the folders that hold internal material. */
const INTERNAL = new Set(['task.md', 'executions', 'sources', 'notes', 'backups', 'archive']);
const tasks = new TaskService();
const outputs = new OutputService();
const workspace = new WorkspaceService();

function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode: status });
}

/** A problem with one file, shown on its row; never a crash of the whole preview. */
class RowProblem extends Error {}

/**
 * Reads a file in pieces, hashing as it goes, and stops as soon as it holds more than `cap` bytes, so a file that grew
 * since its size was checked never costs more memory than allowed. `keep`: also return the bytes (for the ZIP).
 */
export async function readCapped(file: string, cap: number, keep: boolean): Promise<{ size: number; sha256: string; data: Buffer | null } | null> {
  const handle = await fsp.open(file, 'r');
  try {
    const hash = createHash('sha256');
    const chunks: Buffer[] = [];
    const chunk = Buffer.alloc(1024 * 1024);
    let size = 0;
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, size);
      if (bytesRead === 0) break;
      size += bytesRead;
      if (size > cap) return null;
      const piece = chunk.subarray(0, bytesRead);
      hash.update(piece);
      if (keep) chunks.push(Buffer.from(piece));
    }
    return { size, sha256: hash.digest('hex'), data: keep ? Buffer.concat(chunks, size) : null };
  } finally {
    await handle.close();
  }
}

function parseItems(raw: unknown): ShareItem[] {
  if (!Array.isArray(raw) || raw.length === 0) throw httpError(400, 'Choose at least one file.');
  if (raw.length > MAX_ITEMS) throw httpError(400, `A pack holds at most ${MAX_ITEMS} files.`);
  return raw.map((v) => {
    const o = v && typeof v === 'object' ? v as Record<string, unknown> : {};
    if (typeof o['task'] !== 'string' || !TASK_ID.test(o['task'])) throw httpError(400, 'Invalid task.');
    if (o['kind'] !== 'deliverable' && o['kind'] !== 'attachment') throw httpError(400, 'Invalid file kind.');
    if (typeof o['ref'] !== 'string' || !o['ref'] || o['ref'].length > 255) throw httpError(400, 'Invalid file.');
    return { task: o['task'], kind: o['kind'], ref: o['ref'] };
  });
}

/** A zip entry name: the file's base name, with nothing that could mean a folder or another path elsewhere. */
function safeBase(name: string): string {
  // eslint-disable-next-line no-control-regex -- matching control characters is the point here
  return path.posix.basename(name.replace(/\\/g, '/')).replace(/[\x00-\x1f:*?"<>|]/g, '_') || 'file';
}

/**
 * The task's folder as it is now (active or archived), reached through no link below the workspace, and the path of a
 * file inside it, relative to it. A deliverable's `file_path` must point into its own task's folder (saved while active
 * or after archiving); anything else, internal material or a dot file is refused.
 */
async function taskFile(ws: string, taskDir: string, inner: string): Promise<string> {
  const parts = inner.replace(/\\/g, '/').split('/');
  if (parts.some((p) => !p || p === '.' || p === '..' || p.startsWith('.'))) throw new RowProblem('Only files in the task\'s own folder can be shared.');
  // Compared without case: on macOS and Windows `TASK.MD` or `Executions/` are the same internal files.
  if (INTERNAL.has(parts[0]!.toLowerCase())) throw new RowProblem('Internal files of a task (its text, logs, notes, sources or backups) are never shared.');
  const full = path.join(taskDir, ...parts);
  // No link anywhere, in the folder or the file: what is zipped is exactly the file that sits there.
  await workspaceEntry(ws, full).catch(() => { throw new RowProblem('The file is missing or reached through a link.'); });
  const stat = await fsp.lstat(full).catch(() => null);
  if (!stat?.isFile()) throw new RowProblem('The file is missing.');
  return full;
}

function deliverableInner(filePath: string, taskId: string): string {
  const rel = filePath.replace(/\\/g, '/');
  for (const prefix of [`tasks/active/${taskId}/`, `tasks/archive/${taskId}/`]) {
    if (rel.startsWith(prefix)) return rel.slice(prefix.length);
  }
  throw new RowProblem('Its file is not in this task\'s folder, so it cannot be shared from here.');
}

async function resolve(items: ShareItem[]): Promise<{ rows: ShareRow[]; files: (string | null)[]; total: number }> {
  const ws = workspace.getWorkspacePath();
  const templateNames = new Map((await outputs.listTemplates().catch(() => [])).map((t) => [t.id, t.name] as const));
  const width = Math.max(2, String(items.length).length);
  const rows: ShareRow[] = [];
  const files: (string | null)[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const [i, item] of items.entries()) {
    const key = `${item.task}/${item.kind}/${item.ref}`;
    if (seen.has(key)) throw httpError(400, 'A file is chosen twice.');
    seen.add(key);
    const row: ShareRow = { task: item.task, task_title: '', confidentiality: null, kind: item.kind, ref: item.ref, template: null, source_name: safeBase(item.ref), zip_name: '', size: null, sha256: null, problem: null };
    let full: string | null;
    try {
      const task = await tasks.getTask(item.task).catch(() => { throw new RowProblem('This task cannot be read.'); }) as unknown as Record<string, unknown>;
      row.task_title = String(task['title'] ?? '');
      row.confidentiality = typeof task['confidentiality'] === 'string' ? task['confidentiality'] : null;
      const taskDir = path.dirname(String(task['path'] ?? ''));
      await workspaceEntry(ws, taskDir).catch(() => { throw new RowProblem('This task\'s folder is reached through a link.'); });
      let inner: string;
      if (item.kind === 'deliverable') {
        const d = (Array.isArray(task['deliverables']) ? task['deliverables'] : []).find((x: unknown) => (x as { id?: unknown })?.id === item.ref) as Record<string, unknown> | undefined;
        if (!d) throw new RowProblem('This deliverable is no longer on the task.');
        row.template = typeof d['template_ref'] === 'string' ? templateNames.get(d['template_ref']) ?? d['template_ref'] : null;
        if (typeof d['file_path'] !== 'string' || !d['file_path']) throw new RowProblem('This deliverable has no file yet.');
        row.source_name = safeBase(d['file_path']);
        inner = deliverableInner(d['file_path'], item.task);
      } else {
        // An attachment is a file directly in the task's folder.
        if (item.ref.includes('/') || item.ref.includes('\\')) throw new RowProblem('Only files attached to the task can be shared.');
        inner = item.ref;
      }
      full = await taskFile(ws, taskDir, inner);
      const stat = await fsp.stat(full);
      // Sizes first: a pack over the limit is refused before anything large is read.
      if (total + stat.size > MAX_ARCHIVE_BYTES) throw new RowProblem('The pack would be too large to download as one file.');
      const hashed = await readCapped(full, MAX_ARCHIVE_BYTES - total, false);
      if (!hashed) throw new RowProblem('The pack would be too large to download as one file.');
      row.size = hashed.size;
      row.sha256 = hashed.sha256;
      total += hashed.size;
    } catch (err) {
      if (!(err instanceof RowProblem)) throw err;
      row.problem = err.message;
      full = null;
    }
    row.zip_name = `${String(i + 1).padStart(width, '0')}-${row.source_name}`;
    rows.push(row);
    files.push(full);
  }
  return { rows, files, total };
}

/** The README the pack starts with: the reading order and where each file comes from. Nothing is made up. */
export function defaultReadme(rows: ShareRow[]): string {
  const lines = ['# Files in this pack', '', 'In reading order:', ''];
  for (const r of rows) {
    const from = [r.task_title || r.task, r.template].filter(Boolean).join(' · ');
    lines.push(`- \`${r.zip_name}\`: ${from}${r.confidentiality ? ` (marked ${r.confidentiality})` : ''}`);
  }
  return `${lines.join('\n')}\n`;
}

/** Exactly the files and versions previewed: what the download is held to. */
function tokenOf(rows: ShareRow[]): string {
  return createHash('sha256').update(JSON.stringify(rows.map((r) => [r.task, r.kind, r.ref, r.zip_name, r.size, r.sha256]))).digest('hex');
}

export async function previewSharePack(body: unknown): Promise<SharePreview> {
  const items = parseItems((body as Record<string, unknown> | undefined)?.['items']);
  const { rows, total } = await resolve(items);
  return { rows, readme: defaultReadme(rows), total_bytes: total, token: tokenOf(rows), ready: rows.every((r) => !r.problem) };
}

export async function buildSharePack(body: unknown): Promise<{ name: string; data: Buffer }> {
  const b = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const items = parseItems(b['items']);
  const readme = typeof b['readme'] === 'string' ? b['readme'] : '';
  if (Buffer.byteLength(readme, 'utf-8') > MAX_README) throw httpError(400, 'Keep the README under 64 KB.');
  const { rows, files, total } = await resolve(items);
  if (rows.some((r) => r.problem)) throw httpError(409, 'Some files cannot go in the pack. Preview again and remove them.');
  if (tokenOf(rows) !== b['token']) throw httpError(409, 'A file changed since the preview. Preview again before downloading.');
  const readmeBytes = Buffer.from(readme || defaultReadme(rows), 'utf-8');
  if (total + readmeBytes.length > MAX_ARCHIVE_BYTES) throw httpError(413, 'The pack is too large to download as one file.');
  const day = new Date().toISOString().slice(0, 10);
  const folder = `share-pack-${day}`;
  const entries: ZipEntry[] = [{ name: `${folder}/README.md`, data: readmeBytes, modified: new Date() }];
  for (const [i, row] of rows.entries()) {
    const full = files[i]!;
    // Never more than was previewed: reading stops past the previewed size, and the bytes must be the ones previewed.
    const read = await readCapped(full, row.size ?? 0, true);
    if (!read || read.size !== row.size || read.sha256 !== row.sha256 || !read.data) {
      throw httpError(409, 'A file changed while the pack was being made. Preview again.');
    }
    entries.push({ name: `${folder}/${row.zip_name}`, data: read.data, modified: new Date() });
  }
  return { name: `${folder}.zip`, data: buildZip(entries) };
}
