import React from 'react';
import { Link } from 'react-router-dom';
import Badge from '@/components/common/Badge';
import { formatDate } from '@/utils/format';
import type { SituationData } from '@/types';

interface AttentionQueueProps {
  items: SituationData['attention_queue'];
}

type Reason = SituationData['attention_queue'][number]['reason'];

const REASON_CONFIG: Record<
  Reason,
  { label: string; stripColor: string; badgeVariant: string }
> = {
  overdue: {
    label: 'Overdue',
    stripColor: 'var(--color-critical)',
    badgeVariant: 'critical',
  },
  blocked: {
    label: 'Blocked',
    stripColor: 'var(--color-warning)',
    badgeVariant: 'warning',
  },
  due_soon: {
    label: 'Due Soon',
    stripColor: 'var(--color-info)',
    badgeVariant: 'info',
  },
};

const PRIORITY_LABELS: Record<string, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

const styles = {
  container: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '8px',
  },
  item: {
    display: 'flex',
    alignItems: 'stretch',
    background: 'var(--color-surface)',
    border: '1px solid var(--color-border)',
    borderRadius: 'var(--radius-md)',
    overflow: 'hidden',
    transition: 'box-shadow 0.15s ease',
  },
  strip: (color: string): React.CSSProperties => ({
    width: '4px',
    flexShrink: 0,
    background: color,
  }),
  body: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '6px',
    padding: '10px 12px',
    minWidth: 0,
  },
  topRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    flexWrap: 'wrap' as const,
  },
  title: {
    fontFamily: 'var(--font-sans)',
    fontSize: 'var(--text-sm)',
    fontWeight: 600,
    color: 'var(--color-text)',
    textDecoration: 'none',
    flexGrow: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  },
  metaRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    flexWrap: 'wrap' as const,
  },
  dueDate: {
    fontFamily: 'var(--font-sans)',
    fontSize: 'var(--text-xs)',
    color: 'var(--color-text-muted)',
  },
  stakeholderChip: {
    display: 'inline-flex',
    alignItems: 'center',
    padding: '1px 6px',
    borderRadius: 'var(--radius-sm)',
    background: 'var(--color-accent-subtle)',
    color: 'var(--color-accent)',
    fontFamily: 'var(--font-sans)',
    fontSize: 'var(--text-xs)',
    fontWeight: 500,
    whiteSpace: 'nowrap' as const,
  },
  moreChip: {
    display: 'inline-flex',
    alignItems: 'center',
    padding: '1px 6px',
    borderRadius: 'var(--radius-sm)',
    background: 'var(--color-surface-hover)',
    color: 'var(--color-text-muted)',
    fontFamily: 'var(--font-sans)',
    fontSize: 'var(--text-xs)',
    fontWeight: 500,
  },
  separator: {
    color: 'var(--color-border-strong)',
    fontSize: 'var(--text-xs)',
    userSelect: 'none' as const,
  },
  emptyState: {
    fontFamily: 'var(--font-sans)',
    fontSize: 'var(--text-sm)',
    color: 'var(--color-text-muted)',
    textAlign: 'center' as const,
    padding: '24px 0',
  },
};

export default function AttentionQueue({ items }: AttentionQueueProps) {
  if (!items || items.length === 0) {
    return (
      <p style={styles.emptyState} aria-live="polite">
        No items need attention right now.
      </p>
    );
  }

  return (
    <ol style={styles.container} aria-label="Attention queue">
      {items.map((item) => {
        const config = REASON_CONFIG[item.reason] ?? REASON_CONFIG.due_soon;
        const visibleStakeholders = item.stakeholders.slice(0, 2);
        const extraCount = item.stakeholders.length - visibleStakeholders.length;

        return (
          <li key={item.id} style={styles.item}>
            <div
              style={styles.strip(config.stripColor)}
              aria-hidden="true"
            />
            <div style={styles.body}>
              <div style={styles.topRow}>
                <Link
                  to={`/board/task/${item.slug}`}
                  style={styles.title}
                  title={item.title}
                  aria-label={`${item.title} - ${config.label}`}
                >
                  {item.title}
                </Link>
                <Badge variant={config.badgeVariant as any} label={config.label} />
                <Badge variant="priority" label={PRIORITY_LABELS[item.priority] ?? item.priority} />
              </div>

              <div style={styles.metaRow}>
                {item.due_date && (
                  <>
                    <span style={styles.dueDate} aria-label={`Due ${formatDate(item.due_date)}`}>
                      Due {formatDate(item.due_date)}
                    </span>
                    {visibleStakeholders.length > 0 && (
                      <span style={styles.separator} aria-hidden="true">
                        &middot;
                      </span>
                    )}
                  </>
                )}

                {visibleStakeholders.map((ref) => (
                  <span key={ref} style={styles.stakeholderChip} aria-label={`Stakeholder: ${ref}`}>
                    {ref}
                  </span>
                ))}

                {extraCount > 0 && (
                  <span style={styles.moreChip} aria-label={`${extraCount} more stakeholders`}>
                    +{extraCount} more
                  </span>
                )}
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
