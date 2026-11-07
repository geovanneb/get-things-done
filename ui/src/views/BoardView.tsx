import { useLanguage } from '@/i18n/LanguageProvider';
import { rich } from '@/i18n/rich';
import { useState, useCallback, useEffect, useMemo, createContext, useContext } from 'react';
import Page from '@/components/common/Page';
import { SearchInput } from '@/components/common/Input';
import { CountBadge, SegmentedControl, Tabs } from '@/components/common/Tabs';
import IconButton, { icons } from '@/components/common/IconButton';
import Button from '@/components/common/Button';
import BoardColumnsEditor from '@/components/board/BoardColumnsEditor';
import { useNotify } from '@/hooks/useNotify';
import { useNavigate, Outlet } from 'react-router-dom';
import { useApi } from '../hooks/useApi';
import { Task, Stakeholder } from '../types';
import Badge from '../components/common/Badge';
import Avatar from '../components/common/Avatar';
import LoadingSpinner from '../components/common/LoadingSpinner';
import EmptyState from '../components/common/EmptyState';
import { useAppDispatch, useAppState, useDataVersion } from '../store';
import { apiPut } from '../utils/api';
import { formatDate, formatDueStatus, formatStatusLabel, formatPriorityLabel } from '../utils/format';
import { columnLabel, DEFAULT_BOARD, dropUpdate, placeTasks, type BoardColumn, type BoardColumns } from '../utils/boardColumns';

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
          <div key={s.ref} style={{ marginLeft: i > 0 ? -4 : 0, zIndex: max - i }}>
            <Avatar name={stk?.name ?? s.ref} role={stk?.role} initials={stk?.avatar_initials} size="sm" />
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
  const { t } = useLanguage();
  if (!WORKING_STATUSES.includes(task.status)) return null;
  // The agent name only exists once a task is routed to a specialist. Until
  // then still show progress, so the card never looks idle while work is running.
  const label = task.preferred_agent ? formatAgentName(task.preferred_agent) : t('runSteps.working');
  return (
    <div
      title={task.preferred_agent ? t('board.isWorkingOnThisTask', { label }) : t('board.anAgentIsWorkingOn')}
      style={{ display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0 }}
    >
      <svg
        aria-hidden="true"
        width="11"
        height="11"
        viewBox="0 0 24 24"
        fill="none"
        className="gtd-spin" style={{ flexShrink: 0 }}
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
    </div>
  );
}

/* ---- Task card (Kanban) ------------------------------------------- */

function TaskCard({ task, onClick }: { task: Task; onClick: () => void }) {
  const { t } = useLanguage();
  const { showTaskIds } = useAppState();
  return (
    <button
      onClick={onClick}
      aria-label={t('board.openTask', { id: task.id, title: task.title })}
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
      {/* Row 1: priority + type + task ID */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <Badge variant={`priority-${task.priority}` as 'priority-critical'} size="sm">
          {formatPriorityLabel(task.priority)}
        </Badge>
        <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>{task.task_type}</span>
        {task.routine_ref && (
          <span title={t('board.createdByRoutine', { routine_ref: task.routine_ref })} aria-label={t('board.createdByRoutine', { routine_ref: task.routine_ref })} style={{ display: 'inline-flex', color: 'var(--color-text-muted)' }}>
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M2.5 7V6a2.5 2.5 0 0 1 2.5-2.5h7.5M10.5 1.5l2 2-2 2M13.5 9v1a2.5 2.5 0 0 1-2.5 2.5H3.5M5.5 14.5l-2-2 2-2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
        )}
        {showTaskIds && <span
          style={{
            marginLeft: 'auto',
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--text-xs)',
            color: 'var(--color-text-muted)',
            whiteSpace: 'nowrap',
          }}
        >
          {task.id}
        </span>}
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
          {t('renderer.blocked')}
        </div>
      )}

      {/* Row: date + age */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <DueDateChip dueDate={task.due_date} />
        {task.waiting && (
          <span title={t('taskWaiting.cardTitle', { for: task.waiting.for })}>
            <Badge size="sm" variant="info">{t('taskWaiting.cardBadge')}</Badge>
          </span>
        )}
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
function KanbanCol({
  column,
  tasks,
  onCardClick,
  onDrop,
  onAddTask,
}: {
  column: BoardColumn;
  tasks: Task[];
  onCardClick: (id: string) => void;
  onDrop: (taskId: string, column: BoardColumn) => void;
  onAddTask: (column: BoardColumn) => void;
}) {
  const { t } = useLanguage();
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
        // The task gets the column's own status (never a legacy spelling such as `approved`).
        onDrop(taskId, column);
      }}
      style={{
        flex: '1 1 0',
        minWidth: 240,
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
        padding: 'var(--space-2) var(--space-2) var(--space-2) var(--space-3)',
        borderBottom: '1px solid var(--color-border)',
        flexShrink: 0,
      }}>
        <h2 title={columnLabel(column)} style={{ fontWeight: 600, fontSize: 'var(--text-sm)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{columnLabel(column)}</h2>
        <CountBadge count={tasks.length} label={t('board.tasks', { length: tasks.length })} />
        <div style={{ flex: 1 }} />
        <IconButton label={t('board.addATaskTo', { label: columnLabel(column) })} icon={icons.plus} onClick={() => onAddTask(column)} />
      </div>

      {/* Cards */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '10px 10px 4px' }}>
        {tasks.length === 0 && (
          <div style={{ textAlign: 'center', padding: '20px 0', fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)' }}>
            {t('board.dropTasksHere')}
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
  const { t } = useLanguage();
  const { showTaskIds } = useAppState();
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
    { key: 'priority', label: t('newTaskModal.priority'), width: '90px' },
    { key: 'title', label: t('importUpdateModal.title') },
    { key: 'status', label: t('newTaskModal.status'), width: '110px' },
    { key: 'due_date', label: t('dayPanel.due'), width: '90px' },
    { key: 'task_type', label: t('board.type'), width: '110px' },
    { key: 'created_at', label: t('flowChart.created'), width: '90px' },
  ];

  return (
    <div className="gtd-table-wrap">
      <table className="gtd-table">
        <thead>
          <tr>
            {cols.map((col) => (
              <th key={col.key as string} scope="col" style={{ width: col.width }}
                aria-sort={sortKey === col.key ? (sortDir === 'asc' ? 'ascending' : 'descending') : undefined}>
                <button type="button" className="gtd-sort-btn" onClick={() => handleSort(col.key)}>
                  {col.label}
                  {sortKey === col.key && <span aria-hidden="true">{sortDir === 'asc' ? '↑' : '↓'}</span>}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((task) => (
            <tr key={task.id} onClick={() => onRowClick(task.id)} style={{ cursor: 'pointer' }}>
              <td>
                <Badge variant={`priority-${task.priority}` as 'priority-critical'} size="sm">
                  {formatPriorityLabel(task.priority)}
                </Badge>
              </td>
              <td style={{ maxWidth: 360 }}>
                {/* The title is the keyboard way in; the row is the mouse target. */}
                <button type="button" className="gtd-link-strong truncate" style={{ display: 'block', maxWidth: '100%', textAlign: 'left', fontWeight: 500 }}
                  onClick={(e) => { e.stopPropagation(); onRowClick(task.id); }}>
                  {task.title}
                </button>
                {showTaskIds && (
                  <span className="mono" style={{ display: 'block', fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>{task.id}</span>
                )}
                {task.tags.length > 0 && (
                  <div style={{ marginTop: 2, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                    {task.tags.slice(0, 3).map((t) => <Badge key={t} size="sm">{t}</Badge>)}
                  </div>
                )}
              </td>
              <td>
                <Badge variant={`status-${task.status}` as 'status-done'} size="sm">{formatStatusLabel(task.status)}</Badge>
              </td>
              <td><DueDateChip dueDate={task.due_date} /></td>
              <td style={{ color: 'var(--color-text-secondary)' }}>{task.task_type}</td>
              <td className="mono" style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-xs)' }}>{formatDate(task.created_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ---- Main view ----------------------------------------------------- */
export default function BoardView() {
  const { t } = useLanguage();
  const [tab, setTab] = useState<ViewTab>('kanban');
  const [priorityFilter, setPriorityFilter] = useState<PriorityFilter>('all');
  const [search, setSearch] = useState('');
  const navigate = useNavigate();
  const dispatch = useAppDispatch();
  const notify = useNotify();

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

  // The board's columns are saved in the workspace (utils/boardColumns.ts). A failed load shows the default four
  // rather than an empty board; `savedColumns` shows a save at once, without waiting for a refetch.
  const workspacePath = useAppState().workspace?.path;
  const { data: board, loading: boardLoading } = useApi<BoardColumns>('/api/workspace/board', [workspacePath]);
  const [savedColumns, setSavedColumns] = useState<BoardColumn[] | null>(null);
  useEffect(() => setSavedColumns(null), [board]);
  const columns = savedColumns ?? board?.columns ?? DEFAULT_BOARD.columns;
  const [editingColumns, setEditingColumns] = useState(false);

  const openNewTask = useCallback((defaultStatus: Task['status']) => {
    dispatch({ type: 'OPEN_NEW_TASK_MODAL', payload: defaultStatus });
  }, [dispatch]);

  const openNewTaskIn = useCallback((column: BoardColumn) => {
    const { status, board_column } = dropUpdate(column, columns);
    dispatch({ type: 'OPEN_NEW_TASK_MODAL', payload: status, boardColumn: board_column ?? undefined });
  }, [dispatch, columns]);

  const tasks = (data ?? []).filter((t) => {
    if (tab === 'archive') return t.status === 'archived';
    return t.status !== 'archived';
  });

  const filtered = tasks.filter((t) => {
    if (priorityFilter !== 'all' && t.priority !== priorityFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      if (!t.title.toLowerCase().includes(q) && !t.id.toLowerCase().includes(q)) return false;
    }
    return true;
  });

  const placed = placeTasks(filtered, columns);

  const handleDrop = useCallback(async (taskId: string, column: BoardColumn) => {
    try {
      await apiPut(`/api/tasks/${taskId}`, dropUpdate(column, columns));
      dispatch({ type: 'DATA_CHANGED', payload: 'tasks' });
    } catch (err) {
      // The card goes back to its column on the next refresh; say why it did not move.
      notify.error(err, t('board.couldNotMoveTheTask'));
      dispatch({ type: 'DATA_CHANGED', payload: 'tasks' });
    }
  }, [dispatch, notify, columns, t]);

  const priorities: PriorityFilter[] = ['all', 'critical', 'high', 'medium', 'low'];

  return (
    <StakeholderLookup.Provider value={stakeholderLookup}>
    <Page width="full" flush style={{ overflow: 'hidden' }}>
      <Tabs label={t('board.boardViews')} value={tab} onChange={setTab} idPrefix="board"
        style={{ padding: '0 var(--page-gutter)', background: 'var(--color-surface)', flexShrink: 0 }}
        items={[{ id: 'kanban', label: t('board.kanban') }, { id: 'list', label: t('board.list') }, { id: 'archive', label: t('systemCleanup.archive') }]} />

      {/* Filter bar */}
      {tab !== 'archive' && (
        <div className="gtd-toolbar">
          <SegmentedControl label={t('newTaskModal.priority')} value={priorityFilter} onChange={setPriorityFilter}
            options={priorities.map((p) => ({ value: p, label: p === 'all' ? t('all') : formatPriorityLabel(p) }))} />
          <SearchInput value={search} onChange={setSearch} placeholder={t('board.searchTasksByTitleOr')} width={240} size="sm" />
          <span role="status" style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', marginLeft: 'auto' }}>
            {rich(t, 'board.tasks2', { count: filtered.length })}
          </span>
          {tab === 'kanban' && placed.unplaced.length > 0 && (
            // The user removed the only column for these statuses. The tasks are not lost: the List view has them.
            <Button variant="ghost" size="sm" onClick={() => setTab('list')}
              title={t('board.noColumnShowsTheStatus')}>
              {rich(t, 'board.notInAColumn', { length: placed.unplaced.length })}
            </Button>
          )}
          {tab === 'kanban' && (
            <Button variant="ghost" size="sm" icon={icons.edit} onClick={() => setEditingColumns(true)}>
              {t('board.editColumns')}
            </Button>
          )}
        </div>
      )}

      {/* Content */}
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {(loading || (tab === 'kanban' && boardLoading)) && <LoadingSpinner text={t('board.loadingTasks')} />}

        {!loading && !boardLoading && tab === 'kanban' && (
          <div id="board-panel" role="tabpanel" aria-labelledby="board-tab-kanban" style={{ flex: 1, display: 'flex', gap: 'var(--space-4)', padding: 'var(--space-4) var(--page-gutter)', overflowX: 'auto', overflowY: 'hidden', minHeight: 0 }}>
            {columns.map((col) => (
              <KanbanCol
                key={col.id}
                column={col}
                tasks={placed.byColumn.get(col.id) ?? []}
                onCardClick={(id) => navigate(`/board/task/${id}`)}
                onDrop={handleDrop}
                onAddTask={openNewTaskIn}
              />
            ))}
          </div>
        )}

        {!loading && tab === 'list' && (
          <div id="board-panel" role="tabpanel" aria-labelledby="board-tab-list" style={{ flex: 1, overflowY: 'auto', padding: 'var(--space-4) var(--page-gutter)' }}>
            <div className="gtd-card">
              {filtered.length === 0 ? (
                search || priorityFilter !== 'all' ? (
                  <EmptyState size="compact" title={t('board.noTasksMatchTheseFilters')} description={t('board.tryAnotherWordOrPriority')}
                    action={{ label: t('updatesList.clearFilters'), onClick: () => { setSearch(''); setPriorityFilter('all'); } }} />
                ) : (
                  <EmptyState size="compact" title={t('board.noTasksYet')} description={t('board.aTaskIsOnePiece')}
                    action={{ label: t('newTask'), onClick: () => openNewTask('backlog') }} />
                )
              ) : (
                <ListView tasks={filtered} onRowClick={(id) => navigate(`/board/task/${id}`)} />
              )}
            </div>
          </div>
        )}

        {!loading && tab === 'archive' && (
          <div id="board-panel" role="tabpanel" aria-labelledby="board-tab-archive" style={{ flex: 1, overflowY: 'auto', padding: 'var(--space-4) var(--page-gutter)' }}>
            <div className="gtd-card">
              {tasks.length === 0 ? (
                <EmptyState size="compact" title={t('board.theArchiveIsEmpty')} description={t('board.archivedTasksAppearHereMove')} />
              ) : (
                <ListView tasks={tasks} onRowClick={(id) => navigate(`/board/task/${id}`)} />
              )}
            </div>
          </div>
        )}
      </div>

      <BoardColumnsEditor
        isOpen={editingColumns}
        columns={columns}
        tasks={tasks}
        onClose={() => setEditingColumns(false)}
        onSaved={(saved) => {
          setSavedColumns(saved);
          setEditingColumns(false);
          notify.success('Columns saved.');
        }}
      />
    </Page>
    <Outlet context={{ refetchTasks: refetch }} />
    </StakeholderLookup.Provider>
  );
}
