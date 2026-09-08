import React, { useEffect, useState } from 'react';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import EmptyState from '@/components/common/EmptyState';
import { apiGet } from '@/utils/api';
import type { InsightsData } from '@/types';

// ---------------------------------------------------------------------------
// Local type aliases
// ---------------------------------------------------------------------------

type CFPoint = {
  date: string;
  backlog: number;
  ready: number;
  in_progress: number;
  blocked: number;
  review: number;
  done: number;
};

type CFLayerKey = 'done' | 'review' | 'in_progress' | 'ready' | 'blocked' | 'backlog';
type CTPoint = { title: string; days: number; priority: string; completed_at: string };
type ThroughputPoint = { week: string; completed: number };
type DueDateRisk = NonNullable<InsightsData['due_date_risk']>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CF_LAYERS: CFLayerKey[] = ['done', 'review', 'in_progress', 'ready', 'blocked', 'backlog'];

const CF_COLORS: Record<CFLayerKey, string> = {
  done: 'var(--color-success)',
  review: 'var(--color-info)',
  in_progress: 'var(--color-accent)',
  ready: '#6366f1',
  blocked: 'var(--color-critical)',
  backlog: '#9ca3af',
};

const CF_LABELS: Record<CFLayerKey, string> = {
  done: 'Done',
  review: 'Review',
  in_progress: 'In Progress',
  ready: 'Ready',
  blocked: 'Blocked',
  backlog: 'Backlog',
};

const RISK_CATEGORIES: Array<{
  key: keyof DueDateRisk;
  label: string;
  color: string;
}> = [
  { key: 'overdue', label: 'Overdue', color: 'var(--color-critical)' },
  { key: 'due_3d', label: 'Due <3d', color: '#f97316' },
  { key: 'due_7d', label: 'Due <7d', color: '#f59e0b' },
  { key: 'due_14d', label: 'Due <14d', color: 'var(--color-info)' },
  { key: 'safe', label: 'Due 14+', color: '#9ca3af' },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatShortDate(dateStr: string): string {
  try {
    const iso = dateStr.includes('T') ? dateStr : dateStr + 'T00:00:00';
    const d = new Date(iso);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  } catch {
    return dateStr.slice(5, 10);
  }
}

function yTicks(maxVal: number, count = 5): number[] {
  return Array.from({ length: count }, (_, i) =>
    Math.round((maxVal / (count - 1)) * i)
  );
}

// ---------------------------------------------------------------------------
// StatTile
// ---------------------------------------------------------------------------

function StatTile({
  label,
  value,
  unit,
  critical,
}: {
  label: string;
  value: number | undefined;
  unit?: string;
  critical?: boolean;
}) {
  return (
    <div
      style={{
        backgroundColor: 'var(--color-surface)',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-lg)',
        padding: '16px 24px',
        flex: 1,
        minWidth: 140,
      }}
    >
      <div
        style={{
          fontSize: 'var(--text-xs)',
          color: 'var(--color-text-muted)',
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
          marginBottom: 8,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 'var(--text-xl)',
          fontWeight: 700,
          color: critical ? 'var(--color-critical)' : 'var(--color-text)',
          lineHeight: 1.1,
        }}
      >
        {value !== undefined ? `${value}${unit ?? ''}` : '--'}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ChartCard
// ---------------------------------------------------------------------------

function ChartCard({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        backgroundColor: 'var(--color-surface)',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-lg)',
        padding: 16,
      }}
    >
      <h3
        style={{
          fontSize: 'var(--text-base)',
          fontWeight: 600,
          color: 'var(--color-text)',
          margin: '0 0 14px 0',
        }}
      >
        {title}
      </h3>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Axis helpers (SVG)
// ---------------------------------------------------------------------------

const GRID_LINE_PROPS = {
  stroke: 'var(--color-border)' as string,
  strokeWidth: 0.5,
  strokeDasharray: '3,3',
};

function YAxis({
  ticks,
  maxVal,
  margin,
  chartH,
}: {
  ticks: number[];
  maxVal: number;
  margin: { top: number; right: number; bottom: number; left: number };
  chartH: number;
}) {
  return (
    <>
      <line
        x1={margin.left}
        y1={margin.top}
        x2={margin.left}
        y2={margin.top + chartH}
        stroke="var(--color-border)"
        strokeWidth={1}
      />
      {ticks.map((tick, ti) => {
        const y = margin.top + (1 - tick / maxVal) * chartH;
        return (
          <g key={`ytick-${ti}`}>
            <line
              x1={margin.left - 4}
              y1={y}
              x2={margin.left}
              y2={y}
              stroke="var(--color-border-strong)"
              strokeWidth={1}
            />
            <text
              x={margin.left - 8}
              y={y}
              textAnchor="end"
              dominantBaseline="middle"
              fill="var(--color-text-muted)"
              fontSize={10}
            >
              {tick}
            </text>
            <line
              x1={margin.left}
              y1={y}
              x2={margin.left + (400 - margin.left - margin.right)}
              y2={y}
              {...GRID_LINE_PROPS}
            />
          </g>
        );
      })}
    </>
  );
}

// ---------------------------------------------------------------------------
// CumulativeFlowChart
// ---------------------------------------------------------------------------

function CumulativeFlowChart({ data }: { data: InsightsData['cumulative_flow'] }) {
  const VW = 400;
  const VH = 220;
  const M = { top: 30, right: 20, bottom: 50, left: 45 };
  const CW = VW - M.left - M.right; // 335
  const CH = VH - M.top - M.bottom; // 140

  const points: CFPoint[] = (data ?? []).slice(-8) as CFPoint[];
  const n = points.length;

  if (n < 2) {
    return (
      <div style={{ width: '100%' }}>
        <svg viewBox={`0 0 ${VW} ${VH}`} width="100%" style={{ display: 'block' }}>
          <text
            x={VW / 2}
            y={VH / 2}
            textAnchor="middle"
            dominantBaseline="middle"
            fill="var(--color-text-muted)"
            fontSize={13}
          >
            {n === 0 ? 'No data' : 'Need at least 2 data points'}
          </text>
        </svg>
      </div>
    );
  }

  // Compute totals and max
  const totals = points.map((d) =>
    CF_LAYERS.reduce((sum, l) => sum + (d[l] ?? 0), 0)
  );
  const maxTotal = Math.max(...totals, 1);

  const xScale = (i: number) => M.left + (i / (n - 1)) * CW;
  const yScale = (v: number) => M.top + (1 - v / maxTotal) * CH;

  // Stacked cumulative values per data point, per layer
  const stacks = points.map((d) => {
    let cum = 0;
    return CF_LAYERS.map((layer) => {
      const start = cum;
      cum += d[layer] ?? 0;
      return { start, end: cum };
    });
  });

  // Build polygon points for each layer (band between top and bottom boundary)
  const polygons = CF_LAYERS.map((layer, li) => {
    const topPts = points.map((_, i) => {
      const x = xScale(i).toFixed(2);
      const y = yScale(stacks[i][li].end).toFixed(2);
      return `${x},${y}`;
    });
    const botPts = points
      .map((_, i) => {
        const x = xScale(i).toFixed(2);
        const y = yScale(stacks[i][li].start).toFixed(2);
        return `${x},${y}`;
      })
      .reverse();
    return { layer, pts: [...topPts, ...botPts].join(' ') };
  });

  const ticks = yTicks(maxTotal);

  return (
    <div style={{ width: '100%' }}>
      <svg
        viewBox={`0 0 ${VW} ${VH}`}
        width="100%"
        style={{ display: 'block', overflow: 'visible' }}
      >
        {/* Y axis + grid */}
        <YAxis ticks={ticks} maxVal={maxTotal} margin={M} chartH={CH} />

        {/* X axis baseline */}
        <line
          x1={M.left}
          y1={M.top + CH}
          x2={M.left + CW}
          y2={M.top + CH}
          stroke="var(--color-border)"
          strokeWidth={1}
        />

        {/* X axis date labels */}
        {points.map((d, i) => {
          const x = xScale(i);
          return (
            <text
              key={i}
              x={x}
              y={M.top + CH + 14}
              textAnchor="middle"
              fill="var(--color-text-muted)"
              fontSize={9}
              transform={`rotate(-35, ${x}, ${M.top + CH + 14})`}
            >
              {formatShortDate(d.date)}
            </text>
          );
        })}

        {/* Stacked area polygons (rendered bottom-up so lower layers show through) */}
        {polygons.map(({ layer, pts }) => (
          <polygon
            key={layer}
            points={pts}
            fill={CF_COLORS[layer]}
            fillOpacity={0.72}
            stroke={CF_COLORS[layer]}
            strokeWidth={1}
            strokeOpacity={0.9}
          />
        ))}
      </svg>

      {/* Legend */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '6px 14px',
          marginTop: 4,
        }}
      >
        {CF_LAYERS.map((layer) => (
          <span
            key={layer}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              fontSize: 'var(--text-xs)',
              color: 'var(--color-text-secondary)',
            }}
          >
            <span
              style={{
                width: 10,
                height: 10,
                borderRadius: 2,
                backgroundColor: CF_COLORS[layer],
                display: 'inline-block',
                opacity: 0.8,
                flexShrink: 0,
              }}
            />
            {CF_LABELS[layer]}
          </span>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// CycleTimeChart (scatter)
// ---------------------------------------------------------------------------

const PRIORITY_COLORS: Record<string, string> = {
  critical: 'var(--priority-critical)',
  high: 'var(--priority-high)',
  medium: 'var(--priority-medium)',
  low: 'var(--priority-low)',
};

const PRIORITY_FALLBACK: Record<string, string> = {
  critical: 'oklch(0.52 0.18 25)',
  high: '#f59e0b',
  medium: '#3b82f6',
  low: '#9ca3af',
};

function CycleTimeChart({ data }: { data: InsightsData['cycle_time'] }) {
  const VW = 400;
  const VH = 220;
  const M = { top: 30, right: 20, bottom: 40, left: 40 };
  const CW = VW - M.left - M.right; // 340
  const CH = VH - M.top - M.bottom; // 150

  const points: CTPoint[] = data ?? [];

  if (points.length === 0) {
    return (
      <svg viewBox={`0 0 ${VW} ${VH}`} width="100%" style={{ display: 'block' }}>
        <text
          x={VW / 2}
          y={VH / 2}
          textAnchor="middle"
          dominantBaseline="middle"
          fill="var(--color-text-muted)"
          fontSize={13}
        >
          No data
        </text>
      </svg>
    );
  }

  const timestamps = points.map((d) => new Date(d.completed_at).getTime());
  const minTs = Math.min(...timestamps);
  const maxTs = Math.max(...timestamps);
  const tsRange = maxTs - minTs || 1;

  const maxDays = Math.max(...points.map((d) => d.days), 1);
  const yMax = maxDays * 1.1;

  const xScale = (ts: number) => M.left + ((ts - minTs) / tsRange) * CW;
  const yScale = (days: number) => M.top + (1 - days / yMax) * CH;

  const ticks = yTicks(Math.ceil(yMax));

  // X axis: pick up to 5 evenly spaced timestamps from the sorted set
  const sortedTs = [...timestamps].sort((a, b) => a - b);
  const xLabelCount = Math.min(5, sortedTs.length);
  const xLabelTs =
    xLabelCount <= 1
      ? [sortedTs[0]]
      : Array.from({ length: xLabelCount }, (_, i) =>
          sortedTs[Math.round((i / (xLabelCount - 1)) * (sortedTs.length - 1))]
        );

  return (
    <div style={{ width: '100%' }}>
      <svg
        viewBox={`0 0 ${VW} ${VH}`}
        width="100%"
        style={{ display: 'block', overflow: 'visible' }}
      >
        {/* Y axis + grid */}
        <YAxis ticks={ticks} maxVal={yMax} margin={M} chartH={CH} />

        {/* Y axis label */}
        <text
          x={12}
          y={M.top + CH / 2}
          textAnchor="middle"
          fill="var(--color-text-muted)"
          fontSize={10}
          transform={`rotate(-90, 12, ${M.top + CH / 2})`}
        >
          days
        </text>

        {/* X axis baseline */}
        <line
          x1={M.left}
          y1={M.top + CH}
          x2={M.left + CW}
          y2={M.top + CH}
          stroke="var(--color-border)"
          strokeWidth={1}
        />

        {/* X axis date labels */}
        {xLabelTs.map((ts, i) => (
          <text
            key={i}
            x={xScale(ts)}
            y={M.top + CH + 16}
            textAnchor="middle"
            fill="var(--color-text-muted)"
            fontSize={9}
          >
            {formatShortDate(new Date(ts).toISOString().slice(0, 10))}
          </text>
        ))}

        {/* Data circles */}
        {points.map((pt, i) => {
          const ts = new Date(pt.completed_at).getTime();
          const cx = xScale(ts);
          const cy = yScale(pt.days);
          const fill = PRIORITY_COLORS[pt.priority] ?? PRIORITY_FALLBACK[pt.priority] ?? '#9ca3af';

          return (
            <circle
              key={i}
              cx={cx}
              cy={cy}
              r={5}
              style={{ fill }}
              fillOpacity={0.82}
              stroke="var(--color-surface)"
              strokeWidth={1.5}
            >
              <title>{`${pt.title}: ${pt.days} days (${pt.priority})`}</title>
            </circle>
          );
        })}
      </svg>

      {/* Priority legend */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '6px 14px',
          marginTop: 4,
        }}
      >
        {Object.keys(PRIORITY_FALLBACK).map((priority) => (
          <span
            key={priority}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              fontSize: 'var(--text-xs)',
              color: 'var(--color-text-secondary)',
              textTransform: 'capitalize',
            }}
          >
            <span
              style={{
                width: 10,
                height: 10,
                borderRadius: '50%',
                backgroundColor:
                  PRIORITY_FALLBACK[priority],
                display: 'inline-block',
                flexShrink: 0,
              }}
            />
            {priority}
          </span>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// DueDateRiskChart (horizontal bar)
// ---------------------------------------------------------------------------

function DueDateRiskChart({ data }: { data: InsightsData['due_date_risk'] }) {
  const VW = 400;
  const VH = 200;
  const M = { top: 16, right: 50, bottom: 16, left: 90 };
  const CW = VW - M.left - M.right; // 260
  const CH = VH - M.top - M.bottom; // 168

  if (!data) {
    return (
      <svg viewBox={`0 0 ${VW} ${VH}`} width="100%" style={{ display: 'block' }}>
        <text
          x={VW / 2}
          y={VH / 2}
          textAnchor="middle"
          dominantBaseline="middle"
          fill="var(--color-text-muted)"
          fontSize={13}
        >
          No data
        </text>
      </svg>
    );
  }

  const counts = RISK_CATEGORIES.map((c) => data[c.key] ?? 0);
  const maxCount = Math.max(...counts, 1);

  const numCats = RISK_CATEGORIES.length;
  const bandH = CH / numCats;
  const barH = Math.floor(bandH * 0.52);

  return (
    <svg
      viewBox={`0 0 ${VW} ${VH}`}
      width="100%"
      style={{ display: 'block', overflow: 'visible' }}
    >
      {RISK_CATEGORIES.map((cat, i) => {
        const count = data[cat.key] ?? 0;
        const filledW = Math.max((count / maxCount) * CW, count > 0 ? 4 : 0);
        const yCenter = M.top + (i + 0.5) * bandH;
        const barTop = yCenter - barH / 2;

        return (
          <g key={cat.key}>
            {/* Row label */}
            <text
              x={M.left - 8}
              y={yCenter}
              textAnchor="end"
              dominantBaseline="middle"
              fill="var(--color-text-secondary)"
              fontSize={11}
            >
              {cat.label}
            </text>

            {/* Background track */}
            <rect
              x={M.left}
              y={barTop}
              width={CW}
              height={barH}
              fill="var(--color-border)"
              rx={3}
            />

            {/* Filled bar */}
            {count > 0 && (
              <rect
                x={M.left}
                y={barTop}
                width={filledW}
                height={barH}
                fill={cat.color}
                rx={3}
              />
            )}

            {/* Count label after bar */}
            <text
              x={M.left + filledW + 7}
              y={yCenter}
              dominantBaseline="middle"
              fill="var(--color-text-secondary)"
              fontSize={11}
              fontWeight={600}
            >
              {count}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// ThroughputChart (vertical bar)
// ---------------------------------------------------------------------------

function ThroughputChart({ data }: { data: InsightsData['throughput'] }) {
  const VW = 400;
  const VH = 220;
  const M = { top: 30, right: 20, bottom: 50, left: 40 };
  const CW = VW - M.left - M.right; // 340
  const CH = VH - M.top - M.bottom; // 140

  const points: ThroughputPoint[] = (data ?? []).slice(-8);
  const n = points.length;

  if (n === 0) {
    return (
      <svg viewBox={`0 0 ${VW} ${VH}`} width="100%" style={{ display: 'block' }}>
        <text
          x={VW / 2}
          y={VH / 2}
          textAnchor="middle"
          dominantBaseline="middle"
          fill="var(--color-text-muted)"
          fontSize={13}
        >
          No data
        </text>
      </svg>
    );
  }

  const maxVal = Math.max(...points.map((d) => d.completed), 1);
  const ticks = yTicks(maxVal);

  const bandW = CW / n;
  const barW = bandW * 0.62;

  const xCenter = (i: number) => M.left + (i + 0.5) * bandW;
  const bHeight = (v: number) => Math.max((v / maxVal) * CH, v > 0 ? 2 : 0);
  const bY = (v: number) => M.top + CH - bHeight(v);

  return (
    <svg
      viewBox={`0 0 ${VW} ${VH}`}
      width="100%"
      style={{ display: 'block', overflow: 'visible' }}
    >
      {/* Y axis + grid */}
      <line
        x1={M.left}
        y1={M.top}
        x2={M.left}
        y2={M.top + CH}
        stroke="var(--color-border)"
        strokeWidth={1}
      />
      {ticks.map((tick, ti) => {
        const y = M.top + (1 - tick / maxVal) * CH;
        return (
          <g key={`tick-${ti}`}>
            <line
              x1={M.left - 4}
              y1={y}
              x2={M.left}
              y2={y}
              stroke="var(--color-border-strong)"
              strokeWidth={1}
            />
            <text
              x={M.left - 8}
              y={y}
              textAnchor="end"
              dominantBaseline="middle"
              fill="var(--color-text-muted)"
              fontSize={10}
            >
              {tick}
            </text>
            <line
              x1={M.left}
              y1={y}
              x2={M.left + CW}
              y2={y}
              {...GRID_LINE_PROPS}
            />
          </g>
        );
      })}

      {/* X axis baseline */}
      <line
        x1={M.left}
        y1={M.top + CH}
        x2={M.left + CW}
        y2={M.top + CH}
        stroke="var(--color-border)"
        strokeWidth={1}
      />

      {/* Bars + labels */}
      {points.map((d, i) => {
        const cx = xCenter(i);
        const bh = bHeight(d.completed);
        const by = bY(d.completed);

        return (
          <g key={`bar-${i}`}>
            <rect
              x={cx - barW / 2}
              y={by}
              width={barW}
              height={bh}
              fill="var(--color-accent)"
              rx={3}
            />
            {/* Value label inside bar (only if bar is tall enough) */}
            {bh > 16 && (
              <text
                x={cx}
                y={by + 12}
                textAnchor="middle"
                fill="var(--color-text-on-accent)"
                fontSize={10}
                fontWeight={600}
              >
                {d.completed}
              </text>
            )}
            {/* X axis week label */}
            <text
              x={cx}
              y={M.top + CH + 14}
              textAnchor="middle"
              fill="var(--color-text-muted)"
              fontSize={9}
              transform={`rotate(-35, ${cx}, ${M.top + CH + 14})`}
            >
              {formatShortDate(d.week)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// InsightsView
// ---------------------------------------------------------------------------

export default function InsightsView() {
  const [data, setData] = useState<InsightsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const fetchData = async () => {
      setLoading(true);
      setError(null);
      try {
        const result = await apiGet<InsightsData>('/api/insights');
        if (!cancelled) setData(result ?? null);
      } catch (err) {
        if (!cancelled) {
          setError('Failed to load insights. Please try again.');
          console.error(err);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    fetchData();
    return () => { cancelled = true; };
  }, []);

  if (loading) {
    return (
      <div
        style={{
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          minHeight: 320,
        }}
      >
        <LoadingSpinner />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div style={{ padding: 24 }}>
        <EmptyState message={error ?? 'No insights data available.'} />
      </div>
    );
  }

  return (
    <div style={{ padding: 24 }}>
      {/* Page title */}
      <h1
        style={{
          fontSize: 'var(--text-xl)',
          fontWeight: 700,
          color: 'var(--color-text)',
          margin: '0 0 24px 0',
        }}
      >
        Insights
      </h1>

      {/* Summary stat tiles */}
      <div
        style={{
          display: 'flex',
          gap: 16,
          marginBottom: 24,
          flexWrap: 'wrap',
        }}
      >
        <StatTile
          label="Avg Cycle Time"
          value={data.avg_cycle_time}
          unit=" days"
        />
        <StatTile
          label="Throughput This Week"
          value={data.throughput_this_week}
          unit=" tasks"
        />
        <StatTile
          label="Completion Rate"
          value={data.completion_rate}
          unit="%"
        />
        <StatTile
          label="Tasks at Risk"
          value={data.tasks_at_risk}
          critical={(data.tasks_at_risk ?? 0) > 0}
        />
      </div>

      {/* 2x2 chart grid */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 20,
        }}
      >
        <ChartCard title="Cumulative Flow">
          <CumulativeFlowChart data={data.cumulative_flow} />
        </ChartCard>

        <ChartCard title="Cycle Time">
          <CycleTimeChart data={data.cycle_time} />
        </ChartCard>

        <ChartCard title="Due-date Risk">
          <DueDateRiskChart data={data.due_date_risk} />
        </ChartCard>

        <ChartCard title="Throughput (tasks/week)">
          <ThroughputChart data={data.throughput} />
        </ChartCard>
      </div>
    </div>
  );
}
