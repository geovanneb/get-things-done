import {
  InsightsCalendar,
  InsightsCalendarDay,
  InsightsCalendarDayDetail,
  InsightsCalendarEvent,
  Priority,
} from '../types';
import { InsightsService, TaskFacts } from './insightsService';
import { StakeholderService } from './stakeholderService';
import { isOpen } from './taskStatus';

const insightsService = new InsightsService();
const stakeholderService = new StakeholderService();

/** The same windows the Insights filter offers. `all` starts at the first recorded activity. */
const CALENDAR_WINDOWS = new Set([7, 30, 90]);

/** Ranges up to this long also get an hour-of-day breakdown, for the week view. */
export const HOURLY_MAX_DAYS = 31;

const DAY_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Local `YYYY-MM-DD` for a moment.
 *
 * Built from local date parts, like `weekKey()` in InsightsService: going
 * through `toISOString()` would file a task created at 08:00 in Tokyo under
 * the previous day.
 */
export function dayKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * Strict `YYYY-MM-DD` that names a real date, or null.
 *
 * `Date.parse` accepts far more than this and quietly rolls `2026-02-30` over
 * to March, so the value is rebuilt and compared instead.
 */
export function parseDayKey(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const parts = value.match(DAY_KEY);
  if (!parts) return null;
  const date = new Date(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]));
  return dayKey(date) === value ? value : null;
}

/** Local midnight of a valid day key. */
function startOfDayKey(key: string): Date {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/**
 * Every day key from `from` to `to`, inclusive.
 *
 * Steps with `setDate` rather than adding 24 hours, so a daylight saving
 * change cannot skip or repeat a day.
 */
export function daysInRange(from: string, to: string): string[] {
  const keys: string[] = [];
  const cursor = startOfDayKey(from);
  while (dayKey(cursor) <= to) {
    keys.push(dayKey(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return keys;
}

/** Number of days from `from` to `to`, inclusive. Both must be valid keys. */
export function rangeLength(from: string, to: string): number {
  const ms = startOfDayKey(to).getTime() - startOfDayKey(from).getTime();
  // Round, because a DST change makes the gap an hour short or long.
  return Math.round(ms / (24 * 60 * 60 * 1000)) + 1;
}

/**
 * The window from the Insights filter: 7, 30 or 90 days, or `all`. Returns
 * undefined for anything else, so the route can refuse it. Query values can be
 * arrays or anything else at runtime, so nothing is assumed from the types.
 */
export function parseCalendarWindow(raw: unknown): number | null | undefined {
  if (raw === 'all') return null;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return undefined;
  const days = Number(raw);
  return CALENDAR_WINDOWS.has(days) ? days : undefined;
}

/**
 * The days a window covers: the last N calendar days including today, or for
 * `all`, from the first day anything happened. Whole local days, so the grid
 * never starts halfway through a day the way a rolling 24-hour cut would.
 */
export function windowRange(
  days: number | null,
  facts: TaskFacts[],
  now: Date,
): { from: string; to: string } {
  const to = dayKey(now);
  if (days !== null) {
    const from = new Date(now);
    from.setDate(from.getDate() - (days - 1));
    return { from: dayKey(from), to };
  }
  let earliest = to;
  for (const f of facts) {
    for (const at of [f.createdAt, f.completedAt, ...f.runTimes]) {
      if (at !== null) {
        const key = dayKey(at);
        if (key < earliest) earliest = key;
      }
    }
  }
  return { from: earliest, to };
}

/** A due date as a day key plus whether it is already past. */
function dueOf(value: unknown, now: Date): { key: string; past: boolean } | null {
  if (typeof value !== 'string' || !value) return null;
  // A bare date means that whole local day, so it is late only once the day is over.
  const bare = parseDayKey(value);
  if (bare) return { key: bare, past: bare < dayKey(now) };
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return null;
  const due = new Date(parsed);
  return { key: dayKey(due), past: due < now };
}

/** One task's footprint on one day. */
interface TaskOnDay {
  facts: TaskFacts;
  events: Set<InsightsCalendarEvent>;
  runs: number;
  /** Due this day, still open and already late. */
  overdue: boolean;
  /** Created, completed and runs together; ranks the busiest tasks of the day. */
  weight: number;
}

interface DayAccumulator {
  created: number;
  completed: number;
  runs: number;
  due: number;
  overdue: number;
  byHour: number[];
  tasks: Map<string, TaskOnDay>;
}

/**
 * Spread every task's dated events over the days in range.
 *
 * Event times follow the same rules as the rest of Insights: completion is
 * `TaskFacts.completedAt` (done_date, then the fallbacks documented there),
 * and runs are the execution logs. Due dates have no time of day, so they
 * never appear in the hourly breakdown.
 */
export function aggregateDays(
  facts: TaskFacts[],
  from: string,
  to: string,
  now: Date,
): Map<string, DayAccumulator> {
  const days = new Map<string, DayAccumulator>();
  for (const key of daysInRange(from, to)) {
    days.set(key, {
      created: 0,
      completed: 0,
      runs: 0,
      due: 0,
      overdue: 0,
      byHour: new Array(24).fill(0),
      tasks: new Map(),
    });
  }

  const touch = (day: DayAccumulator, f: TaskFacts): TaskOnDay => {
    let entry = day.tasks.get(f.task.id);
    if (!entry) {
      entry = { facts: f, events: new Set(), runs: 0, overdue: false, weight: 0 };
      day.tasks.set(f.task.id, entry);
    }
    return entry;
  };

  const timed = (f: TaskFacts, at: Date | null, event: 'created' | 'completed' | 'ran'): void => {
    if (at === null) return;
    const day = days.get(dayKey(at));
    if (!day) return;
    if (event === 'created') day.created += 1;
    else if (event === 'completed') day.completed += 1;
    else day.runs += 1;
    day.byHour[at.getHours()] += 1;
    const entry = touch(day, f);
    entry.events.add(event);
    entry.weight += 1;
    if (event === 'ran') entry.runs += 1;
  };

  for (const f of facts) {
    timed(f, f.createdAt, 'created');
    timed(f, f.completedAt, 'completed');
    for (const at of f.runTimes) timed(f, at, 'ran');

    const due = dueOf(f.task.due_date, now);
    const day = due && days.get(due.key);
    if (day && due) {
      const entry = touch(day, f);
      entry.events.add('due');
      day.due += 1;
      if (due.past && isOpen(f.status)) {
        day.overdue += 1;
        entry.overdue = true;
      }
    }
  }

  return days;
}

/** Busiest first, then by title so the order is stable between refreshes. */
function rankTasks(day: DayAccumulator): TaskOnDay[] {
  return [...day.tasks.values()].sort(
    (a, b) => b.weight - a.weight || a.facts.task.title.localeCompare(b.facts.task.title),
  );
}

function rankStakeholders(
  tasks: TaskOnDay[],
  nameById: Map<string, string>,
): Array<{ ref: string; name: string; count: number }> {
  const counts = new Map<string, number>();
  for (const t of tasks) {
    for (const ref of new Set(t.facts.stakeholderRefs)) {
      counts.set(ref, (counts.get(ref) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([ref, count]) => ({ ref, name: nameById.get(ref) ?? ref, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/** Shape the per-day accumulators into the range payload. */
export function buildCalendar(
  facts: TaskFacts[],
  from: string,
  to: string,
  now: Date,
  nameById: Map<string, string>,
): Omit<InsightsCalendar, 'window_days'> {
  const hourly = rangeLength(from, to) <= HOURLY_MAX_DAYS;
  const days: InsightsCalendarDay[] = [];

  for (const [date, day] of aggregateDays(facts, from, to, now)) {
    const ranked = rankTasks(day);
    const row: InsightsCalendarDay = {
      date,
      created: day.created,
      completed: day.completed,
      runs: day.runs,
      due: day.due,
      overdue: day.overdue,
      activity: day.created + day.completed + day.runs,
      task_count: day.tasks.size,
      top_tasks: ranked.slice(0, 3).map((t) => ({ id: t.facts.task.id, title: t.facts.task.title })),
      top_stakeholders: rankStakeholders(ranked, nameById)
        .slice(0, 3)
        .map(({ ref, name }) => ({ ref, name })),
    };
    if (hourly) row.by_hour = day.byHour;
    days.push(row);
  }

  return { generated_at: now.toISOString(), from, to, today: dayKey(now), days };
}

/** Event order in the day panel: what happened first in a task's life first. */
const EVENT_ORDER: InsightsCalendarEvent[] = ['created', 'ran', 'completed', 'due'];

/** Shape one day into the pinned day panel payload. */
export function buildDayDetail(
  facts: TaskFacts[],
  date: string,
  now: Date,
  nameById: Map<string, string>,
): InsightsCalendarDayDetail {
  const day = aggregateDays(facts, date, date, now).get(date)!;
  const ranked = rankTasks(day);

  return {
    generated_at: now.toISOString(),
    date,
    totals: {
      created: day.created,
      completed: day.completed,
      runs: day.runs,
      due: day.due,
      overdue: day.overdue,
      activity: day.created + day.completed + day.runs,
    },
    tasks: ranked.map((t) => {
      const task = t.facts.task;
      const row: InsightsCalendarDayDetail['tasks'][number] = {
        id: task.id,
        title: task.title,
        status: t.facts.status,
        priority: (task.priority ?? 'medium') as Priority,
        events: EVENT_ORDER.filter((e) => t.events.has(e)),
        runs: t.runs,
        overdue: t.overdue,
        stakeholders: t.facts.stakeholderRefs.map((ref) => nameById.get(ref) ?? ref),
      };
      if (typeof task.due_date === 'string') row.due_date = task.due_date;
      return row;
    }),
    stakeholders: rankStakeholders(ranked, nameById),
  };
}

async function stakeholderNames(): Promise<Map<string, string>> {
  const people = await stakeholderService.listStakeholders().catch(() => []);
  return new Map(people.map((p) => [p.id, p.name]));
}

/** Calendar for a window from the Insights filter. */
export async function getCalendar(days: number | null): Promise<InsightsCalendar> {
  const [facts, names] = await Promise.all([insightsService.loadFacts(), stakeholderNames()]);
  const now = new Date();
  const { from, to } = windowRange(days, facts, now);
  return { ...buildCalendar(facts, from, to, now, names), window_days: days };
}

/** Day panel for a validated day. */
export async function getCalendarDay(date: string): Promise<InsightsCalendarDayDetail> {
  const [facts, names] = await Promise.all([insightsService.loadFacts(), stakeholderNames()]);
  return buildDayDetail(facts, date, new Date(), names);
}
