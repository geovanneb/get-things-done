import { Link } from 'react-router-dom';
import type { InsightsBar } from '@/types';
import { PanelEmpty } from './Panel';

export type BarColoring =
  /** Leading bar in accent, the rest grey. For "one of these dominates". */
  | { mode: 'emphasis'; lead: string; rest: string }
  /** Every bar the same colour. For nominal categories with no order. */
  | { mode: 'single'; color: string }
  /** Ordered ramp, darkest first. Only for genuinely ordered rows. */
  | { mode: 'ramp'; step: (i: number, n: number) => string };

/**
 * Ranked horizontal bars, built from divs rather than SVG so long labels wrap
 * and reflow like text.
 *
 * Every row carries its own value as a direct label, so nothing is only
 * reachable by hovering.
 */
export default function BarList({
  rows,
  coloring,
  emptyMessage,
  /** Rendered after the count, e.g. "runs" or "tasks". */
  unit,
  /** Show each row's share of the total under the bar. */
  showShare = false,
}: {
  rows: InsightsBar[];
  coloring: BarColoring;
  emptyMessage: string;
  unit?: string;
  showShare?: boolean;
}) {
  if (rows.length === 0) return <PanelEmpty message={emptyMessage} />;

  const max = Math.max(...rows.map((r) => r.value), 1);
  const total = rows.reduce((sum, r) => sum + r.value, 0);

  const colorFor = (i: number): string => {
    if (coloring.mode === 'single') return coloring.color;
    if (coloring.mode === 'ramp') return coloring.step(i, rows.length);
    return i === 0 ? coloring.lead : coloring.rest;
  };

  return (
    <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 12 }}>
      {rows.map((row, i) => {
        const share = total > 0 ? row.value / total : 0;
        const label = (
          <>
            <span
              style={{
                fontSize: 'var(--text-sm)',
                color: 'var(--color-text)',
                fontWeight: i === 0 && coloring.mode === 'emphasis' ? 600 : 400,
              }}
            >
              {row.label}
            </span>
            {row.sublabel && (
              <span
                style={{
                  display: 'block',
                  fontSize: 'var(--text-xs)',
                  color: 'var(--color-text-muted)',
                  marginTop: 1,
                }}
              >
                {row.sublabel}
              </span>
            )}
          </>
        );

        return (
          <li key={row.key}>
            <div
              style={{
                display: 'flex',
                alignItems: 'baseline',
                justifyContent: 'space-between',
                gap: 12,
                marginBottom: 5,
              }}
            >
              <div style={{ minWidth: 0 }}>
                {row.href ? (
                  <Link
                    to={row.href}
                    style={{ textDecoration: 'none', color: 'inherit', display: 'block' }}
                  >
                    {label}
                  </Link>
                ) : (
                  label
                )}
              </div>
              {/* Direct label: the value is readable without a tooltip. */}
              <span
                style={{
                  fontSize: 'var(--text-sm)',
                  fontWeight: 600,
                  color: 'var(--color-text)',
                  fontVariantNumeric: 'tabular-nums',
                  whiteSpace: 'nowrap',
                  flexShrink: 0,
                }}
              >
                {row.value}
                {unit && (
                  <span style={{ fontWeight: 400, color: 'var(--color-text-muted)' }}> {unit}</span>
                )}
                {showShare && (
                  <span style={{ fontWeight: 400, color: 'var(--color-text-muted)' }}>
                    {'  '}
                    {Math.round(share * 100)}%
                  </span>
                )}
              </span>
            </div>
            <div
              style={{
                height: 8,
                borderRadius: 4,
                backgroundColor: 'var(--color-bg)',
                overflow: 'hidden',
              }}
              title={`${row.label}: ${row.value}${unit ? ` ${unit}` : ''}`}
            >
              <div
                style={{
                  width: `${Math.max((row.value / max) * 100, 2)}%`,
                  height: '100%',
                  borderRadius: 4,
                  backgroundColor: colorFor(i),
                }}
              />
            </div>
          </li>
        );
      })}
    </ol>
  );
}
