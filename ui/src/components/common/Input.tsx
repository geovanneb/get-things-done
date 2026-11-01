import React, { useId } from 'react';

/**
 * Form fields. See docs/design-system.md, "Forms".
 *
 * Field is the frame: a visible label tied to the control, a required or optional
 * marker, then a hint or an error, which the control references with aria-describedby.
 * Input, Textarea and Select are the common controls already inside a Field. For any
 * other control, wrap it in Field and give it `className="gtd-control"` and the props
 * from `useFieldProps`.
 */

interface FieldFrameProps {
  label?: React.ReactNode;
  /** Shows a red asterisk and sets aria-required on the control. */
  required?: boolean;
  /** Shows "(optional)" after the label, for forms where most fields are required. */
  optional?: boolean;
  hint?: React.ReactNode;
  error?: React.ReactNode;
  style?: React.CSSProperties;
}

export function Field({
  label,
  required,
  optional,
  hint,
  error,
  htmlFor,
  style,
  children,
}: FieldFrameProps & { htmlFor?: string; children: React.ReactNode }) {
  return (
    <div className="gtd-field" style={style}>
      {label && (
        <label htmlFor={htmlFor} className="gtd-field__label">
          {label}
          {required && <span className="gtd-field__required" aria-hidden="true">*</span>}
          {optional && !required && <span className="gtd-field__optional">(optional)</span>}
        </label>
      )}
      {children}
      {error ? (
        <span id={htmlFor ? `${htmlFor}-error` : undefined} className="gtd-field__error">{error}</span>
      ) : (
        hint && <span id={htmlFor ? `${htmlFor}-hint` : undefined} className="gtd-field__hint">{hint}</span>
      )}
    </div>
  );
}

/** The accessibility props a control inside a Field needs. */
export function useFieldProps(idProp: string | undefined, { error, hint, required }: { error?: unknown; hint?: unknown; required?: boolean }) {
  const generated = useId();
  const id = idProp ?? generated;
  return {
    id,
    'aria-invalid': error ? true : undefined,
    'aria-required': required || undefined,
    'aria-describedby': error ? `${id}-error` : hint ? `${id}-hint` : undefined,
  } as const;
}

/** A label beside its value on wide screens, stacked on a phone. For settings and record details. */
export function FieldRow({ label, htmlFor, children }: { label: React.ReactNode; htmlFor?: string; children: React.ReactNode }) {
  return (
    <div className="gtd-field-row">
      {htmlFor ? (
        <label htmlFor={htmlFor} className="gtd-field-row__label">{label}</label>
      ) : (
        <span className="gtd-field-row__label">{label}</span>
      )}
      <div className="gtd-field-row__value">{children}</div>
    </div>
  );
}

interface InputProps extends FieldFrameProps {
  value: string;
  /** Called with the extracted string value. */
  onChange: (value: string) => void;
  onBlur?: React.FocusEventHandler<HTMLInputElement>;
  onKeyDown?: React.KeyboardEventHandler<HTMLInputElement>;
  placeholder?: string;
  icon?: React.ReactNode;
  type?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  inputStyle?: React.CSSProperties;
  size?: 'sm' | 'md';
  'aria-label'?: string;
  name?: string;
  id?: string;
  autoComplete?: string;
  inputMode?: React.HTMLAttributes<HTMLInputElement>['inputMode'];
  maxLength?: number;
}

export default function Input({
  value,
  onChange,
  onBlur,
  onKeyDown,
  placeholder,
  label,
  required,
  optional,
  error,
  hint,
  icon,
  type = 'text',
  disabled,
  autoFocus,
  style,
  inputStyle,
  size = 'md',
  'aria-label': ariaLabel,
  name,
  id: idProp,
  autoComplete,
  inputMode,
  maxLength,
}: InputProps) {
  const a11y = useFieldProps(idProp, { error, hint, required });
  const classes = ['gtd-control', size === 'sm' && 'gtd-control--sm', icon && 'gtd-control--with-icon'].filter(Boolean).join(' ');

  return (
    <Field label={label} required={required} optional={optional} hint={hint} error={error} htmlFor={a11y.id} style={style}>
      <div style={{ position: 'relative' }}>
        {icon && (
          <span
            aria-hidden="true"
            style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--color-text-muted)', display: 'flex', pointerEvents: 'none' }}
          >
            {icon}
          </span>
        )}
        <input
          {...a11y}
          name={name}
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          disabled={disabled}
          autoFocus={autoFocus}
          required={required}
          autoComplete={autoComplete}
          inputMode={inputMode}
          maxLength={maxLength}
          aria-label={ariaLabel}
          className={classes}
          style={inputStyle}
        />
      </div>
    </Field>
  );
}

interface TextareaProps extends FieldFrameProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  rows?: number;
  'aria-label'?: string;
  id?: string;
  mono?: boolean;
  textareaStyle?: React.CSSProperties;
}

export function Textarea({
  value,
  onChange,
  placeholder,
  label,
  required,
  optional,
  error,
  hint,
  disabled,
  rows = 4,
  style,
  'aria-label': ariaLabel,
  id: idProp,
  mono,
  textareaStyle,
}: TextareaProps) {
  const a11y = useFieldProps(idProp, { error, hint, required });
  return (
    <Field label={label} required={required} optional={optional} hint={hint} error={error} htmlFor={a11y.id} style={style}>
      <textarea
        {...a11y}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        rows={rows}
        required={required}
        aria-label={ariaLabel}
        className="gtd-control"
        style={{ ...(mono ? { fontFamily: 'var(--font-mono)', fontSize: 'var(--text-sm)' } : {}), ...textareaStyle }}
      />
    </Field>
  );
}

interface SelectProps extends FieldFrameProps {
  value: string;
  onChange: (value: string) => void;
  options: ReadonlyArray<{ value: string; label: string; disabled?: boolean }>;
  disabled?: boolean;
  size?: 'sm' | 'md';
  'aria-label'?: string;
  id?: string;
  selectStyle?: React.CSSProperties;
}

/** A native select: keyboard and screen-reader behaviour come with it. */
export function Select({
  value,
  onChange,
  options,
  label,
  required,
  optional,
  error,
  hint,
  disabled,
  size = 'md',
  style,
  'aria-label': ariaLabel,
  id: idProp,
  selectStyle,
}: SelectProps) {
  const a11y = useFieldProps(idProp, { error, hint, required });
  return (
    <Field label={label} required={required} optional={optional} hint={hint} error={error} htmlFor={a11y.id} style={style}>
      <select
        {...a11y}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        required={required}
        aria-label={ariaLabel}
        className={['gtd-control', size === 'sm' && 'gtd-control--sm'].filter(Boolean).join(' ')}
        style={selectStyle}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
      </select>
    </Field>
  );
}

/**
 * The search box of a list or page toolbar. The placeholder says what is searched
 * ("Search templates"); the same text is the accessible name. Full width on a phone.
 */
export function SearchInput({
  value,
  onChange,
  placeholder,
  width = 240,
  size = 'md',
  onKeyDown,
  autoFocus,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  width?: number | string;
  size?: 'sm' | 'md';
  onKeyDown?: React.KeyboardEventHandler<HTMLInputElement>;
  autoFocus?: boolean;
}) {
  return (
    <div className="gtd-search" style={{ position: 'relative', width, maxWidth: '100%' }}>
      <span aria-hidden="true" style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--color-text-muted)', display: 'flex', pointerEvents: 'none' }}>
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.3" />
          <path d="M9.5 9.5L12.5 12.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
      </span>
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        aria-label={placeholder}
        autoFocus={autoFocus}
        className={['gtd-control', 'gtd-control--with-icon', size === 'sm' && 'gtd-control--sm'].filter(Boolean).join(' ')}
      />
    </div>
  );
}
