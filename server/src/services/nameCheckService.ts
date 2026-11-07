import * as path from 'path';
import * as fsp from 'fs/promises';
import { createHash } from 'crypto';
import { TaskService } from './taskService';
import { WorkspaceService } from './workspace';
import { workspaceEntry } from '../utils/files';
import { parseMarkdown } from '../utils/markdown';
import { buildRegistry, checkText, glossaryTerms, proseOf, type Finding, type Registry } from './nameCheck';

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

/** The deliverable's file: in its own task's folder, no dot or internal part, no link, a checkable kind, not too large. */
async function deliverableFile(ws: string, taskId: string, deliverableId: string): Promise<{ taskDir: string; full: string; rel: string; kind: 'md' | 'html' | 'txt' }> {
  const task = await tasks.getTask(taskId).catch(() => { throw httpError(404, 'Task not found.'); }) as unknown as Record<string, unknown>;
  const taskDir = path.dirname(String(task['path'] ?? ''));
  const d = (Array.isArray(task['deliverables']) ? task['deliverables'] : []).find((x: unknown) => (x as { id?: unknown })?.id === deliverableId) as Record<string, unknown> | undefined;
  if (!d) throw httpError(404, 'This deliverable is not on the task.');
  const filePath = typeof d['file_path'] === 'string' ? d['file_path'].replace(/\\/g, '/') : '';
  if (!filePath) throw httpError(400, 'This deliverable has no file yet.');
  const kind = checkableKind(filePath);
  if (!kind) throw httpError(400, 'Only Markdown, HTML and text files can be checked.');
  const prefix = [`tasks/active/${taskId}/`, `tasks/archive/${taskId}/`].find((p) => filePath.startsWith(p));
  if (!prefix) throw httpError(400, 'Its file is not in this task\'s folder.');
  const parts = filePath.slice(prefix.length).split('/');
  if (parts.some((p) => !p || p === '.' || p === '..' || p.startsWith('.'))) throw httpError(400, 'Its file is not in this task\'s folder.');
  const full = path.join(taskDir, ...parts);
  await workspaceEntry(ws, full).catch(() => { throw httpError(400, 'The file is missing or reached through a link.'); });
  const stat = await fsp.lstat(full).catch(() => null);
  if (!stat?.isFile()) throw httpError(404, 'The file is missing.');
  if (stat.size > MAX_FILE_BYTES) throw httpError(413, 'The file is too large to check (over 2 MB).');
  return { taskDir, full, rel: filePath, kind };
}

async function readState(ws: string, taskDir: string): Promise<State> {
  const file = path.join(taskDir, STATE_FILE);
  try {
    await workspaceEntry(ws, file);
    const stat = await fsp.lstat(file);
    if (!stat.isFile() || stat.size > MAX_SOURCE_BYTES) throw new Error('unusable');
    const raw = JSON.parse(await fsp.readFile(file, 'utf-8')) as Partial<State>;
    const deliverables: State['deliverables'] = {};
    for (const [id, v] of Object.entries(raw.deliverables ?? {})) {
      if (!v || typeof v !== 'object') continue;
      deliverables[id] = {
        dismissed: Array.isArray(v.dismissed) ? v.dismissed.filter((k): k is string => typeof k === 'string') : [],
        ...(v.last && typeof v.last.sha256 === 'string' && Array.isArray(v.last.keys) ? { last: { sha256: v.last.sha256, keys: v.last.keys.filter((k): k is string => typeof k === 'string') } } : {}),
      };
    }
    return { version: 1, deliverables, history: Array.isArray(raw.history) ? raw.history.slice(-MAX_HISTORY) : [] };
  } catch {
    return { version: 1, deliverables: {}, history: [] };
  }
}

async function writeState(ws: string, taskDir: string, state: State): Promise<void> {
  const file = path.join(taskDir, STATE_FILE);
  await workspaceEntry(ws, file, true);
  const existing = await fsp.lstat(file).catch(() => null);
  if (existing && !existing.isFile()) throw httpError(409, 'The check\'s record in the task folder is not a plain file.');
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(temp, JSON.stringify(state, null, 2) + '\n', 'utf-8');
  await fsp.rename(temp, file);
}

/** Runs the check on one deliverable and records the run (findings shown, dismissed, fixed since the last run). */
export async function runNameCheck(taskId: string, deliverableId: string): Promise<NameCheckRun> {
  const ws = workspace.getWorkspacePath();
  const registry = await loadRegistry(ws);
  return tasks.underTaskLock(taskId, async () => {
    const { taskDir, full, rel, kind } = await deliverableFile(ws, taskId, deliverableId);
    const bytes = await fsp.readFile(full);
    const text = bytes.toString('utf-8');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const findings = checkText(text, proseOf(text, kind), registry);

    const state = await readState(ws, taskDir);
    const entry = state.deliverables[deliverableId] ?? { dismissed: [] };
    const dismissed = new Set(entry.dismissed);
    const keys = findings.map((f) => f.key);
    const fixed = entry.last && entry.last.sha256 !== sha256
      ? entry.last.keys.filter((k) => !dismissed.has(k) && !keys.includes(k)).length
      : 0;
    const checkedAt = new Date().toISOString();
    state.deliverables[deliverableId] = { dismissed: entry.dismissed, last: { sha256, keys } };
    state.history = [...state.history, {
      at: checkedAt, deliverable: deliverableId,
      shown: findings.filter((f) => !dismissed.has(f.key)).length,
      dismissed: findings.filter((f) => dismissed.has(f.key)).length,
      fixed,
    }].slice(-MAX_HISTORY);
    await writeState(ws, taskDir, state);
    return { deliverable: deliverableId, file: rel, checked_at: checkedAt, findings: findings.map((f) => ({ ...f, dismissed: dismissed.has(f.key) })) };
  });
}

/** Dismisses a finding for this deliverable (or brings it back). Changes nothing else. */
export async function setDismissed(taskId: string, deliverableId: string, body: unknown): Promise<{ dismissed: string[] }> {
  const b = (body ?? {}) as Record<string, unknown>;
  const key = b['key'];
  if (typeof key !== 'string' || !/^(person|abbreviation):/.test(key) || key.length > 300) throw httpError(400, 'Say which finding to dismiss.');
  if (typeof b['dismissed'] !== 'boolean') throw httpError(400, 'Say whether the finding is dismissed.');
  const ws = workspace.getWorkspacePath();
  return tasks.underTaskLock(taskId, async () => {
    const { taskDir } = await deliverableFile(ws, taskId, deliverableId);
    const state = await readState(ws, taskDir);
    const entry = state.deliverables[deliverableId] ?? { dismissed: [] };
    const set = new Set(entry.dismissed);
    if (b['dismissed']) set.add(key); else set.delete(key);
    entry.dismissed = [...set].slice(-1000);
    state.deliverables[deliverableId] = entry;
    await writeState(ws, taskDir, state);
    return { dismissed: entry.dismissed };
  });
}
