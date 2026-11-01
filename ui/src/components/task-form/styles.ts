import React from 'react';

/**
 * Inline styles for task, routine and cleanup forms that predate the shared fields.
 * The values follow the design system (docs/design-system.md): the same control height,
 * radius and text size as `.gtd-control`. New forms use Input, Select and Textarea from
 * components/common/Input instead, which also bring labels, hints and errors.
 */

export const fieldLabelStyle: React.CSSProperties = {
  display: 'block',
  fontFamily: 'var(--font-sans)',
  fontSize: 'var(--text-sm)',
  fontWeight: 500,
  color: 'var(--color-text)',
  marginBottom: '4px',
};

/** Heading of a group of fields (e.g. "Deliverables", "Stakeholders", "Objective"). Sentence case, like card titles. */
export const sectionLabelStyle: React.CSSProperties = {
  fontSize: 'var(--text-base)',
  fontWeight: 600,
  color: 'var(--color-text)',
};

export const selectStyle: React.CSSProperties = {
  width: '100%',
  height: 'var(--control-height-md)',
  padding: '0 10px',
  fontFamily: 'var(--font-sans)',
  fontSize: 'var(--text-base)',
  color: 'var(--color-text)',
  background: 'var(--color-surface)',
  border: '1px solid var(--color-border-control)',
  borderRadius: 'var(--radius-md)',
  cursor: 'pointer',
};

export const dateInputStyle: React.CSSProperties = {
  width: '100%',
  height: 'var(--control-height-md)',
  padding: '0 10px',
  fontFamily: 'var(--font-sans)',
  fontSize: 'var(--text-base)',
  color: 'var(--color-text)',
  background: 'var(--color-surface)',
  border: '1px solid var(--color-border-control)',
  borderRadius: 'var(--radius-md)',
  boxSizing: 'border-box',
};

export const textareaStyle: React.CSSProperties = {
  width: '100%',
  padding: '8px 10px',
  fontFamily: 'var(--font-sans)',
  fontSize: 'var(--text-base)',
  color: 'var(--color-text)',
  background: 'var(--color-surface)',
  border: '1px solid var(--color-border-control)',
  borderRadius: 'var(--radius-md)',
  resize: 'vertical',
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
  fontSize: 'var(--text-xs)',
  lineHeight: 1,
  display: 'flex',
  alignItems: 'center',
};

export const dropdownStyle: React.CSSProperties = {
  position: 'absolute',
  top: 'calc(100% + 4px)',
  left: 0,
  right: 0,
  zIndex: 'var(--z-dropdown)',
  background: 'var(--color-surface)',
  border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius-md)',
  boxShadow: 'var(--shadow-md)',
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
