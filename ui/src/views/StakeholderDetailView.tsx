import React, { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import Avatar from '@/components/common/Avatar';
import Badge from '@/components/common/Badge';
import Button from '@/components/common/Button';
import EmptyState from '@/components/common/EmptyState';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import MarkdownView from '@/components/common/MarkdownView';
import { apiGet } from '@/utils/api';
import { formatDate, formatRelativeDate } from '@/utils/format';
import type { Stakeholder, Task } from '@/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function influenceBadgeVariant(
  influence: Stakeholder['influence'],
): 'error' | 'warning' | 'info' | 'default' {
  switch (influence) {
    case 'decision_maker':
      return 'error';
    case 'influencer':
      return 'warning';
    case 'informed':
      return 'info';
    case 'executor':
      return 'default';
    case 'sponsor':
      return 'error';
  }
}

function influenceLabel(influence: Stakeholder['influence']): string {
  switch (influence) {
    case 'decision_maker':
      return 'Decision Maker';
    case 'influencer':
      return 'Influencer';
    case 'informed':
      return 'Informed';
    case 'executor':
      return 'Executor';
    case 'sponsor':
      return 'Sponsor';
  }
}

type StatusBadgeVariant =
  | 'status-backlog'
  | 'status-ready'
  | 'status-in_progress'
  | 'status-blocked'
  | 'status-review'
  | 'status-done'
  | 'status-archived';

function statusBadgeVariant(status: Task['status']): StatusBadgeVariant {
  return `status-${status}` as StatusBadgeVariant;
}

function statusLabel(status: Task['status']): string {
  const labels: Record<Task['status'], string> = {
    backlog: 'Backlog',
    ready: 'Ready',
    in_progress: 'In Progress',
    blocked: 'Blocked',
    review: 'Review',
    done: 'Done',
    in_review: 'In Review',
    approved: 'Approved',
    archived: 'Archived',
  };
  return labels[status];
}

function priorityLabel(priority: Task['priority']): string {
  const labels: Record<Task['priority'], string> = {
    critical: 'Critical',
    high: 'High',
    medium: 'Medium',
    low: 'Low',
  };
  return labels[priority];
}

function priorityDotColor(priority: Task['priority']): string {
  switch (priority) {
    case 'critical':
      return 'var(--color-critical)';
    case 'high':
      return 'var(--color-warning)';
    case 'medium':
      return 'var(--color-info)';
    case 'low':
      return 'var(--color-text-muted)';
  }
}

function isOverdue(due: string | undefined): boolean {
  if (!due) return false;
  return new Date(due).getTime() < Date.now();
}

function isDueSoon(due: string | undefined): boolean {
  if (!due) return false;
  const diff = (new Date(due).getTime() - Date.now()) / 86400000;
  return diff >= 0 && diff <= 3;
}

// ---------------------------------------------------------------------------
// Icon components
// ---------------------------------------------------------------------------

function BackArrowIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path
        d="M8.5 2.5 L4 7 L8.5 11.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Section card wrapper
// ---------------------------------------------------------------------------

interface SectionCardProps {
  title: string;
  badge?: React.ReactNode;
  children: React.ReactNode;
}

function SectionCard({ title, badge, children }: SectionCardProps) {
  return (
    <section
      style={{
        background: 'var(--color-surface)',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-lg)',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '14px 20px',
          borderBottom: '1px solid var(--color-border)',
        }}
      >
        <h2
          style={{
            margin: 0,
            fontSize: 'var(--text-md)',
            fontWeight: 600,
            color: 'var(--color-text)',
          }}
        >
          {title}
        </h2>
        {badge}
      </div>
      <div style={{ padding: '16px 20px' }}>{children}</div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Task list item
// ---------------------------------------------------------------------------

interface TaskItemProps {
  task: Task;
  isLast: boolean;
}

function TaskItem({ task, isLast }: TaskItemProps) {
  const overdue = isOverdue(task.due_date);
  const dueSoon = isDueSoon(task.due_date);

  let dueDateColor = 'var(--color-text-muted)';
  if (overdue) dueDateColor = 'var(--color-critical)';
  else if (dueSoon) dueDateColor = 'var(--color-warning)';

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '10px 0',
        borderBottom: isLast ? 'none' : '1px solid var(--color-border)',
      }}
    >
      {/* Priority indicator dot */}
      <span
        aria-label={`Priority: ${priorityLabel(task.priority)}`}
        title={`${priorityLabel(task.priority)} priority`}
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: priorityDotColor(task.priority),
          flexShrink: 0,
        }}
      />

      {/* Title link */}
      <Link
        to={`/board/task/${task.slug}`}
        style={{
          flex: 1,
          fontSize: 'var(--text-base)',
          fontWeight: 500,
          color: 'var(--color-text)',
          textDecoration: 'none',
          overflow: 'hidden',
          whiteSpace: 'nowrap',
          textOverflow: 'ellipsis',
        }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLAnchorElement).style.textDecoration = 'underline'; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLAnchorElement).style.textDecoration = 'none'; }}
      >
        {task.title}
      </Link>

      {/* Status badge */}
      <Badge variant={statusBadgeVariant(task.status)}>
        {statusLabel(task.status)}
      </Badge>

      {/* Due date */}
      {task.due_date && (
        <span
          title={formatDate(task.due_date)}
          style={{
            fontSize: 'var(--text-xs)',
            color: dueDateColor,
            whiteSpace: 'nowrap',
            flexShrink: 0,
          }}
        >
          {overdue ? 'Overdue' : formatRelativeDate(task.due_date)}
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main view
// ---------------------------------------------------------------------------

export default function StakeholderDetailView() {
  const { id } = useParams<{ id: string }>();

  const [stakeholder, setStakeholder] = useState<Stakeholder | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;

    let cancelled = false;

    async function load() {
      setLoading(true);
      setNotFound(false);
      setFetchError(null);

      try {
        const [sk, taskList] = await Promise.all([
          apiGet<Stakeholder>(`/api/stakeholders/${id}`),
          apiGet<Task[]>(`/api/tasks?stakeholder=${id}`),
        ]);
        if (cancelled) return;
        setStakeholder(sk);
        setTasks(taskList);
      } catch (err: unknown) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : 'Failed to load.';
        if (msg.includes('404') || msg.toLowerCase().includes('not found')) {
          setNotFound(true);
        } else {
          setFetchError(msg);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  }, [id]);

  // ---- Loading ----
  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: '80px 0' }}>
        <LoadingSpinner />
      </div>
    );
  }

  // ---- 404 ----
  if (notFound) {
    return (
      <div style={{ padding: 16, maxWidth: 720, margin: '0 auto' }}>
        <BackButton />
        <div style={{ marginTop: 32 }}>
          <EmptyState
            title="Stakeholder not found"
            description="This stakeholder may have been deleted or the link is incorrect."
          />
        </div>
      </div>
    );
  }

  // ---- Error ----
  if (fetchError) {
    return (
      <div style={{ padding: 16, maxWidth: 720, margin: '0 auto' }}>
        <BackButton />
        <p role="alert" style={{ marginTop: 24, color: 'var(--color-critical)', fontSize: 'var(--text-sm)' }}>
          {fetchError}
        </p>
      </div>
    );
  }

  if (!stakeholder) return null;

  const notes = stakeholder.notes;
  const hasTags = stakeholder.tags && stakeholder.tags.length > 0;

  return (
    <div
      style={{
        padding: 16,
        maxWidth: 720,
        margin: '0 auto',
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
      }}
    >
      <BackButton />

      {/* Profile card */}
      <div
        style={{
          background: 'var(--color-surface)',
          border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius-lg)',
          padding: 24,
          display: 'flex',
          gap: 20,
          alignItems: 'flex-start',
        }}
      >
        <Avatar name={stakeholder.name} size="lg" />

        <div style={{ flex: 1, minWidth: 0 }}>
          <h1
            style={{
              margin: 0,
              fontSize: 'var(--text-xl)',
              fontWeight: 700,
              color: 'var(--color-text)',
              lineHeight: 1.2,
            }}
          >
            {stakeholder.name}
          </h1>

          {stakeholder.role && (
            <p style={{ margin: '4px 0 0', fontSize: 'var(--text-md)', color: 'var(--color-text-secondary)' }}>
              {stakeholder.role}
            </p>
          )}

          {stakeholder.organization && (
            <p style={{ margin: '2px 0 0', fontSize: 'var(--text-base)', color: 'var(--color-text-secondary)' }}>
              {stakeholder.organization}
            </p>
          )}

          {stakeholder.email && (
            <p style={{ margin: '6px 0 0', fontSize: 'var(--text-base)' }}>
              <a
                href={`mailto:${stakeholder.email}`}
                style={{ color: 'var(--color-accent)', textDecoration: 'none' }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLAnchorElement).style.textDecoration = 'underline'; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLAnchorElement).style.textDecoration = 'none'; }}
              >
                {stakeholder.email}
              </a>
            </p>
          )}

          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'center',
              gap: 8,
              marginTop: 12,
            }}
          >
            <Badge variant={influenceBadgeVariant(stakeholder.influence)} size="md">
              {influenceLabel(stakeholder.influence)}
            </Badge>

            {hasTags &&
              stakeholder.tags.map((tag) => (
                <span
                  key={tag}
                  style={{
                    fontSize: 'var(--text-xs)',
                    fontWeight: 500,
                    padding: '2px 8px',
                    borderRadius: 'var(--radius-sm)',
                    background: 'var(--color-accent-subtle)',
                    color: 'var(--color-accent)',
                    border: '1px solid color-mix(in oklch, var(--color-accent) 20%, transparent)',
                  }}
                >
                  {tag}
                </span>
              ))}
          </div>
        </div>
      </div>

      {/* What matters */}
      {stakeholder.what_matters && (
        <SectionCard title="What matters">
          <p
            style={{
              margin: 0,
              fontSize: 'var(--text-base)',
              color: 'var(--color-text)',
              lineHeight: 1.6,
            }}
          >
            {stakeholder.what_matters}
          </p>
        </SectionCard>
      )}

      {/* Notes */}
      {notes && (
        <SectionCard title="Notes">
          <MarkdownView content={notes} />
        </SectionCard>
      )}

      {/* Related tasks */}
      <SectionCard
        title="Related tasks"
        badge={
          <Badge variant="default" size="sm">
            {tasks.length}
          </Badge>
        }
      >
        {tasks.length === 0 ? (
          <EmptyState
            title="No related tasks"
            description="Tasks linked to this stakeholder will appear here."
          />
        ) : (
          <div>
            {tasks.map((task, i) => (
              <TaskItem key={task.id} task={task} isLast={i === tasks.length - 1} />
            ))}
          </div>
        )}
      </SectionCard>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Back button (used in multiple early-return states)
// ---------------------------------------------------------------------------

function BackButton() {
  return (
    <div>
      <Link
        to="/stakeholders"
        style={{ display: 'inline-block' }}
      >
        <Button
          variant="ghost"
          size="sm"
          icon={<BackArrowIcon />}
          iconPosition="left"
          style={{ marginLeft: -6 }}
        >
          Back to Stakeholders
        </Button>
      </Link>
    </div>
  );
}
