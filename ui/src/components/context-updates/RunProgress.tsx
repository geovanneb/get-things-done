import { useLanguage } from '@/i18n/LanguageProvider';
import { rich } from '@/i18n/rich';
import { useEffect, useState } from 'react';
import Button from '@/components/common/Button';
import type { AgentRun } from '@/types';
import { elapsed, stepText, stepWords } from '@/utils/runSteps';

const codeStyle = { fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)' } as const;

/** A step's words, its path as code. */
function Words({ words }: { words: ReturnType<typeof stepWords> }) {
  return <>{words.verb} {words.path ? <code style={codeStyle}>{words.path}</code> : words.rest}</>;
}

/**
 * A run going, in the Next box (#246): what runs and for how long, the step it is on, Stop, and under "Show details"
 * one line per step. Steps are tool names and workspace paths only, sent by the server while the run lasts.
 *
 * The status line announces step changes only; the time beside it is not announced, so a screen reader is not
 * flooded every second.
 */
export default function RunProgress({ run, runnerLabel, stopping, onStop }: {
  run: AgentRun;
  runnerLabel: string;
  stopping: boolean;
  onStop: () => void;
}) {
  const { t } = useLanguage();
  const [now, setNow] = useState(() => Date.now());
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const apply = run.command === 'apply';
  const steps = run.steps;
  const count = run.step_count ?? steps?.length ?? 0;
  const current = steps?.at(-1);
  const first = count - (steps?.length ?? 0) + 1;
  const since = Date.parse(run.started_at);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <svg aria-hidden="true" width={20} height={20} viewBox="0 0 24 24" fill="none" className="gtd-spin" style={{ flexShrink: 0, marginTop: 2 }}>
          <circle cx="12" cy="12" r="10" stroke="var(--color-border-strong)" strokeWidth="3" />
          <path d="M12 2a10 10 0 0 1 10 10" stroke="var(--color-accent)" strokeWidth="3" strokeLinecap="round" />
        </svg>
        <div style={{ flex: '1 1 220px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ fontSize: 'var(--text-sm)' }}>
            <strong>{rich(t, 'runProgress.with', { value: apply ? t('runProgress.applying') : t('runProgress.analyzing'), runnerLabel: runnerLabel })}</strong>
            {Number.isFinite(since) && <span style={{ color: 'var(--color-text-muted)' }}> · {elapsed(now - since)}</span>}
          </span>
          {steps ? (
            // One line, a long path cut with an ellipsis; the whole step is in the title and the details.
            <span role="status" aria-live="polite" title={current ? stepText(current, true) : undefined}
              style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {current ? <>{t('runProgress.step')} {count} · <Words words={stepWords(current, true)} /></> : t('starting')}
            </span>
          ) : (
            // A run this dashboard did not start (from before a restart): its message says what to do, in full.
            <span role="status" style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)' }}>{run.message}</span>
          )}
        </div>
        {/* Only a run this dashboard started can be stopped from here; it is the one that sends its steps. */}
        {steps && <Button variant="secondary" size="sm" loading={stopping} onClick={onStop}>{apply ? t('runProgress.stopApplying') : t('runProgress.stopAnalysis')}</Button>}
      </div>
      {steps && steps.length > 0 && (
        <details open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
          <summary style={{ cursor: 'pointer', fontSize: 'var(--text-sm)', color: 'var(--color-accent)', fontWeight: 500 }}>{open ? t('runProgress.hideDetails') : t('runProgress.showDetails')}</summary>
          <div style={{ marginTop: 8, padding: '8px 12px', borderRadius: 'var(--radius-md)', background: 'var(--color-bg)', fontSize: 'var(--text-sm)' }}>
            {first > 1 && <p style={{ margin: '0 0 4px', color: 'var(--color-text-muted)', fontSize: 'var(--text-xs)' }}>{rich(t, 'runProgress.steps1ToAreNot', { value: first - 1 })}</p>}
            <ol start={first} style={{ margin: 0, paddingLeft: '2.5em', display: 'flex', flexDirection: 'column', gap: 4 }}>
              {steps.map((step, i) => {
                const last = i === steps.length - 1;
                return (
                  <li key={first + i} aria-current={last ? 'step' : undefined}
                    style={{ overflowWrap: 'anywhere', fontWeight: last ? 600 : undefined, color: last ? 'var(--color-text)' : 'var(--color-text-secondary)' }}>
                    <Words words={stepWords(step, last)} />
                  </li>
                );
              })}
            </ol>
          </div>
          <p style={{ margin: '8px 0 0', fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
            {t('runProgress.toolNamesAndTheNames')}
          </p>
        </details>
      )}
      <p style={{ margin: 0, fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
        {rich(t, 'runProgress.youCanLeaveThisPage', { value: apply ? 'apply' : 'analysis' })}
      </p>
    </div>
  );
}
