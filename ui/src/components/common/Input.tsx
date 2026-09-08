import React, { useId } from 'react';

interface InputProps {
  value: string;
  /** Called with the extracted string value. */
  onChange: (value: string) => void;
  onBlur?: React.FocusEventHandler<HTMLInputElement>;
  onKeyDown?: React.KeyboardEventHandler<HTMLInputElement>;
  placeholder?: string;
  label?: string;
  error?: string;
  hint?: string;
  icon?: React.ReactNode;
  type?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  style?: React.CSSProperties;
  inputStyle?: React.CSSProperties;
  'aria-label'?: string;
  name?: string;
  id?: string;
}

interface TextareaProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  label?: string;
  error?: string;
  hint?: string;
  disabled?: boolean;
  rows?: number;
  style?: React.CSSProperties;
  'aria-label'?: string;
}

const inputBaseStyle: React.CSSProperties = {
  width: '100%',
  height: 34,
  padding: '0 10px',
  fontSize: 'var(--text-base)',
  color: 'var(--color-text)',
  background: 'var(--color-surface)',
  border: '1px solid var(--color-border-strong)',
  borderRadius: 'var(--radius-md)',
  outline: 'none',
  transition: 'border-color 0.15s',
};

export default function Input({
  value,
  onChange,
  onBlur,
  onKeyDown,
  placeholder,
  label,
  error,
  hint,
  icon,
  type = 'text',
  disabled,
  autoFocus,
  style,
  inputStyle,
  'aria-label': ariaLabel,
  name,
  id: idProp,
}: InputProps) {
  const generatedId = useId();
  const id = idProp ?? generatedId;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, ...style }}>
      {label && (
        <label
          htmlFor={id}
          style={{ fontSize: 'var(--text-sm)', fontWeight: 500, color: 'var(--color-text-secondary)' }}
        >
          {label}
        </label>
      )}
      <div style={{ position: 'relative' }}>
        {icon && (
          <span
            aria-hidden="true"
            style={{
              position: 'absolute',
              left: 9,
              top: '50%',
              transform: 'translateY(-50%)',
              color: 'var(--color-text-muted)',
              display: 'flex',
            }}
          >
            {icon}
          </span>
        )}
        <input
          id={id}
          name={name}
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          disabled={disabled}
          autoFocus={autoFocus}
          aria-label={ariaLabel}
          aria-invalid={!!error}
          aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
          style={{
            ...inputBaseStyle,
            paddingLeft: icon ? 32 : 10,
            borderColor: error ? 'var(--color-critical)' : 'var(--color-border-strong)',
            opacity: disabled ? 0.6 : 1,
            cursor: disabled ? 'not-allowed' : 'text',
            ...inputStyle,
          }}
        />
      </div>
      {error && (
        <span id={`${id}-error`} style={{ fontSize: 'var(--text-xs)', color: 'var(--color-critical)' }}>
          {error}
        </span>
      )}
      {!error && hint && (
        <span id={`${id}-hint`} style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
          {hint}
        </span>
      )}
    </div>
  );
}

export function Textarea({
  value,
  onChange,
  placeholder,
  label,
  error,
  hint,
  disabled,
  rows = 4,
  style,
  'aria-label': ariaLabel,
}: TextareaProps) {
  const id = useId();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, ...style }}>
      {label && (
        <label
          htmlFor={id}
          style={{ fontSize: 'var(--text-sm)', fontWeight: 500, color: 'var(--color-text-secondary)' }}
        >
          {label}
        </label>
      )}
      <textarea
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        rows={rows}
        aria-label={ariaLabel}
        aria-invalid={!!error}
        aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
        style={{
          width: '100%',
          padding: '8px 10px',
          fontSize: 'var(--text-base)',
          color: 'var(--color-text)',
          background: 'var(--color-surface)',
          border: `1px solid ${error ? 'var(--color-critical)' : 'var(--color-border-strong)'}`,
          borderRadius: 'var(--radius-md)',
          outline: 'none',
          resize: 'vertical',
          fontFamily: 'var(--font-sans)',
          lineHeight: 1.5,
          opacity: disabled ? 0.6 : 1,
        }}
      />
      {error && (
        <span id={`${id}-error`} style={{ fontSize: 'var(--text-xs)', color: 'var(--color-critical)' }}>
          {error}
        </span>
      )}
      {!error && hint && (
        <span id={`${id}-hint`} style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
          {hint}
        </span>
      )}
    </div>
  );
}
