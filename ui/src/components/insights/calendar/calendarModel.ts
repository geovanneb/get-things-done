/**
 * Date maths and summaries for the activity calendar.
 *
 * Every date is a local `YYYY-MM-DD` key, the same shape the API returns.
 * Keys are built from local date parts and never through `toISOString()`,
 * which would shift days for anyone east of UTC. Weeks start on Sunday, like
 * the weekly chart.
 */
import type { InsightsCalendarDay } from '@/types';
import type { WindowValue } from '../WindowFilter';

export type CalendarMetric = 'activity' | 'completed' | 'created' | 'runs';

/**
 * How the calendar draws each window of the Insights filter. The filter picks
 * the period; the calendar only picks the shape that reads best for it.
 */
export type CalendarLayout = 'week' | 'month' | 'months' | 'years';

export function layoutFor(window: WindowValue): CalendarLayout {
  if (window === '7') return 'week';
  if (window === '30') return 'month';
  if (window === '90') return 'months';
  return 'years';
}

export const METRICS: Array<{ value: CalendarMetric; label: string; one: string; many: string }> = [
  { value: 'activity', label: 'Activity', one: 'event', many: 'events' },
  { value: 'completed', label: 'Completed', one: 'task completed', many: 'tasks completed' },
  { value: 'created', label: 'Created', one: 'task created', many: 'tasks created' },
  { value: 'runs', label: 'Agent runs', one: 'agent run', many: 'agent runs' },
];

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
export const WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function dayKey(date: Date): string {
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${m}-${d}`;
}

/** Local midnight of a key. */
export function fromKey(key: string): Date {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(key: string, n: number): string {
  const d = fromKey(key);
  d.setDate(d.getDate() + n);
  return dayKey(d);
}

export function startOfWeek(key: string): string {
  return addDays(key, -fromKey(key).getDay());
}

export function weekday(key: string): number {
  return fromKey(key).getDay();
}

export function monthIndex(key: string): number {
  return Number(key.slice(5, 7)) - 1;
}

/** Every key from `from` to `to`, inclusive. */
export function keysBetween(from: string, to: string): string[] {
  const keys: string[] = [];
  for (let k = from; k <= to; k = addDays(k, 1)) keys.push(k);
  return keys;
}

/** "Tue 14 Oct" */
export function shortDay(key: string): string {
  const d = fromKey(key);
  return `${WEEKDAYS_SHORT[d.getDay()]} ${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}`;
}

/** "Tuesday 14 October 2026" */
export function longDay(key: string): string {
  const d = fromKey(key);
  return `${WEEKDAYS_LONG[d.getDay()]} ${d.getDate()} ${MONTHS_LONG[d.getMonth()]} ${d.getFullYear()}`;
}

/** First day of every month the range touches, oldest first. */
export function monthsBetween(from: string, to: string): string[] {
  const months: string[] = [];
  const d = fromKey(from);
  d.setDate(1);
  while (dayKey(d) <= to) {
    months.push(dayKey(d));
    d.setMonth(d.getMonth() + 1);
  }
  return months;
}

/** Last day of the month a key falls in. */
export function endOfMonth(key: string): string {
  const d = fromKey(key);
  return dayKey(new Date(d.getFullYear(), d.getMonth() + 1, 0));
}

export function monthLong(key: string): string {
  const d = fromKey(key);
  return `${MONTHS_LONG[d.getMonth()]} ${d.getFullYear()}`;
}

export function monthShort(i: number): string {
  return MONTHS_SHORT[i];
}

export function weekdayLong(i: number): string {
  return WEEKDAYS_LONG[i];
}

export function metricValue(day: InsightsCalendarDay | undefined, metric: CalendarMetric): number {
  return day ? day[metric] : 0;
}

export function countLabel(value: number, metric: CalendarMetric): string {
  const m = METRICS.find((x) => x.value === metric)!;
  return `${value} ${value === 1 ? m.one : m.many}`;
}

/** Number of colour steps above zero. Matches the five `--chart-ramp-*` tokens. */
export const STEPS = 5;

/**
 * Colour scale for a set of values: 0 stays empty, then five steps.
 *
 * The top step starts at the 90th percentile of non-zero values, so one huge
 * day cannot wash every other day out to the palest step. The cap never drops
 * below 5, so in a quiet workspace the steps are simply 1, 2, 3, 4 and 5+, and
 * a single event never looks as heavy as a busy day.
 */
export function buildScale(values: number[]): { step: (v: number) => number; labels: string[] } {
  const nonZero = values.filter((v) => v > 0).sort((a, b) => a - b);
  const p90 = nonZero.length === 0 ? 0 : nonZero[Math.floor((nonZero.length - 1) * 0.9)];
  const cap = Math.max(STEPS, p90);
  const step = (v: number) => (v <= 0 ? 0 : Math.max(1, Math.min(STEPS, Math.ceil((v / cap) * STEPS))));

  const labels: string[] = [];
  let lo = 1;
  for (let k = 1; k <= STEPS; k++) {
    const hi = Math.floor((k * cap) / STEPS);
    labels.push(k === STEPS ? `${lo}+` : hi > lo ? `${lo}-${hi}` : String(lo));
    lo = hi + 1;
  }
  return { step, labels };
}

/** Median of the non-zero values: what a normal active day looks like. */
export function typicalDay(values: number[]): number | null {
  const nonZero = values.filter((v) => v > 0).sort((a, b) => a - b);
  if (nonZero.length === 0) return null;
  const mid = Math.floor(nonZero.length / 2);
  return nonZero.length % 2 ? nonZero[mid] : (nonZero[mid - 1] + nonZero[mid]) / 2;
}

export interface Callout {
  label: string;
  value: string;
}

/**
 * One short line of answers above the grid, so nobody has to read the heatmap
 * to get the point.
 */
export function summarize(
  days: InsightsCalendarDay[],
  metric: CalendarMetric,
  layout: CalendarLayout,
): Callout[] {
  const value = (d: InsightsCalendarDay) => metricValue(d, metric);
  const total = days.reduce((sum, d) => sum + value(d), 0);
  if (total === 0) return [];

  const out: Callout[] = [];
  const busiest = days.reduce((best, d) => (value(d) > value(best) ? d : best));
  out.push({ label: 'Busiest day', value: `${shortDay(busiest.date)} (${value(busiest)})` });

  if (layout === 'years') {
    const byMonth = new Map<string, number>();
    for (const d of days) {
      const key = `${d.date.slice(0, 7)}-01`;
      byMonth.set(key, (byMonth.get(key) ?? 0) + value(d));
    }
    const [top, n] = [...byMonth.entries()].reduce((best, e) => (e[1] > best[1] ? e : best));
    out.push({ label: 'Busiest month', value: `${monthLong(top)} (${n})` });
  }

  if (days.length >= 14) {
    const sums = new Array(7).fill(0);
    const counts = new Array(7).fill(0);
    for (const d of days) {
      sums[weekday(d.date)] += value(d);
      counts[weekday(d.date)] += 1;
    }
    const avg = sums.map((s, i) => (counts[i] ? s / counts[i] : 0));
    out.push({ label: 'Busiest weekday', value: `${WEEKDAYS_LONG[avg.indexOf(Math.max(...avg))]}s` });
  }

  let best = 0;
  let run = 0;
  for (const d of days) {
    run = value(d) > 0 ? run + 1 : 0;
    best = Math.max(best, run);
  }
  if (best > 1) out.push({ label: 'Longest streak', value: `${best} days in a row` });

  out.push({ label: 'Total', value: countLabel(total, metric) });
  return out;
}
