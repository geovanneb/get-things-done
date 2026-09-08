import { RemoveIcon } from './icons';

interface IconRemoveButtonProps {
  onClick: () => void;
  'aria-label': string;
  title?: string;
}

/** The small circular X button used to remove a deliverable, stakeholder, or file row. */
export default function IconRemoveButton({ onClick, 'aria-label': ariaLabel, title }: IconRemoveButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      title={title}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 24,
        height: 24,
        border: 'none',
        background: 'transparent',
        cursor: 'pointer',
        color: 'var(--color-text-muted)',
        borderRadius: 'var(--radius-sm)',
        padding: 0,
        flexShrink: 0,
      }}
      onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--color-critical)'; }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--color-text-muted)'; }}
    >
      <RemoveIcon />
    </button>
  );
}
