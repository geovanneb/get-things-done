
/**
 * One headline number. The number *is* the chart here — a single value never
 * earns a one-bar bar chart.
 */
export default function StatTile({
  label,
  value,
  sub,
  tone = 'default',
}: {
  label: string;
  value: string;
  /** The context line that keeps the headline honest ("11 of 12"). */
  sub?: string;
  tone?: 'default' | 'critical' | 'success';
}) {
  const color =
    tone === 'critical'
      ? 'var(--color-critical)'
      : tone === 'success'
        ? 'var(--color-success)'
        : 'var(--color-text)';

  return (
    <div
      style={{
        backgroundColor: 'var(--color-surface)',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-lg)',
        padding: '14px 18px',
        flex: '1 1 150px',
        minWidth: 150,
      }}
    >
      <div
        style={{
          fontSize: 'var(--text-xs)',
          fontWeight: 600,
          color: 'var(--color-text-muted)',
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
          marginBottom: 6,
        }}
      >
        {label}
      </div>
      {/* Proportional figures: tabular-nums makes a large standalone number
          look loosely spaced, and nothing aligns under it here. */}
      <div
        style={{
          fontSize: '1.65rem',
          fontWeight: 700,
          color,
          lineHeight: 1.1,
          letterSpacing: '-0.01em',
        }}
      >
        {value}
      </div>
      {sub && (
        <div
          style={{
            fontSize: 'var(--text-xs)',
            color: 'var(--color-text-muted)',
            marginTop: 4,
          }}
        >
          {sub}
        </div>
      )}
    </div>
  );
}
