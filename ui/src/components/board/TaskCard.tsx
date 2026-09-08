import React from 'react';
import Badge from '@/components/common/Badge';
import Avatar from '@/components/common/Avatar';
import { formatDate } from '@/utils/format';
import type { Task } from '@/types';

interface TaskCardProps {
  task: Task;
  onStatusChange?: (taskId: string, newStatus: Task['status']) => void;
  onClick?: (task: Task) => void;
}

type Priority = Task['priority'];

const PRIORITY_VARIANT: Record<Priority, string> = {
  critical: 'critical',
  high: 'warning',
  medium: 'info',
  low: 'default',
};

const PRIORITY_LABEL: Record<Priority, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

const TASK_TYPE_LABEL: Record<string, string> = {
  quarterly_report: 'Quarterly Report',
  presentation: 'Presentation',
  memo: 'Memo',
  decision_brief: 'Decision Brief',
  analysis: 'Analysis',
  strategy: 'Strategy',
  ad_hoc: 'Ad Hoc',
};

function getDueDateStyle(dueDate: string | undefined): React.CSSProperties {
  if (!dueDate) return {};
  const now = new Date();
  const due = new Date(dueDate);
  const diffMs = due.getTime() - now.getTime();
  const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays < 0) {
    return {
      background: 'var(--color-critical-subtle)',
      color: 'var(--color-critical)',
    };
  }
  if (diffDays <= 3) {
    return {
      background: 'var(--color-warning-subtle)',
      color: 'var(--color-warning)',
    };
  }
  return {
    background: 'var(--color-surface-hover)',
    color: 'var(--color-text-muted)',
  };
}

function getAgeDays(createdAt: string): number {
  const now = new Date();
  const created = new Date(createdAt);
  return Math.floor((now.getTime() - created.getTime()) / (1000 * 60 * 60 * 24));
}

export default function TaskCard({ task, onClick }: TaskCardProps) {
  const [hovered, setHovered] = React.useState(false);

  const visibleStakeholders = (task.stakeholders ?? []).slice(0, 3);
  const formats = (task.deliverables ?? [])
    .map((d) => d.format)
    .filter((f): f is string => Boolean(f))
    .slice(0, 3);
  const ageDays = getAgeDays(task.created_at);
  const isBlocked = task.status === 'blocked';
  const dueDateStyle = getDueDateStyle(task.due_date);
  const typeLabel = TASK_TYPE_LABEL[task.task_type] ?? task.task_type;

  const handleClick = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).dataset.nopropagate) return;
    onClick?.(task);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onClick?.(task);
    }
  };

  return (
    <article
      role="button"
      tabIndex={0}
      aria-label={`Task: ${task.title}, priority ${task.priority}, status ${task.status}`}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        padding: '12px 12px 10px 36px',
        background: 'var(--color-surface)',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-lg)',
        cursor: 'pointer',
        boxShadow: hovered
          ? '0 4px 12px rgba(0,0,0,0.10)'
          : '0 1px 2px rgba(0,0,0,0.04)',
        transition: 'box-shadow 0.15s ease, border-color 0.15s ease',
        borderColor: hovered ? 'var(--color-border-strong)' : 'var(--color-border)',
        outline: 'none',
        userSelect: 'none',
      }}
    >
      {/* Blocked strip */}
      {isBlocked && (
        <div
          aria-label="Blocked"
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            height: '3px',
            background: 'var(--color-warning)',
            borderRadius: 'var(--radius-lg) var(--radius-lg) 0 0',
          }}
        />
      )}

      {/* Drag handle */}
      <div
        aria-hidden="true"
        title="Drag to reorder"
        style={{
          position: 'absolute',
          left: '10px',
          top: '50%',
          transform: 'translateY(-50%)',
          cursor: 'grab',
          color: 'var(--color-text-muted)',
          fontSize: '16px',
          lineHeight: 1,
          opacity: hovered ? 1 : 0.4,
          transition: 'opacity 0.15s ease',
          fontFamily: 'var(--font-mono)',
        }}
      >
        {'⠇'}
      </div>

      {/* Top row: type label + priority badge */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '8px',
        }}
      >
        <span
          style={{
            fontFamily: 'var(--font-sans)',
            fontSize: 'var(--text-xs)',
            color: 'var(--color-text-muted)',
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
            fontWeight: 500,
          }}
        >
          {typeLabel}
        </span>
        <Badge
          variant={PRIORITY_VARIANT[task.priority] as any}
          label={PRIORITY_LABEL[task.priority]}
        />
      </div>

      {/* Title */}
      <p
        style={{
          margin: 0,
          fontFamily: 'var(--font-sans)',
          fontSize: 'var(--text-sm)',
          fontWeight: 600,
          color: 'var(--color-text)',
          display: '-webkit-box',
          WebkitBoxOrient: 'vertical' as any,
          WebkitLineClamp: 2,
          overflow: 'hidden',
          lineHeight: '1.4',
        }}
      >
        {task.title}
      </p>

      {/* Meta row: due date + age */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
        {task.due_date && (
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              padding: '2px 7px',
              borderRadius: 'var(--radius-sm)',
              fontFamily: 'var(--font-sans)',
              fontSize: 'var(--text-xs)',
              fontWeight: 500,
              ...dueDateStyle,
            }}
            aria-label={`Due ${formatDate(task.due_date)}`}
          >
            {formatDate(task.due_date)}
          </span>
        )}
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            padding: '2px 7px',
            borderRadius: 'var(--radius-sm)',
            background: 'var(--color-surface-hover)',
            color: 'var(--color-text-muted)',
            fontFamily: 'var(--font-sans)',
            fontSize: 'var(--text-xs)',
          }}
          aria-label={`Created ${ageDays} day${ageDays !== 1 ? 's' : ''} ago`}
        >
          {ageDays}d old
        </span>

        {/* Format badges */}
        {formats.map((fmt) => (
          <span
            key={fmt}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              padding: '2px 7px',
              borderRadius: 'var(--radius-sm)',
              background: 'var(--color-accent-subtle)',
              color: 'var(--color-accent)',
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--text-xs)',
              textTransform: 'uppercase',
            }}
          >
            {fmt}
          </span>
        ))}
      </div>

      {/* Bottom row: stakeholder avatars */}
      {visibleStakeholders.length > 0 && (
        <div
          style={{ display: 'flex', alignItems: 'center' }}
          aria-label={`Stakeholders: ${visibleStakeholders.map((s) => s.ref).join(', ')}`}
        >
          {visibleStakeholders.map((s, idx) => (
            <div
              key={s.ref}
              style={{
                marginLeft: idx === 0 ? 0 : '-8px',
                zIndex: visibleStakeholders.length - idx,
                borderRadius: '50%',
                border: '2px solid var(--color-surface)',
              }}
              title={s.ref}
            >
              <Avatar name={s.ref} size="sm" />
            </div>
          ))}
        </div>
      )}
    </article>
  );
}
