import { useLanguage } from '@/i18n/LanguageProvider';
import { tr } from '@/i18n/current';
import { rich } from '@/i18n/rich';
import React, { useState } from 'react';
import Notice from '@/components/common/Notice';
import Page, { PageHeader } from '@/components/common/Page';
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

const WINDOW_LABEL = (): Record<WindowValue, string> => ({
  '7': tr('insights.last7Days'),
  '30': tr('insights.last30Days'),
  '90': tr('insights.last90Days'),
  all: tr('insights.allTime'),
});

const GRID_TWO_COL: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 340px), 1fr))',
  alignItems: 'start',
  gap: 'var(--space-4)',
};

export default function InsightsView() {
  const { t } = useLanguage();
  const [window, setWindow] = useState<WindowValue>('30');
  // Task files are the source for every panel, so the SSE watcher's `tasks`
  // scope is what should trigger a refresh.
  const tasksVersion = useDataVersion('tasks');
  const { data, loading, error } = useApi<InsightsData>(
    `/api/insights?days=${window}`,
    [tasksVersion],
  );

  if (loading && !data) return <LoadingSpinner text={t('insights.loadingInsights')} />;

  // Only fall back to the empty state when there is nothing to show. A failed
  // background refetch (the SSE watcher fires one on every file change) must not
  // blank out a dashboard that is already on screen.
  if (!data) {
    return (
      <Page width="wide">
        {error
          ? <Notice tone="critical" title={t('insights.couldNotLoadInsights')}>{error}</Notice>
          : <EmptyState title={t('insights.noInsightsYet')} description={t('insights.insightsAppearOnceTasksMove')} />}
      </Page>
    );
  }

  const s = data.summary;
  const windowLabel = WINDOW_LABEL()[window];

  return (
    // Hold the previous render at reduced opacity while a refetch is in flight,
    // rather than flashing a skeleton and jumping the layout.
    <Page width="wide" aria-busy={loading || undefined} style={{ gap: 'var(--space-4)', opacity: loading ? 0.6 : 1, transition: 'opacity 120ms ease' }}>
      {/* One filter row, scoping everything below it. */}
      <PageHeader description={t('insights.deliveryEffortAndQualityAcross')} actions={<WindowFilter value={window} onChange={setWindow} />} />

      {error && <Notice tone="warning" title={t('insights.couldNotRefresh')}>{rich(t, 'insights.showingTheLastLoadedData', { error: error })}</Notice>}

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <StatTile
          label={t('attentionList.waitingOnYou')}
          value={String(s.awaiting_review)}
          sub={
            s.awaiting_review === 0
              ? t('insights.reviewQueueIsClear')
              : t('insights.oldest', { awaiting_review_oldest_days: formatDays(s.awaiting_review_oldest_days) })
          }
          tone={s.awaiting_review > 0 ? 'critical' : 'success'}
        />
        <StatTile
          label={t('flowChart.completed')}
          value={String(s.completed)}
          sub={t('insights.stillOpen', { open: s.open, windowLabel })}
        />
        <StatTile
          label={t('insights.medianTurnaround')}
          value={formatHours(s.median_turnaround_hours)}
          sub={t('insights.90Within', { p90_turnaround_hours: formatHours(s.p90_turnaround_hours) })}
        />
        <StatTile
          label={t('insights.firstPassRate')}
          value={formatRate(s.first_pass_rate)}
          sub={
            s.first_pass_rate === null
              ? t('insights.noCompletedTasksYet')
              : t('insights.ofNeededOneRun', { round: Math.round(s.first_pass_rate * s.first_pass_of), first_pass_of: s.first_pass_of })
          }
        />
        <StatTile
          label={t('insights.onTime')}
          value={formatRate(s.on_time_rate)}
          sub={t('insights.ofWithADueDate', { on_time_of: s.on_time_of })}
        />
      </div>

      <Panel
        title={t('insights.needsYourAttention')}
        hint={t('insights.agentsStopAtNeedsReview')}
      >
        <AttentionList items={data.attention} />
      </Panel>

      {/* Full width: a year is 53 columns. It answers "when", the frame for the
          "who" and "what" panels below, and follows the same window filter. */}
      <ActivityCalendar window={window} windowLabel={windowLabel} />

      <div style={GRID_TWO_COL}>
        <Panel
          title={t('insights.whoYourWorkIsFor')}
          hint={t('insights.tasksPerStakeholderASingle')}
        >
          <BarList
            rows={data.by_stakeholder}
            coloring={{ mode: 'emphasis', lead: EMPHASIS.lead, rest: EMPHASIS.rest }}
            emptyMessage={t('insights.noTasksReferenceAStakeholder')}
            showShare
          />
        </Panel>

        <Panel
          title={t('insights.whatYouProduce')}
          hint={t('insights.tasksPerOutputTemplateNot')}
        >
          <BarList
            rows={data.by_output}
            coloring={{ mode: 'single', color: SERIES.completed }}
            emptyMessage={t('insights.noDeliverablesReferenceAnOutput')}
          />
        </Panel>
      </div>

      <div style={GRID_TWO_COL}>
        <Panel
          title={t('insights.reworkWatchlist')}
          hint={t('insights.tasksAnAgentHadTo')}
        >
          <BarList
            rows={data.rework}
            coloring={{ mode: 'ramp', step: (i, n) => rampStep(n - 1 - i, n) }}
            emptyMessage={t('insights.everyTaskWasDoneIn')}
            unit="runs"
          />
        </Panel>

        <Panel
          title={t('insights.lessonsCaptured')}
          hint={t('insights.kaizenEntriesByAreaThe')}
        >
          <BarList
            rows={data.kaizen}
            coloring={{ mode: 'single', color: SERIES.completed }}
            emptyMessage={t('insights.noKaizenEntriesYet')}
          />
        </Panel>
      </div>

      <div style={GRID_TWO_COL}>
        <Panel
          title={t('insights.createdVsCompleted')}
          hint={t('insights.perWeekCreatedRunningAhead')}
        >
          <FlowChart data={data.weekly} />
        </Panel>

        <Panel
          title={t('insights.turnaroundDistribution')}
          hint={
            s.median_review_hours === null
              ? t('insights.fromWritingATaskTo')
              : t('insights.fromWritingATaskTo2', { median_review_hours: formatHours(
                  s.median_review_hours,
                ) })
          }
        >
          <TurnaroundChart data={data.turnaround_buckets} />
        </Panel>
      </div>
    </Page>
  );
}
