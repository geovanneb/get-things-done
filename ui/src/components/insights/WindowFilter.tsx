
export type WindowValue = '7' | '30' | '90' | 'all';

const OPTIONS: Array<{ value: WindowValue; label: string }> = [
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: 'all', label: 'All time' },
];

/**
 * The one filter row. It sits above every panel and scopes all of them at once
 * — a per-card filter would let two panels disagree about what "now" means.
 */
export default function WindowFilter({
  value,
  onChange,
}: {
  value: WindowValue;
  onChange: (value: WindowValue) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Time window"
      style={{
        display: 'inline-flex',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-md)',
        overflow: 'hidden',
        backgroundColor: 'var(--color-surface)',
      }}
    >
      {OPTIONS.map((option, i) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(option.value)}
            style={{
              padding: '6px 14px',
              fontSize: 'var(--text-sm)',
              fontWeight: active ? 600 : 400,
              fontFamily: 'inherit',
              color: active ? 'var(--color-text-on-accent)' : 'var(--color-text-secondary)',
              backgroundColor: active ? 'var(--color-accent)' : 'transparent',
              border: 'none',
              borderLeft: i === 0 ? 'none' : '1px solid var(--color-border)',
              cursor: 'pointer',
            }}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
