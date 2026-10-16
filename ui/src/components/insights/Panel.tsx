import React from 'react';

/**
 * A titled card. Sized by its content rather than a fixed height, so an x-axis
 * band can never get clipped into a nested scrollbar.
 */
export default function Panel({
  title,
  hint,
  action,
  children,
}: {
  title: string;
  /** One line explaining what the panel measures, when that is not obvious. */
  hint?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section
      style={{
        backgroundColor: 'var(--color-surface)',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-lg)',
        padding: 16,
        display: 'flex',
        flexDirection: 'column',
        minWidth: 0,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: 12,
          marginBottom: hint ? 2 : 14,
        }}
      >
        <h2
          style={{
            fontSize: 'var(--text-base)',
            fontWeight: 600,
            color: 'var(--color-text)',
            margin: 0,
          }}
        >
          {title}
        </h2>
        {action}
      </div>
      {hint && (
        <p
          style={{
            fontSize: 'var(--text-xs)',
            color: 'var(--color-text-muted)',
            margin: '0 0 14px 0',
          }}
        >
          {hint}
        </p>
      )}
      {children}
    </section>
  );
}

/** Shared placeholder so an empty panel still reads as a panel, not a bug. */
export function PanelEmpty({ message }: { message: string }) {
  return (
    <p
      style={{
        fontSize: 'var(--text-sm)',
        color: 'var(--color-text-muted)',
        margin: 0,
        padding: '20px 0',
        textAlign: 'center',
      }}
    >
      {message}
    </p>
  );
}
