import React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useApi } from '../hooks/useApi';
import { SituationData } from '../types';
import Avatar from '../components/common/Avatar';
import { useStakeholderNames } from '../hooks/useStakeholderNames';
import { usePendingActions, TONE_COLOR, type PendingAction } from '../hooks/usePendingActions';
import Badge from '../components/common/Badge';
import LoadingSpinner from '../components/common/LoadingSpinner';
import EmptyState from '../components/common/EmptyState';
import { formatDate, formatDueStatus, formatRelativeTime, formatStatusLabel } from '../utils/format';

/* ---- Metric Card -------------------------------------------------- */
function MetricCard({
  label,
  count,
  color,
  icon,
}: {
  label: string;
  count: number;
  color: string;
  icon: React.ReactNode;
}) {
  return (
    <div
      style={{
        flex: '1 1 0',
        minWidth: 0,
        padding: '18px 20px',
        background: 'var(--color-surface)',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-lg)',
        display: 'flex',
        alignItems: 'center',
        gap: 14,
      }}
    >
      <div
        aria-hidden="true"
        style={{
          width: 40,
          height: 40,
          borderRadius: 'var(--radius-md)',
          background: `color-mix(in oklch, ${color} 12%, transparent)`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color,
          flexShrink: 0,
        }}
      >
        {icon}
      </div>
      <div>
        <div style={{ fontSize: 'var(--text-xl)', fontWeight: 700, color, lineHeight: 1 }}>{count}</div>
        <div style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)', marginTop: 3 }}>{label}</div>
      </div>
    </div>
  );
}

/* ---- Waiting on you ---------------------------------------------- */
// Steps only the user can take (review, run a command, fix a routine): the same ones the nav marks with a dot.
function WaitingOnYou({ items }: { items: PendingAction[] }) {
  return (
    <section
      aria-labelledby="waiting-heading"
      style={{
        background: 'var(--color-surface)',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-lg)',
        padding: '14px 16px',
      }}
    >
      <h2 id="waiting-heading" style={{ fontSize: 'var(--text-base)', fontWeight: 600, margin: '0 0 10px' }}>
        Waiting on you
      </h2>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 8 }}>
        {items.map((item) => (
          <li key={item.navPath}>
            <Link
              to={item.to}
              style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', height: '100%',
                border: '1px solid var(--color-border)', borderLeft: `3px solid ${TONE_COLOR[item.tone]}`,
                borderRadius: 'var(--radius-md)', background: 'var(--color-bg)',
                color: 'var(--color-text)', textDecoration: 'none', fontSize: 'var(--text-sm)',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-surface-hover)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--color-bg)'; }}
            >
              <span style={{ flex: 1, minWidth: 0 }}>{item.label}</span>
              <span aria-hidden="true" style={{ color: 'var(--color-text-muted)' }}>→</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

/* ---- Due date chip ------------------------------------------------- */
function DueDateChip({ dueDate }: { dueDate?: string }) {
  if (!dueDate) return null;
  const status = formatDueStatus(dueDate);
  const colorMap = {
    overdue: 'var(--color-critical)',
    'due-today': 'var(--color-warning)',
    'due-soon': 'var(--color-warning)',
    upcoming: 'var(--color-text-muted)',
    none: 'var(--color-text-muted)',
  };
  const color = colorMap[status];
  return (
    <span
      style={{
        fontSize: 'var(--text-xs)',
        color,
        background: `color-mix(in oklch, ${color} 10%, transparent)`,
        border: `1px solid color-mix(in oklch, ${color} 25%, transparent)`,
        borderRadius: 'var(--radius-sm)',
        padding: '1px 6px',
        whiteSpace: 'nowrap',
      }}
    >
      {formatDate(dueDate)}
    </span>
  );
}

/* ---- Stakeholder avatars ------------------------------------------ */
function StakeholderAvatars({ names, max = 3 }: { names: string[]; max?: number }) {
  const lookup = useStakeholderNames();
  if (!names.length) return null;
  const visible = names.slice(0, max);
  const overflow = names.length - max;
  return (
    <div style={{ display: 'flex', alignItems: 'center' }}>
      {visible.map((name, i) => {
        const stk = lookup(name);
        return (
          <div key={name} style={{ marginLeft: i > 0 ? -4 : 0, zIndex: max - i }}>
            <Avatar name={stk.name} role={stk.role} initials={stk.initials} size="sm" />
          </div>
        );
      })}
      {overflow > 0 && (
        <span
          style={{
            marginLeft: -8,
            width: 24,
            height: 24,
            borderRadius: '50%',
            background: 'var(--color-surface-hover)',
            border: '1px solid var(--color-border)',
            fontSize: 'var(--text-xs)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--color-text-muted)',
            zIndex: 0,
          }}
        >
          +{overflow}
        </span>
      )}
    </div>
  );
}

/* ---- Reason badge -------------------------------------------------- */
function ReasonBadge({ reason }: { reason: string }) {
  if (reason === 'overdue') {
    return <Badge variant="error" size="sm">OVERDUE</Badge>;
  }
  if (reason === 'blocked') {
    return <Badge variant="warning" size="sm">BLOCKED</Badge>;
  }
  return <Badge variant="info" size="sm">DUE SOON</Badge>;
}

/* ---- Status bar chart ---------------------------------------------- */
function StatusBarChart({ byStatus }: { byStatus: Record<string, number> }) {
  const statusOrder = ['backlog', 'ready', 'in_progress', 'blocked', 'review', 'done'];
  const colorMap: Record<string, string> = {
    backlog: 'var(--color-text-muted)',
    ready: 'var(--color-info)',
    in_progress: 'var(--color-accent)',
    blocked: 'var(--color-critical)',
    review: 'var(--color-warning)',
    done: 'var(--color-success)',
  };
  const max = Math.max(...statusOrder.map((s) => byStatus[s] ?? 0), 1);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {statusOrder.map((s) => {
        const count = byStatus[s] ?? 0;
        const pct = (count / max) * 100;
        return (
          <div key={s} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ width: 72, fontSize: 'var(--text-xs)', color: 'var(--color-text-secondary)', textAlign: 'right', flexShrink: 0 }}>
              {formatStatusLabel(s)}
            </div>
            <div style={{ flex: 1, height: 18, background: 'var(--color-bg)', borderRadius: 3, overflow: 'hidden' }}>
              <div style={{ width: `${pct}%`, height: '100%', background: colorMap[s], borderRadius: 3, minWidth: count > 0 ? 4 : 0 }} />
            </div>
            <div style={{ width: 24, fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', textAlign: 'right', flexShrink: 0 }}>
              {count}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ---- Cycle time scatter plot --------------------------------------- */
function CycleTimeScatter({ data }: { data: Array<{ title: string; days: number; priority?: string }> }) {
  if (!data.length) return <div style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-sm)' }}>No data</div>;
  const max = Math.max(...data.map((d) => d.days), 1);
  const w = 320;
  const h = 100;
  return (
    <svg
      width="100%"
      viewBox={`0 0 ${w} ${h}`}
      aria-label="Cycle time scatter plot"
      style={{ overflow: 'visible' }}
    >
      {data.map((d, i) => {
        const x = (i / Math.max(data.length - 1, 1)) * (w - 20) + 10;
        const y = h - 10 - (d.days / max) * (h - 20);
        return (
          <circle key={`${d.title}-${i}`} cx={x} cy={y} r={5} fill="var(--color-accent)" opacity={0.65}>
            <title>{d.title}: {d.days} days</title>
          </circle>
        );
      })}
      <line x1="0" y1={h - 10} x2={w} y2={h - 10} stroke="var(--color-border)" strokeWidth="1" />
    </svg>
  );
}

/* ---- Recent activity ---------------------------------------------- */
// "tasks/active/TASK-004/task.md" -> "TASK-004/task.md": the folder is what tells
// two task.md files apart, the rest of the path is in the hover text.
function shortPath(filePath: string): string {
  return filePath.split('/').slice(-2).join('/');
}

/* ---- Progress bar -------------------------------------------------- */
function ProgressBar({ value }: { value: number }) {
  const pct = Math.min(Math.max(value, 0), 100);
  return (
    <div style={{ height: 4, background: 'var(--color-bg)', borderRadius: 2, overflow: 'hidden' }}>
      <div style={{ width: `${pct}%`, height: '100%', background: 'var(--color-accent)', borderRadius: 2 }} />
    </div>
  );
}

/* ---- Main View ----------------------------------------------------- */
export default function SituationView() {
  const { data, loading } = useApi<SituationData>('/api/situation');
  const navigate = useNavigate();
  const pending = usePendingActions();

  if (loading) return <LoadingSpinner text="Loading situation..." />;
  if (!data) {
    return (
      <EmptyState
        title="No situation data"
        description="Could not load the situation board. Check that the backend is running."
      />
    );
  }

  const today = new Date();
  const in14 = new Date(today);
  in14.setDate(today.getDate() + 14);

  return (
    <div className="situation" style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 24, maxWidth: 1280, margin: '0 auto' }}>
      {/* Metric cards */}
      <div className="situation__metrics" role="region" aria-label="Key metrics">
        <MetricCard
          label="Overdue"
          count={data.overdue_count}
          color="var(--color-critical)"
          icon={
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <circle cx="10" cy="10" r="8.5" stroke="currentColor" strokeWidth="1.5" />
              <path d="M10 6v4.5l3 2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          }
        />
        <MetricCard
          label="Due soon"
          count={data.due_soon_count}
          color="var(--color-warning)"
          icon={
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <path d="M10 3L18 17H2L10 3Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
              <path d="M10 9v3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              <circle cx="10" cy="14" r="0.75" fill="currentColor" />
            </svg>
          }
        />
        <MetricCard
          label="Blocked"
          count={data.blocked_count}
          color="oklch(0.62 0.16 35)"
          icon={
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <circle cx="10" cy="10" r="8.5" stroke="currentColor" strokeWidth="1.5" />
              <path d="M4 4L16 16" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          }
        />
        <MetricCard
          label="In progress"
          count={data.in_progress_count}
          color="var(--color-accent)"
          icon={
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <path d="M5 10l3.5 3.5L15 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          }
        />
      </div>

      {pending.length > 0 && <WaitingOnYou items={pending} />}

      {/* Main grid: one column, two from 1,000 px of content width (see .situation__grid in index.css) */}
      <div className="situation__grid">
        {/* Left column */}
        <div className="situation__main" style={{ display: 'flex', flexDirection: 'column', gap: 20, minWidth: 0 }}>
          {/* Attention Queue */}
          <section
            aria-labelledby="attention-heading"
            style={{
              background: 'var(--color-surface)',
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-lg)',
              overflow: 'hidden',
            }}
          >
            <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--color-border)', display: 'flex', alignItems: 'center', gap: 8 }}>
              <h2 id="attention-heading" style={{ fontSize: 'var(--text-base)', fontWeight: 600 }}>Needs attention</h2>
              <Badge variant="error" size="sm">{data.attention_queue.length}</Badge>
            </div>

            {data.attention_queue.length === 0 ? (
              <div style={{ padding: '24px 18px', color: 'var(--color-text-muted)', fontSize: 'var(--text-sm)', textAlign: 'center' }}>
                Nothing needs attention right now.
              </div>
            ) : (
              <ul role="list" style={{ listStyle: 'none' }}>
                {data.attention_queue.map((item, idx) => (
                  <li
                    key={item.id}
                    className="situation__attention-row"
                    style={{
                      padding: '11px 18px',
                      borderBottom: idx < data.attention_queue.length - 1 ? '1px solid var(--color-border)' : 'none',
                    }}
                  >
                    <ReasonBadge reason={item.reason} />
                    <button
                      className="situation__attention-title"
                      onClick={() => navigate(`/board/task/${item.id}`)}
                      style={{
                        background: 'transparent',
                        border: 'none',
                        padding: 0,
                        cursor: 'pointer',
                        textAlign: 'left',
                        fontSize: 'var(--text-sm)',
                        fontWeight: 500,
                        color: 'var(--color-text)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      <span title={item.title}>{item.title}</span>
                    </button>
                    <div className="situation__attention-meta">
                    <DueDateChip dueDate={item.due_date} />
                    <StakeholderAvatars names={item.stakeholders} />
                    <button
                      aria-label="Open task"
                      onClick={() => navigate(`/board/task/${item.id}`)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        width: 26,
                        height: 26,
                        borderRadius: 'var(--radius-sm)',
                        border: '1px solid var(--color-border)',
                        background: 'transparent',
                        cursor: 'pointer',
                        color: 'var(--color-text-muted)',
                        flexShrink: 0,
                      }}
                    >
                      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                        <path d="M2.5 6H9.5M6.5 3L9.5 6L6.5 9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* Upcoming commitments */}
          <section
            aria-labelledby="upcoming-heading"
            style={{
              background: 'var(--color-surface)',
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-lg)',
              overflow: 'hidden',
            }}
          >
            <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--color-border)', display: 'flex', alignItems: 'center', gap: 8 }}>
              <h2 id="upcoming-heading" style={{ fontSize: 'var(--text-base)', fontWeight: 600 }}>Upcoming commitments</h2>
              <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
                next 14 days
              </span>
            </div>

            {data.upcoming_commitments.length === 0 ? (
              <div style={{ padding: '24px 18px', color: 'var(--color-text-muted)', fontSize: 'var(--text-sm)', textAlign: 'center' }}>
                No upcoming commitments.
              </div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table
                  style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--text-sm)' }}
                  aria-label="Upcoming commitments"
                >
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--color-border)' }}>
                      {['Due date', 'Task', 'Stakeholders', 'Type'].map((h) => (
                        <th
                          key={h}
                          scope="col"
                          style={{
                            padding: '8px 18px 8px',
                            textAlign: 'left',
                            fontSize: 'var(--text-xs)',
                            fontWeight: 600,
                            color: 'var(--color-text-muted)',
                            textTransform: 'uppercase',
                            letterSpacing: '0.04em',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.upcoming_commitments.map((c, idx) => (
                      <tr
                        key={c.id}
                        style={{
                          borderBottom: idx < data.upcoming_commitments.length - 1 ? '1px solid var(--color-border)' : 'none',
                          cursor: 'pointer',
                        }}
                        onClick={() => navigate(`/board/task/${c.id}`)}
                      >
                        <td style={{ padding: '10px 18px', whiteSpace: 'nowrap' }}>
                          <DueDateChip dueDate={c.due_date} />
                        </td>
                        <td style={{ padding: '10px 18px', maxWidth: 280 }}>
                          <Link to={`/board/task/${c.id}`} className="truncate situation__task-link" title={c.title}
                            onClick={(e) => e.stopPropagation()}
                            style={{ display: 'block', fontWeight: 500, color: 'inherit', textDecoration: 'none' }}>{c.title}</Link>
                        </td>
                        <td style={{ padding: '10px 18px' }}>
                          <StakeholderAvatars names={c.stakeholders} />
                        </td>
                        <td style={{ padding: '10px 18px' }}>
                          <Badge size="sm">{c.task_type}</Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* Workflow snapshot */}
          <section
            aria-labelledby="workflow-heading"
            style={{
              background: 'var(--color-surface)',
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-lg)',
              overflow: 'hidden',
            }}
          >
            <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--color-border)' }}>
              <h2 id="workflow-heading" style={{ fontSize: 'var(--text-base)', fontWeight: 600 }}>Workflow snapshot</h2>
            </div>
            <div className="situation__snapshot">
              <div>
                <div style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--color-text-secondary)', marginBottom: 12 }}>
                  Tasks by status
                </div>
                <StatusBarChart byStatus={data.workflow_snapshot.by_status} />
              </div>
              <div>
                <div style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--color-text-secondary)', marginBottom: 12 }}>
                  Cycle time (days)
                </div>
                {data.workflow_snapshot.cycle_time_data.length > 0 ? (
                  <CycleTimeScatter data={data.workflow_snapshot.cycle_time_data} />
                ) : (
                  <div style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-sm)' }}>Not enough data yet.</div>
                )}
              </div>
            </div>
          </section>
        </div>

        {/* Right column */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20, minWidth: 0 }}>
          {/* Current focus */}
          <section
            aria-labelledby="focus-heading"
            style={{
              background: 'var(--color-surface)',
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-lg)',
              overflow: 'hidden',
            }}
          >
            <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--color-border)', display: 'flex', alignItems: 'center', gap: 8 }}>
              <h2 id="focus-heading" style={{ fontSize: 'var(--text-base)', fontWeight: 600 }}>Current focus</h2>
              <Badge variant="accent" size="sm">{data.current_focus.length}</Badge>
            </div>

            {data.current_focus.length === 0 ? (
              <div style={{ padding: '24px 18px', color: 'var(--color-text-muted)', fontSize: 'var(--text-sm)', textAlign: 'center' }}>
                No tasks in progress.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
                {data.current_focus.map((task, idx) => {
                  const progress = task.progress ?? 0;
                  return (
                    <div
                      key={task.id}
                      style={{
                        padding: '14px 18px',
                        borderBottom: idx < data.current_focus.length - 1 ? '1px solid var(--color-border)' : 'none',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8, marginBottom: 8 }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <button
                            onClick={() => navigate(`/board/task/${task.id}`)}
                            style={{
                              display: 'block',
                              width: '100%',
                              textAlign: 'left',
                              background: 'transparent',
                              border: 'none',
                              padding: 0,
                              cursor: 'pointer',
                              fontWeight: 600,
                              fontSize: 'var(--text-sm)',
                              color: 'var(--color-text)',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            <span title={task.title}>{task.title}</span>
                          </button>
                        </div>
                        <Badge
                          variant={`priority-${task.priority}` as 'priority-critical'}
                          size="sm"
                        >
                          {task.priority}
                        </Badge>
                      </div>
                      <ProgressBar value={progress} />
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
                        <StakeholderAvatars names={task.stakeholders} />
                        <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
                          {task.deliverables.slice(0, 3).map((d, i) => (
                            d.format && <Badge key={i} size="sm">{d.format}</Badge>
                          ))}
                          {task.due_date && <DueDateChip dueDate={task.due_date} />}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* Recent activity */}
          <section
            aria-labelledby="activity-heading"
            style={{
              background: 'var(--color-surface)',
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-lg)',
              overflow: 'hidden',
            }}
          >
            <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--color-border)' }}>
              <h2 id="activity-heading" style={{ fontSize: 'var(--text-base)', fontWeight: 600 }}>Recent activity</h2>
            </div>
            {data.recent_activity.length === 0 ? (
              <div style={{ padding: '24px 18px', color: 'var(--color-text-muted)', fontSize: 'var(--text-sm)', textAlign: 'center' }}>
                No recent activity.
              </div>
            ) : (
              <ul role="list" style={{ listStyle: 'none', padding: 0 }}>
                {data.recent_activity.map((a, i) => (
                  <li
                    key={i}
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: 10,
                      padding: '10px 18px',
                      borderBottom: i < data.recent_activity.length - 1 ? '1px solid var(--color-border)' : 'none',
                    }}
                  >
                    <div
                      aria-hidden="true"
                      style={{
                        width: 28,
                        height: 28,
                        borderRadius: 'var(--radius-sm)',
                        background: 'var(--color-bg)',
                        border: '1px solid var(--color-border)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        flexShrink: 0,
                        color: 'var(--color-text-muted)',
                      }}
                    >
                      <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true">
                        <path d="M7 1H3a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V5L7 1Z" stroke="currentColor" strokeWidth="1.2" />
                        <path d="M7 1v4h4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
                      </svg>
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }} title={a.path}>
                      <div
                        className="truncate"
                        style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text)', marginBottom: 2 }}
                      >
                        {a.title ?? a.filename}
                      </div>
                      <div className="truncate" style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-secondary)' }}>
                        <span style={{ fontFamily: 'var(--font-mono)' }}>{shortPath(a.path)}</span> · {a.event}
                      </div>
                    </div>
                    <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', whiteSpace: 'nowrap', flexShrink: 0 }}>
                      {formatRelativeTime(a.timestamp)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
