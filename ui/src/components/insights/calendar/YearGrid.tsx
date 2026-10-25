import type React from 'react';
import type { GridProps } from './MonthGrid';
import {
  addDays,
  countLabel,
  fromKey,
  keysBetween,
  longDay,
  metricValue,
  monthIndex,
  monthShort,
  startOfWeek,
} from './calendarModel';
import { RAMP } from '../palette';
import { stepFill } from './parts';

const LABEL_COL = 30;

/**
 * One calendar year: a column per week and a row per weekday, like a
 * contribution graph. "All time" stacks one of these per year. Days of the
 * year outside the window (before the first activity, after today) stay in
 * place as faint, inert cells so every year has the same shape.
 *
 * The monthly totals underneath answer "which month was heaviest" directly,
 * instead of asking the reader to add up cells.
 */
export default function YearGrid({
  year,
  from,
  to,
  byDate,
  metric,
  today,
  pinned,
  step,
  cellProps,
}: GridProps & { year: number }) {
  const start = `${year}-01-01`;
  const end = `${year}-12-31`;
  const days = keysBetween(startOfWeek(start), addDays(startOfWeek(end), 6));
  const weeks = days.length / 7;
  const columns = `${LABEL_COL}px repeat(${weeks}, minmax(0, 1fr))`;

  const monthCols = Array.from({ length: 12 }, (_, m) => {
    const first = `${year}-${String(m + 1).padStart(2, '0')}-01`;
    const offset = Math.round((fromKey(first).getTime() - fromKey(days[0]).getTime()) / 86_400_000);
    return Math.floor(offset / 7);
  });

  const totals = new Array(12).fill(null) as Array<number | null>;
  for (const date of days) {
    if (date < start || date > end || date < from || date > to) continue;
    const m = monthIndex(date);
    totals[m] = (totals[m] ?? 0) + metricValue(byDate.get(date), metric);
  }
  const maxTotal = Math.max(1, ...totals.map((t) => t ?? 0));

  const tiny: React.CSSProperties = { fontSize: 10, color: 'var(--color-text-muted)' };

  return (
    // A year is 53 columns. On a narrow screen the strip scrolls sideways on
    // its own, instead of shrinking the cells to dots or widening the page.
    <div style={{ overflowX: 'auto' }}>
      <div style={{ minWidth: 560 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
          <h3 style={{ margin: 0, fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--color-text)' }}>{year}</h3>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: columns, gap: 2, marginBottom: 4 }} aria-hidden>
          {monthCols.map((col, m) => (
            <span key={m} style={{ ...tiny, gridColumn: `${col + 2} / span 4`, gridRow: 1, whiteSpace: 'nowrap' }}>
              {monthShort(m)}
            </span>
          ))}
        </div>

        <div
          role="grid"
          aria-label={`Days of ${year}`}
          style={{
            display: 'grid',
            gridTemplateColumns: columns,
            gridTemplateRows: 'repeat(7, auto)',
            gridAutoFlow: 'column',
            gap: 2,
          }}
        >
          {['', 'Mon', '', 'Wed', '', 'Fri', ''].map((label, i) => (
            <span key={i} style={{ ...tiny, lineHeight: 1, alignSelf: 'center' }} aria-hidden>
              {label}
            </span>
          ))}
          {days.map((date) => {
            if (date < start || date > end) return <span key={date} aria-hidden />;
            if (date < from || date > to) {
              return (
                <span
                  key={date}
                  aria-hidden
                  style={{ aspectRatio: '1', borderRadius: 2, backgroundColor: 'var(--color-surface-hover)' }}
                />
              );
            }
            const day = byDate.get(date);
            const value = metricValue(day, metric);
            const overdue = day?.overdue ?? 0;
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
                  aspectRatio: '1',
                  width: '100%',
                  padding: 0,
                  backgroundColor: stepFill(step(value)),
                  border: 'none',
                  borderRadius: 2,
                  outline:
                    pinned === date
                      ? '2px solid var(--color-accent)'
                      : date === today
                        ? '1.5px solid var(--color-text)'
                        : undefined,
                  outlineOffset: 1,
                  cursor: 'pointer',
                }}
              />
            );
          })}
        </div>

        <div
          style={{ display: 'grid', gridTemplateColumns: 'repeat(12, minmax(0, 1fr))', gap: 6, marginTop: 12 }}
          aria-label={`Totals per month in ${year}`}
        >
          {totals.map((total, m) => (
            <div
              key={m}
              aria-label={`${monthShort(m)} ${year}: ${total === null ? 'outside the window' : countLabel(total, metric)}`}
              style={{ display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: 3 }}
            >
              <span
                style={{
                  fontSize: 'var(--text-xs)',
                  fontWeight: 600,
                  color: 'var(--color-text-secondary)',
                  fontVariantNumeric: 'tabular-nums',
                  textAlign: 'center',
                  visibility: total === null ? 'hidden' : 'visible',
                }}
              >
                {total ?? 0}
              </span>
              <span style={{ height: 28, display: 'flex', alignItems: 'flex-end' }}>
                <span
                  style={{
                    width: '100%',
                    height: total ? Math.max(3, (total / maxTotal) * 28) : 0,
                    backgroundColor: RAMP[3],
                    borderRadius: '4px 4px 0 0',
                  }}
                />
              </span>
              <span style={{ ...tiny, textAlign: 'center', borderTop: '1px solid var(--color-border-strong)', paddingTop: 3 }}>
                {monthShort(m)}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
