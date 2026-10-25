import * as fs from 'fs';
import * as path from 'path';
import {
  InsightsData,
  InsightsAttentionItem,
  InsightsBar,
  Priority,
  Stakeholder,
  Task,
  TaskStatus,
} from '../types';
import { TaskService } from './taskService';
import { WorkspaceService } from './workspace';
import { StakeholderService } from './stakeholderService';
import { OutputService } from './outputService';
import { readExecutions, UNKNOWN_TIMESTAMP } from './executionLog';
import { isAwaitingReview, isDone, isOpen } from './taskStatus';

const taskService = new TaskService();
const workspaceService = new WorkspaceService();
const stakeholderService = new StakeholderService();
const outputService = new OutputService();

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Turnaround buckets, ordered.
 *
 * This workspace is one executive plus AI agents, not a delivery team: a task
 * written at 09:00 is usually finished by 09:25, but a handful drag on for
 * weeks. In practice the spread can run from minutes to several weeks,
 * so a mean is meaningless and a linear axis hides the whole left half. Fixed
 * log-ish buckets keep both ends readable.
 */
const TURNAROUND_BUCKETS: Array<{ label: string; maxHours: number }> = [
  { label: '< 1h', maxHours: 1 },
  { label: '1-4h', maxHours: 4 },
  { label: '4-24h', maxHours: 24 },
  { label: '1-3d', maxHours: 72 },
  { label: '3d+', maxHours: Infinity },
];

/**
 * Sunday-start week key.
 *
 * Built from local date parts rather than `toISOString()`. The week boundary is
 * computed in local time, so serialising through UTC shifts the key back a day
 * for anyone east of Greenwich — in JST every week would be labelled Saturday
 * and tasks created early on a Sunday would land in the previous week.
 */
function weekKey(date: Date): string {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - d.getDay());
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== 'string' || !value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed);
}

/**
 * End of the given day, so a task due "2026-09-17" is on time all that day.
 *
 * A bare `YYYY-MM-DD` due date means that day in the user's own timezone, so it
 * is resolved locally. Appending `Z` would evaluate deadlines in UTC: in JST a
 * task due today would read as "due in 2 days" and only go overdue at 09:00 the
 * following morning.
 */
function endOfDay(value: string): Date | null {
  if (value.includes('T')) return parseDate(value);
  const parts = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!parts) return parseDate(value);
  return new Date(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]), 23, 59, 59, 999);
}

/** Local midnight of the given moment, for whole-day arithmetic. */
function startOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Whole calendar days from today to the due date: tomorrow is 1, today is 0,
 * yesterday is -1.
 *
 * Measuring the raw duration instead and rounding up would call a task due
 * tomorrow evening "2 days", because it is 1.4 days away. People count the
 * dates on a calendar, not the hours in between.
 */
function calendarDaysUntil(due: Date, now: Date): number {
  return Math.round((startOfDay(due).getTime() - startOfDay(now).getTime()) / DAY_MS);
}

/** Percentile over an ascending list, interpolating between neighbours. */
function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function round(value: number, places = 1): number {
  const f = 10 ** places;
  return Math.round(value * f) / f;
}

/** Task with the extra frontmatter the workspace actually carries. */
export type RawTask = Task & Record<string, unknown>;

/** What Insights derives about one task. Shared with the activity calendar. */
export interface TaskFacts {
  task: RawTask;
  status: TaskStatus;
  createdAt: Date | null;
  /** When the task finished, or null if it has not. */
  completedAt: Date | null;
  /** When the last agent run finished. Null when the task has no execution log. */
  lastExecutionAt: Date | null;
  /** How many agent runs the task took. */
  runs: number;
  /** When each agent run happened, oldest first. */
  runTimes: Date[];
  /** Last sign of life: newest execution, else `updated_at`. */
  lastActivityAt: Date | null;
  stakeholderRefs: string[];
  templateRefs: string[];
}

export class InsightsService {
  /**
   * Build the Insights payload.
   *
   * Everything here is derived from what is on disk. Two things are worth
   * knowing about the derivation:
   *
   * - Completion time is `done_date` when present, and otherwise `updated_at`
   *   at the moment the task is sitting in a finished status. Tasks created
   *   before the server started stamping `done_date` only have the latter, so
   *   for them "completed" really means "last edited while finished".
   * - There is no status history anywhere in the workspace, so a cumulative
   *   flow diagram cannot be reconstructed. It used to be rendered from
   *   guessed data and is deliberately gone rather than faked.
   */
  async getInsightsData(windowDays: number | null = 30): Promise<InsightsData> {
    const now = new Date();
    const since = windowDays === null ? null : new Date(now.getTime() - windowDays * DAY_MS);

    const workspacePath = workspaceService.getWorkspacePath();
    const facts = await this.loadFacts();

    const inWindow = (date: Date | null): boolean =>
      date !== null && (since === null || date >= since);

    // Completed inside the window — the basis for every speed and quality metric.
    const completed = facts.filter((f) => f.completedAt !== null && inWindow(f.completedAt));
    // Open tasks are always shown in full: a task overdue for two months is
    // still overdue today, and hiding it behind a 30-day filter would be a lie.
    const open = facts.filter((f) => isOpen(f.status));

    const turnarounds = completed
      .filter((f) => f.createdAt !== null)
      .map((f) => Math.max(0, (f.completedAt!.getTime() - f.createdAt!.getTime()) / HOUR_MS))
      .sort((a, b) => a - b);

    const withDueDate = completed.filter((f) => typeof f.task.due_date === 'string');
    const onTime = withDueDate.filter((f) => {
      const due = endOfDay(f.task.due_date as string);
      return due !== null && f.completedAt! <= due;
    });

    const withRuns = completed.filter((f) => f.runs > 0);
    const firstPass = withRuns.filter((f) => f.runs === 1);

    // How long finished work sat in Needs Review before the user signed it off.
    // The agent stops at `in_review` by design, so this is the user's own
    // latency, and it is the half of turnaround they can actually control.
    const reviewLatencies = completed
      .filter((f) => f.lastExecutionAt !== null && f.completedAt! > f.lastExecutionAt)
      .map((f) => (f.completedAt!.getTime() - f.lastExecutionAt!.getTime()) / HOUR_MS)
      .sort((a, b) => a - b);

    const awaitingReview = open.filter((f) => isAwaitingReview(f.status));
    const waitingDays = (f: TaskFacts): number =>
      f.lastActivityAt === null
        ? 0
        : Math.max(0, Math.floor((now.getTime() - f.lastActivityAt.getTime()) / DAY_MS));

    const people = await stakeholderService.listStakeholders().catch(() => []);
    const nameById = new Map(people.map((p) => [p.id, p.name]));

    const [byStakeholder, byOutput] = await Promise.all([
      this.stakeholderBars(facts, since, people),
      this.outputBars(facts, since),
    ]);

    return {
      generated_at: now.toISOString(),
      window_days: windowDays,

      summary: {
        awaiting_review: awaitingReview.length,
        awaiting_review_oldest_days: awaitingReview.reduce(
          (max, f) => Math.max(max, waitingDays(f)),
          0,
        ),
        completed: completed.length,
        open: open.length,
        overdue: open.filter((f) => {
          const due = typeof f.task.due_date === 'string' ? endOfDay(f.task.due_date) : null;
          return due !== null && due < now;
        }).length,
        median_turnaround_hours: this.roundOrNull(percentile(turnarounds, 0.5)),
        p90_turnaround_hours: this.roundOrNull(percentile(turnarounds, 0.9)),
        first_pass_rate: withRuns.length > 0 ? round(firstPass.length / withRuns.length, 3) : null,
        first_pass_of: withRuns.length,
        on_time_rate:
          withDueDate.length > 0 ? round(onTime.length / withDueDate.length, 3) : null,
        on_time_of: withDueDate.length,
        median_review_hours: this.roundOrNull(percentile(reviewLatencies, 0.5)),
        review_of: reviewLatencies.length,
      },

      attention: this.buildAttention(open, now, waitingDays, nameById),
      by_stakeholder: byStakeholder,
      by_output: byOutput,
      rework: this.reworkBars(facts, since),
      kaizen: this.kaizenBars(workspacePath, since),
      weekly: this.weeklyFlow(facts, now, windowDays),
      turnaround_buckets: this.bucketTurnarounds(turnarounds),
    };
  }

  private roundOrNull(value: number | null): number | null {
    return value === null ? null : round(value, 2);
  }

  /** Facts for every active and archived task. */
  async loadFacts(): Promise<TaskFacts[]> {
    const tasks = await this.loadTasks();
    const workspacePath = workspaceService.getWorkspacePath();
    return Promise.all(tasks.map((task) => this.factsFor(task, workspacePath)));
  }

  /** Active plus archived tasks, de-duplicated by id. */
  private async loadTasks(): Promise<RawTask[]> {
    let tasks: Task[] = [];
    try {
      tasks = await taskService.listTasks();
      // Archived tasks live in their own folder, so a status filter on the
      // active list would never find them.
      const archived = await taskService.listArchivedTasks().catch(() => []);
      const seen = new Set(tasks.map((t) => t.id));
      for (const t of archived) {
        if (!seen.has(t.id)) tasks.push(t);
      }
    } catch {
      tasks = [];
    }
    return tasks as RawTask[];
  }

  /** Resolve the timestamps a task does not record explicitly. */
  private async factsFor(task: RawTask, workspacePath: string): Promise<TaskFacts> {
    const status = task.status;
    const executions = await readExecutions(workspacePath, task.id);

    const createdAt = parseDate(task.created_at);
    const updatedAt = parseDate(task.updated_at);

    // A run with no recorded time still counts as a run, but it has no day or
    // hour, so it is left out of anything that places runs in time.
    const runTimes = executions
      .filter((e) => e.timestamp !== UNKNOWN_TIMESTAMP)
      .map((e) => parseDate(e.timestamp))
      .filter((d): d is Date => d !== null)
      .sort((a, b) => a.getTime() - b.getTime());
    const lastExecution = runTimes[runTimes.length - 1];

    // When the task finished, in order of how much the source can be trusted:
    //
    // 1. `done_date`, once the server has stamped it. It survives archiving, so
    //    it is checked first whatever the current status is.
    // 2. For a task sitting in a finished status, `updated_at` — the last edit
    //    while finished, which is close enough to the sign-off.
    // 3. For an archived task, the last agent run. `updated_at` would be the
    //    moment it was filed away, which for a task archived weeks after it
    //    shipped would report a turnaround of weeks.
    //
    // An archived task with no runs was abandoned rather than delivered, and is
    // deliberately left uncounted.
    const completedAt =
      parseDate(task.done_date) ??
      (isDone(status) ? updatedAt : status === 'archived' ? (lastExecution ?? null) : null);

    const stakeholders = Array.isArray(task.stakeholders)
      ? (task.stakeholders as Array<{ ref?: string }>)
          .map((s) => s?.ref)
          .filter((r): r is string => typeof r === 'string' && r.length > 0)
      : [];

    const deliverables = Array.isArray(task.deliverables)
      ? (task.deliverables as Array<{ template_ref?: string }>)
      : [];

    return {
      task,
      status,
      createdAt,
      completedAt,
      lastExecutionAt: lastExecution ?? null,
      runs: executions.length,
      runTimes,
      lastActivityAt: lastExecution ?? updatedAt,
      stakeholderRefs: stakeholders.length > 0 ? stakeholders : task.stakeholder_refs ?? [],
      templateRefs: deliverables
        .map((d) => d?.template_ref)
        .filter((r): r is string => typeof r === 'string' && r.length > 0),
    };
  }

  /**
   * What is waiting on the user. The agent never sets Done by design, so work
   * parks in Needs Review until the user looks at it — that queue is the single
   * most actionable thing on the screen and leads the list.
   */
  private buildAttention(
    open: TaskFacts[],
    now: Date,
    waitingDays: (f: TaskFacts) => number,
    nameById: Map<string, string>,
  ): InsightsAttentionItem[] {
    const RANK: Record<InsightsAttentionItem['reason'], number> = {
      overdue: 0,
      review: 1,
      due_soon: 2,
      stalled: 3,
    };

    const items: InsightsAttentionItem[] = [];

    for (const f of open) {
      // `due` is the end of the due day, which is what decides overdue — a task
      // due today is not late until the day is over. `daysToDue` is the
      // calendar-day count, which is what the row actually says out loud.
      const due = typeof f.task.due_date === 'string' ? endOfDay(f.task.due_date) : null;
      const daysToDue = due === null ? undefined : calendarDaysUntil(due, now);
      const waiting = waitingDays(f);

      let reason: InsightsAttentionItem['reason'] | null = null;
      if (due !== null && due < now) reason = 'overdue';
      else if (isAwaitingReview(f.status)) reason = 'review';
      else if (daysToDue !== undefined && daysToDue <= 3) reason = 'due_soon';
      else if (waiting >= 14) reason = 'stalled';

      if (reason === null) continue;

      const item: InsightsAttentionItem = {
        id: f.task.id,
        title: f.task.title,
        status: f.status,
        priority: (f.task.priority ?? 'medium') as Priority,
        reason,
        waiting_days: waiting,
        stakeholders: f.stakeholderRefs.map((ref) => nameById.get(ref) ?? ref),
      };
      if (typeof f.task.due_date === 'string') item.due_date = f.task.due_date;
      if (daysToDue !== undefined) item.days_to_due = daysToDue;
      items.push(item);
    }

    return items.sort((a, b) => {
      const byReason = RANK[a.reason] - RANK[b.reason];
      if (byReason !== 0) return byReason;
      return b.waiting_days - a.waiting_days;
    });
  }

  /** Task volume per stakeholder, with ids resolved to real names. */
  private async stakeholderBars(
    facts: TaskFacts[],
    since: Date | null,
    people: Stakeholder[],
  ): Promise<InsightsBar[]> {
    const counts = new Map<string, number>();
    for (const f of facts) {
      if (!this.countsTowardEffort(f, since)) continue;
      for (const ref of new Set(f.stakeholderRefs)) {
        counts.set(ref, (counts.get(ref) ?? 0) + 1);
      }
    }
    if (counts.size === 0) return [];

    const byId = new Map(people.map((p) => [p.id, p]));

    return this.toBars(counts, (ref) => {
      const person = byId.get(ref);
      const bar: Omit<InsightsBar, 'key' | 'value'> = {
        label: person?.name ?? ref,
        href: `/stakeholders/${ref}`,
      };
      const sub = [person?.role, person?.organization].filter(Boolean).join(' · ');
      if (sub) bar.sublabel = sub;
      return bar;
    });
  }

  /**
   * Task volume per output template, with `template_ref` resolved to the
   * template's registered name rather than the raw file format — the same
   * distinction the agent instructions apply to "output type" columns.
   */
  private async outputBars(facts: TaskFacts[], since: Date | null): Promise<InsightsBar[]> {
    const counts = new Map<string, number>();
    for (const f of facts) {
      if (!this.countsTowardEffort(f, since)) continue;
      for (const ref of new Set(f.templateRefs)) {
        counts.set(ref, (counts.get(ref) ?? 0) + 1);
      }
    }
    if (counts.size === 0) return [];

    const templates = await outputService.listTemplates().catch(() => []);
    const byId = new Map(templates.map((t) => [t.id, t]));

    return this.toBars(counts, (ref) => {
      const template = byId.get(ref);
      const bar: Omit<InsightsBar, 'key' | 'value'> = {
        label: template?.name ?? ref.replace(/^OUT-/, ''),
      };
      if (template?.format) bar.sublabel = template.format.toUpperCase();
      return bar;
    });
  }

  /**
   * Tasks that took more than one agent run. A high run count means the brief
   * was ambiguous or the output template was wrong, which is the actionable
   * part — not the count itself.
   */
  private reworkBars(facts: TaskFacts[], since: Date | null): InsightsBar[] {
    return facts
      .filter((f) => f.runs > 1 && this.countsTowardEffort(f, since))
      .sort((a, b) => b.runs - a.runs)
      .slice(0, 8)
      .map((f) => ({
        key: f.task.id,
        label: f.task.title,
        sublabel: f.task.id,
        value: f.runs,
        href: `/board/task/${f.task.id}`,
      }));
  }

  /**
   * Kaizen entries by area. These are the lessons the workspace captured after
   * something went wrong, so the tall bar is the area that keeps biting.
   */
  private kaizenBars(workspacePath: string, since: Date | null): InsightsBar[] {
    const dir = path.join(workspacePath, 'kaizen');
    let files: string[] = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
    } catch {
      return [];
    }

    const field = (frontmatter: string, key: string): string | undefined =>
      frontmatter
        .match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))?.[1]
        .trim()
        .replace(/^['"]|['"]$/g, '');

    const counts = new Map<string, number>();
    for (const file of files) {
      let area = 'uncategorised';
      try {
        const raw = fs.readFileSync(path.join(dir, file), 'utf-8');
        const frontmatter = raw.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';

        // Honour the window like every other panel, so switching to 7 days
        // does not leave this one card showing all-time counts.
        const raised = parseDate(field(frontmatter, 'created_at') ?? field(frontmatter, 'applied_at'));
        if (since !== null && raised !== null && raised < since) continue;

        area = field(frontmatter, 'area') || area;
      } catch {
        // Unreadable entry still counts as a lesson, just an uncategorised one.
      }
      counts.set(area, (counts.get(area) ?? 0) + 1);
    }

    return this.toBars(counts, (area) => ({
      label: area.replace(/[-_]/g, ' ').replace(/^./, (c) => c.toUpperCase()),
    }));
  }

  /** Tasks created vs completed per week — is output keeping up with intake? */
  private weeklyFlow(
    facts: TaskFacts[],
    now: Date,
    windowDays: number | null,
  ): InsightsData['weekly'] {
    const span = windowDays ?? this.spanDays(facts, now);
    const weekCount = Math.max(2, Math.min(26, Math.ceil(span / 7)));

    const weeks: string[] = [];
    for (let i = weekCount - 1; i >= 0; i--) {
      weeks.push(weekKey(new Date(now.getTime() - i * 7 * DAY_MS)));
    }

    const rows = new Map(weeks.map((w) => [w, { week: w, created: 0, completed: 0 }]));
    for (const f of facts) {
      const created = f.createdAt && rows.get(weekKey(f.createdAt));
      if (created) created.created += 1;
      const done = f.completedAt && rows.get(weekKey(f.completedAt));
      if (done) done.completed += 1;
    }
    return weeks.map((w) => rows.get(w)!);
  }

  /** How many days of history the workspace actually has. */
  private spanDays(facts: TaskFacts[], now: Date): number {
    const earliest = facts
      .map((f) => f.createdAt)
      .filter((d): d is Date => d !== null)
      .sort((a, b) => a.getTime() - b.getTime())[0];
    if (!earliest) return 30;
    return Math.max(14, Math.ceil((now.getTime() - earliest.getTime()) / DAY_MS));
  }

  private bucketTurnarounds(hours: number[]): InsightsData['turnaround_buckets'] {
    return TURNAROUND_BUCKETS.map(({ label, maxHours }, i) => {
      const min = i === 0 ? -Infinity : TURNAROUND_BUCKETS[i - 1].maxHours;
      return { label, count: hours.filter((h) => h > min && h <= maxHours).length };
    });
  }

  /**
   * Effort panels count a task when it was created or finished in the window,
   * so a task written last month and approved today still shows up.
   */
  private countsTowardEffort(f: TaskFacts, since: Date | null): boolean {
    if (since === null) return true;
    if (f.createdAt && f.createdAt >= since) return true;
    if (f.completedAt && f.completedAt >= since) return true;
    return isOpen(f.status);
  }

  private toBars(
    counts: Map<string, number>,
    describe: (key: string) => Omit<InsightsBar, 'key' | 'value'>,
  ): InsightsBar[] {
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 8)
      .map(([key, value]) => ({ key, value, ...describe(key) }));
  }
}
