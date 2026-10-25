import React from 'react';
import type { InsightsCalendarDay } from '@/types';
import {
  WEEKDAYS_SHORT,
  addDays,
  countLabel,
  keysBetween,
  longDay,
  metricValue,
  monthShort,
  monthIndex,
  startOfWeek,
  type CalendarMetric,
} from './calendarModel';
import { stepFill, stepInk } from './parts';

export interface GridProps {
  /** First and last day of the filter window. Only these days are interactive. */
  from: string;
  to: string;
  byDate: Map<string, InsightsCalendarDay>;
  metric: CalendarMetric;
  today: string;
  pinned: string | null;
  step: (value: number) => number;
  /** Hover, focus, click and keyboard wiring for one day button. */
  cellProps: (date: string) => React.ButtonHTMLAttributes<HTMLButtonElement> & { 'data-cal-date': string };
}

/** A small red dot for days with overdue work. Always paired with text in the tooltip and label. */
export function OverdueDot({ count }: { count: number }) {
  return (
    <span
      aria-hidden
      title={`${count} overdue`}
      style={{
        position: 'absolute',
        top: 5,
        right: 5,
        width: 7,
        height: 7,
        borderRadius: '50%',
        backgroundColor: 'var(--color-critical)',
        boxShadow: '0 0 0 2px var(--color-surface)',
      }}
    />
  );
}

/**
 * Fare-calendar grid: whole weeks, the date in each cell and the count, so the
 * colour is never the only way to read a day.
 *
 * `spanFrom`..`spanTo` is what the grid draws (the window itself, or one month
 * of it). Days of the span outside the window are dimmed and inert; the week
 * padding around the span is dimmed too, or left blank in compact month cards.
 */
export default function MonthGrid({
  from,
  to,
  spanFrom,
  spanTo,
  compact = false,
  byDate,
  metric,
  today,
  pinned,
  step,
  cellProps,
}: GridProps & { spanFrom: string; spanTo: string; compact?: boolean }) {
  const days = keysBetween(startOfWeek(spanFrom), addDays(startOfWeek(spanTo), 6));
  const cols: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: 2 };

  return (
    <div role="grid" aria-label={`Days from ${longDay(spanFrom)} to ${longDay(spanTo)}`}>
      <div role="row" style={{ ...cols, marginBottom: 4 }}>
        {WEEKDAYS_SHORT.map((d) => (
          <span
            key={d}
            role="columnheader"
            style={{ fontSize: compact ? 10 : 'var(--text-xs)', color: 'var(--color-text-muted)', textAlign: 'center' }}
          >
            {compact ? d.slice(0, 1) : d}
          </span>
        ))}
      </div>
      {Array.from({ length: days.length / 7 }, (_, row) => (
        <div key={row} role="row" style={{ ...cols, marginBottom: 2 }}>
          {days.slice(row * 7, row * 7 + 7).map((date) => {
            const dayNumber = Number(date.slice(8));
            // Name the month on its first day, so a 30-day grid that spans two
            // months still says where one ends.
            const label = !compact && dayNumber === 1 ? `1 ${monthShort(monthIndex(date))}` : String(dayNumber);
            const inSpan = date >= spanFrom && date <= spanTo;
            const inWindow = date >= from && date <= to;

            // A month card leaves its neighbours' days blank, so no day shows up twice.
            if (compact && !inSpan) return <span key={date} aria-hidden />;

            if (!inWindow) {
              return (
                <span
                  key={date}
                  role="gridcell"
                  aria-disabled
                  style={{
                    minHeight: compact ? 28 : 58,
                    padding: compact ? 0 : '5px 6px',
                    display: 'flex',
                    alignItems: compact ? 'center' : 'flex-start',
                    justifyContent: compact ? 'center' : 'flex-start',
                    fontSize: compact ? 10 : 'var(--text-xs)',
                    color: 'var(--color-text-muted)',
                    opacity: 0.6,
                  }}
                >
                  {label}
                </span>
              );
            }

            const day = byDate.get(date);
            const value = metricValue(day, metric);
            const s = step(value);
            const isToday = date === today;
            const overdue = day?.overdue ?? 0;
            return (
              <button
                key={date}
                type="button"
                role="gridcell"
                aria-selected={pinned === date}
                aria-label={`${longDay(date)}: ${countLabel(value, metric)}${overdue ? `, ${overdue} overdue` : ''}${
                  isToday ? ', today' : ''
                }`}
                {...cellProps(date)}
                style={{
                  position: 'relative',
                  minHeight: compact ? 28 : 58,
                  padding: compact ? 0 : '5px 6px',
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: compact ? 'center' : 'space-between',
                  alignItems: compact ? 'center' : 'stretch',
                  textAlign: 'left',
                  fontFamily: 'inherit',
                  fontSize: compact ? 10 : undefined,
                  backgroundColor: s === 0 ? 'var(--color-surface)' : stepFill(s),
                  color: stepInk(s),
                  border: s === 0 ? '1px solid var(--color-border)' : '1px solid transparent',
                  borderRadius: 'var(--radius-sm)',
                  outline: pinned === date ? '2px solid var(--color-accent)' : isToday && compact ? '1.5px solid var(--color-text)' : undefined,
                  outlineOffset: 1,
                  cursor: 'pointer',
                }}
              >
                {compact ? (
                  // Compact cards show the date only; the count is in the tooltip,
                  // the cell label and the day panel.
                  <span style={{ fontWeight: isToday ? 700 : 400 }}>{dayNumber}</span>
                ) : (
                  <>
                    <span
                      style={{
                        alignSelf: 'flex-start',
                        fontSize: 'var(--text-xs)',
                        fontWeight: isToday ? 700 : 400,
                        lineHeight: '18px',
                        minWidth: 18,
                        textAlign: 'center',
                        borderRadius: 9,
                        padding: isToday ? '0 5px' : 0,
                        backgroundColor: isToday ? 'var(--color-text)' : 'transparent',
                        color: isToday ? 'var(--color-surface)' : 'inherit',
                      }}
                    >
                      {label}
                    </span>
                    {value > 0 && (
                      <span
                        style={{
                          alignSelf: 'flex-end',
                          fontSize: 'var(--text-sm)',
                          fontWeight: 600,
                          fontVariantNumeric: 'tabular-nums',
                        }}
                      >
                        {value}
                      </span>
                    )}
                  </>
                )}
                {overdue > 0 && <OverdueDot count={overdue} />}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
