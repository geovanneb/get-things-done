import React, { useState } from 'react';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import EmptyState from '@/components/common/EmptyState';
import Panel from '@/components/insights/Panel';
import StatTile from '@/components/insights/StatTile';
import BarList from '@/components/insights/BarList';
import AttentionList from '@/components/insights/AttentionList';
import FlowChart from '@/components/insights/FlowChart';
import TurnaroundChart from '@/components/insights/TurnaroundChart';
import ActivityCalendar from '@/components/insights/calendar/ActivityCalendar';
import WindowFilter, { type WindowValue } from '@/components/insights/WindowFilter';
import { EMPHASIS, SERIES, rampStep } from '@/components/insights/palette';
import { formatDays, formatHours, formatRate } from '@/components/insights/format';
import { useApi } from '@/hooks/useApi';
import { useDataVersion } from '@/store';
import type { InsightsData } from '@/types';

const WINDOW_LABEL: Record<WindowValue, string> = {
  '7': 'last 7 days',
  '30': 'last 30 days',
  '90': 'last 90 days',
  all: 'all time',
};

const GRID_TWO_COL: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))',
  alignItems: 'start',
  gap: 16,
};

export default function InsightsView() {
  const [window, setWindow] = useState<WindowValue>('30');
  // Task files are the source for every panel, so the SSE watcher's `tasks`
  // scope is what should trigger a refresh.
  const tasksVersion = useDataVersion('tasks');
  const { data, loading, error } = useApi<InsightsData>(
    `/api/insights?days=${window}`,
    [tasksVersion],
  );

  if (loading && !data) {
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

  // Only fall back to the empty state when there is nothing to show. A failed
  // background refetch (the SSE watcher fires one on every file change) must not
  // blank out a dashboard that is already on screen.
  if (!data) {
    return (
      <div style={{ padding: 24 }}>
        <EmptyState message={error ?? 'No insights data available.'} />
      </div>
    );
  }

  const s = data.summary;
  const windowLabel = WINDOW_LABEL[window];

  return (
    // Hold the previous render at reduced opacity while a refetch is in flight,
    // rather than flashing a skeleton and jumping the layout.
    <div
      style={{
        padding: 24,
        maxWidth: 1180,
        margin: '0 auto',
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
        opacity: loading ? 0.6 : 1,
        transition: 'opacity 120ms ease',
      }}
    >
      {/* One filter row, scoping everything below it. */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          flexWrap: 'wrap',
        }}
      >
        <p
          style={{
            fontSize: 'var(--text-sm)',
            color: 'var(--color-text-muted)',
            margin: 0,
          }}
        >
          Delivery, effort and quality across your workspace.
        </p>
        <WindowFilter value={window} onChange={setWindow} />
      </div>

      {error && (
        <div
          role="status"
          style={{
            fontSize: 'var(--text-sm)',
            color: 'var(--color-critical)',
            backgroundColor: 'var(--color-critical-subtle)',
            border: '1px solid var(--color-critical)',
            borderRadius: 'var(--radius-md)',
            padding: '8px 12px',
          }}
        >
          Could not refresh: {error}. Showing the last loaded data.
        </div>
      )}

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <StatTile
          label="Waiting on you"
          value={String(s.awaiting_review)}
          sub={
            s.awaiting_review === 0
              ? 'review queue is clear'
              : `oldest ${formatDays(s.awaiting_review_oldest_days)}`
          }
          tone={s.awaiting_review > 0 ? 'critical' : 'success'}
        />
        <StatTile
          label="Completed"
          value={String(s.completed)}
          sub={`${s.open} still open · ${windowLabel}`}
        />
        <StatTile
          label="Median turnaround"
          value={formatHours(s.median_turnaround_hours)}
          sub={`90% within ${formatHours(s.p90_turnaround_hours)}`}
        />
        <StatTile
          label="First-pass rate"
          value={formatRate(s.first_pass_rate)}
          sub={
            s.first_pass_rate === null
              ? 'no completed tasks yet'
              : `${Math.round(s.first_pass_rate * s.first_pass_of)} of ${
                  s.first_pass_of
                } needed one run`
          }
        />
        <StatTile
          label="On time"
          value={formatRate(s.on_time_rate)}
          sub={`of ${s.on_time_of} with a due date`}
        />
      </div>

      <Panel
        title="Needs your attention"
        hint="Agents stop at Needs Review by design, so nothing closes until you look at it."
      >
        <AttentionList items={data.attention} />
      </Panel>

      {/* Full width: a year is 53 columns. It answers "when", the frame for the
          "who" and "what" panels below, and follows the same window filter. */}
      <ActivityCalendar window={window} windowLabel={windowLabel} />

      <div style={GRID_TWO_COL}>
        <Panel
          title="Who your work is for"
          hint="Tasks per stakeholder. A single tall bar means your output is concentrated."
        >
          <BarList
            rows={data.by_stakeholder}
            coloring={{ mode: 'emphasis', lead: EMPHASIS.lead, rest: EMPHASIS.rest }}
            emptyMessage="No tasks reference a stakeholder in this window."
            showShare
          />
        </Panel>

        <Panel
          title="What you produce"
          hint="Tasks per output template, not raw file format."
        >
          <BarList
            rows={data.by_output}
            coloring={{ mode: 'single', color: SERIES.completed }}
            emptyMessage="No deliverables reference an output template in this window."
          />
        </Panel>
      </div>

      <div style={GRID_TWO_COL}>
        <Panel
          title="Rework watchlist"
          hint="Tasks an agent had to run more than once. Usually a sign the brief was ambiguous."
        >
          <BarList
            rows={data.rework}
            coloring={{ mode: 'ramp', step: (i, n) => rampStep(n - 1 - i, n) }}
            emptyMessage="Every task was done in a single run."
            unit="runs"
          />
        </Panel>

        <Panel
          title="Lessons captured"
          hint="Kaizen entries by area. The tall bar is what keeps going wrong."
        >
          <BarList
            rows={data.kaizen}
            coloring={{ mode: 'single', color: SERIES.completed }}
            emptyMessage="No kaizen entries yet."
          />
        </Panel>
      </div>

      <div style={GRID_TWO_COL}>
        <Panel
          title="Created vs completed"
          hint="Per week. Created running ahead of completed means the backlog is growing."
        >
          <FlowChart data={data.weekly} />
        </Panel>

        <Panel
          title="Turnaround distribution"
          hint={
            s.median_review_hours === null
              ? 'From writing a task to signing it off.'
              : `From writing a task to signing it off. Of that, a median ${formatHours(
                  s.median_review_hours,
                )} was waiting on your review.`
          }
        >
          <TurnaroundChart data={data.turnaround_buckets} />
        </Panel>
      </div>
    </div>
  );
}
