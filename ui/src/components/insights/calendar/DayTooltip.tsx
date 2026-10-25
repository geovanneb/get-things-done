import type React from 'react';
import type { InsightsCalendarDay } from '@/types';
import { countLabel, longDay, metricValue, type CalendarMetric } from './calendarModel';
import { hourLabel } from './WeekGrid';

const WIDTH = 264;

/** Fixed-position card next to the hovered or focused cell. Never takes the pointer. */
function Frame({ rect, children }: { rect: DOMRect; children: React.ReactNode }) {
  const below = rect.top < 240;
  const half = WIDTH / 2;
  const left = Math.min(Math.max(rect.left + rect.width / 2, half + 8), window.innerWidth - half - 8);
  return (
    <div
      role="tooltip"
      style={{
        position: 'fixed',
        left,
        top: below ? rect.bottom + 8 : rect.top - 8,
        transform: below ? 'translateX(-50%)' : 'translate(-50%, -100%)',
        width: WIDTH,
        padding: '10px 12px',
        backgroundColor: 'var(--color-surface)',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-md)',
        boxShadow: 'var(--shadow-md)',
        pointerEvents: 'none',
        zIndex: 50,
        fontSize: 'var(--text-xs)',
        color: 'var(--color-text-secondary)',
      }}
    >
      {children}
    </div>
  );
}

const strong: React.CSSProperties = {
  color: 'var(--color-text)',
  fontWeight: 600,
  fontVariantNumeric: 'tabular-nums',
};

export function DayTooltip({
  rect,
  day,
  date,
  metric,
  typical,
}: {
  rect: DOMRect;
  day: InsightsCalendarDay | undefined;
  date: string;
  metric: CalendarMetric;
  typical: number | null;
}) {
  const value = metricValue(day, metric);
  const ratio = typical && value > 0 ? value / typical : null;
  const rows: Array<[string, number, string?]> = [
    ['Created', day?.created ?? 0],
    ['Completed', day?.completed ?? 0],
    ['Agent runs', day?.runs ?? 0],
    ['Due', day?.due ?? 0, day?.overdue ? `${day.overdue} overdue` : undefined],
  ];
  const empty = !day || (day.activity === 0 && day.due === 0);

  return (
    <Frame rect={rect}>
      <div style={{ ...strong, fontSize: 'var(--text-sm)', marginBottom: 2 }}>{longDay(date)}</div>
      {empty ? (
        <div>Nothing happened.</div>
      ) : (
        <>
          <div style={{ marginBottom: 8 }}>
            <span style={strong}>{countLabel(value, metric)}</span>
            {ratio !== null && ` · ${ratio.toFixed(1)}x a typical day`}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', rowGap: 2, marginBottom: 8 }}>
            {rows.map(([label, n, note]) => (
              <div key={label} style={{ display: 'contents' }}>
                <span>{label}</span>
                <span style={{ textAlign: 'right' }}>
                  <span style={strong}>{n}</span>
                  {note && <span style={{ color: 'var(--color-critical)' }}> ({note})</span>}
                </span>
              </div>
            ))}
          </div>
          {day!.top_tasks.length > 0 && (
            <div style={{ marginBottom: 4 }}>
              <span style={{ color: 'var(--color-text-muted)' }}>Top: </span>
              {day!.top_tasks.map((t) => t.title).join(', ')}
              {day!.task_count > day!.top_tasks.length && ` and ${day!.task_count - day!.top_tasks.length} more`}
            </div>
          )}
          {day!.top_stakeholders.length > 0 && (
            <div style={{ marginBottom: 4 }}>
              <span style={{ color: 'var(--color-text-muted)' }}>For: </span>
              {day!.top_stakeholders.map((s) => s.name).join(', ')}
            </div>
          )}
          <div style={{ color: 'var(--color-text-muted)', marginTop: 6 }}>Click to see the full day</div>
        </>
      )}
    </Frame>
  );
}

export function HourTooltip({ rect, date, hour, value }: { rect: DOMRect; date: string; hour: number; value: number }) {
  return (
    <Frame rect={rect}>
      <div style={{ ...strong, fontSize: 'var(--text-sm)', marginBottom: 2 }}>{longDay(date)}</div>
      <div>
        {hourLabel(hour)} to {hourLabel((hour + 1) % 24)}: <span style={strong}>{countLabel(value, 'activity')}</span>
      </div>
    </Frame>
  );
}
