import { Link } from 'react-router-dom';
import type { InsightsAttentionItem } from '@/types';
import { STATUS } from './palette';
import { formatDays } from './format';

/**
 * Why a task is on this list, in the words the user would use. The reason is
 * carried by an icon and a label as well as the colour, so it never depends on
 * colour alone.
 */
const REASON: Record<
  InsightsAttentionItem['reason'],
  { label: string; color: string; icon: string }
> = {
  overdue: { label: 'Overdue', color: STATUS.overdue, icon: '!' },
  review: { label: 'Waiting on you', color: STATUS.review, icon: '◆' },
  due_soon: { label: 'Due soon', color: STATUS.due_soon, icon: '•' },
  stalled: { label: 'Stalled', color: STATUS.stalled, icon: '–' },
};

const PRIORITY_COLOR: Record<string, string> = {
  critical: 'var(--priority-critical)',
  high: 'var(--priority-high)',
  medium: 'var(--priority-medium)',
  low: 'var(--priority-low)',
};

/** The urgency line on the right of each row. */
function timing(item: InsightsAttentionItem): string {
  if (item.reason === 'overdue' && item.days_to_due !== undefined) {
    return `${formatDays(Math.abs(item.days_to_due))} late`;
  }
  if (item.reason === 'due_soon' && item.days_to_due !== undefined) {
    return item.days_to_due <= 0 ? 'due today' : `due in ${formatDays(item.days_to_due)}`;
  }
  return item.waiting_days <= 0 ? 'since today' : `waiting ${formatDays(item.waiting_days)}`;
}

export default function AttentionList({ items }: { items: InsightsAttentionItem[] }) {
  if (items.length === 0) {
    return (
      <div
        style={{
          padding: '28px 0',
          textAlign: 'center',
          color: 'var(--color-text-secondary)',
        }}
      >
        <div style={{ fontSize: 'var(--text-md)', fontWeight: 600, marginBottom: 4 }}>
          Nothing is waiting on you
        </div>
        <div style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)' }}>
          No task is in review, overdue, or due in the next three days.
        </div>
      </div>
    );
  }

  return (
    <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
      {items.map((item, i) => {
        const reason = REASON[item.reason];
        return (
          <li
            key={item.id}
            style={{
              borderTop: i === 0 ? 'none' : '1px solid var(--color-border)',
            }}
          >
            <Link
              to={`/board/task/${item.id}`}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '11px 4px',
                textDecoration: 'none',
                color: 'inherit',
              }}
            >
              {/* Reason marker: shape + colour + the label beside it. */}
              <span
                aria-hidden
                style={{
                  width: 18,
                  height: 18,
                  borderRadius: '50%',
                  backgroundColor: `color-mix(in oklch, ${reason.color} 16%, transparent)`,
                  color: reason.color,
                  fontSize: 10,
                  fontWeight: 700,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                }}
              >
                {reason.icon}
              </span>

              <span style={{ minWidth: 0, flex: 1 }}>
                <span
                  className="truncate"
                  style={{
                    display: 'block',
                    fontSize: 'var(--text-sm)',
                    fontWeight: 500,
                    color: 'var(--color-text)',
                  }}
                >
                  {item.title}
                </span>
                <span
                  style={{
                    display: 'block',
                    fontSize: 'var(--text-xs)',
                    color: 'var(--color-text-muted)',
                    marginTop: 2,
                  }}
                >
                  <span style={{ color: reason.color, fontWeight: 600 }}>{reason.label}</span>
                  {item.stakeholders.length > 0 && ` · for ${item.stakeholders.join(', ')}`}
                  {` · ${item.id}`}
                </span>
              </span>

              <span
                aria-hidden
                title={`Priority: ${item.priority}`}
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  backgroundColor: PRIORITY_COLOR[item.priority] ?? 'var(--priority-low)',
                  flexShrink: 0,
                }}
              />
              <span
                style={{
                  fontSize: 'var(--text-xs)',
                  color: 'var(--color-text-secondary)',
                  whiteSpace: 'nowrap',
                  flexShrink: 0,
                  minWidth: 86,
                  textAlign: 'right',
                }}
              >
                {timing(item)}
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
