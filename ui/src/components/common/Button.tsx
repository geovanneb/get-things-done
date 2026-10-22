import React from 'react';

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
type ButtonSize = 'sm' | 'md' | 'lg';

interface ButtonProps {
  children?: React.ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  disabled?: boolean;
  loading?: boolean;
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  type?: 'button' | 'submit' | 'reset';
  icon?: React.ReactNode;
  iconPosition?: 'left' | 'right';
  title?: string;
  'aria-label'?: string;
  /** For toggle buttons. */
  'aria-pressed'?: boolean;
  'aria-controls'?: string;
  style?: React.CSSProperties;
}

const baseStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 6,
  fontWeight: 500,
  borderRadius: 'var(--radius-md)',
  border: '1px solid transparent',
  cursor: 'pointer',
  transition: 'background 0.1s, border-color 0.1s, color 0.1s',
  whiteSpace: 'nowrap',
  flexShrink: 0,
  fontFamily: 'var(--font-sans)',
};

const variantStyles: Record<ButtonVariant, React.CSSProperties> = {
  primary: {
    background: 'var(--color-accent)',
    color: 'var(--color-text-on-accent)',
    borderColor: 'var(--color-accent)',
  },
  secondary: {
    background: 'var(--color-surface)',
    color: 'var(--color-text)',
    borderColor: 'var(--color-border-strong)',
  },
  ghost: {
    background: 'transparent',
    color: 'var(--color-text-secondary)',
    borderColor: 'transparent',
  },
  danger: {
    background: 'var(--color-critical-subtle)',
    color: 'var(--color-critical)',
    borderColor: 'color-mix(in oklch, var(--color-critical) 25%, transparent)',
  },
};

const sizeStyles: Record<ButtonSize, React.CSSProperties> = {
  sm: { height: 28, padding: '0 10px', fontSize: 'var(--text-sm)' },
  md: { height: 34, padding: '0 14px', fontSize: 'var(--text-base)' },
  lg: { height: 40, padding: '0 18px', fontSize: 'var(--text-md)' },
};

export default function Button({
  children,
  variant = 'secondary',
  size = 'md',
  disabled,
  loading,
  onClick,
  type = 'button',
  icon,
  iconPosition = 'left',
  title,
  'aria-label': ariaLabel,
  'aria-pressed': ariaPressed,
  'aria-controls': ariaControls,
  style,
}: ButtonProps) {
  const isDisabled = disabled || loading;

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={isDisabled}
      title={title}
      aria-label={ariaLabel}
      aria-pressed={ariaPressed}
      aria-controls={ariaControls}
      aria-disabled={isDisabled}
      style={{
        ...baseStyle,
        ...variantStyles[variant],
        ...sizeStyles[size],
        opacity: isDisabled ? 0.5 : 1,
        cursor: isDisabled ? 'not-allowed' : 'pointer',
        ...style,
      }}
    >
      {loading ? (
        <span
          style={{
            width: 14,
            height: 14,
            border: '2px solid currentColor',
            borderTopColor: 'transparent',
            borderRadius: '50%',
            animation: 'spin 0.7s linear infinite',
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
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </button>
  );
}
