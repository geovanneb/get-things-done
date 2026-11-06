import { useLanguage } from '@/i18n/LanguageProvider';
import { tr } from '@/i18n/current';
import { forwardRef, useState } from 'react';
import Badge from '@/components/common/Badge';
import type { ContextUpdateStatus } from '@/types';
import { typeMeta, updateType } from '@/utils/updateTypes';

/** What each status means to the user, and what they should do next. */
export const STATUS_META = (): Record<ContextUpdateStatus, { label: string; color: string; subtle: string; step: number; next: string }> => ({
  ready: {
    label: tr('shared.runTheAnalyzeCommand'), color: 'var(--color-info)', subtle: 'var(--color-info-subtle)', step: 1,
    next: tr('shared.materialsAreSavedRunThe'),
  },
  analyzing: {
    label: tr('shared.analyzing'), color: 'var(--color-accent)', subtle: 'var(--color-accent-subtle)', step: 1,
    next: tr('shared.theAgentIsReadingThe'),
  },
  in_review: {
    label: tr('shared.readyForYourReview'), color: 'var(--color-warning)', subtle: 'var(--color-warning-subtle)', step: 2,
    next: tr('shared.checkEachProposalAndTick'),
  },
  approved: {
    label: tr('shared.approvedRunTheApplyCommand'), color: 'var(--color-info)', subtle: 'var(--color-info-subtle)', step: 3,
    next: tr('shared.yourSelectionIsLockedApply'),
  },
  applying: {
    label: tr('shared.applying'), color: 'var(--color-accent)', subtle: 'var(--color-accent-subtle)', step: 3,
    next: tr('shared.theAgentIsWritingThe'),
  },
  done: {
    label: tr('done'), color: 'var(--color-success)', subtle: 'var(--color-success-subtle)', step: 4,
    next: tr('shared.finishedTheRecordBelowShows'),
  },
});

export const STEPS = () => ([
  { label: tr('shared.collect'), hint: tr('shared.youUploadMaterial') },
  { label: tr('shared.analyze'), hint: tr('shared.agentProposesChanges') },
  { label: tr('shared.review'), hint: tr('shared.youAcceptOrReject') },
  { label: tr('analysisRun.apply'), hint: tr('shared.agentWritesAcceptedChanges') },
]);

export function StatusPill({ status }: { status: ContextUpdateStatus }) {
  const meta = STATUS_META()[status];
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '2px 8px', borderRadius: 'var(--radius-sm)', background: meta.subtle, color: meta.color, fontSize: 'var(--text-xs)', fontWeight: 600, whiteSpace: 'nowrap' }}>
      {(status === 'analyzing' || status === 'applying') && (
        <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: '50%', background: 'currentColor' }} />
      )}
      {meta.label}
    </span>
  );
}

/** Collect, Analyze, Review, Apply: where this update is, so the user always knows the next move. */
export function StepIndicator({ status }: { status: ContextUpdateStatus }) {
  const { t } = useLanguage();
  const current = STATUS_META()[status].step;
  return (
    <ol aria-label={t('shared.progress')} style={{ display: 'flex', gap: 0, listStyle: 'none', margin: 0, padding: 0, flexWrap: 'wrap', rowGap: 8 }}>
      {STEPS().map((step, i) => {
        const done = i < current;
        const active = i === current;
        const color = done ? 'var(--color-success)' : active ? 'var(--color-accent)' : 'var(--color-text-muted)';
        return (
          <li key={step.label} aria-current={active ? 'step' : undefined}
            style={{ display: 'flex', alignItems: 'center', gap: 8, flex: '1 1 140px', minWidth: 0 }}>
            <span aria-hidden="true" style={{ width: 22, height: 22, borderRadius: '50%', flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 'var(--text-xs)', fontWeight: 700, border: `1.5px solid ${color}`, background: done ? 'var(--color-success)' : active ? 'var(--color-accent)' : 'transparent', color: done || active ? 'var(--color-text-on-accent)' : color }}>
              {done ? '✓' : i + 1}
            </span>
            <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
              <span style={{ fontSize: 'var(--text-sm)', fontWeight: active ? 700 : 500, color: active ? 'var(--color-text)' : 'var(--color-text-secondary)' }}>{step.label}</span>
              <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>{step.hint}</span>
            </span>
            {i < STEPS().length - 1 && <span aria-hidden="true" style={{ flex: 1, height: 1, minWidth: 12, background: done ? 'var(--color-success)' : 'var(--color-border)', margin: '0 8px' }} />}
          </li>
        );
      })}
    </ol>
  );
}

/** Copies `text`; resolves to false when the clipboard is unavailable (the command stays selectable). */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * The slash command to paste into the agent, with a copy button. `emphasis` marks it as the one thing
 * the user still has to do: accent frame and a primary Copy button. The ref points at the Copy button,
 * so a page can move focus there once the step becomes due.
 */
export const CommandBox = forwardRef<HTMLButtonElement, { command: string; label: string; emphasis?: boolean; onCopied?: () => void }>(
  function CommandBox({ command, label, emphasis = false, onCopied }, ref) {
    const { t } = useLanguage();
    const [copied, setCopied] = useState(false);
    const copy = async () => {
      if (!(await copyText(command))) return;
      setCopied(true);
      onCopied?.();
      setTimeout(() => setCopied(false), 1500);
    };
    return (
      <div style={emphasis ? { padding: 12, borderRadius: 'var(--radius-md)', background: 'var(--color-accent-subtle)', border: '1.5px solid var(--color-accent)' } : undefined}>
        <div style={{ fontSize: 'var(--text-xs)', fontWeight: 600, color: emphasis ? 'var(--color-accent)' : 'var(--color-text-secondary)', marginBottom: 6 }}>{label}</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <code style={{ flex: 1, minWidth: 0, fontSize: 'var(--text-sm)', fontFamily: 'var(--font-mono)', background: 'var(--color-bg)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm)', padding: '8px 10px', color: 'var(--color-text)', overflowX: 'auto', whiteSpace: 'nowrap', userSelect: 'all' }}>
            {command}
          </code>
          <button ref={ref} type="button" onClick={copy} aria-label={t('shared.copy', { command })} data-next-action={emphasis ? '' : undefined}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0, height: 36, padding: '0 12px', borderRadius: 'var(--radius-sm)', fontSize: 'var(--text-sm)', fontWeight: emphasis ? 600 : 500, cursor: 'pointer',
              border: `1px solid ${copied ? 'var(--color-border)' : emphasis ? 'var(--color-accent)' : 'var(--color-border)'}`,
              background: copied ? 'var(--color-success-subtle)' : emphasis ? 'var(--color-accent)' : 'var(--color-surface)',
              color: copied ? 'var(--color-success)' : emphasis ? 'var(--color-text-on-accent)' : 'var(--color-text)',
            }}>
            {copied ? t('shared.copied') : emphasis ? t('updateDetail.copyCommand') : t('shared.copy2')}
          </button>
        </div>
      </div>
    );
  },
);

/** A short explanation box. Tone sets the color: info for guidance, warning for things to check. */
export function HelpBox({ title, children, tone = 'info' }: { title?: string; children: React.ReactNode; tone?: 'info' | 'warning' | 'critical' }) {
  const color = `var(--color-${tone})`;
  return (
    <div role={tone === 'info' ? 'note' : 'status'} style={{ padding: '10px 14px', borderRadius: 'var(--radius-md)', background: `var(--color-${tone}-subtle)`, borderLeft: `3px solid ${color}`, fontSize: 'var(--text-sm)', color: 'var(--color-text)', lineHeight: 1.5 }}>
      {title && <div style={{ fontWeight: 600, marginBottom: 2, color }}>{title}</div>}
      {children}
    </div>
  );
}

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(0)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

/** Formats the agent may not be able to read; the upload warns instead of failing silently later. */
export function hardToRead(name: string): boolean {
  return /\.(mp3|m4a|wav|aac|ogg|flac|mp4|mov|avi|mkv|webm|zip|rar|7z)$/i.test(name);
}

export const sectionLabel: React.CSSProperties = {
  fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', margin: '0 0 8px',
};

/**
 * Marks an update the user did not import (a meeting digest, a memory review). Imports, the usual case, get no
 * badge. Neutral on purpose: color on these cards means status.
 */
export function TypeBadge({ origin, kind }: { origin: string | null; kind?: string | null }) {
  const type = updateType({ origin, kind });
  if (type === 'imported') return null;
  const meta = typeMeta(type);
  return <span title={meta.hint} style={{ display: 'inline-flex' }}><Badge variant="default">{meta.label}</Badge></span>;
}
