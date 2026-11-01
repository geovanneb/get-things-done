import React from 'react';

export type NoticeTone = 'info' | 'success' | 'warning' | 'critical';

const ICONS: Record<NoticeTone, React.ReactNode> = {
  info: (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <circle cx="7" cy="7" r="5.75" stroke="currentColor" strokeWidth="1.3" />
      <path d="M7 6.25v3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <circle cx="7" cy="4.4" r="0.8" fill="currentColor" />
    </svg>
  ),
  success: (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <circle cx="7" cy="7" r="5.75" stroke="currentColor" strokeWidth="1.3" />
      <path d="M4.5 7.2l1.7 1.7 3.3-3.6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  warning: (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <path d="M7 1.8L12.8 12H1.2L7 1.8Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M7 5.8v2.7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <circle cx="7" cy="10.2" r="0.75" fill="currentColor" />
    </svg>
  ),
  critical: (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <circle cx="7" cy="7" r="5.75" stroke="currentColor" strokeWidth="1.3" />
      <path d="M7 4v3.6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <circle cx="7" cy="9.9" r="0.8" fill="currentColor" />
    </svg>
  ),
};

/**
 * An inline message about the page or a part of it: a failed load, a warning before an
 * action, a tip. See docs/design-system.md, "States".
 *
 * Every tone has its own icon, so the meaning never rests on colour alone. Critical
 * notices are announced at once (role="alert"); the others politely (role="status").
 * Short-lived feedback after an action ("Saved") is a toast, not a notice.
 */
export default function Notice({
  tone = 'info',
  title,
  children,
  action,
  style,
}: {
  tone?: NoticeTone;
  title?: React.ReactNode;
  children?: React.ReactNode;
  /** A recovery action, such as "Try again". */
  action?: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <div role={tone === 'critical' ? 'alert' : 'status'} className={`gtd-notice gtd-notice--${tone}`} style={style}>
      <span className="gtd-notice__icon" aria-hidden="true">{ICONS[tone]}</span>
      <div className="gtd-notice__body">
        {title && <div className="gtd-notice__title">{title}</div>}
        {children}
      </div>
      {action && <div className="gtd-notice__action">{action}</div>}
    </div>
  );
}
