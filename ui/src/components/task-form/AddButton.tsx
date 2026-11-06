import { tr } from '@/i18n/current';
import React from 'react';
import { PlusIcon } from './icons';

interface AddButtonProps {
  onClick: () => void;
  children?: React.ReactNode;
}

/** The small text "+ Add" button used above a Deliverables (or similar) list. */
export default function AddButton({ onClick, children = tr('orgChartsPanel.add') }: AddButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        fontSize: 'var(--text-xs)',
        fontWeight: 500,
        color: 'var(--color-accent)',
        border: 'none',
        background: 'transparent',
        cursor: 'pointer',
        padding: '2px 4px',
      }}
    >
      <PlusIcon />
      {children}
    </button>
  );
}
