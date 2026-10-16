import type { InsightsData } from '@/types';
import { SERIES } from './palette';
import { formatShortDate } from './format';
import { PanelEmpty } from './Panel';

/**
 * Tasks created vs completed, per week. The question it answers is "am I
 * keeping up with myself" — bars above the line you can finish mean the
 * backlog is growing.
 *
 * Both series share one axis and one unit. Two y-scales would invent a
 * relationship that isn't in the data.
 */
export default function FlowChart({ data }: { data: InsightsData['weekly'] }) {
  const VW = 440;
  const VH = 210;
  const M = { top: 12, right: 8, bottom: 34, left: 28 };
  const CW = VW - M.left - M.right;
  const CH = VH - M.top - M.bottom;

  const rows = data ?? [];
  if (rows.length === 0) return <PanelEmpty message="No activity in this window." />;

  const max = Math.max(...rows.map((r) => Math.max(r.created, r.completed)), 1);
  const ticks = [0, Math.round(max / 2), max].filter((t, i, a) => a.indexOf(t) === i);

  const bandW = CW / rows.length;
  // A 2px surface gap separates the pair; no borders around the marks.
  const barW = Math.max(6, Math.min(18, (bandW - 10) / 2));

  const y = (v: number) => M.top + (1 - v / max) * CH;
  const h = (v: number) => Math.max((v / max) * CH, v > 0 ? 2 : 0);

  return (
    <figure style={{ margin: 0 }}>
      <svg
        viewBox={`0 0 ${VW} ${VH}`}
        width="100%"
        role="img"
        aria-label="Tasks created and completed per week"
        style={{ display: 'block', overflow: 'visible' }}
      >
        {/* Solid hairline grid, one shade off the surface. */}
        {ticks.map((tick) => (
          <g key={tick}>
            <line
              x1={M.left}
              y1={y(tick)}
              x2={M.left + CW}
              y2={y(tick)}
              stroke="var(--color-border)"
              strokeWidth={1}
            />
            <text
              x={M.left - 6}
              y={y(tick)}
              textAnchor="end"
              dominantBaseline="middle"
              fill="var(--color-text-muted)"
              fontSize={10}
              style={{ fontVariantNumeric: 'tabular-nums' }}
            >
              {tick}
            </text>
          </g>
        ))}

        {rows.map((row, i) => {
          const cx = M.left + (i + 0.5) * bandW;
          const pairs: Array<[number, string, string]> = [
            [row.created, SERIES.created, 'created'],
            [row.completed, SERIES.completed, 'completed'],
          ];
          return (
            <g key={row.week}>
              {pairs.map(([value, color, name], p) => {
                const x = cx + (p === 0 ? -barW - 1 : 1);
                return (
                  <g key={name}>
                    <rect
                      x={x}
                      y={y(value)}
                      width={barW}
                      height={h(value)}
                      fill={color}
                      rx={3}
                    >
                      <title>{`Week of ${formatShortDate(row.week)}: ${value} ${name}`}</title>
                    </rect>
                    {/* Direct label above the bar — never inside, where a short
                        bar would crop it. */}
                    {value > 0 && (
                      <text
                        x={x + barW / 2}
                        y={y(value) - 4}
                        textAnchor="middle"
                        fill="var(--color-text-secondary)"
                        fontSize={9}
                        fontWeight={600}
                        style={{ fontVariantNumeric: 'tabular-nums' }}
                      >
                        {value}
                      </text>
                    )}
                  </g>
                );
              })}
              <text
                x={cx}
                y={M.top + CH + 15}
                textAnchor="middle"
                fill="var(--color-text-muted)"
                fontSize={9}
              >
                {formatShortDate(row.week)}
              </text>
            </g>
          );
        })}

        <line
          x1={M.left}
          y1={M.top + CH}
          x2={M.left + CW}
          y2={M.top + CH}
          stroke="var(--color-border-strong)"
          strokeWidth={1}
        />
      </svg>

      <figcaption style={{ display: 'flex', gap: 16, marginTop: 8 }}>
        {[
          ['Created', SERIES.created],
          ['Completed', SERIES.completed],
        ].map(([label, color]) => (
          <span
            key={label}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 'var(--text-xs)',
              color: 'var(--color-text-secondary)',
            }}
          >
            <span
              style={{
                width: 10,
                height: 10,
                borderRadius: 2,
                backgroundColor: color,
                flexShrink: 0,
              }}
            />
            {label}
          </span>
        ))}
      </figcaption>
    </figure>
  );
}
