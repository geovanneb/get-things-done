import React from 'react';

interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Accessible name. Required — the switch has no visible text of its own. */
  label: string;
  disabled?: boolean;
  id?: string;
}

/**
 * A small on/off switch matching the app's token palette. Rendered as a real
 * checkbox input so it keeps keyboard and screen-reader behaviour for free.
 */
export default function Toggle({ checked, onChange, label, disabled, id }: ToggleProps) {
  const [focused, setFocused] = React.useState(false);

  return (
    <label
      htmlFor={id}
      style={{
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        width: 40,
        height: 22,
        flexShrink: 0,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <input
        id={id}
        type="checkbox"
        role="switch"
        aria-label={label}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={{
          // The input covers the whole switch rather than being visually
          // hidden, so the click target is the control itself.
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          margin: 0,
          opacity: 0,
          cursor: 'inherit',
          zIndex: 1,
        }}
      />
      <span
        aria-hidden="true"
        style={{
          position: 'absolute',
          inset: 0,
          borderRadius: 11,
          background: checked ? 'var(--color-accent)' : 'var(--color-border-strong)',
          border: '1px solid',
          borderColor: checked ? 'var(--color-accent)' : 'var(--color-border-strong)',
          transition: 'background 0.15s, border-color 0.15s',
          boxShadow: focused ? '0 0 0 3px var(--color-accent-subtle)' : 'none',
          pointerEvents: 'none',
        }}
      />
      <span
        aria-hidden="true"
        style={{
          position: 'absolute',
          top: 3,
          left: checked ? 21 : 3,
          width: 16,
          height: 16,
          borderRadius: '50%',
          background: 'var(--color-surface)',
          transition: 'left 0.15s ease',
          boxShadow: '0 1px 2px rgba(0,0,0,0.25)',
          pointerEvents: 'none',
        }}
      />
    </label>
  );
}
