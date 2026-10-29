import { useCallback, useEffect, useRef, useState } from 'react';
import Button from '@/components/common/Button';
import { apiGet, apiPost } from '@/utils/api';
import { formatRelativeDate } from '@/utils/format';
import type { AgentRun, RunnerStatus } from '@/types';
import { HelpBox } from './shared';

const POLL_MS = 3000;

/** "at 14:05", or the date as well when the run did not start today. */
function startedAt(iso: string): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? `at ${time}` : `${formatRelativeDate(iso)} at ${time}`;
}

/**
 * "Run analysis" from the dashboard: the installed AI tool runs the same command the user would copy, without a
 * window, with the user's own sign-in and plan. Shows how the run is going and how the last one ended.
 *
 * While a run is going the page checks on it one request at a time. A failed check keeps the last known state
 * (and Stop) and tries again; an answer for another update, or an older one, is ignored.
 */
export default function AnalysisRun({ updateId, status, onChange, onRunning }: {
  updateId: string;
  status: string;
  onChange: () => void;
  /** Tells the page a run is going, so it does not ask the user to run the command too. */
  onRunning?: (running: boolean) => void;
}) {
  const [runner, setRunner] = useState<RunnerStatus | null>(null);
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
      const latest = await apiGet<AgentRun | null>(`/api/context-updates/${updateId}/analysis-run`);
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
    void apiGet<RunnerStatus>('/api/runner')
      .then((status) => { if (mine === generation.current) setRunner(status); })
      .catch(() => { if (mine === generation.current) setRunner(null); });
    return () => { generation.current += 1; };
  }, [load]);

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
      const started = await apiPost<AgentRun>(`/api/context-updates/${updateId}/analysis-run`);
      if (mine !== generation.current) return;
      setRun(started);
      onChange();
    } catch (err) {
      if (mine === generation.current) setError(err instanceof Error ? err.message : 'Could not start the analysis.');
    } finally { if (mine === generation.current) setBusy(false); }
  };

  const stop = async () => {
    const mine = generation.current;
    setBusy(true);
    try {
      await apiPost(`/api/context-updates/${updateId}/analysis-run/cancel`);
      if (mine !== generation.current) return;
      await load();
      onChange();
    } catch (err) {
      if (mine === generation.current) setError(err instanceof Error ? err.message : 'Could not stop the analysis.');
    } finally { if (mine === generation.current) setBusy(false); }
  };

  const problem = runner?.problems[0]?.message;
  const ended = run && !running ? run : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {running ? (
        <div role="status" aria-live="polite" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 'var(--text-sm)' }}>
          <span style={{ flex: 1, minWidth: 0 }}>{run.message} Started {startedAt(run.started_at)}; this page updates when it is done.</span>
          <Button variant="secondary" size="sm" loading={busy} onClick={() => void stop()}>Stop</Button>
        </div>
      ) : status === 'ready' && runner && known && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <Button variant="secondary" size="sm" loading={busy} disabled={!!problem} onClick={() => void start()}>
            Run analysis with {runner.label}
          </Button>
          <span style={{ flex: 1, minWidth: 200, fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
            {problem ?? `Runs the same command in the background with your ${runner.label} and your Claude plan, under this workspace's permission rules, as when you run it yourself. Hooks and MCP servers are off for this run.`}
          </span>
        </div>
      )}
      {(running || !known) && lostContact && (
        <HelpBox tone="warning">{running ? 'Lost contact with the dashboard for a moment. The analysis keeps running; trying again.' : 'Could not check whether an analysis is running; trying again.'}</HelpBox>
      )}
      {status === 'ready' && !running && runner && !problem && runner.trusted === null && (
        <p style={{ margin: 0, fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
          Could not verify that {runner.label} trusts this workspace folder. If the run reports that it does not, follow its message.
        </p>
      )}
      {ended && ended.status !== 'succeeded' && (
        <HelpBox tone={ended.status === 'cancelled' ? 'warning' : 'critical'} title={ended.status === 'cancelled' ? 'Analysis stopped' : 'The analysis did not finish cleanly'}>
          {ended.message}
        </HelpBox>
      )}
      {ended && ended.status === 'succeeded' && status === 'in_review' && (
        <p style={{ margin: 0, fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
          Analyzed from the dashboard {formatRelativeDate(ended.ended_at ?? ended.started_at)}{ended.turns ? ` in ${ended.turns} steps` : ''}.
        </p>
      )}
      {error && <HelpBox tone="critical">{error}</HelpBox>}
    </div>
  );
}
