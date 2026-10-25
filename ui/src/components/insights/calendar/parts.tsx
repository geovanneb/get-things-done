import React from 'react';
import { RAMP } from '../palette';
import { STEPS } from './calendarModel';

/**
 * Fill for a scale step. Zero is a quiet surface, not the lightest ramp step,
 * so "nothing happened" never reads as "a little".
 */
export function stepFill(step: number): string {
  return step <= 0 ? 'var(--color-surface-active)' : RAMP[Math.min(step, STEPS) - 1];
}

/**
 * Text on a filled cell. The two deepest steps sit at the accent's lightness in
 * both themes, so they take the on-accent ink; the lighter steps keep body text.
 */
export function stepInk(step: number): string {
  return step >= 4 ? 'var(--color-text-on-accent)' : 'var(--color-text)';
}

export const iconButton: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  minWidth: 30,
  height: 30,
  padding: '0 8px',
  fontSize: 'var(--text-sm)',
  fontFamily: 'inherit',
  color: 'var(--color-text-secondary)',
  backgroundColor: 'var(--color-surface)',
  border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius-md)',
  cursor: 'pointer',
};

/** Same look as the window filter: one bordered group, the active option filled. */
export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: Array<{ value: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      style={{
        display: 'inline-flex',
        flexWrap: 'wrap',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-md)',
        overflow: 'hidden',
        backgroundColor: 'var(--color-surface)',
      }}
    >
      {options.map((option, i) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(option.value)}
            style={{
              padding: '5px 12px',
              fontSize: 'var(--text-sm)',
              fontWeight: active ? 600 : 400,
              fontFamily: 'inherit',
              color: active ? 'var(--color-text-on-accent)' : 'var(--color-text-secondary)',
              backgroundColor: active ? 'var(--color-accent)' : 'transparent',
              border: 'none',
              borderLeft: i === 0 ? 'none' : '1px solid var(--color-border)',
              cursor: 'pointer',
            }}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/** "Less [] [] [] More", with the value each step covers under its swatch. */
export function Legend({ labels }: { labels: string[] }) {
  const text: React.CSSProperties = { fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' };
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }} aria-label="Colour scale">
      <span style={{ ...text, lineHeight: '12px' }}>Less</span>
      {['0', ...labels].map((label, step) => (
        <span key={step} style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
          <span
            style={{
              width: 12,
              height: 12,
              borderRadius: 2,
              backgroundColor: stepFill(step),
            }}
          />
          <span style={{ ...text, fontSize: 10, fontVariantNumeric: 'tabular-nums' }}>{label}</span>
        </span>
      ))}
      <span style={{ ...text, lineHeight: '12px' }}>More</span>
    </div>
  );
}
