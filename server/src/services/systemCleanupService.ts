import * as path from 'path';
import * as fsp from 'fs/promises';
import { WorkspaceService } from './workspace';
import { TaskService } from './taskService';
import { ContextUpdateService } from './contextUpdateService';
import { KaizenService } from './kaizenService';
import { parseMarkdown } from '../utils/markdown';
import { atomicWrite } from '../utils/atomicWrite';
import { Schedule, ScheduleError, describeSchedule, localDate, nextOccurrences, occurrencesBetween, parseSchedule } from './routineSchedule';
import { isDone } from './taskStatus';
import { moveToTrash, trashDir, trashedAt } from './trash';
import { reserveIds } from './idReservations';

const workspaceService = new WorkspaceService();
const taskService = new TaskService();
const contextUpdateService = new ContextUpdateService();
const kaizenService = new KaizenService();

/**
 * The built-in "System cleanup" job. It runs on the routine engine's triggers and lock (see
 * RoutineService), on its own schedule, and does two things:
 *
 * 1. Memory review: scans context notes and stakeholders for likely duplicates, stale and empty notes,
 *    and opens a context update tagged `origin: system-cleanup`, `kind: memory-review`. The analyze
 *    command turns it into proposals; nothing changes until the user approves them.
 * 2. File cleanup: per content type, finished items older than a threshold are archived, moved to the
 *    trash or deleted. Every rule is off until the user turns it on.
 *
 *   .situation-board/routines/system-cleanup.json         settings (missing: the defaults below)
 *   .situation-board/routines/system-cleanup-state.json   when it last checked and ran
 *
 * Defaults: weekly on Monday at 09:00, memory review on, no file is archived, trashed or deleted.
 */

export const SYSTEM_CLEANUP_ID = 'SYSTEM-CLEANUP';
export const SYSTEM_CLEANUP_TITLE = 'System cleanup';
/** The `origin` written into every context update this job opens. */
export const CLEANUP_ORIGIN = 'system-cleanup';
export const MEMORY_REVIEW_KIND = 'memory-review';

export const RULE_TYPES = ['completed_tasks', 'archived_tasks', 'context_updates', 'kaizen', 'trash'] as const;
export type RuleType = (typeof RULE_TYPES)[number];
export type CleanupAction = 'archive' | 'trash' | 'delete';

/** What each type may do. Only finished tasks can be archived; emptying the trash is always permanent. */
export const RULE_ACTIONS: Record<RuleType, CleanupAction[]> = {
  completed_tasks: ['archive', 'trash', 'delete'],
  archived_tasks: ['trash', 'delete'],
  context_updates: ['trash', 'delete'],
  kaizen: ['trash', 'delete'],
  trash: ['delete'],
};

export interface CleanupRule { enabled: boolean; older_than_days: number; action: CleanupAction }

export interface CleanupSettings {
  enabled: boolean;
  schedule: Schedule;
  memory_review: { enabled: boolean; stale_after_days: number };
  rules: Record<RuleType, CleanupRule>;
  /** Tasks with this tag are never cleaned up. Empty: no tag protects a task. */
  keep_tag: string;
  /** A safety cap: one run never touches more than this many items. The rest wait for the next run. */
  max_items_per_run: number;
  updated_at: string | null;
}

export interface CleanupState {
  checked_at?: string;
  disabled?: boolean;
  last_run_at?: string;
  last_status?: 'ok' | 'error';
  last_message?: string;
  last_context_update?: string;
}

export interface CleanupItem {
  type: RuleType;
  id: string;
  title: string;
  /** Workspace-relative path of the file or folder. */
  path: string;
  age_days: number;
  action: CleanupAction;
}

export interface CleanupPlan {
  items: CleanupItem[];
  /** Items per type that are old enough, before the per-run cap. */
  counts: Record<RuleType, number>;
  /** Items left for a later run because of the cap. */
  deferred: number;
}

export interface MemoryScan {
  notes: number;
  stakeholders: number;
  duplicates: { reason: string; paths: string[] }[];
  stale: { path: string; title: string; updated_at: string; age_days: number }[];
  thin: { path: string; title: string }[];
  unreadable: { path: string; reason: string }[];
}

export interface CleanupRunResult {
  status: 'ok' | 'error';
  message: string;
  context_update?: string;
  cleaned: { type: RuleType; id: string; action: CleanupAction }[];
  /** False when it opened nothing, cleaned nothing and nothing failed. Such scheduled runs stay out of the history. */
  did_something: boolean;
}

export interface CleanupView {
  id: string;
  title: string;
  settings: CleanupSettings;
  summary: string;
  next_run_at: string | null;
  state: CleanupState;
  /** The memory review this job opened that is not done yet, if any. */
  open_review: string | null;
  defaults: CleanupSettings;
}

const DAY_MS = 86_400_000;
const MAX_ITEMS_LIMIT = 1000;
const MAX_NOTES_COMPARED = 1500;
const MAX_LISTED = 50;
/** Two notes sharing at least this share of their three-word phrases are reported as likely duplicates. */
const SIMILARITY = 0.6;
const TASK_ID = /^TASK-\d{4}-\d{4}$/;
const CU_ID = /^CU-\d{4}-\d{4}$/;
const CONTEXT_CATEGORIES = ['company', 'organization', 'strategy', 'programs', 'decisions', 'risks', 'glossary', 'situation'];

function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode: status });
}

export function defaultSettings(): CleanupSettings {
  return {
    enabled: true,
    // 2026-01-05 is a Monday; a weekly schedule counts its weeks from there.
    schedule: parseSchedule({ frequency: 'weekly', interval: 1, weekdays: ['mon'], time: '09:00', starts_on: '2026-01-05' }),
    memory_review: { enabled: true, stale_after_days: 180 },
    rules: {
      completed_tasks: { enabled: false, older_than_days: 30, action: 'archive' },
      archived_tasks: { enabled: false, older_than_days: 365, action: 'trash' },
      context_updates: { enabled: false, older_than_days: 90, action: 'trash' },
      kaizen: { enabled: false, older_than_days: 90, action: 'trash' },
      trash: { enabled: false, older_than_days: 30, action: 'delete' },
    },
    keep_tag: 'keep',
    max_items_per_run: 200,
    updated_at: null,
  };
}

function days(value: unknown, field: string, min: number, max: number): number {
  const n = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max) throw httpError(400, `Invalid ${field}: use a whole number from ${min} to ${max}`);
  return n;
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});

/** Validates settings from a request or the file, filling anything missing from `base`. */
export function parseSettings(input: unknown, base: CleanupSettings = defaultSettings()): CleanupSettings {
  const o = obj(input);
  let schedule = base.schedule;
  if (o['schedule'] !== undefined) {
    try { schedule = parseSchedule(o['schedule']); } catch (err) {
      if (err instanceof ScheduleError) throw httpError(400, err.message);
      throw err;
    }
  }
  const mr = obj(o['memory_review']);
  const rulesIn = obj(o['rules']);
  const rules = {} as Record<RuleType, CleanupRule>;
  for (const type of RULE_TYPES) {
    const r = obj(rulesIn[type]);
    const b = base.rules[type];
    const action = r['action'] ?? b.action;
    if (!(RULE_ACTIONS[type] as unknown[]).includes(action)) throw httpError(400, `Invalid rules.${type}.action: use ${RULE_ACTIONS[type].join(' or ')}`);
    if (r['enabled'] !== undefined && typeof r['enabled'] !== 'boolean') throw httpError(400, `Invalid rules.${type}.enabled`);
    rules[type] = {
      enabled: r['enabled'] === undefined ? b.enabled : r['enabled'] as boolean,
      older_than_days: r['older_than_days'] === undefined ? b.older_than_days : days(r['older_than_days'], `rules.${type}.older_than_days`, 1, 3650),
      action: action as CleanupAction,
    };
  }
  const keepTag = o['keep_tag'] === undefined ? base.keep_tag : o['keep_tag'];
  if (typeof keepTag !== 'string' || (keepTag && !/^[\w-]{1,50}$/.test(keepTag))) throw httpError(400, 'Invalid keep_tag: letters, digits, - and _ only');
  for (const [k, v] of [['enabled', o['enabled']], ['memory_review.enabled', mr['enabled']]] as const) {
    if (v !== undefined && typeof v !== 'boolean') throw httpError(400, `Invalid ${k}`);
  }
  return {
    enabled: o['enabled'] === undefined ? base.enabled : o['enabled'] as boolean,
    schedule,
    memory_review: {
      enabled: mr['enabled'] === undefined ? base.memory_review.enabled : mr['enabled'] as boolean,
      stale_after_days: mr['stale_after_days'] === undefined ? base.memory_review.stale_after_days : days(mr['stale_after_days'], 'memory_review.stale_after_days', 7, 3650),
    },
    rules,
    keep_tag: keepTag,
    max_items_per_run: o['max_items_per_run'] === undefined ? base.max_items_per_run : days(o['max_items_per_run'], 'max_items_per_run', 1, MAX_ITEMS_LIMIT),
    updated_at: typeof o['updated_at'] === 'string' ? o['updated_at'] : base.updated_at,
  };
}

/** A date from frontmatter (YAML may already have turned it into a Date), or null. */
function when(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value !== 'string' || !value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Whole days since `date`, or null when there is no usable date or it lies in the future.
 * An item without a trustworthy date is never cleaned up: guessing could remove fresh work.
 */
function ageDays(date: Date | null, now: Date): number | null {
  if (!date || date.getTime() > now.getTime()) return null;
  return Math.floor((now.getTime() - date.getTime()) / DAY_MS);
}

const rel = (ws: string, p: string) => path.relative(ws, p).split(path.sep).join('/');

async function isRealDir(p: string): Promise<boolean> {
  const st = await fsp.lstat(p).catch(() => null);
  return Boolean(st?.isDirectory());
}

function normalizeTitle(s: string): string {
  return s.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** The text of a note without comments, headings and Markdown punctuation. */
function plainText(body: string): string {
  return body.replace(/<!--[\s\S]*?-->/g, ' ').replace(/^#+.*$/gm, ' ').replace(/[*_`>#\-|[\]()]/g, ' ').replace(/\s+/g, ' ').trim();
}

function shingles(text: string): Set<string> {
  const words = normalizeTitle(text).split(' ').filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i + 2 < words.length; i++) out.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  let shared = 0;
  const [small, large] = a.size < b.size ? [a, b] : [b, a];
  for (const s of small) if (large.has(s)) shared++;
  return shared / (a.size + b.size - shared || 1);
}

export class SystemCleanupService {
  private dir(): string {
    return path.join(workspaceService.getWorkspacePath(), '.situation-board', 'routines');
  }

  // ---- settings and state -----------------------------------------------------

  async readSettings(): Promise<CleanupSettings> {
    let raw: string;
    try { raw = await fsp.readFile(path.join(this.dir(), 'system-cleanup.json'), 'utf-8'); } catch { return defaultSettings(); }
    try {
      return parseSettings(JSON.parse(raw));
    } catch (err) {
      // A hand edit that does not validate must not silently fall back to the defaults and run with them.
      throw httpError(400, `The system cleanup settings cannot be read (.situation-board/routines/system-cleanup.json): ${(err as Error).message}`);
    }
  }

  async writeSettings(settings: CleanupSettings): Promise<void> {
    await fsp.mkdir(this.dir(), { recursive: true });
    await atomicWrite(path.join(this.dir(), 'system-cleanup.json'), JSON.stringify(settings, null, 2));
  }

  async readState(): Promise<CleanupState> {
    try {
      const parsed = JSON.parse(await fsp.readFile(path.join(this.dir(), 'system-cleanup-state.json'), 'utf-8')) as unknown;
      return obj(parsed) as CleanupState;
    } catch {
      return {};
    }
  }

  async writeState(state: CleanupState): Promise<void> {
    await fsp.mkdir(this.dir(), { recursive: true });
    await atomicWrite(path.join(this.dir(), 'system-cleanup-state.json'), JSON.stringify(state, null, 2));
  }

  async openReview(): Promise<string | null> {
    const updates = await contextUpdateService.list().catch(() => []);
    return updates.find((u) => u.origin === CLEANUP_ORIGIN && u.kind === MEMORY_REVIEW_KIND && u.status !== 'done')?.id ?? null;
  }

  async view(now = new Date()): Promise<CleanupView> {
    const [settings, state, open] = await Promise.all([this.readSettings(), this.readState(), this.openReview()]);
    const from = state.checked_at && Date.parse(state.checked_at) > now.getTime() ? new Date(state.checked_at) : now;
    const next = settings.enabled ? nextOccurrences(settings.schedule, from, 1)[0] : undefined;
    return {
      id: SYSTEM_CLEANUP_ID,
      title: SYSTEM_CLEANUP_TITLE,
      settings,
      summary: describeSchedule(settings.schedule),
      next_run_at: next ? next.toISOString() : null,
      state,
      open_review: open,
      defaults: defaultSettings(),
    };
  }

  /** Saves new settings. A changed schedule, or switching the job back on, starts counting from now. */
  async update(input: unknown, now = new Date()): Promise<CleanupView> {
    const current = await this.readSettings().catch(() => defaultSettings());
    const next = parseSettings(input, current);
    next.updated_at = now.toISOString();
    await this.writeSettings(next);
    if (JSON.stringify(next.schedule) !== JSON.stringify(current.schedule) || next.enabled !== current.enabled) {
      await this.writeState({ ...await this.readState(), checked_at: now.toISOString(), disabled: !next.enabled });
    }
    return this.view(now);
  }

  // ---- scheduling ---------------------------------------------------------------

  /**
   * Runs the job when an occurrence fell between the last check and now. Missed weeks are not caught up
   * one by one: one run covers them, because it looks at the whole workspace as it is now.
   * The caller holds the routine lock.
   */
  async runIfDue(now: Date): Promise<CleanupRunResult | null> {
    const settings = await this.readSettings();
    const state = await this.readState();
    if (!settings.enabled) {
      if (!state.disabled) await this.writeState({ ...state, disabled: true, checked_at: now.toISOString() });
      return null;
    }
    const checked = Date.parse(state.checked_at ?? '');
    if (state.disabled || !Number.isFinite(checked)) {
      // First check, or switched back on: start counting from now, nothing is "missed".
      await this.writeState({ ...state, disabled: false, checked_at: now.toISOString() });
      return null;
    }
    if (occurrencesBetween(settings.schedule, new Date(checked), now).length === 0) return null;
    const result = await this.run(settings, now);
    // Advanced even after an error: retrying every minute would repeat the same failure. Run now retries.
    await this.writeState({ ...state, checked_at: now.toISOString(), ...this.stateFor(result, now) });
    return result;
  }

  /** Runs straight away, whatever the schedule says. The caller holds the routine lock. */
  async runNow(now: Date): Promise<CleanupRunResult> {
    const settings = await this.readSettings();
    const result = await this.run(settings, now);
    await this.writeState({ ...await this.readState(), ...this.stateFor(result, now) });
    return result;
  }

  private stateFor(result: CleanupRunResult, now: Date): CleanupState {
    return {
      last_run_at: now.toISOString(),
      last_status: result.status,
      last_message: result.message,
      ...(result.context_update ? { last_context_update: result.context_update } : {}),
    };
  }

  private async run(settings: CleanupSettings, now: Date): Promise<CleanupRunResult> {
    const parts: string[] = [];
    let status: 'ok' | 'error' = 'ok';
    let contextUpdate: string | undefined;

    if (settings.memory_review.enabled) {
      try {
        const review = await this.openMemoryReview(settings, now);
        contextUpdate = review.id;
        parts.push(review.message);
      } catch (err) {
        status = 'error';
        parts.push(`The memory review failed: ${(err as Error).message}`);
      }
    }

    const cleaned: CleanupRunResult['cleaned'] = [];
    const anyRule = RULE_TYPES.some((t) => settings.rules[t].enabled);
    if (anyRule) {
      const plan = await this.plan(settings, now);
      const failures: string[] = [];
      for (const item of plan.items) {
        try {
          if (await this.execute(item, settings, now)) cleaned.push({ type: item.type, id: item.id, action: item.action });
        } catch (err) {
          failures.push(`${item.id}: ${(err as Error).message}`);
        }
      }
      parts.push(cleaned.length ? describeCleaned(cleaned) : 'No file was old enough to clean up.');
      if (plan.deferred) parts.push(`${plan.deferred} more wait for the next run (at most ${settings.max_items_per_run} per run).`);
      if (failures.length) {
        status = 'error';
        parts.push(`${failures.length} could not be cleaned up: ${failures.slice(0, 3).join('; ')}${failures.length > 3 ? '...' : ''}`);
      }
    }
    if (!settings.memory_review.enabled && !anyRule) parts.push('Nothing to do: the memory review and every cleanup rule are off.');
    return {
      status, message: parts.join(' '), ...(contextUpdate ? { context_update: contextUpdate } : {}), cleaned: cleaned.slice(0, 100),
      did_something: Boolean(contextUpdate) || cleaned.length > 0 || status === 'error',
    };
  }

  // ---- file cleanup ---------------------------------------------------------------

  /** What a run would clean up now, oldest first. Nothing is changed. */
  async plan(settings: CleanupSettings, now = new Date()): Promise<CleanupPlan> {
    const ws = workspaceService.getWorkspacePath();
    const found: CleanupItem[] = [];
    const counts = Object.fromEntries(RULE_TYPES.map((t) => [t, 0])) as Record<RuleType, number>;
    const add = (type: RuleType, id: string, title: string, p: string, age: number | null) => {
      const rule = settings.rules[type];
      if (age === null || age < rule.older_than_days) return;
      counts[type]++;
      found.push({ type, id, title, path: rel(ws, p), age_days: age, action: rule.action });
    };
    const kept = (tags: unknown) => Boolean(settings.keep_tag) && Array.isArray(tags) && tags.includes(settings.keep_tag);

    if (settings.rules.completed_tasks.enabled) {
      for (const t of await taskService.listTasks().catch(() => [])) {
        if (!TASK_ID.test(t.id) || !isDone(t.status) || kept(t.tags)) continue;
        add('completed_tasks', t.id, t.title, path.join(ws, 'tasks', 'active', t.id), ageDays(when(t.done_date) ?? when(t.updated_at), now));
      }
    }
    if (settings.rules.archived_tasks.enabled) {
      for (const t of await taskService.listArchivedTasks().catch(() => [])) {
        if (!TASK_ID.test(t.id) || kept(t.tags)) continue;
        // updated_at is stamped when the task is archived: the clock starts when it was filed away.
        add('archived_tasks', t.id, t.title, path.join(ws, 'tasks', 'archive', t.id), ageDays(when(t.updated_at) ?? when(t.done_date), now));
      }
    }
    if (settings.rules.context_updates.enabled) {
      for (const u of await contextUpdateService.list().catch(() => [])) {
        // Only finished ones. Kept materials are the user's explicit choice; pending removals still need the record.
        if (!CU_ID.test(u.id) || u.status !== 'done' || u.keep_materials) continue;
        if (u.proposals.some((p) => p.action === 'remove' && p.decision === 'accepted' && !p.outcome)) continue;
        add('context_updates', u.id, u.title, path.join(ws, 'context-updates', u.id), ageDays(when(u.applied_at) ?? when(u.updated_at), now));
      }
    }
    if (settings.rules.kaizen.enabled) {
      for (const { filename, proposal } of await kaizenService.listKaizenFiles().catch(() => [])) {
        if (proposal.status !== 'applied' && proposal.status !== 'rejected') continue;
        add('kaizen', proposal.id || filename, proposal.title, path.join(ws, 'kaizen', filename), ageDays(when(proposal.applied_at) ?? when(proposal.created_at), now));
      }
    }
    if (settings.rules.trash.enabled) {
      const dir = trashDir(ws);
      for (const name of await fsp.readdir(dir).catch(() => [] as string[])) {
        // Only entries this app named: anything else in the folder was put there by someone else.
        add('trash', name, name.replace(/^\d{4}-\d{2}-\d{2}T[\d-]+Z-[0-9a-f-]{36}-/, ''), path.join(dir, name), ageDays(trashedAt(name), now));
      }
    }

    found.sort((a, b) => b.age_days - a.age_days);
    const items = found.slice(0, settings.max_items_per_run);
    return { items, counts, deferred: found.length - items.length };
  }

  /**
   * Cleans up one item after checking again that it still qualifies: the plan may be a few seconds old,
   * and the user or an agent may have reopened a task in the meantime. Returns false when it no longer does.
   */
  private async execute(item: CleanupItem, settings: CleanupSettings, now: Date): Promise<boolean> {
    const ws = workspaceService.getWorkspacePath();
    const full = path.join(ws, ...item.path.split('/'));
    if (!full.startsWith(ws + path.sep)) throw new Error('outside the workspace');
    const st = await fsp.lstat(full).catch(() => null);
    if (!st) return false;
    // Never follow a link out of the workspace, and never remove what it points at.
    if (st.isSymbolicLink()) throw new Error('is a symbolic link; left alone');

    if (item.type === 'completed_tasks' || item.type === 'archived_tasks') {
      if (!st.isDirectory()) return false;
      const raw = await fsp.readFile(path.join(full, 'task.md'), 'utf-8').catch(() => null);
      if (raw === null) return false;
      const data = obj(parseMarkdown(raw).data);
      if (item.type === 'completed_tasks' && !isDone(String(data['status'] ?? ''))) return false;
      if (settings.keep_tag && Array.isArray(data['tags']) && data['tags'].includes(settings.keep_tag)) return false;
      if (item.action === 'archive') {
        await taskService.archiveTask(item.id);
        return true;
      }
    }
    if (item.type === 'context_updates') {
      if (!(await isRealDir(full))) return false;
      const u = await contextUpdateService.list().then((all) => all.find((x) => x.id === item.id)).catch(() => undefined);
      if (!u || u.status !== 'done' || u.keep_materials) return false;
    }

    // The id stays taken, so a new task or update never inherits links that pointed at this one.
    if (item.type === 'completed_tasks' || item.type === 'archived_tasks' || item.type === 'context_updates') await reserveIds([item.id]);
    if (item.action === 'trash' && item.type !== 'trash') {
      await moveToTrash(ws, full, now);
    } else {
      await fsp.rm(full, { recursive: true, force: true });
    }
    return true;
  }

  // ---- memory review -----------------------------------------------------------------

  private async openMemoryReview(settings: CleanupSettings, now: Date): Promise<{ id?: string; message: string }> {
    const open = await this.openReview();
    // One review at a time: a backlog of unread reviews helps nobody.
    if (open) return { message: `The memory review ${open} is still open, so no new one was started.` };
    const scan = await this.scanMemory(settings, now);
    if (scan.notes + scan.stakeholders === 0) return { message: 'No context notes or stakeholders yet, so there is no memory to review.' };
    const date = localDate(now);
    const update = await contextUpdateService.create({
      title: `Memory review ${date}`,
      source_date: date,
      notes: memoryBrief(settings),
      text: scanReport(scan, settings, date),
    }, { origin: CLEANUP_ORIGIN, kind: MEMORY_REVIEW_KIND, textName: 'memory-scan.md' });
    const found = scan.duplicates.length + scan.stale.length + scan.thin.length;
    return {
      id: update.id,
      message: `Started memory review ${update.id} (${scan.notes} notes, ${scan.stakeholders} stakeholders; ${found} candidate${found === 1 ? '' : 's'} from the scan). Run the analyze command to get proposals.`,
    };
  }

  /** A quick, mechanical look at the memory. A starting point for the agent, not a verdict. */
  async scanMemory(settings: CleanupSettings, now = new Date()): Promise<MemoryScan> {
    const ws = workspaceService.getWorkspacePath();
    const scan: MemoryScan = { notes: 0, stakeholders: 0, duplicates: [], stale: [], thin: [], unreadable: [] };
    const notes: { path: string; title: string; text: string }[] = [];

    for (const category of CONTEXT_CATEGORIES) {
      const dir = path.join(ws, 'context', category);
      for (const entry of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
        if (!entry.isDirectory()) continue;
        const file = path.join(dir, entry.name, 'note.md');
        const raw = await fsp.readFile(file, 'utf-8').catch(() => null);
        if (raw === null) continue;
        const relPath = rel(ws, file);
        let parsed: ReturnType<typeof parseMarkdown>;
        try { parsed = parseMarkdown(raw); } catch (err) {
          scan.unreadable.push({ path: relPath, reason: (err as Error).message.split('\n')[0] ?? 'cannot be parsed' });
          continue;
        }
        const data = obj(parsed.data);
        const content = parsed.content;
        scan.notes++;
        const title = typeof data['title'] === 'string' && data['title'] ? data['title'] : entry.name;
        const text = plainText(content);
        notes.push({ path: relPath, title, text });
        if (text.length < 40) scan.thin.push({ path: relPath, title });
        const updated = when(data['updated_at']) ?? when(data['created_at']);
        const age = ageDays(updated, now);
        if (age !== null && age >= settings.memory_review.stale_after_days) {
          scan.stale.push({ path: relPath, title, updated_at: updated!.toISOString().slice(0, 10), age_days: age });
        }
      }
    }

    // Same title in two places.
    const byTitle = new Map<string, string[]>();
    for (const n of notes) {
      const key = normalizeTitle(n.title);
      if (key) byTitle.set(key, [...byTitle.get(key) ?? [], n.path]);
    }
    for (const paths of byTitle.values()) if (paths.length > 1) scan.duplicates.push({ reason: 'Same title', paths });

    // Mostly the same text under different titles.
    const compared = notes.slice(0, MAX_NOTES_COMPARED).map((n) => ({ ...n, sh: shingles(n.text) })).filter((n) => n.sh.size >= 20);
    const reported = new Set(scan.duplicates.flatMap((d) => d.paths.length === 2 ? [d.paths.slice().sort().join('|')] : []));
    for (let i = 0; i < compared.length; i++) {
      for (let j = i + 1; j < compared.length; j++) {
        const key = [compared[i]!.path, compared[j]!.path].sort().join('|');
        if (reported.has(key)) continue;
        const score = jaccard(compared[i]!.sh, compared[j]!.sh);
        if (score >= SIMILARITY) {
          scan.duplicates.push({ reason: `About ${Math.round(score * 100)}% of the text is the same`, paths: [compared[i]!.path, compared[j]!.path] });
          reported.add(key);
        }
      }
    }

    // Two stakeholder files for one person or group.
    for (const folder of ['people', 'groups']) {
      const byName = new Map<string, string[]>();
      const dir = path.join(ws, 'stakeholders', folder);
      for (const name of await fsp.readdir(dir).catch(() => [] as string[])) {
        if (!name.endsWith('.md')) continue;
        const raw = await fsp.readFile(path.join(dir, name), 'utf-8').catch(() => null);
        if (raw === null) continue;
        try {
          const data = obj(parseMarkdown(raw).data);
          scan.stakeholders++;
          const key = normalizeTitle(String(data['name'] ?? ''));
          if (key) byName.set(key, [...byName.get(key) ?? [], `stakeholders/${folder}/${name}`]);
        } catch (err) {
          scan.unreadable.push({ path: `stakeholders/${folder}/${name}`, reason: (err as Error).message.split('\n')[0] ?? 'cannot be parsed' });
        }
      }
      for (const paths of byName.values()) if (paths.length > 1) scan.duplicates.push({ reason: 'Same name', paths });
    }

    scan.stale.sort((a, b) => b.age_days - a.age_days);
    return scan;
  }
}

function describeCleaned(cleaned: CleanupRunResult['cleaned']): string {
  const verbs: Record<CleanupAction, string> = { archive: 'archived', trash: 'moved to the trash', delete: 'deleted' };
  const by = new Map<CleanupAction, number>();
  for (const c of cleaned) by.set(c.action, (by.get(c.action) ?? 0) + 1);
  return `Cleaned up ${cleaned.length} item${cleaned.length === 1 ? '' : 's'}: ${[...by].map(([a, n]) => `${n} ${verbs[a]}`).join(', ')}.`;
}

/** The body of the update: what the analyze command should do with it. */
function memoryBrief(settings: CleanupSettings): string {
  return [
    'Opened by the weekly **System cleanup** job, not imported by you. There is no new material:',
    'this review looks at the memory that is already in the workspace.',
    '',
    'Review the whole context library and the stakeholder files, and propose only changes that make the',
    'memory more accurate and easier to use: merge duplicates, move a fact to the note where it belongs,',
    `remove what is obsolete or no longer useful, and flag notes not updated in ${settings.memory_review.stale_after_days} days or more that may be out of date.`,
    '',
    'materials/memory-scan.md lists what a quick mechanical scan found. It is a starting point, not a verdict.',
    'Nothing changes until you approve the proposals.',
  ].join('\n');
}

function scanReport(scan: MemoryScan, settings: CleanupSettings, date: string): string {
  const lines = [
    `# Memory scan, ${date}`,
    '',
    `Scanned ${scan.notes} context notes and ${scan.stakeholders} stakeholder files. Candidates only: confirm each one against the files before proposing anything.`,
    '',
    '## Possible duplicates',
    '',
  ];
  if (scan.duplicates.length === 0) lines.push('None found by title, name or text.');
  for (const d of scan.duplicates.slice(0, MAX_LISTED)) lines.push(`- ${d.reason}: ${d.paths.map((p) => `\`${p}\``).join(', ')}`);
  lines.push('', `## Not updated in ${settings.memory_review.stale_after_days} days or more`, '');
  if (scan.stale.length === 0) lines.push('None.');
  for (const s of scan.stale.slice(0, MAX_LISTED)) lines.push(`- \`${s.path}\` (${s.title}): last updated ${s.updated_at}, ${s.age_days} days ago`);
  lines.push('', '## Empty or nearly empty', '');
  if (scan.thin.length === 0) lines.push('None.');
  for (const t of scan.thin.slice(0, MAX_LISTED)) lines.push(`- \`${t.path}\` (${t.title})`);
  if (scan.unreadable.length) {
    lines.push('', '## Could not be read', '');
    for (const u of scan.unreadable.slice(0, MAX_LISTED)) lines.push(`- \`${u.path}\`: ${u.reason}`);
  }
  const more = [scan.duplicates, scan.stale, scan.thin].some((l) => l.length > MAX_LISTED);
  if (more) lines.push('', `Lists are cut at ${MAX_LISTED} entries.`);
  return lines.join('\n') + '\n';
}
