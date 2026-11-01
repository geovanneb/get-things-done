import React from 'react';
import Button from './Button';

interface EmptyStateProps {
  icon?: React.ReactNode;
  /** What is missing: "No routines yet". */
  title?: string;
  /** Why, and what to do next. */
  description?: React.ReactNode;
  /** Alias for description */
  message?: React.ReactNode;
  action?: {
    label: string;
    onClick: () => void;
  };
  /** A second, quieter way forward, such as "Learn more". */
  secondaryAction?: {
    label: string;
    onClick: () => void;
  };
  /** compact: for an empty list inside a card. page (default): for an empty page or main region. */
  size?: 'page' | 'compact';
}

/**
 * What a list, card or page shows when it has nothing yet. See docs/design-system.md, "States".
 * Say what is missing and how to add it; offer the action that fixes it.
 */
export default function EmptyState({ icon, title, description, message, action, secondaryAction, size = 'page' }: EmptyStateProps) {
  const desc = description ?? message;
  const compact = size === 'compact';
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: compact ? 'var(--space-2)' : 'var(--space-3)',
        padding: compact ? 'var(--space-6) var(--space-4)' : 'var(--space-12) var(--space-6)',
        textAlign: 'center',
      }}
    >
      {icon && (
        <div
          aria-hidden="true"
          style={{ width: 48, height: 48, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-text-muted)', marginBottom: 'var(--space-1)' }}
        >
          {icon}
        </div>
      )}
      {title && (
        <p style={{ fontSize: compact ? 'var(--text-base)' : 'var(--text-md)', fontWeight: 600, color: 'var(--color-text)' }}>{title}</p>
      )}
      {desc && (
        <p style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)', maxWidth: 420, lineHeight: 'var(--leading-normal)' }}>{desc}</p>
      )}
      {(action || secondaryAction) && (
        <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: 'var(--space-2)', marginTop: 'var(--space-2)' }}>
          {secondaryAction && (
            <Button variant="ghost" size={compact ? 'sm' : 'md'} onClick={secondaryAction.onClick}>{secondaryAction.label}</Button>
          )}
          {action && (
            <Button variant="primary" size={compact ? 'sm' : 'md'} onClick={action.onClick}>{action.label}</Button>
          )}
        </div>
      )}
    </div>
  );
}
