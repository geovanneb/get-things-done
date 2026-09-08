import React from 'react';

type BadgeVariant =
  | 'default'
  | 'muted'
  | 'priority-critical'
  | 'priority-high'
  | 'priority-medium'
  | 'priority-low'
  | 'status-backlog'
  | 'status-ready'
  | 'status-in_progress'
  | 'status-done'
  | 'status-blocked'
  | 'status-review'
  | 'status-archived'
  | 'success'
  | 'warning'
  | 'error'
  | 'info'
  | 'accent'
  | 'accent-subtle'
  | 'critical'
  | 'priority'
  | (string & {});

type BadgeSize = 'sm' | 'md';

interface BadgeProps {
  children?: React.ReactNode;
  /** Alternative to children for convenience */
  label?: string;
  variant?: BadgeVariant;
  size?: BadgeSize;
  style?: React.CSSProperties;
}

// Alias map for shorthand variants
const VARIANT_ALIASES: Record<string, string> = {
  critical: 'error',
  priority: 'default',
};

const variantStyles: Record<string, React.CSSProperties> = {
  muted: {
    background: 'var(--color-surface-hover)',
    color: 'var(--color-text-muted)',
    border: '1px solid var(--color-border)',
  },
  'accent-subtle': {
    background: 'var(--color-accent-subtle)',
    color: 'var(--color-accent)',
    border: '1px solid color-mix(in oklch, var(--color-accent) 25%, transparent)',
  },
  default: {
    background: 'var(--color-surface-hover)',
    color: 'var(--color-text-secondary)',
    border: '1px solid var(--color-border)',
  },
  'priority-critical': {
    background: 'var(--color-critical-subtle)',
    color: 'var(--color-critical)',
    border: '1px solid color-mix(in oklch, var(--color-critical) 25%, transparent)',
  },
  'priority-high': {
    background: 'var(--color-warning-subtle)',
    color: 'var(--color-warning)',
    border: '1px solid color-mix(in oklch, var(--color-warning) 25%, transparent)',
  },
  'priority-medium': {
    background: 'var(--color-info-subtle)',
    color: 'var(--color-info)',
    border: '1px solid color-mix(in oklch, var(--color-info) 25%, transparent)',
  },
  'priority-low': {
    background: 'var(--color-surface-hover)',
    color: 'var(--color-text-muted)',
    border: '1px solid var(--color-border)',
  },
  'status-backlog': {
    background: 'var(--color-surface-hover)',
    color: 'var(--color-text-secondary)',
    border: '1px solid var(--color-border)',
  },
  'status-ready': {
    background: 'var(--color-info-subtle)',
    color: 'var(--color-info)',
    border: '1px solid color-mix(in oklch, var(--color-info) 25%, transparent)',
  },
  'status-in_progress': {
    background: 'var(--color-accent-subtle)',
    color: 'var(--color-accent)',
    border: '1px solid color-mix(in oklch, var(--color-accent) 25%, transparent)',
  },
  'status-done': {
    background: 'var(--color-success-subtle)',
    color: 'var(--color-success)',
    border: '1px solid color-mix(in oklch, var(--color-success) 25%, transparent)',
  },
  'status-blocked': {
    background: 'var(--color-critical-subtle)',
    color: 'var(--color-critical)',
    border: '1px solid color-mix(in oklch, var(--color-critical) 25%, transparent)',
  },
  'status-review': {
    background: 'var(--color-warning-subtle)',
    color: 'var(--color-warning)',
    border: '1px solid color-mix(in oklch, var(--color-warning) 25%, transparent)',
  },
  'status-archived': {
    background: 'var(--color-surface-hover)',
    color: 'var(--color-text-muted)',
    border: '1px solid var(--color-border)',
  },
  success: {
    background: 'var(--color-success-subtle)',
    color: 'var(--color-success)',
    border: '1px solid color-mix(in oklch, var(--color-success) 25%, transparent)',
  },
  warning: {
    background: 'var(--color-warning-subtle)',
    color: 'var(--color-warning)',
    border: '1px solid color-mix(in oklch, var(--color-warning) 25%, transparent)',
  },
  error: {
    background: 'var(--color-critical-subtle)',
    color: 'var(--color-critical)',
    border: '1px solid color-mix(in oklch, var(--color-critical) 25%, transparent)',
  },
  info: {
    background: 'var(--color-info-subtle)',
    color: 'var(--color-info)',
    border: '1px solid color-mix(in oklch, var(--color-info) 25%, transparent)',
  },
  accent: {
    background: 'var(--color-accent)',
    color: 'var(--color-text-on-accent)',
    border: '1px solid transparent',
  },
};

export default function Badge({ children, label, variant = 'default', size = 'sm', style }: BadgeProps) {
  const sizeStyle: React.CSSProperties =
    size === 'sm'
      ? { fontSize: 'var(--text-xs)', padding: '1px 6px', lineHeight: '18px' }
      : { fontSize: 'var(--text-sm)', padding: '2px 8px', lineHeight: '20px' };

  const resolvedVariant = VARIANT_ALIASES[variant as string] ?? variant;
  const resolvedStyle = variantStyles[resolvedVariant] ?? variantStyles['default'];

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        fontWeight: 500,
        borderRadius: 'var(--radius-sm)',
        whiteSpace: 'nowrap',
        ...resolvedStyle,
        ...sizeStyle,
        ...style,
      }}
    >
      {children ?? label}
    </span>
  );
}
