import * as path from 'path';
import * as fsp from 'fs/promises';
import { createHash } from 'crypto';
import { parseMarkdown } from '../utils/markdown';
import { safeFileName, workspaceEntry } from '../utils/files';
import { atomicWrite } from '../utils/atomicWrite';
import { hashFile } from '../utils/fileHash';
import { isDone } from './taskStatus';

/**
 * Accepted tasks for the weekly memory review (#80): the tasks the user accepted (moved to Done) since the switch was
 * turned on, gathered into the memory review's materials so the analysis can propose what the week's work changed.
 *
 * What was gathered is recorded outside any context update, because a finished update can be cleaned up:
 *
 *   .situation-board/routines/system-cleanup-accepted.json
 *   { since, last_gathered_at, tasks: { TASK-id: { accepted_at, gathered_at, update, files } } }
 *
 * Confidential and restricted tasks are never recorded, copied or named: each review counts the ones accepted since the
 * last review that gathered (`last_gathered_at`), and says only how many.
 *
 * A task is pending while its acceptance stamp (its done_date) is not the one recorded. Reopening clears the done_date
 * and accepting again writes a new one, so a re-accepted task is gathered once more, and an unchanged one never twice.
 * Nothing moves with the schedule: what is pending is worked out from the tasks and this record on every run, so a run
 * that cannot open a review (one is still open) loses nothing. A task is recorded only after the update holding its
 * copies is written, and until then the cleanup rules leave its folder alone (see `heldTaskIds`). A task with a file that
 * was too large to copy stays held until the review that lists it is finished: a hash is not a copy.
 */

/** At most this many tasks go into one review, oldest acceptance first; the rest wait for the next one. */
export const MAX_TASKS_PER_REVIEW = 30;
/** A file larger than this is listed with its hash, not copied. */
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
/** All copies of one review together. Files past this are listed with their hash, not copied. */
export const MAX_REVIEW_BYTES = 25 * 1024 * 1024;
/** The list the agent reads first. */
export const ACCEPTED_TASKS_FILE = 'accepted-tasks.md';

const LEDGER = 'system-cleanup-accepted.json';
const TASK_ID = /^TASK-\d{4}-\d{4}$/;
const CU_ID = /^CU-\d{4}-\d{4}$/;
const SHA256 = /^[0-9a-f]{64}$/;
/** Tasks marked like this never leave their folder through this job; only how many were left out is said. */
const LEFT_OUT = new Set(['confidential', 'restricted']);
/** A deliverable saved this long after the task was accepted is flagged: what is copied may not be what was accepted. */
const CHANGED_AFTER_MS = 60_000;

export interface GatheredFile {
  /** Its name in the update's materials; null when it was not copied. */
  name: string | null;
  /** Where it was, relative to the workspace. */
  source: string;
  sha256: string;
  bytes: number;
  copied: boolean;
}

export interface LedgerEntry {
  /** The acceptance this entry is about (the task's done_date as an ISO time). */
  accepted_at: string;
  gathered_at: string;
  /** The memory review that holds the copies. */
  update: string;
  files: GatheredFile[];
}

export interface AcceptedLedger {
  /** Acceptances before this are not gathered: the switch was turned on then. Null: nothing is gathered yet. */
  since: string | null;
  /** When the last review that gathered was opened: confidential tasks accepted since then are counted in the next. */
  last_gathered_at: string | null;
  tasks: Record<string, LedgerEntry>;
}

interface AcceptedTask {
  id: string;
  title: string;
  /** Folder of the task, relative to the workspace (`tasks/active/<id>` or `tasks/archive/<id>`). */
  folder: string;
  accepted_at: string;
  status: string;
  left_out: boolean;
  data: Record<string, unknown>;
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});

function when(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value !== 'string' || !value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function ledgerFile(ws: string): string {
  return path.join(ws, '.situation-board', 'routines', LEDGER);
}

/**
 * When the user accepted the task, or null when it is not accepted. Archiving keeps the done_date, so an archived task
 * counts by it; a legacy `approved` task without one counts from its last change.
 */
export function acceptanceStamp(data: Record<string, unknown>): string | null {
  const status = String(data['status'] ?? '');
  const date = isDone(status) ? when(data['done_date']) ?? when(data['updated_at'])
    : status === 'archived' ? when(data['done_date'])
      : null;
  return date ? date.toISOString() : null;
}

export function isLeftOut(data: Record<string, unknown>): boolean {
  return LEFT_OUT.has(String(data['confidentiality'] ?? '').toLowerCase());
}

/**
 * The record of what was gathered. A missing file is an empty record. A file that cannot be read is reported as
 * broken: nothing is gathered then (it could be gathered twice), and every accepted task is held from cleanup.
 */
export async function readLedger(ws: string): Promise<{ ledger: AcceptedLedger; broken: boolean }> {
  const empty: AcceptedLedger = { since: null, last_gathered_at: null, tasks: {} };
  let raw: string;
  try { raw = await fsp.readFile(ledgerFile(ws), 'utf-8'); } catch (err) {
    // Only a missing file is an empty record; anything else fails closed.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ledger: empty, broken: false };
    return { ledger: empty, broken: true };
  }
  try {
    return { ledger: parseLedger(JSON.parse(raw)), broken: false };
  } catch {
    return { ledger: empty, broken: true };
  }
}

const isTime = (v: unknown): v is string => typeof v === 'string' && when(v) !== null;

/** The whole record, checked: any other shape throws, so a damaged record never passes for an empty one. */
function parseLedger(input: unknown): AcceptedLedger {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('not an object');
  const o = input as Record<string, unknown>;
  if (!isTime(o['since'])) throw new Error('since');
  if (o['last_gathered_at'] !== null && o['last_gathered_at'] !== undefined && !isTime(o['last_gathered_at'])) throw new Error('last_gathered_at');
  const t = o['tasks'];
  if (!t || typeof t !== 'object' || Array.isArray(t)) throw new Error('tasks');
  const tasks: Record<string, LedgerEntry> = {};
  for (const [id, value] of Object.entries(t as Record<string, unknown>)) {
    const e = obj(value);
    if (!TASK_ID.test(id) || !isTime(e['accepted_at']) || !isTime(e['gathered_at']) || typeof e['update'] !== 'string' || !CU_ID.test(e['update'])) throw new Error(id);
    if (!Array.isArray(e['files'])) throw new Error(id);
    const files = e['files'].map((f) => {
      const x = obj(f);
      if ((x['name'] !== null && typeof x['name'] !== 'string') || typeof x['source'] !== 'string' || typeof x['sha256'] !== 'string' || !SHA256.test(x['sha256'])
        || typeof x['bytes'] !== 'number' || !Number.isInteger(x['bytes']) || x['bytes'] < 0 || typeof x['copied'] !== 'boolean') throw new Error(id);
      return { name: x['name'] as string | null, source: x['source'], sha256: x['sha256'], bytes: x['bytes'], copied: x['copied'] };
    });
    tasks[id] = { accepted_at: e['accepted_at'], gathered_at: e['gathered_at'], update: e['update'], files };
  }
  return { since: o['since'], last_gathered_at: (o['last_gathered_at'] as string | null | undefined) ?? null, tasks };
}

async function writeLedger(ws: string, ledger: AcceptedLedger): Promise<void> {
  await fsp.mkdir(path.dirname(ledgerFile(ws)), { recursive: true });
  await atomicWrite(ledgerFile(ws), JSON.stringify(ledger, null, 2));
}

/** Gathering starts from `now`: called when the switch is turned on. What was recorded before is kept. */
export async function startGathering(ws: string, now: Date): Promise<void> {
  const { ledger, broken } = await readLedger(ws);
  if (broken) throw new Error(`The record of gathered tasks (.situation-board/routines/${LEDGER}) cannot be read; fix or remove it first`);
  await writeLedger(ws, { ...ledger, since: now.toISOString() });
}

/** Every accepted task in the workspace, active or archived, as its task.md says now. Links are never followed. */
async function acceptedTasks(ws: string): Promise<AcceptedTask[]> {
  const found: AcceptedTask[] = [];
  for (const folder of ['active', 'archive']) {
    const dir = path.join(ws, 'tasks', folder);
    for (const entry of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory() || !TASK_ID.test(entry.name)) continue;
      const file = path.join(dir, entry.name, 'task.md');
      try {
        await workspaceEntry(ws, file);
        const data = obj(parseMarkdown(await fsp.readFile(file, 'utf-8')).data);
        const stamp = acceptanceStamp(data);
        if (!stamp) continue;
        found.push({
          id: entry.name, title: String(data['title'] ?? '').replace(/\s+/g, ' ').trim().slice(0, 200),
          folder: `tasks/${folder}/${entry.name}`, accepted_at: stamp, status: String(data['status'] ?? ''), left_out: isLeftOut(data), data,
        });
      } catch {
        // An unreadable task, or one reached through a link, is not gathered.
      }
    }
  }
  return found;
}

/** Whether a review is not finished: it exists and is not done. One that cannot be read counts as not finished. */
async function reviewOpen(ws: string, id: string): Promise<boolean> {
  if (!CU_ID.test(id)) return false;
  let raw: string;
  try { raw = await fsp.readFile(path.join(ws, 'context-updates', id, 'update.md'), 'utf-8'); } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ENOENT';
  }
  try { return obj(parseMarkdown(raw).data)['status'] !== 'done'; } catch { return true; }
}

/** Accepted since `since` and not recorded with this acceptance, oldest first. */
function pendingOf(tasks: AcceptedTask[], ledger: AcceptedLedger): AcceptedTask[] {
  if (!ledger.since) return [];
  const since = Date.parse(ledger.since);
  return tasks
    .filter((t) => Date.parse(t.accepted_at) >= since && ledger.tasks[t.id]?.accepted_at !== t.accepted_at)
    .sort((a, b) => a.accepted_at.localeCompare(b.accepted_at) || a.id.localeCompare(b.id));
}

/** Whether one task, as its task.md says now, still waits to be gathered. */
export function isPending(id: string, data: Record<string, unknown>, ledger: AcceptedLedger, broken: boolean): boolean {
  const stamp = acceptanceStamp(data);
  if (!stamp || isLeftOut(data)) return false;
  if (broken) return true;
  if (!ledger.since || Date.parse(stamp) < Date.parse(ledger.since)) return false;
  return ledger.tasks[id]?.accepted_at !== stamp;
}

/**
 * Whether the cleanup rules must leave one task alone: it waits to be gathered, or it was gathered with a file too large
 * to copy and the review listing that file is not finished yet (the original is the only copy).
 */
export async function isHeld(ws: string, id: string, data: Record<string, unknown>, ledger: AcceptedLedger, broken: boolean): Promise<boolean> {
  if (isPending(id, data, ledger, broken)) return true;
  const entry = ledger.tasks[id];
  const stamp = acceptanceStamp(data);
  if (!entry || !stamp || entry.accepted_at !== stamp || !entry.files.some((f) => !f.copied)) return false;
  return reviewOpen(ws, entry.update);
}

/**
 * The tasks the cleanup rules must leave alone (see `isHeld`). With a record that cannot be read, every accepted task
 * is held. A left-out task is never copied, so it is never held.
 */
export async function heldTaskIds(ws: string): Promise<Set<string>> {
  const { ledger, broken } = await readLedger(ws);
  const held = new Set<string>();
  for (const t of await acceptedTasks(ws)) if (await isHeld(ws, t.id, t.data, ledger, broken)) held.add(t.id);
  return held;
}

export interface Gathering {
  /** accepted-tasks.md and the copies, ready to be saved into the update's materials. */
  files: { name: string; data: Buffer }[];
  /** What to record once the update is written. */
  entries: Record<string, LedgerEntry>;
  gathered: number;
  leftOut: number;
  /** Pending tasks past the per-review cap. */
  waiting: number;
  gatheredAt: string;
}

/** How many accepted tasks wait now (not counting left-out ones). Null when the record cannot be read. */
export async function pendingCount(ws: string): Promise<number | null> {
  const { ledger, broken } = await readLedger(ws);
  if (broken) return null;
  return pendingOf(await acceptedTasks(ws), ledger).filter((t) => !t.left_out).length;
}

/** Whether the task's file still says what it said when it was listed: accepted at the same time, and not left out. */
async function stillAccepted(ws: string, t: AcceptedTask): Promise<boolean> {
  try {
    const file = path.join(ws, ...t.folder.split('/'), 'task.md');
    await workspaceEntry(ws, file);
    const data = obj(parseMarkdown(await fsp.readFile(file, 'utf-8')).data);
    return acceptanceStamp(data) === t.accepted_at && !isLeftOut(data);
  } catch {
    return false;
  }
}

/** The files of a task worth reading: its task.md, its deliverables in its own folder, its latest execution log. */
async function sourcesOf(ws: string, t: AcceptedTask): Promise<{ label: string; rel: string; deliverable: boolean }[]> {
  const out: { label: string; rel: string; deliverable: boolean }[] = [{ label: 'the task', rel: `${t.folder}/task.md`, deliverable: false }];
  const seen = new Set(out.map((s) => s.rel));
  for (const value of Array.isArray(t.data['deliverables']) ? t.data['deliverables'] : []) {
    const d = obj(value);
    const filePath = typeof d['file_path'] === 'string' ? d['file_path'].replace(/\\/g, '/') : '';
    // Only a file in the task's own folder: a deliverable saved while active keeps its active path after archiving.
    const inner = [`tasks/active/${t.id}/`, `tasks/archive/${t.id}/`].map((p) => (filePath.startsWith(p) ? filePath.slice(p.length) : null)).find((x) => x !== null);
    if (!inner || inner.split('/').some((p) => !p || p === '.' || p === '..' || p.startsWith('.'))) continue;
    const rel = `${t.folder}/${inner}`;
    if (seen.has(rel)) continue;
    seen.add(rel);
    out.push({ label: `deliverable ${typeof d['id'] === 'string' && d['id'] ? d['id'] : '(no id)'}`, rel, deliverable: true });
  }
  const logs = (await fsp.readdir(path.join(ws, t.folder, 'executions'), { withFileTypes: true }).catch(() => []))
    .filter((e) => e.isFile() && e.name.endsWith('.md') && !e.name.startsWith('.')).map((e) => e.name).sort();
  if (logs.length) out.push({ label: 'the latest execution log', rel: `${t.folder}/executions/${logs[logs.length - 1]}`, deliverable: false });
  return out;
}

function sizeText(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Reads the pending tasks' files into memory (within the caps) and writes the list the agent reads first. Nothing is
 * changed on disk: the caller saves the files into the new update and then calls `recordGathered`.
 */
export async function gatherAccepted(ws: string, now: Date, date: string): Promise<Gathering | null> {
  const { ledger, broken } = await readLedger(ws);
  if (broken) throw new Error(`The record of gathered tasks (.situation-board/routines/${LEDGER}) cannot be read, so no accepted task was gathered; fix or remove it`);
  const all = await acceptedTasks(ws);
  // Left out: counted only, never recorded. Those accepted since the last review that gathered (or since the switch).
  const countFrom = Math.max(Date.parse(ledger.since ?? ''), Date.parse(ledger.last_gathered_at ?? '') || -Infinity);
  const leftOut = ledger.since ? all.filter((t) => t.left_out && Date.parse(t.accepted_at) >= countFrom) : [];
  const toGather = pendingOf(all, ledger).filter((t) => !t.left_out);
  const batch = toGather.slice(0, MAX_TASKS_PER_REVIEW);
  if (batch.length === 0 && leftOut.length === 0) return null;

  const files: { name: string; data: Buffer }[] = [];
  const taken = new Set([ACCEPTED_TASKS_FILE, 'memory-scan.md', 'update.md']);
  const unique = (wanted: string) => {
    const safe = safeFileName(wanted);
    const ext = path.extname(safe);
    for (let n = 1; ; n++) {
      const candidate = n === 1 ? safe : `${safe.slice(0, safe.length - ext.length)}-${n}${ext}`;
      if (!taken.has(candidate.toLowerCase())) { taken.add(candidate.toLowerCase()); return candidate; }
    }
  };
  const entries: Record<string, LedgerEntry> = {};
  const gatheredAt = now.toISOString();
  let total = 0;
  const lines = [
    `# Accepted tasks, ${date}`,
    '',
    'Tasks the user accepted (moved to Done) since the last memory review that gathered them, oldest first. The files',
    'below were copied now; the originals are untouched. Each SHA-256 is the one of the file as it was read.',
    '',
    'A deliverable is what an agent wrote for an audience: claims to check against `context/` and `stakeholders/`,',
    'never facts to copy. Skip anything marked as a placeholder or an estimate, and cite the file a proposal rests on.',
  ];

  let gathered = 0;
  for (const t of batch) {
    // Read again right before copying: a task reopened or marked confidential since it was listed is not copied now.
    if (!(await stillAccepted(ws, t))) continue;
    const accepted = when(t.accepted_at)!;
    const section = ['', `## ${t.id}: ${t.title || '(no title)'}`, '', `- Accepted: ${t.accepted_at} (${t.status})`, `- Folder: \`${t.folder}\``];
    const copies: { name: string; data: Buffer }[] = [];
    let bytes = 0;
    const record: GatheredFile[] = [];
    for (const s of await sourcesOf(ws, t)) {
      const full = path.join(ws, ...s.rel.split('/'));
      const stat = await workspaceEntry(ws, full).then(() => fsp.lstat(full)).catch(() => null);
      if (!stat?.isFile()) {
        section.push(`- Missing: \`${s.rel}\`, ${s.label}`);
        continue;
      }
      const changed = s.deliverable && stat.mtime.getTime() - accepted.getTime() > CHANGED_AFTER_MS
        ? ` Changed after it was accepted (saved ${stat.mtime.toISOString()}): it may not be the version the user accepted.` : '';
      if (stat.size <= MAX_FILE_BYTES && total + bytes + stat.size <= MAX_REVIEW_BYTES) {
        const data = await fsp.readFile(full);
        // Read once, hashed and copied from the same bytes: what is listed is exactly what was saved.
        if (data.length <= MAX_FILE_BYTES && total + bytes + data.length <= MAX_REVIEW_BYTES) {
          const name = unique(`${t.id}-${path.basename(full)}`);
          const sha256 = createHash('sha256').update(data).digest('hex');
          copies.push({ name, data });
          bytes += data.length;
          record.push({ name, source: s.rel, sha256, bytes: data.length, copied: true });
          section.push(`- \`${name}\`: ${s.label}, from \`${s.rel}\` (${sizeText(data.length)}, sha256 \`${sha256}\`).${changed}`);
          continue;
        }
      }
      const { sha256, size } = await hashFile(full);
      const why = size > MAX_FILE_BYTES ? `over the ${sizeText(MAX_FILE_BYTES)} limit per file` : `over the ${sizeText(MAX_REVIEW_BYTES)} limit per review`;
      record.push({ name: null, source: s.rel, sha256, bytes: size, copied: false });
      section.push(`- Not copied: \`${s.rel}\`, ${s.label} (${sizeText(size)}, ${why}; sha256 \`${sha256}\`). Read it in place if needed${t.folder.startsWith('tasks/active/') ? ` (under \`tasks/archive/${t.id}/\` once archived)` : ''}; the task is kept until this review is finished.${changed}`);
    }
    // Changed while it was being read: left for the next review, nothing of it is listed now.
    if (!(await stillAccepted(ws, t))) continue;
    lines.push(...section);
    files.push(...copies);
    total += bytes;
    gathered++;
    entries[t.id] = { accepted_at: t.accepted_at, gathered_at: gatheredAt, update: '', files: record };
  }
  if (gathered === 0) lines.push('', 'No task to read this time.');
  if (leftOut.length) {
    lines.push('', '## Left out', '', `${leftOut.length} accepted task${leftOut.length === 1 ? ' was' : 's were'} left out because ${leftOut.length === 1 ? 'it is' : 'they are'} marked confidential or restricted. Do not look for ${leftOut.length === 1 ? 'it' : 'them'}.`);
  }
  const waiting = toGather.length - batch.length;
  if (waiting) lines.push('', '## Waiting', '', `${waiting} more accepted task${waiting === 1 ? ' waits' : 's wait'} for the next memory review (at most ${MAX_TASKS_PER_REVIEW} per review).`);
  files.unshift({ name: ACCEPTED_TASKS_FILE, data: Buffer.from(lines.join('\n') + '\n', 'utf-8') });
  return { files, entries, gathered, leftOut: leftOut.length, waiting, gatheredAt };
}

/**
 * Records the gathered tasks once their update is written. Read again first, so a switch turned on meanwhile keeps
 * its `since`; entries of tasks that no longer exist are dropped, which keeps the record as small as the workspace.
 */
export async function recordGathered(ws: string, gathering: Gathering, update: string): Promise<void> {
  const { ledger, broken } = await readLedger(ws);
  if (broken) throw new Error(`The record of gathered tasks (.situation-board/routines/${LEDGER}) cannot be read`);
  const tasks: Record<string, LedgerEntry> = {};
  const merged = { ...ledger.tasks, ...Object.fromEntries(Object.entries(gathering.entries).map(([id, e]) => [id, { ...e, update }])) };
  for (const [id, entry] of Object.entries(merged)) {
    const there = await Promise.all(['active', 'archive'].map((f) => fsp.lstat(path.join(ws, 'tasks', f, id, 'task.md')).then(() => true, () => false)));
    if (there.some(Boolean)) tasks[id] = entry;
  }
  await writeLedger(ws, { since: ledger.since, last_gathered_at: gathering.gatheredAt, tasks });
}
