import { useState, useCallback, useMemo, createContext, useContext } from 'react';
import { useNavigate, Outlet } from 'react-router-dom';
import { useApi } from '../hooks/useApi';
import { Task, Stakeholder } from '../types';
import Badge from '../components/common/Badge';
import Avatar from '../components/common/Avatar';
import Input from '../components/common/Input';
import LoadingSpinner from '../components/common/LoadingSpinner';
import EmptyState from '../components/common/EmptyState';
import { useAppDispatch, useDataVersion } from '../store';
import { apiPut } from '../utils/api';
import { formatDate, formatDueStatus, formatStatusLabel, formatPriorityLabel } from '../utils/format';

type ViewTab = 'kanban' | 'list' | 'archive';
type PriorityFilter = 'all' | 'critical' | 'high' | 'medium' | 'low';

/* ---- Due date chip ----------------------------------------------- */
function DueDateChip({ dueDate }: { dueDate?: string }) {
  if (!dueDate) return null;
  const status = formatDueStatus(dueDate);
  const colorMap: Record<string, string> = {
    overdue: 'var(--color-critical)',
    'due-today': 'var(--color-warning)',
    'due-soon': 'var(--color-warning)',
    upcoming: 'var(--color-text-muted)',
    none: 'var(--color-text-muted)',
  };
  const color = colorMap[status] ?? 'var(--color-text-muted)';
  return (
    <span style={{
      fontSize: 'var(--text-xs)',
      color,
      background: `color-mix(in oklch, ${color} 10%, transparent)`,
      border: `1px solid color-mix(in oklch, ${color} 25%, transparent)`,
      borderRadius: 'var(--radius-sm)',
      padding: '1px 6px',
      whiteSpace: 'nowrap',
      flexShrink: 0,
    }}>
      {formatDate(dueDate)}
    </span>
  );
}

/* ---- Stakeholder avatars ------------------------------------------ */
// Task cards only carry stakeholder refs (STK-0001…). The board loads the stakeholders once and
// shares them here, so avatars show the person's initials and name instead of "S" for "STK-…".
const StakeholderLookup = createContext<Map<string, Stakeholder>>(new Map());

function StakeholderAvatars({ refs, max = 3 }: { refs: Task['stakeholders']; max?: number }) {
  const lookup = useContext(StakeholderLookup);
  if (!refs.length) return null;
  const visible = refs.slice(0, max);
  const overflow = refs.length - max;
  return (
    <div style={{ display: 'flex', alignItems: 'center' }}>
      {visible.map((s, i) => {
        const stk = lookup.get(s.ref);
        return (
          <div key={s.ref} style={{ marginLeft: i > 0 ? -8 : 0, zIndex: max - i }}>
            <Avatar name={stk?.name ?? s.ref} initials={stk?.avatar_initials} size="sm" />
          </div>
        );
      })}
      {overflow > 0 && (
        <span style={{
          marginLeft: -8,
          width: 24, height: 24, borderRadius: '50%',
          background: 'var(--color-surface-hover)',
          border: '1px solid var(--color-border)',
          fontSize: 'var(--text-xs)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: 'var(--color-text-muted)',
        }}>
          +{overflow}
        </span>
      )}
    </div>
  );
}

/* ---- Age chip ----------------------------------------------------- */
function AgeChip({ createdAt }: { createdAt: string }) {
  const days = Math.floor((Date.now() - new Date(createdAt).getTime()) / 86400000);
  if (days < 1) return null;
  return (
    <span style={{
      fontSize: 'var(--text-xs)',
      color: 'var(--color-text-muted)',
      background: 'var(--color-bg)',
      border: '1px solid var(--color-border)',
      borderRadius: 'var(--radius-sm)',
      padding: '1px 6px',
      flexShrink: 0,
    }}>
      {days}d
    </span>
  );
}

/* ---- Agent working indicator -------------------------------------- */
function formatAgentName(agent: string): string {
  return agent.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/** Statuses that mean an agent is actively on the task. */
const WORKING_STATUSES: Task['status'][] = ['in_progress', 'review'];

function AgentWorkingIndicator({ task }: { task: Task }) {
  if (!WORKING_STATUSES.includes(task.status)) return null;
  // The agent name only exists once a task is routed to a specialist. Until
  // then still show progress, so the card never looks idle while work is running.
  const label = task.preferred_agent ? formatAgentName(task.preferred_agent) : 'Working';
  return (
    <div
      title={task.preferred_agent ? `${label} is working on this task` : 'An agent is working on this task'}
      style={{ display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0 }}
    >
      <svg
        aria-hidden="true"
        width="11"
        height="11"
        viewBox="0 0 24 24"
        fill="none"
        style={{ animation: 'esb-spin 0.75s linear infinite', flexShrink: 0 }}
      >
        <circle cx="12" cy="12" r="10" stroke="var(--color-border-strong)" strokeWidth="3" />
        <path d="M12 2a10 10 0 0 1 10 10" stroke="var(--color-accent)" strokeWidth="3" strokeLinecap="round" />
      </svg>
      <span style={{
        fontSize: 'var(--text-xs)',
        color: 'var(--color-accent)',
        fontWeight: 500,
        whiteSpace: 'nowrap',
        maxWidth: 130,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      }}>
        {label}
      </span>
      <style>{`@keyframes esb-spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

/* ---- Task card (Kanban) ------------------------------------------- */

function TaskCard({ task, onClick }: { task: Task; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      aria-label={`Open task: ${task.title}`}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        width: '100%',
        textAlign: 'left',
        background: 'var(--color-surface)',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-md)',
        padding: 12,
        cursor: 'pointer',
        transition: 'border-color 0.15s, box-shadow 0.15s',
        marginBottom: 8,
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLElement).style.borderColor = 'var(--color-border-strong)';
        (e.currentTarget as HTMLElement).style.boxShadow = 'var(--shadow-sm)';
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLElement).style.borderColor = 'var(--color-border)';
        (e.currentTarget as HTMLElement).style.boxShadow = 'none';
      }}
    >
      {/* Row 1: priority + type */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <Badge variant={`priority-${task.priority}` as 'priority-critical'} size="sm">
          {formatPriorityLabel(task.priority)}
        </Badge>
        <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>{task.task_type}</span>
      </div>

      {/* Title */}
      <div style={{
        fontWeight: 600,
        fontSize: 'var(--text-sm)',
        color: 'var(--color-text)',
        lineHeight: 1.35,
        display: '-webkit-box',
        WebkitLineClamp: 2,
        WebkitBoxOrient: 'vertical',
        overflow: 'hidden',
      }}>
        {task.title}
      </div>

      {/* Blocked warning */}
      {task.status === 'blocked' && (
        <div style={{
          background: 'var(--color-critical-subtle)',
          border: '1px solid color-mix(in oklch, var(--color-critical) 20%, transparent)',
          borderRadius: 'var(--radius-sm)',
          padding: '4px 8px',
          fontSize: 'var(--text-xs)',
          color: 'var(--color-critical)',
          fontWeight: 500,
        }}>
          Blocked
        </div>
      )}

      {/* Row: date + age */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <DueDateChip dueDate={task.due_date} />
        <AgeChip createdAt={task.created_at} />
        {(task.deliverables ?? []).slice(0, 2).map((d, i) =>
          d.format ? <Badge key={i} size="sm">{d.format}</Badge> : null
        )}
      </div>

      {/* Row: stakeholders + agent indicator */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <StakeholderAvatars refs={task.stakeholders ?? []} />
        <AgentWorkingIndicator task={task} />
      </div>
    </button>
  );
}

/* ---- Kanban column ------------------------------------------------- */
interface KanbanColumn {
  id: string;
  label: string;
  statuses: Task['status'][];
}

const KANBAN_COLUMNS: KanbanColumn[] = [
  { id: 'backlog', label: 'Backlog', statuses: ['backlog', 'ready'] },
  { id: 'in_progress', label: 'In Progress', statuses: ['in_progress', 'blocked', 'review'] },
  { id: 'needs_review', label: 'Needs Review', statuses: ['in_review'] },
  { id: 'done', label: 'Done', statuses: ['done', 'approved'] },
];

function KanbanCol({
  column,
  tasks,
  onCardClick,
  onDrop,
  onAddTask,
}: {
  column: KanbanColumn;
  tasks: Task[];
  onCardClick: (id: string) => void;
  onDrop: (taskId: string, status: Task['status']) => void;
  onAddTask: (defaultStatus: Task['status']) => void;
}) {
  const [dragOver, setDragOver] = useState(false);

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        const taskId = e.dataTransfer.getData('text/plain');
        // Dropping within the same column keeps the task's own status (e.g. `blocked` stays blocked).
        if (tasks.some((t) => t.id === taskId)) return;
        // A column's first status is its canonical one: backlog, in_progress, in_review, done.
        // (Using the second one made a drop into In Progress set `blocked` and into Done set `approved`.)
        onDrop(taskId, column.statuses[0]);
      }}
      style={{
        flex: '1 1 0',
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        background: dragOver ? 'var(--color-accent-subtle)' : 'var(--color-bg)',
        border: `1px solid ${dragOver ? 'var(--color-accent)' : 'var(--color-border)'}`,
        borderRadius: 'var(--radius-lg)',
        transition: 'background 0.15s, border-color 0.15s',
      }}
    >
      {/* Column header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '12px 14px',
        borderBottom: '1px solid var(--color-border)',
        flexShrink: 0,
      }}>
        <span style={{ fontWeight: 600, fontSize: 'var(--text-sm)' }}>{column.label}</span>
        <Badge size="sm">{tasks.length}</Badge>
        <div style={{ flex: 1 }} />
        <button
          aria-label={`Add task to ${column.label}`}
          onClick={() => onAddTask(column.statuses[0])}
          style={{ color: 'var(--color-text-muted)', cursor: 'pointer', border: 'none', background: 'transparent', display: 'flex' }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--color-accent)'; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--color-text-muted)'; }}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      {/* Cards */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '10px 10px 4px' }}>
        {tasks.length === 0 && (
          <div style={{ textAlign: 'center', padding: '20px 0', fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)' }}>
            Drop tasks here
          </div>
        )}
        {tasks.map((task) => (
          <div
            key={task.id}
            draggable
            onDragStart={(e) => e.dataTransfer.setData('text/plain', task.id)}
          >
            <TaskCard task={task} onClick={() => onCardClick(task.id)} />
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---- List view ----------------------------------------------------- */
function ListView({
  tasks,
  onRowClick,
}: {
  tasks: Task[];
  onRowClick: (id: string) => void;
}) {
  const [sortKey, setSortKey] = useState<keyof Task>('created_at');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  const sorted = [...tasks].sort((a, b) => {
    const av = (a[sortKey] ?? '') as string;
    const bv = (b[sortKey] ?? '') as string;
    return sortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
  });

  const handleSort = (key: keyof Task) => {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(key); setSortDir('asc'); }
  };

  type ColDef = { key: keyof Task; label: string; width?: string };
  const cols: ColDef[] = [
    { key: 'priority', label: 'Priority', width: '90px' },
    { key: 'title', label: 'Title' },
    { key: 'status', label: 'Status', width: '110px' },
    { key: 'due_date', label: 'Due', width: '90px' },
    { key: 'task_type', label: 'Type', width: '110px' },
    { key: 'created_at', label: 'Created', width: '90px' },
  ];

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--text-sm)' }}>
        <thead>
          <tr style={{ borderBottom: '2px solid var(--color-border)' }}>
            {cols.map((col) => (
              <th
                key={col.key as string}
                scope="col"
                onClick={() => handleSort(col.key)}
                style={{
                  padding: '8px 14px',
                  textAlign: 'left',
                  fontSize: 'var(--text-xs)',
                  fontWeight: 600,
                  color: 'var(--color-text-muted)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.04em',
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                  width: col.width,
                  userSelect: 'none',
                }}
              >
                {col.label}
                {sortKey === col.key && <span aria-hidden="true">{sortDir === 'asc' ? ' ↑' : ' ↓'}</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((task) => (
            <tr
              key={task.id}
              onClick={() => onRowClick(task.id)}
              tabIndex={0}
              onKeyDown={(e) => e.key === 'Enter' && onRowClick(task.id)}
              style={{
                borderBottom: '1px solid var(--color-border)',
                cursor: 'pointer',
                transition: 'background 0.1s',
              }}
              onMouseEnter={(e) => (e.currentTarget as HTMLElement).style.background = 'var(--color-surface-hover)'}
              onMouseLeave={(e) => (e.currentTarget as HTMLElement).style.background = 'transparent'}
            >
              <td style={{ padding: '10px 14px' }}>
                <Badge variant={`priority-${task.priority}` as 'priority-critical'} size="sm">
                  {formatPriorityLabel(task.priority)}
                </Badge>
              </td>
              <td style={{ padding: '10px 14px', fontWeight: 500, maxWidth: 360 }}>
                <span className="truncate" style={{ display: 'block' }}>{task.title}</span>
                {task.tags.length > 0 && (
                  <div style={{ marginTop: 2, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                    {task.tags.slice(0, 3).map((t) => <Badge key={t} size="sm">{t}</Badge>)}
                  </div>
                )}
              </td>
              <td style={{ padding: '10px 14px' }}>
                <Badge variant={`status-${task.status}` as 'status-done'} size="sm">
                  {formatStatusLabel(task.status)}
                </Badge>
              </td>
              <td style={{ padding: '10px 14px' }}>
                <DueDateChip dueDate={task.due_date} />
              </td>
              <td style={{ padding: '10px 14px', color: 'var(--color-text-secondary)' }}>{task.task_type}</td>
              <td style={{ padding: '10px 14px', color: 'var(--color-text-muted)', fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)' }}>
                {formatDate(task.created_at)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {sorted.length === 0 && (
        <div style={{ padding: '32px', textAlign: 'center', color: 'var(--color-text-muted)', fontSize: 'var(--text-sm)' }}>
          No tasks match the current filters.
        </div>
      )}
    </div>
  );
}

/* ---- Main view ----------------------------------------------------- */
export default function BoardView() {
  const [tab, setTab] = useState<ViewTab>('kanban');
  const [priorityFilter, setPriorityFilter] = useState<PriorityFilter>('all');
  const [search, setSearch] = useState('');
  const navigate = useNavigate();
  const dispatch = useAppDispatch();

  // Refetch whenever tasks change anywhere: a new task from the modal, a drag
  // between columns, or an agent editing task.md on disk.
  const tasksVersion = useDataVersion('tasks');
  const { data, loading, refetch } = useApi<Task[]>('/api/tasks', [tasksVersion]);
  const stakeholdersVersion = useDataVersion('stakeholders');
  const { data: stakeholders } = useApi<Stakeholder[]>('/api/stakeholders', [stakeholdersVersion]);
  const stakeholderLookup = useMemo(
    () => new Map((stakeholders ?? []).map((s) => [s.id, s] as const)),
    [stakeholders],
  );

  const openNewTask = useCallback((defaultStatus: Task['status']) => {
    dispatch({ type: 'OPEN_NEW_TASK_MODAL', payload: defaultStatus });
  }, [dispatch]);

  const tasks = (data ?? []).filter((t) => {
    if (tab === 'archive') return t.status === 'archived';
    return t.status !== 'archived';
  });

  const filtered = tasks.filter((t) => {
    if (priorityFilter !== 'all' && t.priority !== priorityFilter) return false;
    if (search && !t.title.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const handleDrop = useCallback(async (taskId: string, status: Task['status']) => {
    try {
      await apiPut(`/api/tasks/${taskId}`, { status });
      dispatch({ type: 'DATA_CHANGED', payload: 'tasks' });
    } catch {
      // ignore
    }
  }, [dispatch]);

  const priorities: PriorityFilter[] = ['all', 'critical', 'high', 'medium', 'low'];

  return (
    <StakeholderLookup.Provider value={stakeholderLookup}>
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Tabs */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 2,
        padding: '0 20px',
        borderBottom: '1px solid var(--color-border)',
        background: 'var(--color-surface)',
        flexShrink: 0,
      }}>
        {(['kanban', 'list', 'archive'] as ViewTab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            aria-selected={tab === t}
            role="tab"
            style={{
              padding: '12px 14px',
              fontSize: 'var(--text-sm)',
              fontWeight: tab === t ? 600 : 400,
              color: tab === t ? 'var(--color-text)' : 'var(--color-text-muted)',
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              borderBottom: tab === t ? '2px solid var(--color-accent)' : '2px solid transparent',
              transition: 'color 0.1s',
              textTransform: 'capitalize',
            }}
          >
            {t}
          </button>
        ))}
      </div>

      {/* Filter bar */}
      {tab !== 'archive' && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '10px 20px',
          borderBottom: '1px solid var(--color-border)',
          background: 'var(--color-surface)',
          flexShrink: 0,
          flexWrap: 'wrap',
        }}>
          <div style={{ display: 'flex', gap: 6 }}>
            {priorities.map((p) => (
              <button
                key={p}
                onClick={() => setPriorityFilter(p)}
                aria-pressed={priorityFilter === p}
                style={{
                  padding: '3px 10px',
                  fontSize: 'var(--text-xs)',
                  fontWeight: 500,
                  borderRadius: 'var(--radius-sm)',
                  border: '1px solid',
                  cursor: 'pointer',
                  transition: 'background 0.1s, color 0.1s',
                  ...(priorityFilter === p
                    ? { background: 'var(--color-accent)', color: 'var(--color-text-on-accent)', borderColor: 'var(--color-accent)' }
                    : { background: 'transparent', color: 'var(--color-text-secondary)', borderColor: 'var(--color-border)' }),
                }}
              >
                {p === 'all' ? 'All' : formatPriorityLabel(p)}
              </button>
            ))}
          </div>
          <Input
            value={search}
            onChange={setSearch}
            placeholder="Search tasks..."
            style={{ maxWidth: 220 }}
            icon={
              <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true">
                <circle cx="5.5" cy="5.5" r="4" stroke="currentColor" strokeWidth="1.2" />
                <path d="M8.5 8.5L11 11" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
              </svg>
            }
          />
          <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', marginLeft: 'auto' }}>
            {filtered.length} task{filtered.length !== 1 ? 's' : ''}
          </span>
        </div>
      )}

      {/* Content */}
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {loading && <LoadingSpinner text="Loading tasks..." />}

        {!loading && tab === 'kanban' && (
          <div style={{ flex: 1, display: 'flex', gap: 14, padding: '16px 20px', overflow: 'hidden', minHeight: 0 }}>
            {KANBAN_COLUMNS.map((col) => (
              <KanbanCol
                key={col.id}
                column={col}
                tasks={filtered.filter((t) => col.statuses.includes(t.status))}
                onCardClick={(id) => navigate(`/board/task/${id}`)}
                onDrop={handleDrop}
                onAddTask={openNewTask}
              />
            ))}
          </div>
        )}

        {!loading && tab === 'list' && (
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {filtered.length === 0 ? (
              <EmptyState
                title="No tasks"
                description="Add tasks to start tracking your work."
                action={{ label: 'Create task', onClick: () => {} }}
              />
            ) : (
              <ListView tasks={filtered} onRowClick={(id) => navigate(`/board/task/${id}`)} />
            )}
          </div>
        )}

        {!loading && tab === 'archive' && (
          <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px' }}>
            {tasks.length === 0 ? (
              <EmptyState title="Archive is empty" description="Completed and archived tasks will appear here." />
            ) : (
              <ListView tasks={tasks} onRowClick={(id) => navigate(`/board/task/${id}`)} />
            )}
          </div>
        )}
      </div>

    </div>
    <Outlet context={{ refetchTasks: refetch }} />
    </StakeholderLookup.Provider>
  );
}
