import React from 'react';
import Card from '@/components/common/Card';

/**
 * A titled chart card. Sized by its content rather than a fixed height, so an x-axis
 * band can never get clipped into a nested scrollbar. A thin wrapper over Card.
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
    <Card title={title} description={hint} actions={action}>
      {children}
    </Card>
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
        padding: 'var(--space-5) 0',
        textAlign: 'center',
      }}
    >
      {message}
    </p>
  );
}
