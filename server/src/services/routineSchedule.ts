/**
 * When a routine fires. A small, dependency-free subset of calendar recurrence
 * (daily / weekly / monthly with an interval), evaluated in the machine's local time.
 *
 * Everything here is pure: given a schedule and a time window it returns the
 * occurrences inside it. The routine engine decides what to do with them, which is
 * what makes catch-up after the computer was off possible: it simply asks for the
 * occurrences since the last check.
 */

export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type Weekday = (typeof WEEKDAYS)[number];
export type Frequency = 'daily' | 'weekly' | 'monthly';

export interface Schedule {
  frequency: Frequency;
  /** Every N days, weeks or months. */
  interval: number;
  /** Weekly: the days it fires on. */
  weekdays: Weekday[];
  /** Monthly by date: 1-31, or -1 for the last day. Days past the end of a short month fall on its last day. */
  month_day: number | null;
  /** Monthly by weekday: 1-4, or -1 for the last one (with month_weekday). */
  month_week: number | null;
  month_weekday: Weekday | null;
  /** Local time, HH:MM. */
  time: string;
  /** First day it may fire, YYYY-MM-DD. Weekly and monthly intervals count from here. */
  starts_on: string;
  /** Last day it may fire, YYYY-MM-DD, or null for never. */
  ends_on: string | null;
}

export class ScheduleError extends Error {
  statusCode = 400;
}

const DAY_MS = 86_400_000;
const WEEKDAY_NAMES: Record<Weekday, string> = {
  mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday',
};
const ORDINALS: Record<string, string> = { '1': 'first', '2': 'second', '3': 'third', '4': 'fourth', '-1': 'last' };

/** A calendar date as a day count, independent of time zones and DST. */
function dayNumber(y: number, m: number, d: number): number {
  return Math.floor(Date.UTC(y, m, d) / DAY_MS);
}

function parseDate(value: string): { y: number; m: number; d: number } {
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  return { y, m: m - 1, d };
}

export function isDateOnly(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const { y, m, d } = parseDate(value);
  const date = new Date(Date.UTC(y, m, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m && date.getUTCDate() === d;
}

/** YYYY-MM-DD of a Date in local time. */
export function localDate(date: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

/** Adds whole calendar days to a YYYY-MM-DD date. */
export function addDays(date: string, days: number): string {
  const { y, m, d } = parseDate(date);
  return new Date(Date.UTC(y, m, d + days)).toISOString().slice(0, 10);
}

/** Monday = 0 ... Sunday = 6. */
function weekdayIndex(y: number, m: number, d: number): number {
  return (new Date(Date.UTC(y, m, d)).getUTCDay() + 6) % 7;
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
}

function asInt(value: unknown, field: string, min: number, max: number): number {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max) {
    throw new ScheduleError(`Invalid schedule.${field}: use a whole number from ${min} to ${max}`);
  }
  return n;
}

function asWeekday(value: unknown, field: string): Weekday {
  if (typeof value !== 'string' || !(WEEKDAYS as readonly string[]).includes(value)) {
    throw new ScheduleError(`Invalid schedule.${field}: use ${WEEKDAYS.join(', ')}`);
  }
  return value as Weekday;
}

/** Validates a schedule from a request or a routine file. Values from YAML may be Dates or numeric strings. */
export function parseSchedule(raw: unknown): Schedule {
  if (!raw || typeof raw !== 'object') throw new ScheduleError('Invalid schedule');
  const o = raw as Record<string, unknown>;
  const dateField = (v: unknown): unknown => (v instanceof Date ? v.toISOString().slice(0, 10) : v);

  const frequency = o['frequency'];
  if (frequency !== 'daily' && frequency !== 'weekly' && frequency !== 'monthly') {
    throw new ScheduleError('Invalid schedule.frequency: use daily, weekly or monthly');
  }
  const interval = o['interval'] === undefined || o['interval'] === null ? 1 : asInt(o['interval'], 'interval', 1, 99);

  let time = o['time'] === undefined || o['time'] === null ? '09:00' : o['time'];
  // YAML 1.1 reads an unquoted 18:30 as the base-60 number 1110. Accept it as the time it was written as.
  if (typeof time === 'number' && Number.isInteger(time) && time >= 0 && time < 24 * 60) {
    time = `${String(Math.floor(time / 60)).padStart(2, '0')}:${String(time % 60).padStart(2, '0')}`;
  }
  if (typeof time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
    throw new ScheduleError('Invalid schedule.time: use HH:MM (24-hour)');
  }

  const startsOn = dateField(o['starts_on']);
  if (!isDateOnly(startsOn)) throw new ScheduleError('Invalid schedule.starts_on: use YYYY-MM-DD');
  const endsRaw = dateField(o['ends_on']);
  const endsOn = endsRaw === undefined || endsRaw === null || endsRaw === '' ? null : endsRaw;
  if (endsOn !== null && !isDateOnly(endsOn)) throw new ScheduleError('Invalid schedule.ends_on: use YYYY-MM-DD');
  if (endsOn !== null && endsOn < startsOn) throw new ScheduleError('Invalid schedule.ends_on: it is before starts_on');

  const schedule: Schedule = {
    frequency, interval, weekdays: [], month_day: null, month_week: null, month_weekday: null,
    time, starts_on: startsOn, ends_on: endsOn,
  };

  if (frequency === 'weekly') {
    const days = Array.isArray(o['weekdays']) ? o['weekdays'] : [];
    const set = new Set(days.map((d, i) => asWeekday(d, `weekdays[${i}]`)));
    if (set.size === 0) throw new ScheduleError('Invalid schedule.weekdays: pick at least one day');
    schedule.weekdays = WEEKDAYS.filter((d) => set.has(d));
  }

  if (frequency === 'monthly') {
    const hasWeekday = o['month_weekday'] !== undefined && o['month_weekday'] !== null;
    if (hasWeekday) {
      const week = asInt(o['month_week'], 'month_week', -1, 4);
      if (week === 0) throw new ScheduleError('Invalid schedule.month_week: use 1-4, or -1 for the last');
      schedule.month_week = week;
      schedule.month_weekday = asWeekday(o['month_weekday'], 'month_weekday');
    } else {
      const day = asInt(o['month_day'] ?? Number(startsOn.slice(8)), 'month_day', -1, 31);
      if (day === 0) throw new ScheduleError('Invalid schedule.month_day: use 1-31, or -1 for the last day');
      schedule.month_day = day;
    }
  }

  return schedule;
}

/** Whether the schedule fires on this calendar day (ignoring the time of day). */
function firesOn(s: Schedule, y: number, m: number, d: number): boolean {
  const start = parseDate(s.starts_on);
  const day = dayNumber(y, m, d);
  const startDay = dayNumber(start.y, start.m, start.d);
  if (day < startDay) return false;
  if (s.ends_on) {
    const end = parseDate(s.ends_on);
    if (day > dayNumber(end.y, end.m, end.d)) return false;
  }

  if (s.frequency === 'daily') return (day - startDay) % s.interval === 0;

  if (s.frequency === 'weekly') {
    const wd = weekdayIndex(y, m, d);
    if (!s.weekdays.includes(WEEKDAYS[wd]!)) return false;
    // Weeks run Monday to Sunday and are counted from the week that contains starts_on.
    const startWeek = startDay - weekdayIndex(start.y, start.m, start.d);
    const thisWeek = day - wd;
    return ((thisWeek - startWeek) / 7) % s.interval === 0;
  }

  const months = (y * 12 + m) - (start.y * 12 + start.m);
  if (months % s.interval !== 0) return false;
  const last = daysInMonth(y, m);
  if (s.month_weekday) {
    if (WEEKDAYS[weekdayIndex(y, m, d)] !== s.month_weekday) return false;
    if (s.month_week === -1) return d + 7 > last;
    return Math.ceil(d / 7) === s.month_week;
  }
  const target = s.month_day === -1 ? last : Math.min(s.month_day ?? 1, last);
  return d === target;
}

function atTime(s: Schedule, y: number, m: number, d: number): Date {
  const [hh, mm] = s.time.split(':').map(Number) as [number, number];
  return new Date(y, m, d, hh, mm, 0, 0);
}

/**
 * Occurrences after `from` (exclusive) up to `to` (inclusive), oldest first.
 * The window is walked day by day, so it is capped to keep a years-long gap cheap.
 */
export function occurrencesBetween(s: Schedule, from: Date, to: Date, maxDays = 800): Date[] {
  const out: Date[] = [];
  if (to <= from) return out;
  const start = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const lastDay = dayNumber(to.getFullYear(), to.getMonth(), to.getDate());
  let firstDay = dayNumber(start.getFullYear(), start.getMonth(), start.getDate());
  if (lastDay - firstDay > maxDays) firstDay = lastDay - maxDays;

  for (let day = firstDay; day <= lastDay; day++) {
    const date = new Date(day * DAY_MS);
    const y = date.getUTCFullYear(), m = date.getUTCMonth(), d = date.getUTCDate();
    if (!firesOn(s, y, m, d)) continue;
    const at = atTime(s, y, m, d);
    if (at > from && at <= to) out.push(at);
  }
  return out;
}

/** The next `count` occurrences, including distant starts and the maximum interval. */
export function nextOccurrences(s: Schedule, after: Date, count: number): Date[] {
  const out: Date[] = [];
  const start = parseDate(s.starts_on);
  const first = Math.max(dayNumber(after.getFullYear(), after.getMonth(), after.getDate()), dayNumber(start.y, start.m, start.d));
  // Every supported schedule fires at least once within this many days.
  const gap = s.interval * (s.frequency === 'monthly' ? 31 : s.frequency === 'weekly' ? 7 : 1) + 7;
  const end = s.ends_on ? parseDate(s.ends_on) : null;
  const last = Math.min(first + gap * count, end ? dayNumber(end.y, end.m, end.d) : Infinity);
  for (let day = first; day <= last && out.length < count; day++) {
    const date = new Date(day * DAY_MS);
    const y = date.getUTCFullYear(), m = date.getUTCMonth(), d = date.getUTCDate();
    if (!firesOn(s, y, m, d)) continue;
    const at = atTime(s, y, m, d);
    if (at > after) out.push(at);
  }
  return out;
}

function list(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** A sentence for people: "Every 2 weeks on Monday at 09:00". */
export function describeSchedule(s: Schedule): string {
  const every = (unit: string) => (s.interval === 1 ? `Every ${unit}` : `Every ${s.interval} ${unit}s`);
  let text: string;
  if (s.frequency === 'daily') {
    text = s.interval === 1 ? 'Every day' : every('day');
  } else if (s.frequency === 'weekly') {
    const weekdays = ['mon', 'tue', 'wed', 'thu', 'fri'];
    const days = s.weekdays.length === 5 && weekdays.every((d) => s.weekdays.includes(d as Weekday))
      ? 'every weekday'
      : list(s.weekdays.map((d) => WEEKDAY_NAMES[d]));
    text = s.interval === 1
      ? (days === 'every weekday' ? 'Every weekday' : `Every ${days}`)
      : `${every('week')} on ${days === 'every weekday' ? 'weekdays' : days}`;
  } else if (s.month_weekday) {
    text = `${every('month')} on the ${ORDINALS[String(s.month_week)]} ${WEEKDAY_NAMES[s.month_weekday]}`;
  } else {
    const day = s.month_day === -1 ? 'the last day' : `day ${s.month_day}`;
    text = `${every('month')} on ${day}`;
  }
  text += ` at ${s.time}`;
  if (s.ends_on) text += `, until ${s.ends_on}`;
  return text;
}
