import * as path from 'path';
import * as fsp from 'fs/promises';
import { createHash, randomUUID } from 'crypto';
import { constants as fsConstants } from 'fs';
import { TaskService } from './taskService';
import { WorkspaceService } from './workspace';
import { workspaceEntry } from '../utils/files';
import { parseMarkdown } from '../utils/markdown';
import { buildRegistry, checkTextFull, glossaryTerms, MAX_FINDINGS, proseOf, type Finding, type Registry } from './nameCheck';

/**
 * Advisory name and term check of a deliverable's Markdown, HTML or text file (#85). Reads the stakeholders and the
 * glossary as they are, never changes them, the deliverable or task.md. What the user dismissed and a short history
 * of runs (to see whether the check is useful) are kept in a hidden file in the task's folder.
 */

const tasks = new TaskService();
const workspace = new WorkspaceService();

const STATE_FILE = '.name-check.json';
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_SOURCE_BYTES = 512 * 1024;
const MAX_STATE_BYTES = 1024 * 1024;
const MAX_DISMISSED = 1000;
/** Deliverable ids as the task schema allows them; never a key like `__proto__`. */
const DELIVERABLE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const MAX_HISTORY = 100;
const KINDS: Record<string, 'md' | 'html' | 'txt'> = { '.md': 'md', '.markdown': 'md', '.html': 'html', '.htm': 'html', '.txt': 'txt' };

function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode: status });
}

export interface NameCheckRun {
  deliverable: string;
  file: string;
  checked_at: string;
  findings: Array<Finding & { dismissed: boolean }>;
  /** How many findings there were in all; more than listed when the file had over MAX_FINDINGS. */
  total: number;
  /** An archived task is only read: the run is not recorded and nothing can be dismissed. */
  recorded: boolean;
}

interface DeliverableState { dismissed: string[]; last?: { sha256: string; keys: string[] } }
interface State {
  version: 1;
  deliverables: Record<string, DeliverableState>;
  /** One row per run: findings shown, dismissed, and fixed (gone after the file changed). */
  history: Array<{ at: string; deliverable: string; shown: number; dismissed: number; fixed: number }>;
}

/** The kind of file the check reads, from its name; null for anything else (Office files, PDFs, images). */
export function checkableKind(filePath: string): 'md' | 'html' | 'txt' | null {
  return KINDS[path.extname(filePath).toLowerCase()] ?? null;
}

/** A small Markdown file in the workspace, read only when it is a plain file reached through no link. */
async function readSource(ws: string, file: string): Promise<{ data: Record<string, unknown>; content: string } | null> {
  try {
    await workspaceEntry(ws, file);
    const stat = await fsp.lstat(file);
    if (!stat.isFile() || stat.size > MAX_SOURCE_BYTES) return null;
    const parsed = parseMarkdown(await fsp.readFile(file, 'utf-8'));
    return { data: parsed.data as Record<string, unknown>, content: parsed.content };
  } catch {
    return null;
  }
}

async function plainEntries(ws: string, dir: string): Promise<import('fs').Dirent[]> {
  try {
    await workspaceEntry(ws, dir);
    return await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Known names and terms: stakeholder names and organizations, and the glossary (one note per term, or many terms as headings). */
export async function loadRegistry(ws = workspace.getWorkspacePath()): Promise<Registry> {
  const names: string[] = [];
  const organizations: string[] = [];
  const terms: string[] = [];
  for (const kind of ['people', 'groups']) {
    const dir = path.join(ws, 'stakeholders', kind);
    for (const entry of await plainEntries(ws, dir)) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const source = await readSource(ws, path.join(dir, entry.name));
      if (!source) continue;
      const { name, organization } = source.data;
      if (typeof name === 'string') (kind === 'people' ? names : terms).push(name);
      if (typeof organization === 'string') organizations.push(organization);
    }
  }
  const glossary = path.join(ws, 'context', 'glossary');
  for (const entry of await plainEntries(ws, glossary)) {
    const file = entry.isDirectory() ? path.join(glossary, entry.name, 'note.md') : entry.isFile() && entry.name.endsWith('.md') ? path.join(glossary, entry.name) : null;
    if (!file) continue;
    const source = await readSource(ws, file);
    if (source) terms.push(...glossaryTerms(typeof source.data['title'] === 'string' ? source.data['title'] : undefined, source.content));
  }
  return buildRegistry({ names, organizations, terms });
}

interface ResolvedDeliverable { taskDir: string; archived: boolean; filePath: string }

/** The task and its deliverable, without touching the file: enough to dismiss a finding. */
async function resolveDeliverable(ws: string, taskId: string, deliverableId: string): Promise<ResolvedDeliverable> {
  if (!DELIVERABLE_ID.test(deliverableId)) throw httpError(400, 'Not a deliverable id.');
  const task = await tasks.getTask(taskId).catch(() => { throw httpError(404, 'Task not found.'); }) as unknown as Record<string, unknown>;
  const taskDir = path.dirname(String(task['path'] ?? ''));
  await workspaceEntry(ws, taskDir).catch(() => { throw httpError(400, 'This task\'s folder is reached through a link.'); });
  const d = (Array.isArray(task['deliverables']) ? task['deliverables'] : []).find((x: unknown) => (x as { id?: unknown })?.id === deliverableId) as Record<string, unknown> | undefined;
  if (!d) throw httpError(404, 'This deliverable is not on the task.');
  const archived = path.basename(path.dirname(taskDir)) === 'archive';
  return { taskDir, archived, filePath: typeof d['file_path'] === 'string' ? d['file_path'].replace(/\\/g, '/') : '' };
}

/** The deliverable's file: in its own task's folder, no dot, stream or climbing part, no link, a checkable kind. */
async function deliverableFile(ws: string, taskId: string, resolved: ResolvedDeliverable): Promise<{ full: string; kind: 'md' | 'html' | 'txt' }> {
  const filePath = resolved.filePath;
  if (!filePath) throw httpError(400, 'This deliverable has no file yet.');
  const kind = checkableKind(filePath);
  if (!kind) throw httpError(400, 'Only Markdown, HTML and text files can be checked.');
  const prefix = [`tasks/active/${taskId}/`, `tasks/archive/${taskId}/`].find((p) => filePath.startsWith(p));
  if (!prefix) throw httpError(400, 'Its file is not in this task\'s folder.');
  const parts = filePath.slice(prefix.length).split('/');
  if (parts.some((p) => !p || p === '.' || p === '..' || p.startsWith('.') || p.includes(':'))) throw httpError(400, 'Its file is not in this task\'s folder.');
  const full = path.join(resolved.taskDir, ...parts);
  await workspaceEntry(ws, full).catch(() => { throw httpError(400, 'The file is missing or reached through a link.'); });
  return { full, kind };
}

/** Reads a file without following a link at its last step, and never more than `cap` bytes (null when larger). */
async function readNoFollow(file: string, cap: number): Promise<Buffer | null> {
  // A plain file only: a pipe or device would block the open itself, so look first, and open without blocking.
  const before = await fsp.lstat(file);
  if (!before.isFile()) throw Object.assign(new Error('Not a plain file.'), { code: 'ENOTFILE' });
  const handle = await fsp.open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
  try {
    if (!(await handle.stat()).isFile()) throw Object.assign(new Error('Not a plain file.'), { code: 'ENOTFILE' });
    const buffer = Buffer.alloc(cap + 1);
    let size = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
      if (bytesRead === 0) break;
      size += bytesRead;
      if (size > cap) return null;
    }
    return buffer.subarray(0, size);
  } finally {
    await handle.close();
  }
}

function emptyState(): State {
  return { version: 1, deliverables: Object.create(null) as State['deliverables'], history: [] };
}

/**
 * The record in the task folder. Missing: a fresh one. Present but unreadable (damaged, too large, not a plain file):
 * it is set aside as `.name-check.json.bad-<time>` before anything new is written, never overwritten silently.
 */
async function readState(ws: string, taskDir: string, setAsideBad: boolean): Promise<State> {
  const file = path.join(taskDir, STATE_FILE);
  await workspaceEntry(ws, file, true).catch(() => { throw httpError(409, 'The check\'s record in the task folder is reached through a link.'); });
  let bytes: Buffer | null;
  try {
    bytes = await readNoFollow(file, MAX_STATE_BYTES);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return emptyState();
    if (code === 'ENOTFILE' || code === 'ELOOP') throw httpError(409, 'The check\'s record in the task folder is not a plain file.');
    // Busy, locked or not allowed right now (a sync tool, antivirus): leave the record as it is and try later.
    throw httpError(503, 'The check\'s record in the task folder cannot be read right now. Try again in a moment.');
  }
  let raw: Partial<State> | null;
  try {
    raw = bytes ? JSON.parse(bytes.toString('utf-8')) as Partial<State> : null;
  } catch {
    raw = null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    // Damaged or too large: set aside, never overwritten silently.
    if (setAsideBad) await fsp.rename(file, `${file}.bad-${Date.now()}`).catch(() => { throw httpError(409, 'The check\'s record in the task folder cannot be read or set aside.'); });
    return emptyState();
  }
  const state = emptyState();
  for (const [id, v] of Object.entries(raw.deliverables ?? {})) {
    if (!DELIVERABLE_ID.test(id) || !v || typeof v !== 'object') continue;
    state.deliverables[id] = {
      dismissed: Array.isArray(v.dismissed) ? v.dismissed.filter((k): k is string => typeof k === 'string').slice(-MAX_DISMISSED) : [],
      ...(v.last && typeof v.last.sha256 === 'string' && Array.isArray(v.last.keys)
        ? { last: { sha256: v.last.sha256, keys: v.last.keys.filter((k): k is string => typeof k === 'string').slice(0, MAX_FINDINGS) } } : {}),
    };
  }
  state.history = Array.isArray(raw.history) ? raw.history.filter((h) => h && typeof h === 'object').slice(-MAX_HISTORY) : [];
  return state;
}

/** Writes the record through a new, uniquely named temporary file (never an existing one), then renames it in place. */
async function writeState(ws: string, taskDir: string, state: State): Promise<void> {
  const file = path.join(taskDir, STATE_FILE);
  await workspaceEntry(ws, file, true);
  const existing = await fsp.lstat(file).catch(() => null);
  if (existing && !existing.isFile()) throw httpError(409, 'The check\'s record in the task folder is not a plain file.');
  const temp = path.join(taskDir, `.name-check.${randomUUID()}.tmp`);
  try {
    await fsp.writeFile(temp, JSON.stringify(state, null, 2) + '\n', { encoding: 'utf-8', flag: 'wx' });
    await fsp.rename(temp, file);
  } catch (err) {
    await fsp.rm(temp, { force: true }).catch(() => undefined);
    throw err;
  }
}

/**
 * Runs the check on one deliverable. The file is read and checked outside the task's lock; only recording the run
 * (findings shown, dismissed, fixed since the last run) takes it. An archived task is only read, never written.
 */
export async function runNameCheck(taskId: string, deliverableId: string): Promise<NameCheckRun> {
  const ws = workspace.getWorkspacePath();
  const resolved = await resolveDeliverable(ws, taskId, deliverableId);
  const { full, kind } = await deliverableFile(ws, taskId, resolved);
  const bytes = await readNoFollow(full, MAX_FILE_BYTES).catch((err) => {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw httpError(404, 'The file is missing.');
    throw httpError(400, 'The file is not a plain file, or is reached through a link.');
  });
  if (!bytes) throw httpError(413, 'The file is too large to check (over 2 MB).');
  const text = bytes.toString('utf-8').normalize('NFC');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const registry = await loadRegistry(ws);
  const { findings, total } = checkTextFull(text, proseOf(text, kind), registry);
  const checkedAt = new Date().toISOString();
  const result = (dismissed: Set<string>, recorded: boolean): NameCheckRun => ({
    deliverable: deliverableId, file: resolved.filePath, checked_at: checkedAt, total, recorded,
    findings: findings.map((f) => ({ ...f, dismissed: dismissed.has(f.key) })),
  });
  if (resolved.archived) {
    const state = await readState(ws, resolved.taskDir, false);
    return result(new Set(state.deliverables[deliverableId]?.dismissed ?? []), false);
  }
  return tasks.underTaskLock(taskId, async () => {
    const state = await readState(ws, resolved.taskDir, true);
    const entry = state.deliverables[deliverableId] ?? { dismissed: [] };
    const dismissed = new Set(entry.dismissed);
    const keys = new Set(findings.map((f) => f.key));
    const fixed = entry.last && entry.last.sha256 !== sha256 && total <= MAX_FINDINGS
      ? entry.last.keys.filter((k) => !dismissed.has(k) && !keys.has(k)).length
      : 0;
    state.deliverables[deliverableId] = { dismissed: entry.dismissed, last: { sha256, keys: [...keys] } };
    state.history = [...state.history, {
      at: checkedAt, deliverable: deliverableId,
      shown: findings.filter((f) => !dismissed.has(f.key)).length,
      dismissed: findings.filter((f) => dismissed.has(f.key)).length,
      fixed,
    }].slice(-MAX_HISTORY);
    await writeState(ws, resolved.taskDir, state);
    return result(dismissed, true);
  });
}

/** Dismisses a finding for this deliverable (or brings it back). Needs only the task and the deliverable, not its file. */
export async function setDismissed(taskId: string, deliverableId: string, body: unknown): Promise<{ dismissed: string[] }> {
  const b = (body ?? {}) as Record<string, unknown>;
  const key = b['key'];
  if (typeof key !== 'string' || !/^(person|abbreviation):/.test(key) || key.length > 300) throw httpError(400, 'Say which finding to dismiss.');
  if (typeof b['dismissed'] !== 'boolean') throw httpError(400, 'Say whether the finding is dismissed.');
  const ws = workspace.getWorkspacePath();
  const resolved = await resolveDeliverable(ws, taskId, deliverableId);
  if (resolved.archived) throw httpError(409, 'This task is archived: its checks are kept as they are.');
  return tasks.underTaskLock(taskId, async () => {
    const state = await readState(ws, resolved.taskDir, true);
    const entry = state.deliverables[deliverableId] ?? { dismissed: [] };
    const set = new Set(entry.dismissed);
    if (b['dismissed']) set.add(key); else set.delete(key);
    entry.dismissed = [...set].slice(-MAX_DISMISSED);
    state.deliverables[deliverableId] = entry;
    await writeState(ws, resolved.taskDir, state);
    return { dismissed: entry.dismissed };
  });
}
