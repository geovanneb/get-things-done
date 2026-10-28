import type { OfficeCheck } from '@/types';

const TEXT: Record<OfficeCheck, { label: string; title: string }> = {
  encrypted: {
    label: 'Encrypted',
    title: 'This Office file is encrypted (for example by a sensitivity label), so agents cannot read it. Save an unprotected copy if an agent needs it.',
  },
  unsupported_container: {
    label: 'Not readable',
    title: 'This file has an Office extension but is not a valid Office document (empty, damaged or renamed), so agents cannot read it.',
  },
};

/** Marks an Office file agents cannot read. Renders nothing when the server reported no problem. */
export default function OfficeCheckBadge({ check }: { check?: OfficeCheck }) {
  if (!check) return null;
  const { label, title } = TEXT[check];
  return (
    <span title={title} style={{
      flexShrink: 0, padding: '1px 6px', borderRadius: 'var(--radius-sm)', fontSize: 'var(--text-xs)', fontWeight: 500,
      color: 'var(--color-warning)', background: 'var(--color-warning-subtle)', border: '1px solid var(--color-warning)',
    }}>
      {label}
    </span>
  );
}
