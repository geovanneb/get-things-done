import { useLanguage } from '@/i18n/LanguageProvider';
import { tr } from '@/i18n/current';
import { rich } from '@/i18n/rich';
import React from 'react';
import { Link } from 'react-router-dom';
import Badge from '@/components/common/Badge';
import Button from '@/components/common/Button';
import Notice from '@/components/common/Notice';
import { sectionLabelStyle } from '@/components/task-form/styles';
import { apiGet, apiPost } from '@/utils/api';
import type { MeetingSourcesCheck, PinnedMeeting } from '@/types';

const REVIEW = (): Record<PinnedMeeting['review'], { label: string; variant: string }> => ({
  final: { label: tr('taskMeetingSources.reviewed'), variant: 'success' },
  provisional: { label: tr('taskMeetingSources.inReview'), variant: 'warning' },
  waiting: { label: tr('taskMeetingSources.notReviewedYet'), variant: 'warning' },
  queued: { label: tr('taskMeetingSources.notReviewedYet'), variant: 'warning' },
});

/**
 * The meetings a task's Objective mentions, as the agent will read them: pinned when the task was saved, so a
 * transcript changed or deleted since is shown, never swapped for newer text. Refresh pins them again as they are now.
 */
export default function TaskMeetingSources({ taskId, refreshKey, pinError = null, onPinned }: { taskId: string; refreshKey: number; pinError?: string | null; onPinned?: () => void }) {
  const { t } = useLanguage();
  const [check, setCheck] = React.useState<MeetingSourcesCheck | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  // Only the latest request may set what is shown: a late answer for another task, or an older check, is dropped.
  const latest = React.useRef(0);

  React.useEffect(() => {
    const request = ++latest.current;
    setCheck(null);
    setError(null);
    setLoading(true);
    // A refresh still running for the task before is no longer this view's: its button must not stay busy.
    setBusy(false);
    apiGet<MeetingSourcesCheck>(`/api/tasks/${taskId}/meeting-sources`)
      .then((c) => { if (request === latest.current) setCheck(c); })
      .catch((err: Error) => { if (request === latest.current) setError(err.message); })
      .finally(() => { if (request === latest.current) setLoading(false); });
    // Leaving the page: no answer may land after it.
    return () => { latest.current++; };
  }, [taskId, refreshKey]);

  const refresh = async () => {
    const request = ++latest.current;
    setBusy(true);
    try {
      const next = await apiPost<MeetingSourcesCheck>(`/api/tasks/${taskId}/meeting-sources/refresh`);
      if (request === latest.current) { setCheck(next); setError(null); onPinned?.(); }
    } catch (err) {
      if (request === latest.current) setError(t('taskMeetingSources.tryRefreshSourcesAgain', { message: (err as Error).message }));
    } finally {
      if (request === latest.current) { setBusy(false); setLoading(false); }
    }
  };
  const meetings = check?.selection?.meetings ?? [];
  const changed = (check?.sources ?? []).filter((s) => s.state !== 'ok');
  const stale = changed.length > 0 || (check?.record_changed.length ?? 0) > 0 || (check?.unpinned.length ?? 0) > 0;

  return (
    <section aria-labelledby={`meeting-sources-${taskId}`} style={{ marginBottom: 'var(--space-6)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', marginBottom: 'var(--space-2)' }}>
        <h3 id={`meeting-sources-${taskId}`} style={sectionLabelStyle}>{t('taskMeetingSources.meetingSources')}</h3>
        <span style={{ flex: 1 }} />
        <Button size="sm" variant={stale ? 'secondary' : 'ghost'} loading={busy} onClick={() => void refresh()}>{t('taskMeetingSources.refreshSources')}</Button>
      </div>
      {loading && !check && !error && <p role="status" style={{ margin: 0, fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>{t('taskMeetingSources.checkingTheMeetings')}</p>}
      {pinError && !error && <Notice tone="warning" title={t('taskMeetingSources.theTaskWasSavedBut')}>{rich(t, 'taskMeetingSources.pressRefreshSourcesToTry', { pinError: pinError })}</Notice>}
      {error && <Notice tone="critical" title={t('taskMeetingSources.couldNotCheckTheMeeting')}>{error}</Notice>}
      {check && (
        <>
          <p style={{ margin: '0 0 var(--space-2)', fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
            {check.selection ? t('taskMeetingSources.theAgentReadsTheseAs', { toLocaleString: new Date(check.selection.at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }), id: check.selection.id }) : t('taskMeetingSources.notPinnedYetSaveThe')}
          </p>
          <ul className="gtd-list" aria-label={t('taskMeetingSources.meetingsThisTaskUses')}>
            {meetings.map((m) => {
              const review = REVIEW()[m.review];
              const bad = changed.filter((s) => s.meeting === m.id);
              return (
                <li key={m.id} className="gtd-list__row" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-2)', paddingLeft: 0, paddingRight: 0 }}>
                  <Link to={`/meetings/${m.id}`} className="gtd-link-strong truncate" style={{ flex: '1 1 200px', minWidth: 0, fontSize: 'var(--text-sm)' }}>{m.title}</Link>
                  <span className="mono" style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>{m.meeting_date}</span>
                  <Badge size="sm" variant={review.variant}>{review.label}</Badge>
                  <span style={{ flexBasis: '100%', fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
                    {m.sources.length === 0 ? t('taskMeetingSources.noTranscriptOrNotesThe') : `${m.sources.length} ${m.sources.length === 1 ? 'file' : 'files'}`}
                    {m.record ? t('taskMeetingSources.record', { value: m.record.confirmation === 'confirmed' ? 'confirmed' : t('taskMeetingSources.notConfirmed') }) : t('taskMeetingSources.noRecord')}
                    {bad.length > 0 && <strong> {rich(t, 'taskMeetingSources.filesSinceLeftOut', { count: bad.length, value: bad.every((b) => b.state === 'missing') ? 'gone' : 'changed' })}</strong>}
                    {check.review_changes.filter((c) => c.meeting === m.id).map((c) => <strong key={c.change}> · {c.change}</strong>)}
                  </span>
                </li>
              );
            })}
          </ul>
          {(check.selection?.problems.length ?? 0) > 0 && (
            <Notice tone="warning" title={t('taskMeetingSources.someMeetingsCouldNotBe')}>{check.selection!.problems.map((p) => `${p.id}: ${p.reason}`).join(' ')}</Notice>
          )}
          {check.unpinned.length > 0 && (
            <Notice tone="info" title={t('taskMeetingSources.mentionedSinceTheLastPin')}>{rich(t, 'taskMeetingSources.saveTheTaskOrRefresh', { join: check.unpinned.join(', ') })}</Notice>
          )}
        </>
      )}
    </section>
  );
}
