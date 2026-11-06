import { en } from '../../../server/src/i18n/en';
import type { MessageKey } from '../../../server/src/i18n/messages';
import { currentLocale, listText, tr } from './current';

const serverMessages = new Map(Object.entries(en).filter(([key]) => key.startsWith('server.')).map(([key, text]) => [text as string, key as MessageKey]));

/** Fixed English text the server sends (model notes, run checks) in the interface language; anything else stays as sent. */
export function serverText(text: string): string;
export function serverText(text: string | null | undefined): string | null | undefined;
export function serverText(text: string | null | undefined) {
  if (!text) return text;
  const key = serverMessages.get(text);
  if (key) return (tr as unknown as (key: MessageKey) => string)(key);
  const memory = /^This computer has (\d+) GB of memory\. (.+) needs about ([\d.]+) GB while it transcribes; (.+) needs under 1 GB\.$/.exec(text);
  if (memory) return tr('server.lowMemory', { total: memory[1], heavy: memory[2], needed: memory[3], light: memory[4] });
  const billed = /^This workspace's \.claude\/settings\.json sets (.+), which would bill an API account instead of your plan\. Remove it to run from the dashboard\.$/.exec(text);
  if (billed) return tr('server.workspaceAuth', { settings: billed[1] });
  return text;
}

/** A transcription language in the interface language; the server's English name is the fallback. */
export function languageName(id: string, fallback: string): string {
  try { return new Intl.DisplayNames([currentLocale()], { type: 'language' }).of(id) ?? fallback; }
  catch { return fallback; }
}

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const weekdayName = (name: string) => {
  const index = WEEKDAYS.indexOf(name);
  // 2 November 2026 is a Monday.
  return index < 0 ? name : new Intl.DateTimeFormat(currentLocale(), { weekday: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2026, 10, 2 + index)));
};
const weekdayList = (names: string) => listText(names.split(/, | and /).map(weekdayName));
const ordinals: Record<string, () => string> = {
  first: () => tr('routineEditor.first'), second: () => tr('routineEditor.second'), third: () => tr('routineEditor.third'),
  fourth: () => tr('routineEditor.fourth'), last: () => tr('routineEditor.last'),
};

/** The server describes a schedule in one fixed English grammar (`describeSchedule`); this reads that sentence back. */
export function scheduleText(text: string): string {
  const parts = /^(.+) at (\d\d:\d\d)(?:, until (\S+))?(.*)$/.exec(text);
  if (!parts) return text;
  const [, rule, time, until, rest] = parts;
  const when = scheduleRule(rule);
  if (!when) return text;
  const sentence = tr('server.scheduleAt', { when, time });
  return (until ? tr('server.scheduleUntil', { schedule: sentence, until }) : sentence) + rest;
}

function scheduleRule(rule: string): string | null {
  let match: RegExpExecArray | null;
  if (rule === 'Every day') return tr('server.everyDay');
  if (rule === 'Every weekday') return tr('routineEditor.everyWeekday');
  if ((match = /^Every (\d+) days$/.exec(rule))) return tr('server.everyDays', { n: match[1] });
  if ((match = /^Every (\d+) weeks on weekdays$/.exec(rule))) return tr('server.everyWeeksWeekdays', { n: match[1] });
  if ((match = /^Every (\d+) weeks on (.+)$/.exec(rule))) return tr('server.everyWeeksOn', { n: match[1], days: weekdayList(match[2]) });
  const month = /^Every (?:(\d+) months|month) on (.+)$/.exec(rule);
  if (month) {
    const [, n, on] = month;
    const nth = /^the (first|second|third|fourth|last) (\w+)$/.exec(on);
    const day = /^day (\d+)$/.exec(on);
    const place = on === 'the last day' ? tr('routineEditor.lastDay')
      : nth ? tr('server.monthNth', { nth: ordinals[nth[1]](), day: weekdayName(nth[2]) })
      : day ? tr('server.monthDay', { day: day[1] }) : null;
    if (!place) return null;
    return n ? tr('server.everyMonthsOn', { n, place }) : tr('server.everyMonthOn', { place });
  }
  if ((match = /^Every (.+)$/.exec(rule))) return tr('server.everyDaysOf', { days: weekdayList(match[1]) });
  return null;
}
