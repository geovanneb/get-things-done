import * as path from 'path';
import { randomUUID } from 'crypto';
import * as fsp from 'fs/promises';
import { WorkspaceService } from './workspace';
import { TaskService } from './taskService';
import { parseMarkdown, stringifyMarkdown } from '../utils/markdown';
import { atomicWrite } from '../utils/atomicWrite';
import { fileInside } from '../utils/files';
import {
  Schedule, ScheduleError, addDays, describeSchedule, isDateOnly, localDate, nextOccurrences, occurrencesBetween, parseSchedule,
} from './routineSchedule';

const workspaceService = new WorkspaceService();
const taskService = new TaskService();

/**
 * Routines: things that should happen on a schedule, such as a task that has to be on the
 * backlog every other Monday.
 *
 *   routines/RT-NNNN.md                    the routine: schedule + task template (frontmatter), task body (Markdown)
 *   .situation-board/routines/state.json   when each routine was last checked and what happened
 *   .situation-board/routines/runs.jsonl   run history, newest last, capped
 *   .situation-board/routines/run.lock     held while a run is in progress, by any process
 *
 * Nothing here relies on a timer firing at the right moment. Every trigger (the server starting,
 * its once-a-minute tick, `gtd routines run` from the OS scheduler or a terminal) asks the same
 * question: which occurrences fell between the last check and now? That is what lets routines catch
 * up after the computer was asleep or off, or the dashboard was not running.
 *
 * Each created task records its routine and occurrence (`routine_ref`, `routine_occurrence`).
 * Runs check those markers before creating tasks; a local lock coordinates this engine's writers.
 * File synchronization between machines is not a distributed lock: run the scheduler on one host.
 */

export const CATCH_UP_POLICIES = ['latest', 'all', 'skip'] as const;
export type CatchUpPolicy = (typeof CATCH_UP_POLICIES)[number];
export type RunTrigger = 'startup' | 'timer' | 'cli' | 'scheduler' | 'manual';

const TASK_STATUSES = ['backlog', 'ready'] as const;
const PRIORITIES = ['critical', 'high', 'medium', 'low'] as const;
const STAKEHOLDER_ROLES = ['approver', 'reviewer', 'audience', 'sponsor', 'executor', 'informed', 'stakeholder'];
const DELIVERABLE_FORMATS = ['pptx', 'docx', 'pdf', 'md', 'xlsx', 'html', 'txt'];
const TASK_TYPES = ['quarterly_report', 'presentation', 'memo', 'decision_brief', 'analysis', 'strategy', 'ad_hoc', 'review', 'communication'];
const CONFIDENTIALITY = ['public', 'internal', 'confidential', 'restricted'];
const CONTEXT_RELEVANCE = ['required', 'recommended', 'optional'];
const ID_PATTERN = /^RT-\d{4}$/;
/** "Create all missed" never creates more than this many tasks for one routine in one run. */
const MAX_CATCH_UP = 12;
/** A routine that has never been checked looks back at most this far. */
const MAX_LOOKBACK_DAYS = 35;
const MAX_RUNS_KEPT = 300;
/** Heartbeats distinguish active work from abandoned locks, even after PID reuse. */
const LOCK_HEARTBEAT_MS = 30_000;
const STALE_LOCK_MS = 2 * 60_000;
/** A task created this long after its scheduled time is reported as caught up, not on time. */
const LATE_MS = 10 * 60_000;

export interface RoutineTaskTemplate {
  title: string;
  status: (typeof TASK_STATUSES)[number];
  priority: (typeof PRIORITIES)[number];
  tags: string[];
  stakeholders: { ref: string; role: string; key: boolean }[];
  deliverables: { id: string; format?: string; template_ref?: string; status: 'pending' }[];
  /** Days from the scheduled run date to the due date; null for no due date. */
  due_offset_days: number | null;
  task_type: string;
  /** Context notes the task should load, as in task.md. */
  contexts: { ref: string; relevance?: string }[];
  preferred_agent: string | null;
  confidentiality: string | null;
  /** Markdown body of the created task, kept verbatim (including @-mention links). */
  body: string;
}

export interface Routine {
  id: string;
  title: string;
  enabled: boolean;
  schedule: Schedule;
  catch_up: CatchUpPolicy;
  /** YYYY-MM-DD: runs before this day are skipped, not caught up. For a long absence. */
  paused_until: string | null;
  task: RoutineTaskTemplate;
  created_at: string;
  updated_at: string;
}

export interface RoutineState {
  checked_at?: string;
  /** Last enabled/disabled state the engine saw, so switching back on (also by editing the file) never back-fills. */
  disabled?: boolean;
  last_run_at?: string;
  last_status?: 'ok' | 'error';
  last_message?: string;
  last_task_id?: string;
}

export interface RoutineView extends Routine {
  summary: string;
  next_run_at: string | null;
  state: RoutineState;
  /** Set when the file could not be read as a routine. */
  problem?: string;
}

export interface RoutineRun {
  routine_id: string;
  routine_title: string;
  trigger: RunTrigger;
  at: string;
  status: 'ok' | 'error';
  /** Occurrences this run handled, as local "YYYY-MM-DDTHH:MM". */
  occurrences: string[];
  /** Occurrences that were missed and deliberately not created (catch-up policy). */
  skipped: string[];
  /** Occurrences created well after their scheduled time (the computer was off or asleep). */
  caught_up?: string[];
  created: string[];
  message: string;
}

interface StateFile {
  version: 1;
  routines: Record<string, RoutineState>;
}

function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode: status });
}

/** A routine id from a request. Strict, because it becomes a file name. */
export function routineId(value: unknown): string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) throw httpError(400, 'Invalid routine id');
  return value;
}

/** Local "YYYY-MM-DDTHH:MM": the occurrence key written into each created task. */
export function occurrenceKey(at: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${localDate(at)}T${p(at.getHours())}:${p(at.getMinutes())}`;
}

function str(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
}

function text(value: unknown, field: string, max: number, required = false): string {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string') throw httpError(400, `Invalid ${field}`);
  const trimmed = value.trim();
  if (required && !trimmed) throw httpError(400, `Invalid ${field}: it is required`);
  if (trimmed.length > max) throw httpError(400, `Invalid ${field}: at most ${max} characters`);
  return trimmed;
}

function parseTaskTemplate(raw: unknown, body: unknown): RoutineTaskTemplate {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const status = o['status'] ?? 'backlog';
  if (!(TASK_STATUSES as readonly unknown[]).includes(status)) throw httpError(400, 'Invalid task.status: use backlog or ready');
  const priority = o['priority'] ?? 'medium';
  if (!(PRIORITIES as readonly unknown[]).includes(priority)) throw httpError(400, 'Invalid task.priority');

  const tags = Array.isArray(o['tags']) ? o['tags'] : [];
  if (tags.length > 20 || tags.some((t) => typeof t !== 'string' || !t.trim() || t.length > 50)) throw httpError(400, 'Invalid task.tags');

  const stakeholders = (Array.isArray(o['stakeholders']) ? o['stakeholders'] : []).map((s) => {
    const x = (s && typeof s === 'object' ? s : {}) as Record<string, unknown>;
    if (typeof x['ref'] !== 'string' || !/^STK-\d{4}$/.test(x['ref'])) throw httpError(400, 'Invalid task.stakeholders: ref must look like STK-0001');
    const role = typeof x['role'] === 'string' && STAKEHOLDER_ROLES.includes(x['role']) ? x['role'] : 'stakeholder';
    return { ref: x['ref'], role, key: x['key'] === true };
  });
  if (stakeholders.length > 50) throw httpError(400, 'Invalid task.stakeholders: too many');

  const deliverables = (Array.isArray(o['deliverables']) ? o['deliverables'] : []).map((d, i) => {
    const x = (d && typeof d === 'object' ? d : {}) as Record<string, unknown>;
    const out: RoutineTaskTemplate['deliverables'][number] = { id: `DEL-${String(i + 1).padStart(2, '0')}`, status: 'pending' };
    if (x['format'] !== undefined && x['format'] !== null && x['format'] !== '') {
      if (typeof x['format'] !== 'string' || !DELIVERABLE_FORMATS.includes(x['format'])) throw httpError(400, 'Invalid task.deliverables format');
      out.format = x['format'];
    }
    if (typeof x['template_ref'] === 'string' && x['template_ref'].trim()) out.template_ref = text(x['template_ref'], 'task.deliverables template', 200);
    return out;
  });
  if (deliverables.length > 20) throw httpError(400, 'Invalid task.deliverables: too many');

  const dueOffset = parseDueOffset(o['due_offset_days']);

  const taskType = o['task_type'] ?? 'ad_hoc';
  if (typeof taskType !== 'string' || !TASK_TYPES.includes(taskType)) throw httpError(400, 'Invalid task.task_type');
  const contexts = (Array.isArray(o['contexts']) ? o['contexts'] : []).map((c) => {
    const x = (c && typeof c === 'object' ? c : {}) as Record<string, unknown>;
    const out: RoutineTaskTemplate['contexts'][number] = { ref: text(x['ref'], 'task.contexts ref', 300, true) };
    if (x['relevance'] !== undefined && x['relevance'] !== null) {
      if (typeof x['relevance'] !== 'string' || !CONTEXT_RELEVANCE.includes(x['relevance'])) throw httpError(400, 'Invalid task.contexts relevance');
      out.relevance = x['relevance'];
    }
    return out;
  });
  if (contexts.length > 50) throw httpError(400, 'Invalid task.contexts: too many');
  const agent = o['preferred_agent'] === undefined || o['preferred_agent'] === null ? '' : text(o['preferred_agent'], 'task.preferred_agent', 100);
  if (agent && !/^[\w.\- ]+$/.test(agent)) throw httpError(400, 'Invalid task.preferred_agent');
  const confidentiality = o['confidentiality'] ?? null;
  if (confidentiality !== null && (typeof confidentiality !== 'string' || !CONFIDENTIALITY.includes(confidentiality))) {
    throw httpError(400, 'Invalid task.confidentiality');
  }

  return {
    title: text(o['title'], 'task.title', 200, true),
    status: status as RoutineTaskTemplate['status'],
    priority: priority as RoutineTaskTemplate['priority'],
    tags: tags.map((t) => (t as string).trim()),
    stakeholders,
    deliverables,
    due_offset_days: dueOffset,
    task_type: taskType,
    contexts,
    preferred_agent: agent || null,
    confidentiality: confidentiality as string | null,
    // Only the outer whitespace is trimmed; mentions and Markdown are copied into each task as written.
    body: text(body, 'task body', 50_000),
  };
}

function parsePausedUntil(value: unknown): string | null {
  const v = value instanceof Date ? value.toISOString().slice(0, 10) : value;
  if (v === undefined || v === null || v === '') return null;
  if (!isDateOnly(v)) throw httpError(400, 'Invalid paused_until: use YYYY-MM-DD, or leave it empty');
  return v;
}

function parseDueOffset(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const n = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 365) {
    throw httpError(400, 'Invalid task.due_offset_days: use 0 to 365, or leave it empty');
  }
  return n;
}

function parseCatchUp(value: unknown): CatchUpPolicy {
  const v = value ?? 'latest';
  if (!(CATCH_UP_POLICIES as readonly unknown[]).includes(v)) throw httpError(400, 'Invalid catch_up: use latest, all or skip');
  return v as CatchUpPolicy;
}

/** Fills {{date}} (scheduled run date) and {{due_date}} in a task title, both YYYY-MM-DD. */
export function fillTitle(template: string, date: string, dueDate: string | null): string {
  return template.replace(/\{\{\s*date\s*\}\}/g, date).replace(/\{\{\s*due_date\s*\}\}/g, dueDate ?? '').trim() || template;
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM'; }
}

// One run at a time inside this process; the lock file covers other processes.
let inProcess: Promise<unknown> = Promise.resolve();

export class RoutineService {
  routinesDir(): string {
    return path.join(workspaceService.getWorkspacePath(), 'routines');
  }

  private stateDir(): string {
    return path.join(workspaceService.getWorkspacePath(), '.situation-board', 'routines');
  }

  private file(id: string): string {
    return path.join(this.routinesDir(), `${routineId(id)}.md`);
  }

  // ---- state ---------------------------------------------------------------

  private async readState(): Promise<StateFile> {
    try {
      const parsed = JSON.parse(await fsp.readFile(path.join(this.stateDir(), 'state.json'), 'utf-8')) as StateFile;
      if (parsed && typeof parsed.routines === 'object' && parsed.routines && !Array.isArray(parsed.routines)) {
        const routines = Object.fromEntries(Object.entries(parsed.routines).map(([id, state]) =>
          [id, state && typeof state === 'object' && !Array.isArray(state) ? state : {}]));
        return { version: 1, routines };
      }
    } catch {
      // Missing or unreadable: start fresh. Created tasks still carry their occurrence, so nothing is duplicated.
    }
    return { version: 1, routines: {} };
  }

  private async writeState(state: StateFile): Promise<void> {
    await fsp.mkdir(this.stateDir(), { recursive: true });
    await atomicWrite(path.join(this.stateDir(), 'state.json'), JSON.stringify(state, null, 2));
  }

  private async patchState(id: string, patch: RoutineState): Promise<void> {
    const state = await this.readState();
    state.routines[id] = { ...state.routines[id], ...patch };
    await this.writeState(state);
  }

  private async appendRuns(runs: RoutineRun[]): Promise<void> {
    if (runs.length === 0) return;
    const file = path.join(this.stateDir(), 'runs.jsonl');
    await fsp.mkdir(this.stateDir(), { recursive: true });
    const existing = await fsp.readFile(file, 'utf-8').catch(() => '');
    const lines = [...existing.split('\n').filter(Boolean), ...runs.map((r) => JSON.stringify(r))].slice(-MAX_RUNS_KEPT);
    await atomicWrite(file, lines.join('\n') + '\n');
  }

  async history(limit = 50): Promise<RoutineRun[]> {
    const raw = await fsp.readFile(path.join(this.stateDir(), 'runs.jsonl'), 'utf-8').catch(() => '');
    const runs: RoutineRun[] = [];
    for (const line of raw.split('\n').filter(Boolean).reverse()) {
      try { runs.push(JSON.parse(line) as RoutineRun); } catch { /* a torn line is skipped */ }
      if (runs.length >= limit) break;
    }
    return runs;
  }

  // ---- lock ----------------------------------------------------------------

  /**
   * Runs `fn` under a renewable local lease, or returns null when it is occupied.
   * An event-loop stall longer than the expiry can lose the lease; this is not
   * fencing for a suspended writer or a transaction across task and state files.
   */
  private async withLock<T>(fn: () => Promise<T>): Promise<T | null> {
    await fsp.mkdir(this.stateDir(), { recursive: true });
    const lock = path.join(this.stateDir(), 'run.lock');
    for (let attempt = 0; attempt < 2; attempt++) {
      let handle: fsp.FileHandle;
      const owner = JSON.stringify({ pid: process.pid, at: new Date().toISOString(), token: randomUUID() });
      try {
        handle = await fsp.open(lock, 'wx', 0o600);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        const raw = await fsp.readFile(lock, 'utf-8').catch(() => '');
        let holder: { pid?: number } = {};
        try { holder = JSON.parse(raw) as { pid?: number }; } catch { /* still being written, or torn */ }
        const stat = await fsp.stat(lock).catch(() => null);
        const age = stat ? Date.now() - stat.mtimeMs : 0;
        const dead = typeof holder.pid === 'number' && holder.pid !== process.pid && !isAlive(holder.pid);
        if (attempt === 0 && (dead || age > STALE_LOCK_MS)) {
          // Another process may have taken over the same stale lock a moment ago. Remove only the lock
          // that was judged stale, never the fresh one that replaced it. (A small window remains between
          // this check and the removal; the occurrence markers and receipts still apply.)
          const again = await fsp.readFile(lock, 'utf-8').catch(() => null);
          const againStat = await fsp.stat(lock).catch(() => null);
          if (again === raw && againStat?.mtimeMs === stat?.mtimeMs) await fsp.rm(lock, { force: true });
          continue;
        }
        return null;
      }
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let pendingHeartbeat = Promise.resolve();
      try {
        await handle.writeFile(owner);
        heartbeat = setInterval(() => {
          pendingHeartbeat = pendingHeartbeat.then(async () => {
            const now = new Date();
            // Touch our open file, never a replacement lock acquired by another process.
            await handle.utimes(now, now);
          }).catch((err: Error) => console.error(`[routines] Lock heartbeat failed: ${err.message}`));
        }, LOCK_HEARTBEAT_MS);
        heartbeat.unref();
        return await fn();
      } finally {
        if (heartbeat) clearInterval(heartbeat);
        await pendingHeartbeat;
        await handle.close();
        // A suspended process may resume after its lease expired. Leave a new owner's lock alone.
        if (await fsp.readFile(lock, 'utf-8').catch(() => '') === owner) {
          await fsp.rm(lock, { force: true });
        }
      }
    }
    return null;
  }

  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    const result = inProcess.then(fn);
    inProcess = result.then(() => {}, () => {});
    return result;
  }

  private mutate<T>(fn: () => Promise<T>): Promise<T> {
    return this.serialized(async () => {
      const result = await this.withLock(async () => ({ value: await fn() }));
      if (!result) throw httpError(409, 'Another routine operation is in progress; try again in a moment');
      return result.value;
    });
  }

  // ---- reading ---------------------------------------------------------------

  private parse(raw: string, id: string): Routine {
    const { data, content } = parseMarkdown(raw);
    const d = (data ?? {}) as Record<string, unknown>;
    return {
      // The file name is the id: a file edited to say otherwise must not point elsewhere.
      id,
      title: str(d['title']) || id,
      enabled: d['enabled'] !== false,
      schedule: parseSchedule(d['schedule']),
      catch_up: parseCatchUp(d['catch_up']),
      paused_until: parsePausedUntil(d['paused_until']),
      task: parseTaskTemplate(d['task'], content.trim()),
      created_at: str(d['created_at']),
      updated_at: str(d['updated_at']),
    };
  }

  private async read(id: string): Promise<Routine> {
    const name = `${routineId(id)}.md`;
    let raw: string;
    try {
      // Contained resolver: a routine file symlinked outside the workspace is refused, not followed.
      raw = await fsp.readFile(await fileInside(this.routinesDir(), name), 'utf-8');
    } catch (err) {
      if ((err as Error).message?.includes('traversal')) throw httpError(400, `Invalid routine file: ${name} points outside the workspace`);
      throw httpError(404, `Routine not found: ${id}`);
    }
    return this.parse(raw, id);
  }

  /** Every routine file, including broken ones (reported with `problem` instead of being hidden). */
  private async readAll(): Promise<{ routines: Routine[]; broken: { id: string; problem: string }[] }> {
    const entries = await fsp.readdir(this.routinesDir()).catch(() => [] as string[]);
    const routines: Routine[] = [];
    const broken: { id: string; problem: string }[] = [];
    for (const name of entries.sort()) {
      const id = name.replace(/\.md$/, '');
      if (!name.endsWith('.md') || !ID_PATTERN.test(id)) continue;
      try {
        routines.push(this.parse(await fsp.readFile(await fileInside(this.routinesDir(), name), 'utf-8'), id));
      } catch (err) {
        broken.push({ id, problem: (err as Error).message });
      }
    }
    return { routines, broken };
  }

  private view(routine: Routine, state: RoutineState, now: Date): RoutineView {
    let from = state.checked_at && Date.parse(state.checked_at) > now.getTime() ? new Date(state.checked_at) : now;
    const resume = routine.paused_until ? startOfDay(routine.paused_until) : null;
    if (resume && resume > from) from = new Date(resume.getTime() - 1);
    const next = routine.enabled ? nextOccurrences(routine.schedule, from, 1)[0] : undefined;
    return {
      ...routine,
      summary: describeSchedule(routine.schedule),
      next_run_at: next ? next.toISOString() : null,
      state,
    };
  }

  async list(now = new Date()): Promise<RoutineView[]> {
    const [{ routines, broken }, state] = await Promise.all([this.readAll(), this.readState()]);
    const views = routines.map((r) => this.view(r, state.routines[r.id] ?? {}, now));
    for (const b of broken) {
      views.push({
        id: b.id, title: b.id, enabled: false, catch_up: 'latest', paused_until: null, created_at: '', updated_at: '',
        schedule: { frequency: 'daily', interval: 1, weekdays: [], month_day: null, month_week: null, month_weekday: null, time: '09:00', starts_on: '2000-01-01', ends_on: null },
        task: {
          title: '', status: 'backlog', priority: 'medium', tags: [], stakeholders: [], deliverables: [], due_offset_days: null,
          task_type: 'ad_hoc', contexts: [], preferred_agent: null, confidentiality: null, body: '',
        },
        summary: '', next_run_at: null, state: state.routines[b.id] ?? {}, problem: b.problem,
      });
    }
    return views.sort((a, b) => a.id.localeCompare(b.id));
  }

  async get(id: string, now = new Date()): Promise<RoutineView> {
    const routine = await this.read(id);
    return this.view(routine, (await this.readState()).routines[routine.id] ?? {}, now);
  }

  /** Summary and upcoming dates for a schedule being edited, before it is saved. */
  preview(schedule: unknown, dueOffset: unknown, now = new Date(), pausedUntil: unknown = null): { summary: string; next_runs: { at: string; due_date: string | null }[] } {
    const s = parseSchedule(schedule);
    const offset = parseDueOffset(dueOffset);
    const resume = parsePausedUntil(pausedUntil);
    const from = resume && startOfDay(resume) > now ? new Date(startOfDay(resume).getTime() - 1) : now;
    return {
      summary: describeSchedule(s),
      next_runs: nextOccurrences(s, from, 5).map((at) => ({
        at: at.toISOString(),
        due_date: offset !== null ? addDays(localDate(at), offset) : null,
      })),
    };
  }

  // ---- writing ---------------------------------------------------------------

  private validate(input: Record<string, unknown>): Omit<Routine, 'id' | 'created_at' | 'updated_at'> {
    try {
      const schedule = parseSchedule(input['schedule']);
      const taskTitle = (input['task'] as Record<string, unknown> | undefined)?.['title'];
      // Without a name, the task title stands in, minus its {{date}} placeholders.
      const fallback = typeof taskTitle === 'string' ? taskTitle.replace(/\(?\s*\{\{[^}]*\}\}\s*\)?/g, ' ').replace(/\s+/g, ' ').trim() : taskTitle;
      return {
        title: text(typeof input['title'] === 'string' && input['title'].trim() ? input['title'] : fallback, 'title', 200, true),
        enabled: input['enabled'] !== false,
        schedule,
        catch_up: parseCatchUp(input['catch_up']),
        paused_until: parsePausedUntil(input['paused_until']),
        task: parseTaskTemplate(input['task'], (input['task'] as Record<string, unknown> | undefined)?.['body']),
      };
    } catch (err) {
      if (err instanceof ScheduleError) throw httpError(400, err.message);
      throw err;
    }
  }

  private async save(routine: Routine): Promise<void> {
    await atomicWrite(this.file(routine.id), this.render(routine));
  }

  private render(routine: Routine): string {
    const { body, ...task } = routine.task;
    const data: Record<string, unknown> = {
      schema_version: '1.0',
      type: 'routine',
      id: routine.id,
      title: routine.title,
      enabled: routine.enabled,
      schedule: Object.fromEntries(Object.entries(routine.schedule).filter(([, v]) => v !== null && !(Array.isArray(v) && v.length === 0))),
      catch_up: routine.catch_up,
      ...(routine.paused_until ? { paused_until: routine.paused_until } : {}),
      task: Object.fromEntries(Object.entries(task).filter(([, v]) => v !== null)),
      created_at: routine.created_at,
      updated_at: routine.updated_at,
    };
    return stringifyMarkdown(body ? `${body}\n` : '', data);
  }

  async create(input: Record<string, unknown>, now = new Date()): Promise<RoutineView> {
    return this.mutate(() => this.createLocked(input, now));
  }

  private async createLocked(input: Record<string, unknown>, now = new Date()): Promise<RoutineView> {
    const fields = this.validate(input);
    await fsp.mkdir(this.routinesDir(), { recursive: true });
    const entries = await fsp.readdir(this.routinesDir()).catch(() => [] as string[]);
    const state = await this.readState();
    // Ids still referenced by tasks or receipts stay reserved, even if state.json was lost.
    const referenced = [...await this.existingOccurrences()].map((key) => key.split('|')[0]);
    let seq = [...entries, ...[...Object.keys(state.routines), ...referenced].map((id) => `${id}.md`)].reduce((max, e) => {
      const m = e.match(/^RT-(\d{4})\.md$/);
      return m ? Math.max(max, Number(m[1])) : max;
    }, 0);
    const iso = now.toISOString();
    // Two saves at the same moment can pick the same number; the exclusive create lets only one win.
    for (let attempt = 0; attempt < 20; attempt++) {
      const id = `RT-${String(++seq).padStart(4, '0')}`;
      try {
        // Complete content in the exclusive create: no reader ever sees an empty, "broken" routine.
        await fsp.writeFile(this.file(id), this.render({ id, ...fields, created_at: iso, updated_at: iso }), { flag: 'wx', mode: 0o600 });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
        throw err;
      }
      // Starts counting from now: creating a routine never back-fills past dates.
      await this.patchState(id, { checked_at: iso, disabled: !fields.enabled });
      return this.get(id, now);
    }
    throw httpError(409, 'Could not reserve a new routine id; try again');
  }

  async update(id: string, input: Record<string, unknown>, now = new Date()): Promise<RoutineView> {
    return this.mutate(() => this.updateLocked(id, input, now));
  }

  private async updateLocked(id: string, input: Record<string, unknown>, now = new Date()): Promise<RoutineView> {
    const existing = await this.read(id);
    const fields = this.validate({ ...existing, ...input, task: { ...existing.task, ...(input['task'] as object ?? {}) } });
    const iso = now.toISOString();
    await this.save({ ...existing, ...fields, updated_at: iso });
    // A new schedule, or switching it back on, starts from now: the gap is not "missed".
    const scheduleChanged = JSON.stringify(fields.schedule) !== JSON.stringify(existing.schedule);
    if (scheduleChanged || fields.enabled !== existing.enabled) await this.patchState(id, { checked_at: iso, disabled: !fields.enabled });
    return this.get(id, now);
  }

  async remove(id: string): Promise<void> {
    return this.mutate(() => this.removeLocked(id));
  }

  private async removeLocked(id: string): Promise<void> {
    const file = this.file(id);
    // Retain an id reservation so old tasks never become attached to a new routine.
    // Deletion must also work when the Markdown cannot be parsed.
    try { await fsp.access(file); } catch { throw httpError(404, `Routine not found: ${id}`); }
    await this.patchState(id, {});
    await fsp.rm(file);
  }

  // ---- running ---------------------------------------------------------------

  /**
   * Keys of every occurrence that already produced a task: from the receipts (which outlive the tasks,
   * so a task that was deleted or cleaned up is not created again) and from the tasks themselves
   * (which cover receipts lost with the state folder).
   */
  private async existingOccurrences(): Promise<Set<string>> {
    const tasks = [...await taskService.listTasks().catch(() => []), ...await taskService.listArchivedTasks().catch(() => [])];
    const keys = new Set<string>();
    const receipts = await fsp.readFile(path.join(this.stateDir(), 'receipts.jsonl'), 'utf-8').catch(() => '');
    for (const line of receipts.split('\n')) {
      try {
        const r = JSON.parse(line) as { routine_id?: unknown; occurrence?: unknown };
        if (typeof r.routine_id === 'string' && typeof r.occurrence === 'string') keys.add(`${r.routine_id}|${r.occurrence}`);
      } catch { /* blank or torn line */ }
    }
    for (const t of tasks) {
      if (typeof t['routine_ref'] === 'string' && typeof t['routine_occurrence'] === 'string') {
        keys.add(`${t['routine_ref']}|${t['routine_occurrence']}`);
      }
    }
    return keys;
  }

  private async createTaskFor(routine: Routine, at: Date, key: string): Promise<string> {
    const date = localDate(at);
    const due = routine.task.due_offset_days === null ? null : addDays(date, routine.task.due_offset_days);
    const task = await taskService.createTask({
      title: fillTitle(routine.task.title, date, due),
      status: routine.task.status,
      priority: routine.task.priority,
      due_date: due ?? undefined,
      tags: routine.task.tags,
      stakeholders: routine.task.stakeholders,
      deliverables: routine.task.deliverables,
      body: routine.task.body,
      task_type: routine.task.task_type,
      ...(routine.task.contexts.length ? { contexts: routine.task.contexts } : {}),
      ...(routine.task.preferred_agent ? { preferred_agent: routine.task.preferred_agent } : {}),
      ...(routine.task.confidentiality ? { confidentiality: routine.task.confidentiality } : {}),
      routine_ref: routine.id,
      routine_occurrence: key,
    } as unknown as Parameters<TaskService['createTask']>[0]);
    await fsp.mkdir(this.stateDir(), { recursive: true });
    await fsp.appendFile(path.join(this.stateDir(), 'receipts.jsonl'),
      JSON.stringify({ routine_id: routine.id, occurrence: key, task_id: task.id, at: new Date().toISOString() }) + '\n', { mode: 0o600 });
    return task.id;
  }

  /** Which missed occurrences to act on, given the catch-up policy. */
  private pick(routine: Routine, due: Date[], now: Date): { create: Date[]; skipped: Date[] } {
    if (routine.catch_up === 'all') {
      const create = due.slice(-MAX_CATCH_UP);
      return { create, skipped: due.slice(0, due.length - create.length) };
    }
    if (routine.catch_up === 'skip') {
      // Only runs that are on time: still the same day they were scheduled for.
      const today = localDate(now);
      return { create: due.filter((d) => localDate(d) === today), skipped: due.filter((d) => localDate(d) !== today) };
    }
    return { create: due.slice(-1), skipped: due.slice(0, -1) };
  }

  /**
   * Handles every occurrence that came due since the last check. Safe to call often and from
   * several processes: returns [] without doing anything when another run holds the lock.
   */
  async runDue(trigger: RunTrigger, now = new Date()): Promise<RoutineRun[]> {
    return this.serialized(async () => (await this.withLock(() => this.runDueLocked(trigger, now))) ?? []);
  }

  private async runDueLocked(trigger: RunTrigger, now: Date): Promise<RoutineRun[]> {
    const { routines } = await this.readAll();
    const state = await this.readState();
    const runs: RoutineRun[] = [];
    let existing: Set<string> | null = null;
    let stateChanged = false;

    for (const routine of routines) {
      const st = state.routines[routine.id] ?? {};
      if (!routine.enabled) {
        if (!st.disabled) { state.routines[routine.id] = { ...st, disabled: true, checked_at: now.toISOString() }; stateChanged = true; }
        continue;
      }
      if (st.disabled) {
        // Switched back on since the last check: runs while it was off are not "missed".
        state.routines[routine.id] = { ...st, disabled: false, checked_at: now.toISOString() };
        stateChanged = true;
        continue;
      }
      const fallback = Date.parse(routine.updated_at || routine.created_at);
      const floor = now.getTime() - MAX_LOOKBACK_DAYS * 86_400_000;
      const checked = Date.parse(st.checked_at ?? '');
      const from = new Date(Number.isFinite(checked) ? checked : Math.max(Number.isNaN(fallback) ? now.getTime() : fallback, floor));
      const all = occurrencesBetween(routine.schedule, from, now);
      // Runs during a "pause until" are dropped, like runs while switched off: nothing to catch up later.
      const due = routine.paused_until ? all.filter((d) => localDate(d) >= routine.paused_until!) : all;
      if (due.length === 0) {
        if (all.length > 0) { state.routines[routine.id] = { ...st, checked_at: now.toISOString() }; stateChanged = true; continue; }
        if (!st.checked_at) { state.routines[routine.id] = { ...st, checked_at: now.toISOString() }; stateChanged = true; }
        continue;
      }

      const { create, skipped } = this.pick(routine, due, now);
      const run: RoutineRun = {
        routine_id: routine.id, routine_title: routine.title, trigger, at: now.toISOString(), status: 'ok',
        occurrences: due.map(occurrenceKey), skipped: skipped.map(occurrenceKey), created: [], message: '',
      };
      try {
        existing ??= await this.existingOccurrences();
        for (const at of create) {
          const key = occurrenceKey(at);
          if (existing.has(`${routine.id}|${key}`)) continue;
          run.created.push(await this.createTaskFor(routine, at, key));
          existing.add(`${routine.id}|${key}`);
          if (now.getTime() - at.getTime() > LATE_MS) (run.caught_up ??= []).push(key);
        }
        run.message = describeRun(run);
      } catch (err) {
        run.status = 'error';
        run.message = (err as Error).message;
      }
      // An error does not advance the check: the next trigger retries the same occurrences.
      state.routines[routine.id] = {
        ...st,
        ...(run.status === 'ok' ? { checked_at: now.toISOString() } : {}),
        last_run_at: now.toISOString(),
        last_status: run.status,
        last_message: run.message,
        ...(run.created.length ? { last_task_id: run.created[run.created.length - 1] } : {}),
      };
      stateChanged = true;
      runs.push(run);
    }

    if (stateChanged) await this.writeState(state);
    await this.appendRuns(runs);
    return runs;
  }

  /** Creates the routine's task right now, whatever the schedule says. */
  async runNow(id: string, now = new Date()): Promise<RoutineRun> {
    const result = await this.serialized(async () => this.withLock(async () => {
      const routine = await this.read(id);
      const key = occurrenceKey(now);
      const run: RoutineRun = {
        routine_id: routine.id, routine_title: routine.title, trigger: 'manual', at: now.toISOString(), status: 'ok',
        occurrences: [key], skipped: [], created: [], message: '',
      };
      if ((await this.existingOccurrences()).has(`${routine.id}|${key}`)) {
        run.message = 'A task for this minute already exists.';
      } else {
        run.created.push(await this.createTaskFor(routine, now, key));
        run.message = describeRun(run);
      }
      await this.patchState(routine.id, {
        last_run_at: run.at, last_status: 'ok', last_message: run.message,
        ...(run.created.length ? { last_task_id: run.created[0] } : {}),
      });
      await this.appendRuns([run]);
      return run;
    }));
    if (!result) throw httpError(409, 'Another routine run is in progress; try again in a moment');
    return result;
  }
}

function describeRun(run: RoutineRun): string {
  const parts: string[] = [];
  if (run.created.length) parts.push(`Created ${run.created.join(', ')}`);
  else parts.push('Nothing new to create');
  if (run.caught_up?.length) parts.push(`caught up after the computer was off (scheduled for ${run.caught_up.join(', ').replace(/T/g, ' ')})`);
  if (run.skipped.length) parts.push(`${run.skipped.length} missed run${run.skipped.length === 1 ? '' : 's'} skipped`);
  return parts.join('; ') + '.';
}

/** Local midnight at the start of a YYYY-MM-DD day. */
function startOfDay(date: string): Date {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, d);
}
