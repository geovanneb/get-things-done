import * as path from 'path';
import * as fsp from 'fs/promises';
import { createHash } from 'crypto';
import { constants as fsConstants } from 'fs';
import { Worker } from 'worker_threads';
import { WorkspaceService } from './workspace';
import { effectiveSensitivity } from './contextService';
import { parseMarkdown } from '../utils/markdown';
import { workspaceEntry } from '../utils/files';
import type { exportSection } from './contextShareExport';

/**
 * Share context notes as one Markdown file (#107). Only notes labelled `shareable` can be shared, checked here on
 * every call. The file holds each note's title and body, rebuilt from an explicit list of Markdown parts; everything
 * else (frontmatter, HTML and comments, images, link targets, footnotes, attachments, related notes, sources) is left
 * out, and a part this exporter does not know refuses the note rather than passing through as raw text.
 *
 * Preview, then download: the preview returns the exact text and a token (a hash of that text and of every note file
 * it came from). The download rebuilds the text and refuses it (409) unless the token is the same, so the bytes saved
 * are exactly the bytes previewed, and a note changed, moved or relabelled in between needs a new preview.
 *
 * Parsing runs in a worker thread with a deadline and a memory limit: a pathological note (deep nesting, long runs of
 * emphasis markers) is reported as too complex instead of stalling the dashboard.
 */

const workspace = new WorkspaceService();

const CATEGORIES = ['company', 'organization', 'strategy', 'programs', 'decisions', 'risks', 'glossary', 'situation'];
const MAX_NOTES = 50;
const MAX_NOTE_BYTES = 512 * 1024;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024;
const NOTE_ID = /^CTX-[a-z0-9][a-z0-9-]{0,120}$/;
/** Time one note may take to export, and one whole request. */
const NOTE_DEADLINE_MS = 3000;
const REQUEST_DEADLINE_MS = 20_000;

function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode: status });
}

/** Why a chosen note cannot be shared. The dashboard words each code in the user's language; `problem` is the English. */
export type ShareProblem = 'gone' | 'unreadable' | 'duplicate_id' | 'not_shareable' | 'invalid_label' | 'too_large_total'
  | 'too_complex' | 'unknown_part' | 'took_too_long';

const PROBLEMS: Record<ShareProblem, string> = {
  gone: 'This note is no longer there.',
  unreadable: 'This note could not be read (too large, reached through a link, or not a plain file).',
  duplicate_id: 'Two notes have this id; fix that before sharing.',
  not_shareable: 'Only notes labelled shareable can be shared.',
  invalid_label: 'Its sharing label is not one the app knows, so it is never shared.',
  too_large_total: 'The file would be too large; choose fewer notes.',
  too_complex: 'This note is too complex to export safely (very deep nesting or very long runs of markup).',
  unknown_part: 'It contains a part the export cannot handle safely.',
  took_too_long: 'Building the file took too long; choose fewer notes.',
};

class NoteProblem extends Error {
  constructor(readonly code: ShareProblem) { super(PROBLEMS[code]); }
}

interface FoundNote { id: string; file: string; title: string; body: string; label: unknown; sha256: string }

/** Reads a plain file reached through no link, without blocking on a pipe; null when it holds more than `cap` bytes. */
async function readPlain(ws: string, file: string, cap: number, firstBytesOnly = false): Promise<Buffer | null> {
  await workspaceEntry(ws, file);
  const before = await fsp.lstat(file);
  if (!before.isFile()) throw new NoteProblem('unreadable');
  const handle = await fsp.open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
  try {
    const stat = await handle.stat();
    // The same file that was looked at: not another one swapped in between.
    if (!stat.isFile() || stat.ino !== before.ino || stat.dev !== before.dev) throw new NoteProblem('unreadable');
    const buffer = Buffer.allocUnsafe(Math.min(stat.size, cap) + 1);
    let size = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
      if (bytesRead === 0) break;
      size += bytesRead;
      if (size === buffer.length) break;
    }
    if (firstBytesOnly) return buffer.subarray(0, Math.min(size, cap));
    // More than the cap, or grown since it was looked at: not read as a note.
    return size > Math.min(stat.size, cap) ? null : buffer.subarray(0, size);
  } finally {
    await handle.close();
  }
}

/** The id in a note's frontmatter, from its first bytes only: to name a note that could not be read in full. */
async function peekId(ws: string, file: string): Promise<string | null> {
  try {
    const head = await readPlain(ws, file, 64 * 1024, true);
    const source = head ? head.toString('utf-8') : '';
    return /^---\r?\n[\s\S]*?^id:\s*['"]?(CTX-[a-z0-9-]+)['"]?\s*$/m.exec(source)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Every chosen context note, read only (no folder is created or moved), through no link; ids of unreadable ones too. */
async function findNotes(ws: string, wanted: Set<string>): Promise<{ found: Map<string, FoundNote[]>; unreadable: Set<string>; anyUnreadable: boolean }> {
  const found = new Map<string, FoundNote[]>();
  const unreadable = new Set<string>();
  let anyUnreadable = false;
  const base = path.join(ws, 'context');
  for (const cat of CATEGORIES) {
    const dir = path.join(base, cat);
    let entries: import('fs').Dirent[];
    try {
      await workspaceEntry(ws, dir);
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const file = entry.isDirectory() ? path.join(dir, entry.name, 'note.md') : entry.isFile() && entry.name.endsWith('.md') ? path.join(dir, entry.name) : null;
      if (!file) continue;
      let parsed: { data: Record<string, unknown>; content: string } | null = null;
      let bytes: Buffer | null = null;
      try {
        bytes = await readPlain(ws, file, MAX_NOTE_BYTES);
        if (bytes) parsed = parseMarkdown(bytes.toString('utf-8')) as unknown as { data: Record<string, unknown>; content: string };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      }
      if (!parsed || !bytes) {
        if (entry.isDirectory() && !(await fsp.lstat(file).catch(() => null))) continue; // a folder without a note
        anyUnreadable = true;
        const id = await peekId(ws, file);
        if (id && wanted.has(id)) unreadable.add(id);
        continue;
      }
      const id = parsed.data['id'];
      if (typeof id !== 'string' || !wanted.has(id)) continue;
      found.set(id, [...(found.get(id) ?? []), {
        id, file, title: typeof parsed.data['title'] === 'string' ? parsed.data['title'] : 'Untitled', body: parsed.content,
        label: parsed.data['sensitivity'], sha256: createHash('sha256').update(bytes).digest('hex'),
      }]);
    }
  }
  return { found, unreadable, anyUnreadable };
}

type Section = ReturnType<typeof exportSection>;

/** Exports notes one by one in a worker thread; a note that runs past its deadline or memory is stopped. */
class ExportWorker {
  private worker: Worker | null = null;
  private readonly module = path.join(__dirname, `contextShareExport${path.extname(__filename)}`);

  private start(): Worker {
    // Built, the module is JavaScript. Under the test runner it is TypeScript: load it the way the tests do.
    const code = `const { parentPort, workerData } = require('worker_threads');
if (workerData.endsWith('.ts')) require('tsx/cjs');
const m = require(workerData);
parentPort.on('message', ({ title, body }) => {
  try { parentPort.postMessage(m.exportSection(title, body)); }
  catch (e) { parentPort.postMessage({ ok: false, code: 'too_complex', message: String(e && e.message) }); }
});`;
    this.worker = new Worker(code, {
      eval: true, workerData: this.module,
      resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 },
    });
    this.worker.unref();
    return this.worker;
  }

  async run(title: string, body: string, ms: number): Promise<Section> {
    const worker = this.worker ?? this.start();
    return new Promise<Section>((resolve) => {
      let settled = false;
      const finish = (result: Section, stop: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        worker.off('message', onMessage);
        worker.off('error', onError);
        worker.off('exit', onExit);
        if (stop) { this.worker = null; void worker.terminate(); }
        resolve(result);
      };
      const tooComplex: Section = { ok: false, code: 'too_complex', message: PROBLEMS.too_complex };
      const onMessage = (result: Section) => finish(result, false);
      const onError = () => finish(tooComplex, true); // out of memory, or a crash
      const onExit = () => finish(tooComplex, true);
      const timer = setTimeout(() => finish(tooComplex, true), ms);
      worker.on('message', onMessage);
      worker.once('error', onError);
      worker.once('exit', onExit);
      worker.postMessage({ title, body });
    });
  }

  async close(): Promise<void> {
    const worker = this.worker;
    this.worker = null;
    if (worker) await worker.terminate();
  }
}

export interface ShareRow { id: string; title: string; problem: string | null; code: ShareProblem | null }
export interface SharePreview { rows: ShareRow[]; text: string | null; token: string | null; file_name: string }

function request(body: unknown): { ids: string[]; day: string } {
  const b = (body ?? {}) as { notes?: unknown; day?: unknown };
  const notes = b.notes;
  if (!Array.isArray(notes) || notes.length === 0) throw httpError(400, 'Choose at least one note.');
  if (notes.length > MAX_NOTES) throw httpError(400, `Choose at most ${MAX_NOTES} notes.`);
  const ids = notes.map((n) => (typeof n === 'string' && NOTE_ID.test(n) ? n : null));
  if (ids.some((n) => n === null)) throw httpError(400, 'Not a context note id.');
  if (new Set(ids).size !== ids.length) throw httpError(400, 'A note is chosen twice.');
  // The file is named after the user's own day, which the dashboard sends; the server's day otherwise.
  const day = typeof b.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(b.day) ? b.day : new Date().toISOString().slice(0, 10);
  return { ids: ids as string[], day };
}

/** The text of the file, the rows (with a reason for each note that cannot be shared) and the token. */
async function build(body: unknown): Promise<SharePreview> {
  const { ids, day } = request(body);
  const ws = workspace.getWorkspacePath();
  const { found, unreadable, anyUnreadable } = await findNotes(ws, new Set(ids));
  const rows: ShareRow[] = [];
  const parts: string[] = [];
  const hashes: string[] = [];
  const exporter = new ExportWorker();
  const started = Date.now();
  let total = 0;
  try {
    for (const id of ids) {
      const matches = found.get(id) ?? [];
      const row: ShareRow = { id, title: matches[0]?.title ?? id, problem: null, code: null };
      try {
        if (matches.length === 0) throw new NoteProblem(unreadable.has(id) || anyUnreadable ? 'unreadable' : 'gone');
        if (matches.length > 1 || unreadable.has(id)) throw new NoteProblem('duplicate_id');
        const note = matches[0]!;
        const label = effectiveSensitivity(note.label);
        if (label !== 'shareable') throw new NoteProblem(label === 'invalid' ? 'invalid_label' : 'not_shareable');
        const left = REQUEST_DEADLINE_MS - (Date.now() - started);
        if (left <= 0) throw new NoteProblem('took_too_long');
        const section = await exporter.run(note.title, note.body, Math.min(NOTE_DEADLINE_MS, left));
        if (!section.ok) throw new NoteProblem(section.code);
        total += Buffer.byteLength(section.text, 'utf-8');
        if (total > MAX_TOTAL_BYTES) throw new NoteProblem('too_large_total');
        parts.push(section.text);
        hashes.push(`${note.id}\u0000${path.relative(ws, note.file)}\u0000${note.sha256}`);
      } catch (err) {
        if (!(err instanceof NoteProblem)) throw err;
        row.problem = err.message;
        row.code = err.code;
      }
      rows.push(row);
    }
  } finally {
    await exporter.close();
  }
  const fileName = `context-notes-${day}.md`;
  if (rows.some((r) => r.problem)) return { rows, text: null, token: null, file_name: fileName };
  const text = parts.join('\n\n---\n\n') + '\n';
  const token = createHash('sha256').update(text).update('\u0001').update(fileName).update('\u0001').update(hashes.join('\u0002')).digest('hex');
  return { rows, text, token, file_name: fileName };
}

/** What the file would hold, exactly; no token while any chosen note cannot be shared. */
export async function previewContextShare(body: unknown): Promise<SharePreview> {
  return build(body);
}

/** The file itself, only when it is exactly what was previewed (same notes, files, order and name). */
export async function downloadContextShare(body: unknown): Promise<{ name: string; text: string }> {
  const token = (body as { token?: unknown } | null)?.token;
  if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) throw httpError(400, 'Preview the file first.');
  const built = await build(body);
  if (!built.text || built.token !== token) {
    throw httpError(409, 'A note changed, moved or was relabelled since the preview. Preview again before downloading.');
  }
  return { name: built.file_name, text: built.text };
}
