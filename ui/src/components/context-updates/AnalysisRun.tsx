import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, type ReactNode } from 'react';
import Button from '@/components/common/Button';
import { apiGet, apiPost } from '@/utils/api';
import { formatRelativeDate } from '@/utils/format';
import type { AgentRun, RunnerStatus } from '@/types';
import RunProgress from './RunProgress';
import { HelpBox } from './shared';

const POLL_MS = 3000;

/** What the panel offers for each status: analyze a ready update, apply an approved one. */
const COMMAND_FOR: Record<string, 'analyze' | 'apply'> = { ready: 'analyze', approved: 'apply', applying: 'apply' };

/**
 * Running a workspace command from the dashboard: the installed AI tool runs the same command the user would copy
 * (analyze for a ready update, apply for an approved one), without a window, with the user's own sign-in and plan.
 * Shows how the run is going and how the last one ended.
 *
 * While a run is going the page checks on it one request at a time. A failed check keeps the last known state
 * (and Stop) and tries again; an answer for another update, or an older one, is ignored.
 */
/** What the page can ask of the panel: start the run, as its own button would (the sticky bar repeats it). */
export interface AnalysisRunHandle { start(): void }

/**
 * The next step as the panel offers it, shared with the page's sticky bar so the two always agree (#246):
 * - `checking`: not known yet whether the dashboard can run it, or whether a run is going (neither way is offered);
 * - `run` / `starting`: the dashboard runs it (one primary button), starting now;
 * - `copy`: run it yourself (the command is the primary action), with the reason;
 * - `running`: a run is going; `none`: nothing to start here.
 */
export type NextAction = 'checking' | 'run' | 'starting' | 'copy' | 'running' | 'none';

export default forwardRef<AnalysisRunHandle, {
  updateId: string;
  status: string;
  onChange: () => void;
  /** False: a run going on is still shown, with Stop, but none is offered to start or continue. */
  startable?: boolean;
  /** Tells the page a run is going, so it does not ask the user to run the command too. */
  onRunning?: (running: boolean) => void;
  /**
   * The way to run it yourself (the command to copy, other tools): folded under "Or run it yourself" while the
   * dashboard can run it, shown as the main action (`emphasis`) when it cannot (#246).
   */
  manual?: (emphasis: boolean) => ReactNode;
  /** The next step as offered here, so the page's sticky bar repeats the same action. */
  onAction?: (action: NextAction) => void;
  /** A start failed: the page brings the box (and its message) into view. */
  onStartFailed?: () => void;
}>(function AnalysisRun({ updateId, status, onChange, onRunning, startable = true, manual, onAction, onStartFailed }, handle) {
  const [runner, setRunner] = useState<RunnerStatus | null>(null);
  // The runner check: until it answers neither way is offered (no flicker); when it fails, that is said.
  const [runnerCheck, setRunnerCheck] = useState<'checking' | 'ok' | 'failed'>('checking');
  const [run, setRun] = useState<AgentRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [lostContact, setLostContact] = useState(false);
  // False until the first check of this update's run has answered: until then a run may be going unseen.
  const [known, setKnown] = useState(false);
  // Bumped when the update changes or the panel goes away, so late answers are dropped.
  const generation = useRef(0);

  const load = useCallback(async (): Promise<{ ok: boolean; run: AgentRun | null }> => {
    const mine = generation.current;
    try {
      const latest = await apiGet<AgentRun | null>(`/api/context-updates/${updateId}/run`);
      if (mine !== generation.current) return { ok: false, run: null };
      setRun(latest);
      setKnown(true);
      setLostContact(false);
      return { ok: true, run: latest };
    } catch {
      if (mine === generation.current) setLostContact(true);
      return { ok: false, run: null };
    }
  }, [updateId]);

  useEffect(() => {
    generation.current += 1;
    const mine = generation.current;
    setRun(null);
    setKnown(false);
    setError('');
    void load();
    void checkRunner(mine);
    return () => { generation.current += 1; };
  }, [load]);

  /** Asks whether the dashboard can run it here; also from "Check again". */
  function checkRunner(mine = generation.current): Promise<void> {
    setRunnerCheck('checking');
    return apiGet<RunnerStatus>('/api/runner')
      .then((answer) => { if (mine === generation.current) { setRunner(answer); setRunnerCheck('ok'); } })
      .catch(() => { if (mine === generation.current) { setRunner(null); setRunnerCheck('failed'); } });
  }

  const running = run?.status === 'running';
  useEffect(() => { onRunning?.(running); }, [running, onRunning]);
  useEffect(() => () => onRunning?.(false), [onRunning]);

  // One check at a time while a run is going, or until the first check has answered; a failed check is
  // retried and the last known state stays.
  useEffect(() => {
    if (!running && known) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      const { ok, run: latest } = await load();
      if (stopped) return;
      if (ok && latest?.status !== 'running') { if (running) onChange(); return; }
      timer = setTimeout(() => void tick(), POLL_MS);
    };
    timer = setTimeout(() => void tick(), POLL_MS);
    return () => { stopped = true; clearTimeout(timer); };
  }, [running, known, load, onChange]);

  // Every answer is checked against the update on screen: one for an update the user has left is dropped.
  const start = async () => {
    const mine = generation.current;
    setBusy(true);
    setError('');
    try {
      const started = await apiPost<AgentRun>(`/api/context-updates/${updateId}/run`, { command });
      if (mine !== generation.current) return;
      setRun(started);
      onChange();
    } catch (err) {
      if (mine === generation.current) {
        setError(err instanceof Error ? err.message : 'Could not start the analysis.');
        onStartFailed?.();
      }
    } finally { if (mine === generation.current) setBusy(false); }
  };

  const stop = async () => {
    const mine = generation.current;
    setBusy(true);
    try {
      await apiPost(`/api/context-updates/${updateId}/run/cancel`);
      if (mine !== generation.current) return;
      await load();
      onChange();
    } catch (err) {
      if (mine === generation.current) setError(err instanceof Error ? err.message : 'Could not stop the analysis.');
    } finally { if (mine === generation.current) setBusy(false); }
  };

  const problem = runner?.problems[0]?.message;
  const ended = run && !running ? run : null;
  const command = startable ? COMMAND_FOR[status] : undefined;
  const noun = (ended ?? run)?.command === 'apply' ? 'Apply' : 'Analysis';
  // The dashboard runs it: one primary button, the command one click away. Otherwise copying it is the main action.
  const action: NextAction = running ? 'running'
    : !command ? 'none'
      : !known || runnerCheck === 'checking' ? 'checking'
        : runnerCheck === 'ok' && runner && !problem ? (busy ? 'starting' : 'run')
          : 'copy';
  const runnable = action === 'run' || action === 'starting';
  useEffect(() => { onAction?.(action); }, [action, onAction]);
  useEffect(() => () => onAction?.('none'), [onAction]);
  useImperativeHandle(handle, () => ({ start: () => { if (action === 'run') void start(); } }));
  const label = command === 'analyze' ? 'Run analysis' : status === 'applying' ? 'Continue applying' : `Apply with ${runner?.label ?? 'Claude Code'}`;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {running ? (
        <RunProgress run={run} runnerLabel={runner?.label ?? 'Claude Code'} stopping={busy} onStop={() => void stop()} />
      ) : action === 'checking' ? (
        <p role="status" style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)' }}>Checking whether the dashboard can run this here…</p>
      ) : runnable && runner ? (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            {/* data-next-action: the page moves focus here when this step becomes due. */}
            <Button data-next-action="" variant="primary" loading={busy} onClick={() => void start()}>{label}</Button>
            <span style={{ flex: '1 1 240px', minWidth: 0, fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)' }}>
              Runs {runner.label} with your Claude plan, under this workspace&apos;s rules. You can leave this page; it updates when it is ready.
            </span>
          </div>
          <p style={{ margin: 0, fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
            {command === 'analyze'
              ? 'The same command you would run yourself, in the background. Hooks and MCP servers are off for this run.'
              : 'The same command you would run yourself, in the background. Where the workspace would ask you, the dashboard answers: yes only for the files you accepted, no for anything else.'}
          </p>
          {manual && (
            <details>
              <summary style={{ cursor: 'pointer', fontSize: 'var(--text-sm)', color: 'var(--color-accent)', fontWeight: 500 }}>Or run it yourself</summary>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>{manual(false)}</div>
            </details>
          )}
          {!ended && <p style={{ margin: 0, fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>Last run: none yet</p>}
        </>
      ) : (
        <>
          {action === 'copy' && problem && <p role="status" style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)' }}>{problem}</p>}
          {action === 'copy' && runnerCheck === 'failed' && (
            <p role="status" style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              Could not check whether the dashboard can run this here, so run it yourself.
              <Button size="sm" variant="ghost" onClick={() => void checkRunner()}>Check again</Button>
            </p>
          )}
          {manual && (!startable || action === 'copy') && manual(true)}
        </>
      )}
      {(running || !known) && lostContact && (
        <HelpBox tone="warning">{running ? 'Lost contact with the dashboard for a moment. The run keeps going; trying again.' : 'Could not check whether something is running for this update; trying again.'}</HelpBox>
      )}
      {command && !running && runner && !problem && runner.trusted === null && (
        <p style={{ margin: 0, fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
          Could not verify that {runner.label} trusts this workspace folder. If the run reports that it does not, follow its message.
        </p>
      )}
      {ended && ended.status !== 'succeeded' && (
        <HelpBox tone={ended.status === 'cancelled' ? 'warning' : 'critical'} title={ended.status === 'cancelled' ? `${noun} stopped` : `The ${noun.toLowerCase()} did not finish cleanly`}>
          {ended.message}
        </HelpBox>
      )}
      {ended && ended.status === 'succeeded' && (status === 'in_review' || status === 'done') && (
        <p style={{ margin: 0, fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
          {ended.command === 'apply' ? `${ended.message} Applied` : 'Analyzed'} from the dashboard {formatRelativeDate(ended.ended_at ?? ended.started_at)}{ended.turns ? ` in ${ended.turns} turns` : ''}.
        </p>
      )}
      {error && <HelpBox tone="critical">{error}</HelpBox>}
    </div>
  );
});
