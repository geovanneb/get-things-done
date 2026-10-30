import React from 'react';
import { Link } from 'react-router-dom';
import { useApi } from '@/hooks/useApi';
import { useDataVersion } from '@/store';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import EmptyState from '@/components/common/EmptyState';
import Button from '@/components/common/Button';
import Badge from '@/components/common/Badge';
import Toggle from '@/components/common/Toggle';
import RoutineEditor from '@/components/routines/RoutineEditor';
import { SystemCleanupCard, SystemCleanupEditor } from '@/components/routines/SystemCleanup';
import { MeetingDigestCard, MeetingDigestEditor } from '@/components/routines/MeetingDigest';
import { apiDelete, apiPatch, apiPost } from '@/utils/api';
import { formatRelativeTime } from '@/utils/format';
import type { MeetingDigest, Routine, RoutineRun, SystemCleanup } from '@/types';

const TRIGGER_LABEL: Record<RoutineRun['trigger'], string> = {
  startup: 'Dashboard started',
  timer: 'On schedule',
  cli: 'gtd routines run',
  scheduler: 'System scheduler',
  manual: 'Run now',
};

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function dueText(r: Routine): string {
  const d = r.task.due_offset_days;
  if (d === null) return '';
  return d === 0 ? ', due the same day' : `, due ${d} day${d === 1 ? '' : 's'} later`;
}

const cardStyle: React.CSSProperties = {
  border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius-lg)',
  background: 'var(--color-surface)',
  padding: 16,
};

function RoutineCard({ routine, onEdit, onChanged }: { routine: Routine; onEdit: () => void; onChanged: () => void }) {
  const [busy, setBusy] = React.useState<'toggle' | 'run' | 'delete' | null>(null);
  const [notice, setNotice] = React.useState<{ text: string; error?: boolean } | null>(null);

  const act = async (kind: 'toggle' | 'run' | 'delete', fn: () => Promise<string | void>) => {
    setBusy(kind);
    setNotice(null);
    try {
      const text = await fn();
      if (text) setNotice({ text });
      onChanged();
    } catch (err) {
      setNotice({ text: (err as Error).message, error: true });
    } finally {
      setBusy(null);
    }
  };

  if (routine.problem) {
    return (
      <div style={{ ...cardStyle, borderColor: 'var(--color-critical)' }}>
        <div style={{ fontWeight: 600 }}>{routine.id}</div>
        <div style={{ fontSize: 'var(--text-sm)', color: 'var(--color-critical)', marginTop: 4 }}>
          This routine file cannot be read, so it does not run: {routine.problem}
        </div>
        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', marginTop: 4 }}>
          Fix routines/{routine.id}.md in the workspace folder, or delete it.
        </div>
        {notice && <div role="alert" style={{ color: 'var(--color-critical)', marginTop: 4 }}>{notice.text}</div>}
        <div style={{ marginTop: 10 }}>
          <Button size="sm" variant="danger" loading={busy === 'delete'}
            onClick={() => act('delete', async () => { if (window.confirm(`Delete ${routine.id}?`)) await apiDelete(`/api/routines/${routine.id}`); })}>
            Delete
          </Button>
        </div>
      </div>
    );
  }

  const failed = routine.state.last_status === 'error';
  return (
    <article style={{ ...cardStyle, opacity: routine.enabled ? 1 : 0.75 }} aria-label={routine.title}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <h3 style={{ margin: 0, fontSize: 'var(--text-base)', fontWeight: 600 }}>{routine.title}</h3>
            {!routine.enabled && <Badge size="sm">Paused</Badge>}
            {routine.enabled && routine.paused_until && routine.paused_until > new Date().toLocaleDateString('en-CA') && (
              <Badge size="sm">Paused until {routine.paused_until}</Badge>
            )}
            {failed && <Badge variant="critical" size="sm">Last run failed</Badge>}
          </div>
          <div style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)', marginTop: 4 }}>
            {routine.summary}{dueText(routine)}
          </div>
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', marginTop: 6, display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            <span>Next: {routine.enabled ? (routine.next_run_at ? formatWhen(routine.next_run_at) : 'no more runs') : 'paused'}</span>
            {routine.state.last_run_at && (
              <span title={routine.state.last_message}>
                Last: {formatRelativeTime(routine.state.last_run_at)}
                {routine.state.last_task_id && (
                  <> · <Link to={`/board/task/${routine.state.last_task_id}`} style={{ color: 'var(--color-accent)' }}>{routine.state.last_task_id}</Link></>
                )}
              </span>
            )}
          </div>
          {failed && routine.state.last_message && (
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-critical)', marginTop: 6 }}>
              {routine.state.last_message} It will try again on the next check.
            </div>
          )}
        </div>
        <Toggle
          label={routine.enabled ? `Pause ${routine.title}` : `Resume ${routine.title}`}
          checked={routine.enabled}
          disabled={busy !== null}
          onChange={(on) => act('toggle', async () => { await apiPatch(`/api/routines/${routine.id}`, { enabled: on }); })}
        />
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <Button size="sm" variant="secondary" loading={busy === 'run'} disabled={busy !== null}
          title="Create the task now, without waiting for the schedule"
          onClick={() => act('run', async () => (await apiPost<RoutineRun>(`/api/routines/${routine.id}/run`)).message)}>
          Run now
        </Button>
        <Button size="sm" variant="ghost" onClick={onEdit} disabled={busy !== null}>Edit</Button>
        <Button size="sm" variant="ghost" loading={busy === 'delete'} disabled={busy !== null}
          onClick={() => act('delete', async () => {
            if (window.confirm(`Delete "${routine.title}"? Tasks it already created stay on the board.`)) await apiDelete(`/api/routines/${routine.id}`);
          })}>
          Delete
        </Button>
        {notice && (
          <span role={notice.error ? 'alert' : 'status'} style={{ fontSize: 'var(--text-xs)', color: notice.error ? 'var(--color-critical)' : 'var(--color-text-muted)' }}>
            {notice.text}
          </span>
        )}
      </div>
    </article>
  );
}

function RunHistory({ runs }: { runs: RoutineRun[] }) {
  if (runs.length === 0) {
    return <p style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)', margin: 0 }}>No runs yet. Runs appear here when a routine creates a task or fails.</p>;
  }
  return (
    <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column' }}>
      {runs.map((run, i) => (
        <li key={`${run.at}-${run.routine_id}-${i}`} style={{ display: 'flex', flexWrap: 'wrap', gap: 12, padding: '8px 0', borderBottom: '1px solid var(--color-border)', fontSize: 'var(--text-sm)', alignItems: 'baseline' }}>
          <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, background: run.status === 'ok' ? 'var(--color-success)' : 'var(--color-critical)', alignSelf: 'center' }} />
          <span style={{ width: 150, flexShrink: 0, color: 'var(--color-text-muted)' }}>{formatWhen(run.at)}</span>
          <span style={{ flex: '1 1 220px', minWidth: 0 }}>
            <strong style={{ fontWeight: 600 }}>{run.routine_title}</strong>{' '}
            <span style={{ color: run.status === 'ok' ? 'var(--color-text-secondary)' : 'var(--color-critical)' }}>
              {run.routine_id === 'SYSTEM-CLEANUP'
                ? <>{run.message}{run.context_update && <> <Link to={`/context/updates/${run.context_update}`} style={{ color: 'var(--color-accent)' }}>Open {run.context_update}</Link></>}</>
                : run.created.length > 0
                ? <>created {run.created.map((id, j) => <React.Fragment key={id}>{j > 0 && ', '}<Link to={`/board/task/${id}`} style={{ color: 'var(--color-accent)' }}>{id}</Link></React.Fragment>)}</>
                : run.message}
              {run.created.length > 0 && run.skipped.length > 0 && ` (${run.skipped.length} missed run${run.skipped.length === 1 ? '' : 's'} skipped)`}
              {run.caught_up && run.caught_up.length > 0 && (
                <span style={{ color: 'var(--color-text-muted)' }}>
                  {' '}· caught up, was due {run.caught_up.map((k) => formatWhen(k)).join(', ')}
                </span>
              )}
            </span>
          </span>
          <span style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-xs)', flexShrink: 0 }}>{TRIGGER_LABEL[run.trigger] ?? run.trigger}</span>
        </li>
      ))}
    </ul>
  );
}

export default function RoutinesView() {
  const routinesVersion = useDataVersion('routines');
  const tasksVersion = useDataVersion('tasks');
  const { data: routines, loading, error, refetch } = useApi<Routine[]>('/api/routines', [routinesVersion, tasksVersion]);
  const { data: runs, refetch: refetchRuns } = useApi<RoutineRun[]>('/api/routines/history?limit=30', [routinesVersion, tasksVersion]);
  const { data: cleanup, error: cleanupError, refetch: refetchCleanup } = useApi<SystemCleanup>('/api/routines/system-cleanup', [routinesVersion, useDataVersion('context-updates')]);
  const { data: digest, error: digestError, refetch: refetchDigest } = useApi<MeetingDigest>('/api/routines/meeting-digest', [routinesVersion, useDataVersion('context-updates')]);
  const [cleanupOpen, setCleanupOpen] = React.useState(false);
  const [digestOpen, setDigestOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<Routine | null>(null);
  const [editorOpen, setEditorOpen] = React.useState(false);

  const refresh = React.useCallback(() => { refetch(); refetchRuns(); refetchCleanup(); refetchDigest(); }, [refetch, refetchRuns, refetchCleanup, refetchDigest]);
  const openEditor = (routine: Routine | null) => { setEditing(routine); setEditorOpen(true); };

  if (loading && !routines) return <LoadingSpinner text="Loading routines..." />;

  return (
    <div style={{ padding: 24, maxWidth: 900, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 28 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', gap: 16 }}>
        <div style={{ flex: '1 1 220px' }}>
          <h1 style={{ fontSize: 'var(--text-xl)', fontWeight: 700, margin: 0 }}>Routines</h1>
          <p style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)', marginTop: 4, marginBottom: 0, maxWidth: 640 }}>
            Recurring tasks that land on your backlog by themselves. Routines run while the dashboard is open, and catch up
            when it starts again after the computer was off. To run them without the dashboard, use{' '}
            <code style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)' }}>gtd routines run</code>.
          </p>
        </div>
        <Button variant="primary" onClick={() => openEditor(null)}>+ New routine</Button>
      </div>

      {error && <div role="alert" style={{ color: 'var(--color-critical)', fontSize: 'var(--text-sm)' }}>{error}</div>}

      <section aria-labelledby="built-in">
        <h2 id="built-in" style={{ fontSize: 'var(--text-base)', fontWeight: 600, margin: '0 0 12px' }}>Built-in</h2>
        {cleanupError && <div role="alert" style={{ ...cardStyle, borderColor: 'var(--color-critical)', color: 'var(--color-critical)', fontSize: 'var(--text-sm)' }}>System cleanup does not run: {cleanupError}</div>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {cleanup && <SystemCleanupCard job={cleanup} onEdit={() => setCleanupOpen(true)} onChanged={refresh} />}
          {digestError && <div role="alert" style={{ ...cardStyle, borderColor: 'var(--color-critical)', color: 'var(--color-critical)', fontSize: 'var(--text-sm)' }}>Meeting digest does not run: {digestError}</div>}
          {digest && <MeetingDigestCard job={digest} onEdit={() => setDigestOpen(true)} onChanged={refresh} />}
        </div>
      </section>

      <section aria-labelledby="your-routines">
        <h2 id="your-routines" style={{ fontSize: 'var(--text-base)', fontWeight: 600, margin: '0 0 12px' }}>Your routines</h2>
        {routines && routines.length === 0 ? (
          <div style={cardStyle}>
            <EmptyState
              title="No routines yet"
              description="Set up a task once and let it come back on schedule: meeting prep every other Monday, a weekly report every Friday, a monthly review on the first Monday."
              action={{ label: 'Create your first routine', onClick: () => openEditor(null) }}
            />
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {(routines ?? []).map((r) => <RoutineCard key={r.id} routine={r} onEdit={() => openEditor(r)} onChanged={refresh} />)}
          </div>
        )}
      </section>

      <section aria-labelledby="run-history">
        <h2 id="run-history" style={{ fontSize: 'var(--text-base)', fontWeight: 600, margin: '0 0 4px' }}>Run history</h2>
        <p style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', margin: '0 0 8px' }}>
          Every task a routine created, and every run that failed. Checks with nothing to do are not listed.
        </p>
        <RunHistory runs={runs ?? []} />
      </section>

      <MeetingDigestEditor isOpen={digestOpen} job={digest ?? null} onClose={() => setDigestOpen(false)} onSaved={refresh} />
      <SystemCleanupEditor isOpen={cleanupOpen} job={cleanup ?? null} onClose={() => setCleanupOpen(false)} onSaved={refresh} />
      <RoutineEditor isOpen={editorOpen} routine={editing} onClose={() => setEditorOpen(false)} onSaved={refresh} />
    </div>
  );
}
