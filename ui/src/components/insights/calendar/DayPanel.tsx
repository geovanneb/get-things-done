import type React from 'react';
import { Link } from 'react-router-dom';
import { useApi } from '@/hooks/useApi';
import type { InsightsCalendarDayDetail, InsightsCalendarEvent } from '@/types';
import { longDay } from './calendarModel';
import { iconButton } from './parts';

const EVENT_LABEL: Record<InsightsCalendarEvent, string> = {
  created: 'Created',
  ran: 'Agent ran',
  completed: 'Completed',
  due: 'Due',
};

function Chip({ children, tone = 'neutral' }: { children: React.ReactNode; tone?: 'neutral' | 'critical' }) {
  return (
    <span
      style={{
        fontSize: 'var(--text-xs)',
        padding: '1px 7px',
        borderRadius: 999,
        whiteSpace: 'nowrap',
        color: tone === 'critical' ? 'var(--color-critical)' : 'var(--color-text-secondary)',
        backgroundColor: tone === 'critical' ? 'var(--color-critical-subtle)' : 'var(--color-surface-hover)',
      }}
    >
      {children}
    </span>
  );
}

/**
 * The pinned day: everything that happened, with links. It opens under the
 * grid instead of in a dialog, so the calendar stays in view for comparison.
 */
export default function DayPanel({
  date,
  version,
  today,
  canMove,
  onMove,
  onClose,
}: {
  date: string;
  /** Data version from the file watcher, so the panel refreshes with the grid. */
  version: number;
  today: string;
  /** Whether the next or previous day is still inside the filter window. */
  canMove: (dir: -1 | 1) => boolean;
  onMove: (dir: -1 | 1) => void;
  onClose: () => void;
}) {
  const { data, loading, error } = useApi<InsightsCalendarDayDetail>(
    `/api/insights/calendar/day/${date}`,
    [version],
  );
  const detail = data?.date === date ? data : null;
  const t = detail?.totals;

  return (
    <section
      aria-label={`Details for ${longDay(date)}`}
      style={{
        marginTop: 16,
        paddingTop: 14,
        borderTop: '1px solid var(--color-border)',
        opacity: loading && !detail ? 0.6 : 1,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
        <h3 style={{ fontSize: 'var(--text-base)', fontWeight: 600, color: 'var(--color-text)', margin: 0, flex: 1 }}>
          {longDay(date)}
        </h3>
        <button
          type="button"
          style={{ ...iconButton, opacity: canMove(-1) ? 1 : 0.4 }}
          disabled={!canMove(-1)}
          onClick={() => onMove(-1)}
          aria-label="Previous day"
        >
          ‹
        </button>
        <button
          type="button"
          style={{ ...iconButton, opacity: canMove(1) ? 1 : 0.4 }}
          disabled={!canMove(1)}
          onClick={() => onMove(1)}
          aria-label="Next day"
        >
          ›
        </button>
        <button type="button" style={iconButton} onClick={onClose} aria-label="Close day details">
          ✕
        </button>
      </div>

      {error && !detail && (
        <p style={{ fontSize: 'var(--text-sm)', color: 'var(--color-critical)', margin: 0 }}>
          Could not load this day: {error}
        </p>
      )}

      {t && (
        <p style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)', margin: '0 0 10px' }}>
          {t.created} created · {t.completed} completed · {t.runs} agent {t.runs === 1 ? 'run' : 'runs'} · {t.due} due
          {t.overdue > 0 && <span style={{ color: 'var(--color-critical)' }}> ({t.overdue} overdue)</span>}
        </p>
      )}

      {detail && detail.tasks.length === 0 && (
        <p style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)', margin: 0 }}>
          {date > today ? 'Nothing is due on this day yet.' : 'Nothing happened on this day.'}
        </p>
      )}

      {detail && detail.tasks.length > 0 && (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column' }}>
          {detail.tasks.map((task) => (
            <li
              key={task.id}
              style={{
                display: 'flex',
                alignItems: 'baseline',
                gap: 8,
                flexWrap: 'wrap',
                padding: '7px 0',
                borderBottom: '1px solid var(--color-border)',
              }}
            >
              <Link
                to={`/board/task/${encodeURIComponent(task.id)}`}
                style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text)', fontWeight: 500, minWidth: 0 }}
              >
                {task.title}
              </Link>
              <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
                {task.events.map((e) => {
                  const late = e === 'due' && task.overdue;
                  return (
                    <Chip key={e} tone={late ? 'critical' : 'neutral'}>
                      {late ? 'Overdue' : EVENT_LABEL[e]}
                      {e === 'ran' && task.runs > 1 ? ` x${task.runs}` : ''}
                    </Chip>
                  );
                })}
              </span>
              {task.stakeholders.length > 0 && (
                <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', marginLeft: 'auto' }}>
                  {task.stakeholders.join(', ')}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      {detail && detail.stakeholders.length > 0 && (
        <p style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', margin: '10px 0 0' }}>
          For:{' '}
          {detail.stakeholders.map((s, i) => (
            <span key={s.ref}>
              {i > 0 && ', '}
              <Link to={`/stakeholders/${encodeURIComponent(s.ref)}`} style={{ color: 'var(--color-text-secondary)' }}>
                {s.name}
              </Link>{' '}
              ({s.count})
            </span>
          ))}
        </p>
      )}
    </section>
  );
}
