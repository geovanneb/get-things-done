import React from 'react';

/**
 * Shared style tokens for task creation/edit fields (New Task modal and the
 * Edit Task overlay's Work tab). Keeping these in one place is what keeps the
 * two screens visually consistent — don't redefine these locally in either
 * screen; import from here instead.
 */

export const fieldLabelStyle: React.CSSProperties = {
  display: 'block',
  fontFamily: 'var(--font-sans)',
  fontSize: 'var(--text-sm)',
  fontWeight: 500,
  color: 'var(--color-text)',
  marginBottom: '4px',
};

/** Uppercase, letter-spaced section header (e.g. "Deliverables", "Stakeholders", "Objective"). */
export const sectionLabelStyle: React.CSSProperties = {
  fontSize: 'var(--text-sm)',
  fontWeight: 600,
  color: 'var(--color-text-secondary)',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
};

export const selectStyle: React.CSSProperties = {
  width: '100%',
  padding: '8px 10px',
  fontFamily: 'var(--font-sans)',
  fontSize: 'var(--text-sm)',
  color: 'var(--color-text)',
  background: 'var(--color-surface)',
  border: '1px solid var(--color-border-strong)',
  borderRadius: 'var(--radius-md)',
  appearance: 'none',
  outline: 'none',
  cursor: 'pointer',
};

export const dateInputStyle: React.CSSProperties = {
  width: '100%',
  padding: '8px 10px',
  fontFamily: 'var(--font-sans)',
  fontSize: 'var(--text-sm)',
  color: 'var(--color-text)',
  background: 'var(--color-surface)',
  border: '1px solid var(--color-border-strong)',
  borderRadius: 'var(--radius-md)',
  outline: 'none',
  boxSizing: 'border-box',
};

export const textareaStyle: React.CSSProperties = {
  width: '100%',
  padding: '8px 10px',
  fontFamily: 'var(--font-sans)',
  fontSize: 'var(--text-sm)',
  color: 'var(--color-text)',
  background: 'var(--color-surface)',
  border: '1px solid var(--color-border-strong)',
  borderRadius: 'var(--radius-md)',
  resize: 'vertical',
  outline: 'none',
  lineHeight: '1.5',
  boxSizing: 'border-box',
  minHeight: '72px',
};

export const chipStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '4px',
  padding: '2px 8px',
  borderRadius: 'var(--radius-sm)',
  background: 'var(--color-accent-subtle)',
  color: 'var(--color-accent)',
  fontFamily: 'var(--font-sans)',
  fontSize: 'var(--text-xs)',
  fontWeight: 500,
  cursor: 'default',
};

export const chipRemoveStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  padding: '0 0 0 2px',
  cursor: 'pointer',
  color: 'var(--color-accent)',
  fontSize: '12px',
  lineHeight: 1,
  display: 'flex',
  alignItems: 'center',
};

export const dropdownStyle: React.CSSProperties = {
  position: 'absolute',
  top: 'calc(100% + 4px)',
  left: 0,
  right: 0,
  zIndex: 100,
  background: 'var(--color-surface)',
  border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius-md)',
  boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
  maxHeight: '180px',
  overflowY: 'auto',
};

export const dropdownItemStyle: React.CSSProperties = {
  padding: '8px 12px',
  fontFamily: 'var(--font-sans)',
  fontSize: 'var(--text-sm)',
  color: 'var(--color-text)',
  cursor: 'pointer',
  listStyle: 'none',
};
