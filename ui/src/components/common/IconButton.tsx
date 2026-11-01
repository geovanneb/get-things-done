import React from 'react';

interface IconButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'type' | 'aria-label'> {
  /** Accessible name and tooltip. Required: the button has no visible text. */
  label: string;
  icon: React.ReactNode;
  size?: 'sm' | 'md';
  /** danger turns red on hover, for delete and remove. */
  tone?: 'default' | 'danger';
  /** outline gives the button a border, for standalone use outside a toolbar or row. */
  outline?: boolean;
  type?: 'button' | 'submit';
}

/** A square, icon-only button: edit, delete, close, copy, collapse. */
export default function IconButton({ label, icon, size = 'sm', tone = 'default', outline, type = 'button', className, title, ...rest }: IconButtonProps) {
  const classes = ['gtd-icon-btn', `gtd-icon-btn--${size}`, tone === 'danger' && 'gtd-icon-btn--danger', outline && 'gtd-icon-btn--outline', className]
    .filter(Boolean)
    .join(' ');
  return (
    <button {...rest} type={type} aria-label={label} title={title ?? label} className={classes}>
      <span aria-hidden="true" style={{ display: 'flex' }}>{icon}</span>
    </button>
  );
}

/** The icons most icon buttons need, drawn on the same 14px grid. */
export const icons = {
  edit: (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <path d="M9.5 2.5l2 2L5 11H3V9l6.5-6.5z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  ),
  trash: (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <path d="M2.5 4h9M5.5 4V2.5h3V4M3.5 4l.5 7.5h6l.5-7.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  close: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path d="M4 4L12 12M12 4L4 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
  plus: (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
      <path d="M6.5 2v9M2 6.5h9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
  copy: (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <rect x="4.5" y="4.5" width="7" height="7" rx="1.2" stroke="currentColor" strokeWidth="1.3" />
      <path d="M9.5 4.5V3a.5.5 0 00-.5-.5H3a.5.5 0 00-.5.5v6a.5.5 0 00.5.5h1.5" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  ),
  search: (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M9.5 9.5L12.5 12.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  ),
};
