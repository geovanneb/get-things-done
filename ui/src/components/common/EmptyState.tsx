import React from 'react';
import Button from './Button';

interface EmptyStateProps {
  icon?: React.ReactNode;
  title?: string;
  description?: string;
  /** Alias for description */
  message?: string;
  action?: {
    label: string;
    onClick: () => void;
  };
}

export default function EmptyState({ icon, title, description, message, action }: EmptyStateProps) {
  const desc = description ?? message;
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 12,
        padding: '48px 24px',
        textAlign: 'center',
      }}
    >
      {icon && (
        <div
          aria-hidden="true"
          style={{
            width: 48,
            height: 48,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--color-text-muted)',
            marginBottom: 4,
          }}
        >
          {icon}
        </div>
      )}
      <p
        style={{
          fontSize: 'var(--text-md)',
          fontWeight: 600,
          color: 'var(--color-text)',
        }}
      >
        {title}
      </p>
      {desc && (
        <p
          style={{
            fontSize: 'var(--text-sm)',
            color: 'var(--color-text-muted)',
            maxWidth: 360,
            lineHeight: 1.5,
          }}
        >
          {desc}
        </p>
      )}
      {action && (
        <Button variant="primary" onClick={action.onClick} style={{ marginTop: 8 }}>
          {action.label}
        </Button>
      )}
    </div>
  );
}
