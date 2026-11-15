import { serverText } from '@/i18n/serverText';
import { useLanguage } from '@/i18n/LanguageProvider';
import { rich } from '@/i18n/rich';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, type ReactNode } from 'react';
import Button from '@/components/common/Button';
import { usePageApi } from '@/hooks/usePageApi';
import { formatRelativeDate } from '@/utils/format';
import type { AgentRun, RunnerStatus } from '@/types';
import { waitingOutcome } from '@/utils/runNotices';
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
 *
 * An analysis asked for while another run goes waits in line (#344): the panel says so, with Cancel, and keeps
 * checking until it starts. The line is kept in the dashboard's memory only, so a restart forgets it; when the
 * server no longer knows a run this page saw waiting, the panel says it did not start, without guessing why.
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
  const { t } = useLanguage();
  // The page's requests: bound to the workspace it was opened for, when it was opened from a notice.
  const api = usePageApi();
  const [runner, setRunner] = useState<RunnerStatus | null>(null);
  // The runner check: until it answers neither way is offered (no flicker); when it fails, that is said.
  const [runnerCheck, setRunnerCheck] = useState<'checking' | 'ok' | 'failed'>('checking');
  const [run, setRun] = useState<AgentRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [lostContact, setLostContact] = useState(false);
  // False until the first check of this update's run has answered: until then a run may be going unseen.
  const [known, setKnown] = useState(false);
  // When this update's run was seen waiting in line: if the server no longer knows it, the line was lost.
  const waitingSince = useRef<string | null>(null);
  const [lostWait, setLostWait] = useState(false);
  // A run this page took out of the line itself: its "did not start" note is not repeated back.
  const removedHere = useRef<string | null>(null);
  // Bumped when the update changes or the panel goes away, so late answers are dropped.
  const generation = useRef(0);

  const load = useCallback(async (): Promise<{ ok: boolean; run: AgentRun | null }> => {
    const mine = generation.current;
    try {
      const latest = await api.get<AgentRun | null>(`/api/context-updates/${updateId}/run`);
      if (mine !== generation.current) return { ok: false, run: null };
      if (latest?.status === 'queued') {
        waitingSince.current = latest.started_at;
        setLostWait(false);
      } else if (waitingSince.current) {
        if (waitingOutcome(waitingSince.current, latest) === 'lost') setLostWait(true);
        waitingSince.current = null;
      }
      setRun(latest);
      setKnown(true);
      setLostContact(false);
      return { ok: true, run: latest };
    } catch {
      if (mine === generation.current) setLostContact(true);
      return { ok: false, run: null };
    }
  }, [updateId, api]);

  useEffect(() => {
    generation.current += 1;
    const mine = generation.current;
    setRun(null);
    setKnown(false);
    setError('');
    waitingSince.current = null;
    setLostWait(false);
    void load();
    void checkRunner(mine);
    return () => { generation.current += 1; };
  }, [load]);

  /** Asks whether the dashboard can run it here; also from "Check again". */
  function checkRunner(mine = generation.current): Promise<void> {
    setRunnerCheck('checking');
    return api.get<RunnerStatus>('/api/runner')
      .then((answer) => { if (mine === generation.current) { setRunner(answer); setRunnerCheck('ok'); } })
      .catch(() => { if (mine === generation.current) { setRunner(null); setRunnerCheck('failed'); } });
  }

  const running = run?.status === 'running';
  const queued = run?.status === 'queued';
  // Waiting in line counts as going for the page: it does not ask the user to run the command too.
  const going = running || queued;
  useEffect(() => { onRunning?.(going); }, [going, onRunning]);
  useEffect(() => () => onRunning?.(false), [onRunning]);

  // One check at a time while a run is going or waiting, or until the first check has answered; a failed check is
  // retried and the last known state stays.
  useEffect(() => {
    if (!going && known) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      const { ok, run: latest } = await load();
      if (stopped) return;
      if (ok && latest?.status !== 'running' && latest?.status !== 'queued') { if (going) onChange(); return; }
      timer = setTimeout(() => void tick(), POLL_MS);
    };
    timer = setTimeout(() => void tick(), POLL_MS);
    return () => { stopped = true; clearTimeout(timer); };
  }, [going, known, load, onChange]);

  // Every answer is checked against the update on screen: one for an update the user has left is dropped.
  const start = async () => {
    const mine = generation.current;
    setBusy(true);
    setError('');
    setLostWait(false);
    try {
      const started = await api.post<AgentRun>(`/api/context-updates/${updateId}/run`, { command });
      if (mine !== generation.current) return;
      waitingSince.current = started.status === 'queued' ? started.started_at : null;
      setRun(started);
      onChange();
    } catch (err) {
      if (mine === generation.current) {
        setError(err instanceof Error ? err.message : t('analysisRun.couldNotStartTheAnalysis'));
        onStartFailed?.();
      }
    } finally { if (mine === generation.current) setBusy(false); }
  };

  const stop = async () => {
    const mine = generation.current;
    setBusy(true);
    try {
      await api.post(`/api/context-updates/${updateId}/run/cancel`);
      if (mine !== generation.current) return;
      // Taken out of the line here: what comes back next is not a lost wait, and its note is not repeated back.
      if (waitingSince.current) removedHere.current = waitingSince.current;
      waitingSince.current = null;
      await load();
      onChange();
    } catch (err) {
      if (mine === generation.current) setError(err instanceof Error ? err.message : t('analysisRun.couldNotStopTheAnalysis'));
    } finally { if (mine === generation.current) setBusy(false); }
  };

  const problem = serverText(runner?.problems[0]?.message);
  // Which sign-in the dashboard uses: with several Claude accounts on one computer it may not be the one a terminal uses.
  const account = runner?.account;
  // A personal plan's organization is often named after the email: then it is left out.
  const organization = account?.organization && !(account.email && account.organization.includes(account.email)) ? account.organization : null;
  const who = account?.email ?? organization ?? '';
  const details = [who === organization ? null : organization, account?.plan].filter(Boolean).join(', ');
  const accountText = who ? (details ? `${who} (${details})` : who) : '';
  const ended = run && !going ? run : null;
  const command = startable ? COMMAND_FOR[status] : undefined;
  const noun = (ended ?? run)?.command === 'apply' ? t('analysisRun.apply') : t('analysisRun.analysis');
  // The dashboard runs it: one primary button, the command one click away. Otherwise copying it is the main action.
  const action: NextAction = going ? 'running'
    : !command ? 'none'
      : !known || runnerCheck === 'checking' ? 'checking'
        : runnerCheck === 'ok' && runner && !problem ? (busy ? 'starting' : 'run')
          : 'copy';
  const runnable = action === 'run' || action === 'starting';
  useEffect(() => { onAction?.(action); }, [action, onAction]);
  useEffect(() => () => onAction?.('none'), [onAction]);
  useImperativeHandle(handle, () => ({ start: () => { if (action === 'run') void start(); } }));
  const label = command === 'analyze' ? t('analysisRun.runAnalysis') : status === 'applying' ? t('analysisRun.continueApplying') : t('analysisRun.applyWith', { label: runner?.label ?? 'Claude Code' });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {running ? (
        <RunProgress run={run} runnerLabel={runner?.label ?? 'Claude Code'} stopping={busy} onStop={() => void stop()} />
      ) : queued ? (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <span role="status" style={{ flex: '1 1 240px', minWidth: 0, fontSize: 'var(--text-sm)' }}>
              <strong>{t('analysisRun.waitingStartsWhenTheCurrent')}</strong>
              {(run.position ?? 1) > 1 && <span style={{ color: 'var(--color-text-muted)' }}> · {t('analysisRun.placeInLine', { position: run.position ?? 1 })}</span>}
            </span>
            <Button variant="secondary" size="sm" loading={busy} onClick={() => void stop()}>{t('analysisRun.cancelWaitingRun')}</Button>
          </div>
          <p style={{ margin: 0, fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>{t('analysisRun.oneRunAtATime')}</p>
        </>
      ) : action === 'checking' ? (
        <p role="status" style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)' }}>{t('analysisRun.checkingWhetherTheDashboardCan')}</p>
      ) : runnable && runner ? (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            {/* data-next-action: the page moves focus here when this step becomes due. */}
            <Button data-next-action="" variant="primary" loading={busy} onClick={() => void start()}>{label}</Button>
            <span style={{ flex: '1 1 240px', minWidth: 0, fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)' }}>
              {rich(t, 'analysisRun.runsWithYourClaudePlan', { label: runner.label })}
              {accountText && <> {t('analysisRun.signedInAs', { account: accountText })}</>}
            </span>
          </div>
          <p style={{ margin: 0, fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
            {command === 'analyze'
              ? t('analysisRun.theSameCommandYouWould')
              : t('analysisRun.theSameCommandYouWould2')}
          </p>
          {manual && (
            <details>
              <summary style={{ cursor: 'pointer', fontSize: 'var(--text-sm)', color: 'var(--color-accent)', fontWeight: 500 }}>{t('analysisRun.orRunItYourself')}</summary>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>{manual(false)}</div>
            </details>
          )}
          {!ended && <p style={{ margin: 0, fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>{t('analysisRun.lastRunNoneYet')}</p>}
        </>
      ) : (
        <>
          {action === 'copy' && problem && <p role="status" style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)' }}>{problem}</p>}
          {action === 'copy' && runnerCheck === 'failed' && (
            <p role="status" style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              {t('analysisRun.couldNotCheckWhetherThe')}
              <Button size="sm" variant="ghost" onClick={() => void checkRunner()}>{t('analysisRun.checkAgain')}</Button>
            </p>
          )}
          {manual && (!startable || action === 'copy') && manual(true)}
        </>
      )}
      {(going || !known) && lostContact && (
        <HelpBox tone="warning">{going ? t('analysisRun.lostContactWithTheDashboard') : t('analysisRun.couldNotCheckWhetherSomething')}</HelpBox>
      )}
      {lostWait && !going && <HelpBox tone="warning">{t('analysisRun.waitingRunWasForgotten')}</HelpBox>}
      {command && !running && runner && !problem && runner.trusted === null && (
        <p style={{ margin: 0, fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
          {rich(t, 'analysisRun.couldNotVerifyThatTrusts', { label: runner.label })}
        </p>
      )}
      {ended && ended.status !== 'succeeded' && !(ended.not_started && ended.started_at === removedHere.current) && (
        <HelpBox tone={ended.status === 'cancelled' ? 'warning' : 'critical'} title={ended.not_started ? t('analysisRun.didNotStart', { noun }) : ended.status === 'cancelled' ? t('analysisRun.stopped', { noun }) : t('analysisRun.theDidNotFinishCleanly', { toLowerCase: noun.toLowerCase() })}>
          {ended.message}
        </HelpBox>
      )}
      {ended && ended.status === 'succeeded' && (status === 'in_review' || status === 'done') && (
        <p style={{ margin: 0, fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
          {rich(t, 'analysisRun.fromTheDashboard', { value: ended.command === 'apply' ? t('analysisRun.applied', { message: ended.message }) : t('analysisRun.analyzed'), ended_at: formatRelativeDate(ended.ended_at ?? ended.started_at), value2: ended.turns ? t('analysisRun.inTurns', { turns: ended.turns }) : '' })}
        </p>
      )}
      {error && <HelpBox tone="critical">{error}</HelpBox>}
    </div>
  );
});
