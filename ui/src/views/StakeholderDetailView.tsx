import { useLanguage } from '@/i18n/LanguageProvider';
import { tr } from '@/i18n/current';
import { rich } from '@/i18n/rich';
import React, { useEffect, useState } from 'react';
import Card from '@/components/common/Card';
import Notice from '@/components/common/Notice';
import Page from '@/components/common/Page';
import { Link, useParams } from 'react-router-dom';

import Avatar from '@/components/common/Avatar';
import Badge from '@/components/common/Badge';
import Button from '@/components/common/Button';
import EmptyState from '@/components/common/EmptyState';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import MarkdownView from '@/components/common/MarkdownView';
import { apiGet } from '@/utils/api';
import { dueHighlight, formatDate, formatRelativeDate } from '@/utils/format';
import { useAppDispatch } from '@/store';
import { meetingPrepDraft } from '@/utils/meetingPrep';
import type { ClaudeAgent, OrgPersonSummary, OrgPosition, OutputTemplate, Stakeholder, Task } from '@/types';
import { StakeholderVoice, StakeholderVoiceCard } from '@/components/stakeholders/VoiceTag';
import StakeholderLastMeeting from '@/components/stakeholders/LastMeeting';

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
      return tr('stakeholderDetail.decisionMaker');
    case 'influencer':
      return tr('stakeholderDetail.influencer');
    case 'informed':
      return tr('stakeholderDetail.informed');
    case 'executor':
      return tr('stakeholderDetail.executor');
    case 'sponsor':
      return tr('stakeholderDetail.sponsor');
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
    backlog: tr('routineEditor.backlog'),
    ready: tr('routineEditor.ready'),
    in_progress: 'In Progress',
    blocked: tr('renderer.blocked'),
    review: tr('shared.review'),
    done: tr('done'),
    in_review: tr('simulation.needsReview'),
    approved: tr('format.approved'),
    archived: tr('format.archived'),
  };
  return labels[status];
}

function priorityLabel(priority: Task['priority']): string {
  const labels: Record<Task['priority'], string> = {
    critical: tr('attentionQueue.critical'),
    high: tr('attentionQueue.high'),
    medium: tr('attentionQueue.medium'),
    low: tr('attentionQueue.low'),
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
// Task list item
// ---------------------------------------------------------------------------

interface TaskItemProps {
  task: Task;
  isLast: boolean;
}

function TaskItem({ task, isLast }: TaskItemProps) {
  const { t } = useLanguage();
  const due = dueHighlight(task.due_date);

  let dueDateColor = 'var(--color-text-muted)';
  if (due === 'overdue') dueDateColor = 'var(--color-critical)';
  else if (due === 'soon') dueDateColor = 'var(--color-warning)';

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
        aria-label={t('stakeholderDetail.priority', { priorityLabel: priorityLabel(task.priority) })}
        title={t('stakeholderDetail.priority2', { priorityLabel: priorityLabel(task.priority) })}
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
        to={`/board/task/${encodeURIComponent(task.id)}`}
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
          {due === 'overdue' ? t('attentionList.overdue') : formatRelativeDate(task.due_date)}
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main view
// ---------------------------------------------------------------------------

/**
 * A stakeholder's profile. As a page it reads the id from the URL; `embedded` shows it inside a dialog
 * (e.g. from an org chart card) for `stakeholderId`, without the Back button or page padding.
 */
export default function StakeholderDetailView({ stakeholderId, embedded = false, onNavigate }: {
  stakeholderId?: string;
  embedded?: boolean;
  /** Embedded only: called when a link inside the profile is followed, so the dialog can close. */
  onNavigate?: () => void;
} = {}) {
  const { t } = useLanguage();
  const params = useParams<{ id: string }>();
  const id = stakeholderId ?? params.id;

  const [stakeholder, setStakeholder] = useState<Stakeholder | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [positions, setPositions] = useState<OrgPosition[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  const dispatch = useAppDispatch();

  /** Opens the New task form filled in for preparing a meeting with this person. */
  async function prepareMeeting(person: Stakeholder) {
    setPreparing(true);
    try {
      const [templates, agents] = await Promise.all([
        apiGet<OutputTemplate[]>('/api/outputs/templates').catch(() => []),
        apiGet<ClaudeAgent[]>('/api/agents').catch(() => []),
      ]);
      onNavigate?.();
      dispatch({ type: 'OPEN_NEW_TASK_DRAFT', payload: meetingPrepDraft(person, templates, agents) });
    } finally {
      setPreparing(false);
    }
  }

  useEffect(() => {
    if (!id) return;

    let cancelled = false;

    async function load() {
      setLoading(true);
      setNotFound(false);
      setFetchError(null);

      try {
        const [sk, taskList, orgPositions] = await Promise.all([
          apiGet<Stakeholder>(`/api/stakeholders/${id}`),
          apiGet<Task[]>(`/api/tasks?stakeholder_ref=${encodeURIComponent(id!)}`),
          apiGet<OrgPosition[]>(`/api/org-charts?stakeholder=${encodeURIComponent(id!)}`).catch(() => []),
        ]);
        if (cancelled) return;
        setStakeholder(sk);
        setTasks(taskList);
        setPositions(orgPositions);
      } catch (err: unknown) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : t('stakeholderDetail.failedToLoad');
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

  // Standalone, the page frame; inside an org chart panel, no frame of its own.
  const Frame = ({ children }: { children: React.ReactNode }) => embedded
    ? <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>{children}</div>
    : <Page width="narrow" style={{ gap: 'var(--space-4)' }}>{children}</Page>;

  // ---- Loading ----
  if (loading) return <LoadingSpinner text={t('stakeholderDetail.loadingStakeholder')} />;

  // ---- 404 ----
  if (notFound) {
    return (
      <Frame>
        {!embedded && <BackButton />}
        <EmptyState
          title={t('stakeholderDetail.stakeholderNotFound')}
          description={t('stakeholderDetail.thisStakeholderMayHaveBeen')}
        />
      </Frame>
    );
  }

  // ---- Error ----
  if (fetchError) {
    return (
      <Frame>
        {!embedded && <BackButton />}
        <Notice tone="critical" title={t('stakeholderDetail.couldNotLoadThisStakeholder')}>{fetchError}</Notice>
      </Frame>
    );
  }

  if (!stakeholder) return null;

  const notes = stakeholder.notes;
  const hasTags = stakeholder.tags && stakeholder.tags.length > 0;

  return (
    <div onClickCapture={embedded && onNavigate ? (e) => { if ((e.target as HTMLElement).closest('a')) onNavigate(); } : undefined}>
    <Frame>
      {!embedded && <BackButton />}

      {/* Profile card */}
      <div className="gtd-card" style={{ flexDirection: 'row', padding: 'var(--space-5)', gap: 'var(--space-5)', alignItems: 'flex-start' }}>
        <Avatar name={stakeholder.name} size="lg" />

        <div style={{ flex: 1, minWidth: 0 }}>
          {React.createElement(embedded ? 'h3' : 'h2', {
            style: {
              margin: 0,
              fontSize: 'var(--text-xl)',
              fontWeight: 600,
              color: 'var(--color-text)',
              lineHeight: 1.2,
            },
          }, stakeholder.name)}

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

            <StakeholderVoice id={stakeholder.id} />
          </div>
        </div>

        <Button variant="secondary" size="sm" loading={preparing} onClick={() => void prepareMeeting(stakeholder)} style={{ flexShrink: 0 }}>
          {t('stakeholderDetail.prepareMeeting')}
        </Button>
      </div>

      <StakeholderLastMeeting id={stakeholder.id} />

      {/* Organization */}
      <Card headingLevel={embedded ? 3 : 2} title={t('orgChartDialogs.organization')}>
        {positions.length === 0 ? (
          <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)' }}>
            {rich(t, 'stakeholderDetail.notInAnyOrgChart', { link: <Link to="/stakeholders?tab=charts" style={{ color: 'var(--color-accent)' }}>{t('stakeholderDetail.openOrgCharts')}</Link> })}
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {positions.map((p) => (
              <div key={p.chart.id}>
                <Link to={`/stakeholders?tab=charts&chart=${encodeURIComponent(p.chart.id)}`}
                  style={{ fontWeight: 600, fontSize: 'var(--text-sm)', color: 'var(--color-text)' }}>
                  {p.chart.name}
                </Link>
                {p.chart.organization && p.chart.organization !== p.chart.name && (
                  <span style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)' }}> · {p.chart.organization}</span>
                )}
                <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '6px 16px', margin: '8px 0 0', fontSize: 'var(--text-sm)' }}>
                  {p.title && (
                    <>
                      <dt style={{ color: 'var(--color-text-muted)' }}>{t('stakeholderDetail.titleHere')}</dt>
                      <dd style={{ margin: 0, color: 'var(--color-text)' }}>{p.title}</dd>
                    </>
                  )}
                  {p.unit && (
                    <>
                      <dt style={{ color: 'var(--color-text-muted)' }}>{t('routineEditor.unit')}</dt>
                      <dd style={{ margin: 0, color: 'var(--color-text)' }}>{p.unit.path.join(' › ')}</dd>
                    </>
                  )}
                  {p.head_of && (
                    <>
                      <dt style={{ color: 'var(--color-text-muted)' }}>{t('stakeholderDetail.leads')}</dt>
                      <dd style={{ margin: 0, color: 'var(--color-text)' }}>{p.head_of.map((u) => u.name).join(', ')}</dd>
                    </>
                  )}
                  <OrgRow label={t('stakeholderDetail.reportsTo')} people={p.manager ? [p.manager] : []} empty={t('orgChartsPanel.nobodyTopOfTheChart')} />
                  <OrgRow label={t('stakeholderDetail.directReports')} people={p.direct_reports} empty={t('stakeholderDetail.none')} />
                  {p.manager && <OrgRow label={t('stakeholderDetail.peers')} people={p.peers} empty={t('stakeholderDetail.none')} />}
                </dl>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* What matters */}
      {stakeholder.what_matters && (
        <Card headingLevel={embedded ? 3 : 2} title={t('stakeholderDetail.whatMatters')}>
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
        </Card>
      )}

      {/* Notes */}
      {notes && (
        <Card headingLevel={embedded ? 3 : 2} title={t('orgChartsPanel.notes')}>
          <MarkdownView content={notes} />
        </Card>
      )}

      {/* Voice: see and manage what is remembered of it (Recognize known voices) */}
      <StakeholderVoiceCard id={stakeholder.id} name={stakeholder.name} headingLevel={embedded ? 3 : 2} />

      {/* Related tasks */}
      <Card headingLevel={embedded ? 3 : 2}
        title={t('stakeholderDetail.relatedTasks')}
        badge={
          <Badge variant="default" size="sm">
            {tasks.length}
          </Badge>
        }
      >
        {tasks.length === 0 ? (
          <EmptyState
            title={t('stakeholderDetail.noRelatedTasks')}
            description={t('stakeholderDetail.tasksLinkedToThisStakeholder')}
          />
        ) : (
          <div>
            {tasks.map((task, i) => (
              <TaskItem key={task.id} task={task} isLast={i === tasks.length - 1} />
            ))}
          </div>
        )}
      </Card>
    </Frame>
    </div>
  );
}

function OrgRow({ label, people, empty }: { label: string; people: OrgPersonSummary[]; empty: string }) {
  const { t } = useLanguage();
  return (
    <>
      <dt style={{ color: 'var(--color-text-muted)' }}>{label}</dt>
      <dd style={{ margin: 0, color: 'var(--color-text)' }}>
        {people.length === 0 ? <span style={{ color: 'var(--color-text-muted)' }}>{empty}</span> : people.map((person, i) => (
          <React.Fragment key={person.id}>
            {i > 0 && ', '}
            {person.placeholder
              ? <span title={t('stakeholderDetail.placeholderInTheChartNot')}>{person.name} <em style={{ color: 'var(--color-text-muted)' }}>{t('stakeholderDetail.placeholder')}</em></span>
              : <Link to={`/stakeholders/${encodeURIComponent(person.id)}`} style={{ color: 'var(--color-accent)' }}>{person.name}</Link>}
            {person.role && <span style={{ color: 'var(--color-text-muted)' }}> ({person.role})</span>}
          </React.Fragment>
        ))}
      </dd>
    </>
  );
}

// ---------------------------------------------------------------------------
// Back button (used in multiple early-return states)
// ---------------------------------------------------------------------------

function BackButton() {
  const { t } = useLanguage();
  return (
    <div>
      <Link to="/stakeholders" className="gtd-btn gtd-btn--ghost gtd-btn--sm" style={{ marginLeft: -6 }}>
        {rich(t, 'stakeholderDetail.backToStakeholders', { part: <span aria-hidden="true" style={{ display: 'flex' }}><BackArrowIcon /></span> })}
      </Link>
    </div>
  );
}
