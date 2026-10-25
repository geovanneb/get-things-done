import { OverdueDot, type GridProps } from './MonthGrid';
import { WEEKDAYS_SHORT, countLabel, keysBetween, longDay, metricValue, weekday } from './calendarModel';
import { stepFill, stepInk } from './parts';

/** The hours worth showing: every hour with activity, and at least a 09:00 to 18:00 workday. */
export function visibleHours(days: Array<number[] | undefined>): number[] {
  let first = 9;
  let last = 17;
  for (const hours of days) {
    hours?.forEach((v, h) => {
      if (v > 0) {
        first = Math.min(first, h);
        last = Math.max(last, h);
      }
    });
  }
  return Array.from({ length: last - first + 1 }, (_, i) => first + i);
}

export const hourLabel = (h: number) => `${String(h).padStart(2, '0')}:00`;

/**
 * The last 7 days: a day row on top (the chosen metric, like the other windows) and an
 * hour-by-day grid underneath that shows when the work happened. Hours carry
 * the combined activity, because due dates have no time of day.
 */
export default function WeekGrid({
  from,
  to,
  byDate,
  metric,
  today,
  pinned,
  step,
  cellProps,
  onHourHover,
  onPickDay,
}: GridProps & {
  onPickDay: (date: string) => void;
  onHourHover: (hit: { date: string; hour: number; value: number; el: HTMLElement } | null) => void;
}) {
  const days = keysBetween(from, to);
  const hours = visibleHours(days.map((d) => byDate.get(d)?.by_hour));
  const columns = '44px repeat(7, minmax(0, 1fr))';

  return (
    <div>
      <div role="grid" aria-label="Days of the week" style={{ display: 'grid', gridTemplateColumns: columns, gap: 2 }}>
        <span />
        {days.map((date) => {
          const value = metricValue(byDate.get(date), metric);
          const overdue = byDate.get(date)?.overdue ?? 0;
          const s = step(value);
          return (
            <button
              key={date}
              type="button"
              role="gridcell"
              aria-selected={pinned === date}
              aria-label={`${longDay(date)}: ${countLabel(value, metric)}${overdue ? `, ${overdue} overdue` : ''}${
                date === today ? ', today' : ''
              }`}
              {...cellProps(date)}
              style={{
                position: 'relative',
                padding: '6px 4px',
                fontFamily: 'inherit',
                textAlign: 'center',
                backgroundColor: s === 0 ? 'var(--color-surface)' : stepFill(s),
                color: stepInk(s),
                border: s === 0 ? '1px solid var(--color-border)' : '1px solid transparent',
                borderRadius: 'var(--radius-sm)',
                outline: pinned === date ? '2px solid var(--color-accent)' : undefined,
                outlineOffset: 1,
                cursor: 'pointer',
              }}
            >
              <span style={{ display: 'block', fontSize: 'var(--text-xs)', fontWeight: date === today ? 700 : 400 }}>
                {WEEKDAYS_SHORT[weekday(date)]} {Number(date.slice(8))}
                {date === today ? ' · today' : ''}
              </span>
              <span style={{ display: 'block', fontSize: 'var(--text-sm)', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
                {value}
              </span>
              {overdue > 0 && <OverdueDot count={overdue} />}
            </button>
          );
        })}
      </div>

      <p style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', margin: '12px 0 6px' }}>
        Activity by hour (created, completed and agent runs)
      </p>
      <div
        aria-hidden
        style={{ display: 'grid', gridTemplateColumns: columns, gap: 2 }}
        onPointerLeave={() => onHourHover(null)}
      >
        {hours.map((h) => (
          <HourRow
            key={h}
            hour={h}
            days={days}
            pinned={pinned}
            value={(date) => byDate.get(date)?.by_hour?.[h] ?? 0}
            // Same scale as the days and the legend, so a colour means the
            // same count everywhere in the panel.
            step={step}
            onHover={onHourHover}
            onPick={onPickDay}
          />
        ))}
      </div>
    </div>
  );
}

function HourRow({
  hour,
  days,
  pinned,
  value,
  step,
  onHover,
  onPick,
}: {
  hour: number;
  days: string[];
  pinned: string | null;
  value: (date: string) => number;
  step: (v: number) => number;
  onHover: (hit: { date: string; hour: number; value: number; el: HTMLElement } | null) => void;
  onPick: (date: string) => void;
}) {
  return (
    <>
      <span
        style={{
          fontSize: 10,
          color: 'var(--color-text-muted)',
          fontVariantNumeric: 'tabular-nums',
          alignSelf: 'center',
        }}
      >
        {hourLabel(hour)}
      </span>
      {days.map((date) => {
        const v = value(date);
        return (
          <span
            key={date}
            onPointerEnter={(e) => onHover({ date, hour, value: v, el: e.currentTarget })}
            onClick={() => onPick(date)}
            style={{
              height: 16,
              borderRadius: 2,
              backgroundColor: stepFill(step(v)),
              boxShadow: pinned === date ? 'inset 0 0 0 1px var(--color-accent)' : undefined,
              cursor: 'pointer',
            }}
          />
        );
      })}
    </>
  );
}
