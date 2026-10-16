import type { InsightsData } from '@/types';
import { rampStep } from './palette';
import { PanelEmpty } from './Panel';

/**
 * How long tasks take, as a distribution.
 *
 * A single "average cycle time" is actively misleading on this data: the real
 * spread runs from six minutes to several weeks, so the mean sits in a gap
 * where almost nothing actually lands. The buckets are ordered, so they get the
 * ordinal ramp rather than a categorical palette.
 */
export default function TurnaroundChart({
  data,
}: {
  data: InsightsData['turnaround_buckets'];
}) {
  const buckets = data ?? [];
  const total = buckets.reduce((sum, b) => sum + b.count, 0);

  if (total === 0) return <PanelEmpty message="No tasks completed in this window." />;

  const max = Math.max(...buckets.map((b) => b.count), 1);

  return (
    <div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${buckets.length}, 1fr)`,
          gap: 6,
          alignItems: 'end',
          height: 150,
        }}
      >
        {buckets.map((bucket, i) => (
          <div
            key={bucket.label}
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'flex-end',
              height: '100%',
            }}
            title={`${bucket.label}: ${bucket.count} of ${total} tasks`}
          >
            <span
              style={{
                fontSize: 'var(--text-xs)',
                fontWeight: 600,
                color: bucket.count > 0 ? 'var(--color-text)' : 'var(--color-text-muted)',
                marginBottom: 4,
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {bucket.count}
            </span>
            <div
              style={{
                width: '100%',
                height: `${Math.max((bucket.count / max) * 100, bucket.count > 0 ? 3 : 1)}%`,
                minHeight: bucket.count > 0 ? 4 : 2,
                borderRadius: '4px 4px 0 0',
                backgroundColor:
                  bucket.count > 0 ? rampStep(i, buckets.length) : 'var(--color-border)',
              }}
            />
          </div>
        ))}
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${buckets.length}, 1fr)`,
          gap: 6,
          borderTop: '1px solid var(--color-border-strong)',
          paddingTop: 6,
          marginTop: 2,
        }}
      >
        {buckets.map((bucket) => (
          <span
            key={bucket.label}
            style={{
              fontSize: 'var(--text-xs)',
              color: 'var(--color-text-muted)',
              textAlign: 'center',
            }}
          >
            {bucket.label}
          </span>
        ))}
      </div>
    </div>
  );
}
