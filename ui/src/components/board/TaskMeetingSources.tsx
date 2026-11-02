import React from 'react';
import { Link } from 'react-router-dom';
import Badge from '@/components/common/Badge';
import Button from '@/components/common/Button';
import Notice from '@/components/common/Notice';
import { sectionLabelStyle } from '@/components/task-form/styles';
import { apiGet, apiPost } from '@/utils/api';
import type { MeetingSourcesCheck, PinnedMeeting } from '@/types';

const REVIEW: Record<PinnedMeeting['review'], { label: string; variant: string }> = {
  final: { label: 'Reviewed', variant: 'success' },
  provisional: { label: 'In review', variant: 'warning' },
  waiting: { label: 'Not reviewed yet', variant: 'warning' },
  queued: { label: 'Not reviewed yet', variant: 'warning' },
};

/**
 * The meetings a task's Objective mentions, as the agent will read them: pinned when the task was saved, so a
 * transcript changed or deleted since is shown, never swapped for newer text. Refresh pins them again as they are now.
 */
export default function TaskMeetingSources({ taskId, refreshKey, pinError = null, onPinned }: { taskId: string; refreshKey: number; pinError?: string | null; onPinned?: () => void }) {
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
      if (request === latest.current) setError(`${(err as Error).message} Try Refresh sources again.`);
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
        <h3 id={`meeting-sources-${taskId}`} style={sectionLabelStyle}>Meeting sources</h3>
        <span style={{ flex: 1 }} />
        <Button size="sm" variant={stale ? 'secondary' : 'ghost'} loading={busy} onClick={() => void refresh()}>Refresh sources</Button>
      </div>
      {loading && !check && !error && <p role="status" style={{ margin: 0, fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>Checking the meetings…</p>}
      {pinError && !error && <Notice tone="warning" title="The task was saved, but its meetings could not be pinned.">{pinError} Press Refresh sources to try again.</Notice>}
      {error && <Notice tone="critical" title="Could not check the meeting sources.">{error}</Notice>}
      {check && (
        <>
          <p style={{ margin: '0 0 var(--space-2)', fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
            {check.selection ? `The agent reads these as they were on ${new Date(check.selection.at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })} (selection ${check.selection.id}). Refresh takes the meetings as they are now; what was made before keeps its selection.` : 'Not pinned yet: save the task, or refresh.'}
          </p>
          <ul className="gtd-list" aria-label="Meetings this task uses">
            {meetings.map((m) => {
              const review = REVIEW[m.review];
              const bad = changed.filter((s) => s.meeting === m.id);
              return (
                <li key={m.id} className="gtd-list__row" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-2)', paddingLeft: 0, paddingRight: 0 }}>
                  <Link to={`/meetings/${m.id}`} className="gtd-link-strong truncate" style={{ flex: '1 1 200px', minWidth: 0, fontSize: 'var(--text-sm)' }}>{m.title}</Link>
                  <span className="mono" style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>{m.meeting_date}</span>
                  <Badge size="sm" variant={review.variant}>{review.label}</Badge>
                  <span style={{ flexBasis: '100%', fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
                    {m.sources.length === 0 ? 'No transcript or notes: the record only.' : `${m.sources.length} ${m.sources.length === 1 ? 'file' : 'files'}`}
                    {m.record ? ` · record ${m.record.confirmation === 'confirmed' ? 'confirmed' : 'not confirmed'}` : ' · no record'}
                    {bad.length > 0 && <strong> · {bad.length} {bad.length === 1 ? 'file' : 'files'} {bad.every((b) => b.state === 'missing') ? 'gone' : 'changed'} since, left out</strong>}
                    {check.review_changes.filter((c) => c.meeting === m.id).map((c) => <strong key={c.change}> · {c.change}</strong>)}
                  </span>
                </li>
              );
            })}
          </ul>
          {(check.selection?.problems.length ?? 0) > 0 && (
            <Notice tone="warning" title="Some meetings could not be used.">{check.selection!.problems.map((p) => `${p.id}: ${p.reason}`).join(' ')}</Notice>
          )}
          {check.unpinned.length > 0 && (
            <Notice tone="info" title="Mentioned since the last pin.">{check.unpinned.join(', ')}: save the task or refresh to pin them.</Notice>
          )}
        </>
      )}
    </section>
  );
}
