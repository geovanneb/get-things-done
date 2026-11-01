import React from 'react';

/**
 * The one button for text actions. See docs/design-system.md, "Buttons".
 *
 *  primary    the main action of a page, card or dialog: one per group
 *  secondary  every other action (the default)
 *  ghost      low-emphasis actions in toolbars, rows and "Cancel"
 *  danger     an action that deletes or cannot be undone
 *
 * Icon-only actions use IconButton, which requires an accessible name.
 */
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

interface ButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'type'> {
  children?: React.ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner, disables the button and sets aria-busy, which also stops a second submit. */
  loading?: boolean;
  type?: 'button' | 'submit' | 'reset';
  icon?: React.ReactNode;
  iconPosition?: 'left' | 'right';
  /** Stretch to the width of the container (dialog footers on a phone, setup steps). */
  block?: boolean;
}

export default function Button({
  children,
  variant = 'secondary',
  size = 'md',
  disabled,
  loading,
  type = 'button',
  icon,
  iconPosition = 'left',
  block,
  className,
  ...rest
}: ButtonProps) {
  const isDisabled = disabled || loading;
  const classes = ['gtd-btn', `gtd-btn--${variant}`, `gtd-btn--${size}`, block && 'gtd-btn--block', className]
    .filter(Boolean)
    .join(' ');

  return (
    <button {...rest} type={type} disabled={isDisabled} aria-busy={loading || undefined} className={classes}>
      {loading ? (
        <span
          className="gtd-spin"
          style={{
            width: 14,
            height: 14,
            border: '2px solid currentColor',
            borderTopColor: 'transparent',
            borderRadius: 'var(--radius-full)',
            display: 'inline-block',
          }}
          aria-hidden="true"
        />
      ) : (
        icon && iconPosition === 'left' && <span aria-hidden="true" style={{ display: 'flex' }}>{icon}</span>
      )}
      {children}
      {!loading && icon && iconPosition === 'right' && (
        <span aria-hidden="true" style={{ display: 'flex' }}>{icon}</span>
      )}
    </button>
  );
}
