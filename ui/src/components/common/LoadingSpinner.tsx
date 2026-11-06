import { useLanguage } from '@/i18n/LanguageProvider';
interface LoadingSpinnerProps {
  /** What is loading, as "Loading tasks…". Announced to screen readers. */
  text?: string;
  size?: number;
  /** inline: no padding, for a spinner inside a row or a button-sized slot. */
  inline?: boolean;
}

/** The loading state of a page, card or list. See docs/design-system.md, "States". */
export default function LoadingSpinner({ text, size = 20, inline }: LoadingSpinnerProps) {
  const { t } = useLanguage();
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 10,
        padding: inline ? 0 : 'var(--space-6)',
        color: 'var(--color-text-muted)',
        fontSize: 'var(--text-sm)',
      }}
    >
      <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" className="gtd-spin" style={{ flexShrink: 0 }}>
        <circle cx="12" cy="12" r="10" stroke="var(--color-border-strong)" strokeWidth="3" />
        <path d="M12 2a10 10 0 0 1 10 10" stroke="var(--color-accent)" strokeWidth="3" strokeLinecap="round" />
      </svg>
      {text ? <span>{text}</span> : <span className="sr-only">{t('loading')}</span>}
    </div>
  );
}
