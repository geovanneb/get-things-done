import React, { useEffect, useMemo, useRef, useState } from 'react';
import Panel from '../Panel';
import type { WindowValue } from '../WindowFilter';
import { useApi } from '@/hooks/useApi';
import { useDataVersion } from '@/store';
import type { InsightsCalendar } from '@/types';
import {
  METRICS,
  addDays,
  buildScale,
  endOfMonth,
  layoutFor,
  metricValue,
  monthLong,
  monthsBetween,
  summarize,
  typicalDay,
  type CalendarMetric,
} from './calendarModel';
import { Legend, Segmented } from './parts';
import MonthGrid from './MonthGrid';
import YearGrid from './YearGrid';
import WeekGrid, { hourLabel } from './WeekGrid';
import { DayTooltip, HourTooltip } from './DayTooltip';
import DayPanel from './DayPanel';

type Hover =
  | { kind: 'day'; date: string; rect: DOMRect }
  | { kind: 'hour'; date: string; hour: number; value: number; rect: DOMRect }
  | null;

/**
 * Activity calendar: how busy each day was, as a heatmap.
 *
 * The period always comes from the window filter at the top of Insights, like
 * every other panel; the calendar has no date controls of its own. Each window
 * gets the shape that reads best for it: the last 7 days with their hours, a
 * month grid for 30 days, small month cards for 90 days and a strip per year
 * for all time.
 */
export default function ActivityCalendar({ window, windowLabel }: { window: WindowValue; windowLabel: string }) {
  const [metric, setMetric] = useState<CalendarMetric>('activity');
  const [pinned, setPinned] = useState<string | null>(null);
  const [focusDate, setFocusDate] = useState<string | null>(null);
  const [hover, setHover] = useState<Hover>(null);
  const keyboardMove = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const tasksVersion = useDataVersion('tasks');
  const { data, loading, error } = useApi<InsightsCalendar>(
    `/api/insights/calendar?days=${window}`,
    [tasksVersion],
  );
  // Until the new window arrives, keep drawing the last one in its own layout,
  // so the grid never pairs one window's shape with another window's days.
  const shownWindow: WindowValue = data
    ? data.window_days === null
      ? 'all'
      : (String(data.window_days) as WindowValue)
    : window;
  const layout = layoutFor(shownWindow);
  const from = data?.from ?? '';
  const to = data?.to ?? '';
  const today = data?.today ?? '';

  const byDate = useMemo(() => new Map((data?.days ?? []).map((d) => [d.date, d])), [data]);
  const values = (data?.days ?? []).map((d) => metricValue(d, metric));
  const scale = useMemo(() => buildScale(values), [values.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps
  const typical = typicalDay(values);
  const hasOverdue = (data?.days ?? []).some((d) => d.overdue > 0);

  const callouts = data ? summarize(data.days, metric, layout) : [];
  if (data && layout === 'week') {
    const byHour = new Array(24).fill(0);
    for (const d of data.days) d.by_hour?.forEach((v, h) => (byHour[h] += v));
    const peak = Math.max(...byHour);
    if (peak > 0) {
      const h = byHour.indexOf(peak);
      callouts.splice(1, 0, { label: 'Busiest hour', value: `${hourLabel(h)} to ${hourLabel((h + 1) % 24)}` });
    }
  }

  // A new window swaps the grid out from under the pointer without a
  // pointerleave, so drop any open tooltip with it.
  useEffect(() => setHover(null), [window, data]);

  // A pinned day from a wider window is dropped when the filter narrows past it.
  useEffect(() => {
    if (pinned && data && (pinned < data.from || pinned > data.to)) setPinned(null);
  }, [data, pinned]);

  // Exactly one day button is in the tab order: the focused day when it is in
  // the window, otherwise today.
  const tabDate = focusDate && focusDate >= from && focusDate <= to ? focusDate : to;

  useEffect(() => {
    if (!keyboardMove.current) return;
    keyboardMove.current = false;
    rootRef.current?.querySelector<HTMLButtonElement>(`[data-cal-date="${focusDate}"]`)?.focus();
  }, [focusDate]);

  const clamp = (date: string) => (date < from ? from : date > to ? to : date);

  const onDayKey = (date: string) => (e: React.KeyboardEvent) => {
    // In the year strips weekdays run down the columns; everywhere else, across rows.
    const across = layout === 'years' ? 7 : 1;
    const down = layout === 'years' ? 1 : layout === 'week' ? 0 : 7;
    const step: Record<string, number> = { ArrowLeft: -across, ArrowRight: across, ArrowUp: -down, ArrowDown: down };
    if (e.key in step) {
      e.preventDefault();
      setHover(null);
      keyboardMove.current = true;
      setFocusDate(clamp(addDays(date, step[e.key])));
    } else if (e.key === 'Escape' && pinned) {
      setPinned(null);
    }
  };

  const pick = (date: string) => {
    setPinned((p) => (p === date ? null : date));
    setFocusDate(date);
  };

  const cellProps = (date: string) => ({
    'data-cal-date': date,
    tabIndex: date === tabDate ? 0 : -1,
    onClick: () => pick(date),
    onKeyDown: onDayKey(date),
    onPointerEnter: (e: React.PointerEvent<HTMLButtonElement>) =>
      setHover({ kind: 'day', date, rect: e.currentTarget.getBoundingClientRect() }),
    onPointerLeave: () => setHover(null),
    onFocus: (e: React.FocusEvent<HTMLButtonElement>) => {
      setFocusDate(date);
      setHover({ kind: 'day', date, rect: e.currentTarget.getBoundingClientRect() });
    },
    onBlur: () => setHover(null),
  });

  const gridProps = { from, to, byDate, metric, today, pinned, step: scale.step, cellProps };

  const years: number[] = [];
  if (layout === 'years' && data) {
    for (let y = Number(to.slice(0, 4)); y >= Number(from.slice(0, 4)); y--) years.push(y);
  }

  return (
    <Panel
      title="Activity calendar"
      hint={`How busy each day was, ${windowLabel}. Hover a day for a summary, click it for the details.`}
    >
      <div ref={rootRef} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {/* What to count, not which dates: the dates come from the filter above. */}
        <div>
          <Segmented
            label="What to count"
            options={METRICS.map((m) => ({ value: m.value, label: m.label }))}
            value={metric}
            onChange={setMetric}
          />
        </div>
        {callouts.length > 0 && (
          <p
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              columnGap: 16,
              rowGap: 4,
              margin: 0,
              fontSize: 'var(--text-xs)',
              color: 'var(--color-text-muted)',
            }}
          >
            {callouts.map((c) => (
              <span key={c.label}>
                {c.label}: <span style={{ color: 'var(--color-text)', fontWeight: 600 }}>{c.value}</span>
              </span>
            ))}
          </p>
        )}

        {error && !data && (
          <p role="status" style={{ fontSize: 'var(--text-sm)', color: 'var(--color-critical)', margin: 0 }}>
            Could not load the calendar: {error}
          </p>
        )}

        {/* Hold the last render while the next window loads, rather than flashing. */}
        {data && (
          <div style={{ opacity: loading ? 0.6 : 1, transition: 'opacity 120ms ease' }}>
            {layout === 'week' && (
              <WeekGrid
                {...gridProps}
                onPickDay={pick}
                onHourHover={(hit) => setHover(hit && { kind: 'hour', ...hit, rect: hit.el.getBoundingClientRect() })}
              />
            )}
            {layout === 'month' && <MonthGrid {...gridProps} spanFrom={from} spanTo={to} />}
            {layout === 'months' && (
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
                  gap: 20,
                  alignItems: 'start',
                }}
              >
                {monthsBetween(from, to).map((first) => (
                  <div key={first}>
                    <h3
                      style={{
                        margin: '0 0 6px',
                        fontSize: 'var(--text-sm)',
                        fontWeight: 600,
                        color: 'var(--color-text)',
                      }}
                    >
                      {monthLong(first)}
                    </h3>
                    <MonthGrid {...gridProps} spanFrom={first} spanTo={endOfMonth(first)} compact />
                  </div>
                ))}
              </div>
            )}
            {layout === 'years' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
                {years.map((y) => (
                  <YearGrid key={y} {...gridProps} year={y} />
                ))}
              </div>
            )}
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <Legend labels={scale.labels} />
          {hasOverdue && (
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 'var(--text-xs)',
                color: 'var(--color-text-muted)',
              }}
            >
              <span style={{ width: 7, height: 7, borderRadius: '50%', backgroundColor: 'var(--color-critical)' }} />
              Has overdue tasks
            </span>
          )}
        </div>

        {pinned && data && (
          <DayPanel
            date={pinned}
            version={tasksVersion}
            today={today}
            canMove={(dir) => (dir < 0 ? pinned > from : pinned < to)}
            onMove={(dir) => {
              const next = addDays(pinned, dir);
              setPinned(next);
              setFocusDate(next);
            }}
            onClose={() => setPinned(null)}
          />
        )}
      </div>

      {hover?.kind === 'day' && (
        <DayTooltip
          rect={hover.rect}
          date={hover.date}
          day={byDate.get(hover.date)}
          metric={metric}
          typical={typical}
        />
      )}
      {hover?.kind === 'hour' && <HourTooltip rect={hover.rect} date={hover.date} hour={hover.hour} value={hover.value} />}
    </Panel>
  );
}
