import React from 'react';
import { Link } from 'react-router-dom';
import Badge from '@/components/common/Badge';
import Button from '@/components/common/Button';
import Card from '@/components/common/Card';
import EmptyState from '@/components/common/EmptyState';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import Notice from '@/components/common/Notice';
import { Checkbox, SearchInput, Select } from '@/components/common/Input';
import { SegmentedControl } from '@/components/common/Tabs';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { useRecorder } from '@/components/recording/RecordingProvider';
import { recordingElsewhere } from '@/components/meetings/QueuedMeetingActions';
import { apiDelete, apiPost } from '@/utils/api';
import { groupRows, inFilter, matchingRows, meetingRows, whenLabel, type MeetingFilter, type MeetingRow, type RowStatus, type StatusTone } from '@/utils/meetingHistory';
import { canMakeDeliverable, deliverableDraft } from '@/utils/meetingDeliverable';
import { useAppDispatch } from '@/store';
import type { HistoryMeeting, MeetingDigest } from '@/types';

/** How many rows show before "Show older"; what needs the user is always shown. */
const SHOWN = 30;

const BADGE: Record<StatusTone, string> = { critical: 'error', info: 'info', warning: 'warning', accent: 'accent-subtle', muted: 'muted', success: 'success' };

/** True below `px` wide: the filters become a select there, so they never push the page sideways. */
function useNarrow(px: number): boolean {
  const query = `(max-width: ${px}px)`;
  const [narrow, setNarrow] = React.useState(() => window.matchMedia?.(query).matches ?? false);
  React.useEffect(() => {
    const list = window.matchMedia?.(query);
    if (!list) return undefined;
    const on = () => setNarrow(list.matches);
    list.addEventListener('change', on);
    return () => list.removeEventListener('change', on);
  }, [query]);
  return narrow;
}

function Status({ status, label }: { status: RowStatus; label: string }) {
  return (
    <div aria-label={`${label}: ${status.label}${status.detail ? `, ${status.detail}` : ''}`} style={{ flex: '0 0 170px', minWidth: 0, display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 2 }}>
      {status.tone ? <Badge size="sm" variant={BADGE[status.tone]}>{status.label}</Badge> : <span style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)' }}>{status.label}</span>}
      {status.update && <Link to={`/context/updates/${status.update}`} className="gtd-link mono" style={{ fontSize: 'var(--text-xs)' }}>{status.update}</Link>}
      {status.detail && <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>{status.detail}</span>}
    </div>
  );
}

function Row({ row, now, selected, onSelect }: { row: MeetingRow; now: Date; selected: boolean; onSelect: (on: boolean) => void }) {
  const selectable = canMakeDeliverable(row);
  return (
    <li className="gtd-list__row" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', columnGap: 'var(--space-4)', rowGap: 'var(--space-2)' }}>
      {/* Every row keeps the same indent, also one that cannot be picked yet (its review is still open). */}
      <span style={{ flex: '0 0 20px' }}>
        {selectable && <Checkbox checked={selected} onChange={onSelect} label={<span className="sr-only">Select {row.title}</span>} />}
      </span>
      <span className="mono" style={{ flex: '0 0 64px', fontSize: 'var(--text-xs)', color: 'var(--color-text-secondary)' }}>{whenLabel(row, now)}</span>
      <div style={{ flex: '1 1 220px', minWidth: 0 }}>
        <Link to={row.href} className="gtd-link-strong truncate" style={{ display: 'block', fontSize: 'var(--text-sm)' }}>{row.title}</Link>
        <div className="truncate" style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
          {row.source}{row.people.length ? ` · ${row.people.join(', ')}` : ''}
          {row.textGone && <em> · transcript no longer kept</em>}
        </div>
      </div>
      <Status status={row.processing} label="Processing" />
      <Status status={row.review} label="Review" />
    </li>
  );
}

/**
 * Every meeting: the queue and the meetings held by a context update, newest first, each with where its processing and
 * its review stand. A meeting opens in its own dialog (/meetings/<id>). Deleted meetings wait in the trash below.
 */
export function MeetingsList({ job, history, error, retention, actions, onChanged }: {
  job: MeetingDigest | null; history: HistoryMeeting[] | null; error: string | null;
  /** System cleanup's Meetings settings: whether text is kept after review (null until chosen), and the rule. */
  retention: { keep_text: boolean | null; enabled: boolean; days: number; action: string } | null;
  actions?: React.ReactNode; onChanged: () => void;
}) {
  const recorder = useRecorder();
  const confirm = useConfirm();
  const narrow = useNarrow(640);
  const [filter, setFilter] = React.useState<MeetingFilter>('all');
  const [query, setQuery] = React.useState('');
  const [all, setAll] = React.useState(false);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<{ text: string; error?: boolean } | null>(null);
  // Meetings picked for a deliverable, in the order they were picked.
  const [selected, setSelected] = React.useState<string[]>([]);
  const dispatch = useAppDispatch();
  const now = new Date();

  const rows = job && history ? meetingRows(job.queue, history, {
    installed: job.installed_models ?? null, runnable: job.runnable_models ?? {}, progress: job.transcription ?? null,
    nextDigest: job.next_run_at && !job.open_digest ? new Date(job.next_run_at).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : null,
    recordingNow: (m) => (recorder.active && recorder.meetingId === m.id) || recordingElsewhere(m),
  }) : [];
  const count = (f: MeetingFilter) => rows.filter((r) => inFilter(r, f)).length;
  const found = matchingRows(rows.filter((r) => inFilter(r, filter)), query);
  const urgent = found.filter((r) => r.needsYou);
  const others = found.filter((r) => !r.needsYou);
  const limited = query.trim() || all ? found : [...urgent, ...others.slice(0, SHOWN)];
  const hidden = found.length - limited.length;
  const trash = rows.filter((r) => r.inTrash);
  // A meeting that left the list, or can no longer be used, is no longer picked.
  const picked = selected.flatMap((id) => rows.filter((r) => r.id === id && canMakeDeliverable(r)));
  const select = (id: string, on: boolean) => setSelected((prev) => (on ? [...prev.filter((x) => x !== id), id] : prev.filter((x) => x !== id)));
  const options: { value: MeetingFilter; label: string }[] = [
    { value: 'all', label: `All ${count('all')}` },
    { value: 'you', label: `Needs you ${count('you')}` },
    { value: 'progress', label: `In progress ${count('progress')}` },
    { value: 'review', label: `Waiting for review ${count('review')}` },
    { value: 'reviewed', label: `Reviewed ${count('reviewed')}` },
  ];

  const act = async (id: string, fn: () => Promise<string>) => {
    setBusy(id);
    setNotice(null);
    try { setNotice({ text: await fn() }); } catch (err) { setNotice({ text: (err as Error).message, error: true }); } finally { setBusy(null); onChanged(); }
  };

  return (
    <Card title="Meetings" padding="none" actions={actions}>
      {error && <div style={{ padding: 'var(--space-4) var(--space-5)' }}><Notice tone="critical" title="Could not load the meetings.">{error}</Notice></div>}
      {!job && !history && !error && <LoadingSpinner text="Loading meetings…" />}
      {job && history && (
        <>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-3)', padding: 'var(--space-3) var(--space-5)', borderBottom: '1px solid var(--color-border)' }}>
            <SearchInput value={query} onChange={setQuery} placeholder="Search title, date or people" size="sm" width={narrow ? '100%' : 280} />
            {narrow
              ? <Select label="Show" size="sm" value={filter} onChange={(v) => setFilter(v as MeetingFilter)} options={options} />
              : <SegmentedControl label="Show" value={filter} onChange={setFilter} options={options} />}
          </div>
          {job.queue_problems.length > 0 && (
            <div style={{ padding: 'var(--space-3) var(--space-5)' }}>
              <Notice tone="critical" title="Some meetings in the queue cannot be read.">{job.queue_problems.map((p) => `${p.id}: ${p.reason}`).join(' ')}</Notice>
            </div>
          )}
          {rows.filter((r) => !r.inTrash).length === 0 ? (
            <EmptyState size="compact" title="No meetings yet"
              description="Record a meeting, or add a recording or transcript under Context > Updates. Each one stays here after its digest." />
          ) : found.length === 0 ? (
            <EmptyState size="compact" title={query ? `No meeting matches "${query}"` : 'No meetings here'}
              description={query ? 'Try a title, a date or a name.' : 'Choose another filter to see the others.'}
              action={query ? { label: 'Clear search', onClick: () => setQuery('') } : { label: 'Show all meetings', onClick: () => setFilter('all') }} />
          ) : (
            groupRows(limited, now).map((g) => (
              <section key={g.label} aria-label={g.label}>
                <h3 style={{ margin: 0, padding: 'var(--space-2) var(--space-5)', fontSize: 'var(--text-xs)', fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--color-text-muted)', background: 'var(--color-bg)', borderBottom: '1px solid var(--color-border)' }}>{g.label}</h3>
                <ul aria-label={`Meetings, ${g.label}`} className="gtd-list">{g.rows.map((r) => <Row key={r.id} row={r} now={now} selected={selected.includes(r.id)} onSelect={(on) => select(r.id, on)} />)}</ul>
              </section>
            ))
          )}
          {picked.length > 0 && (
            <div role="region" aria-label="Selected meetings" style={{ position: 'sticky', bottom: 0, zIndex: 'var(--z-sticky)', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-3)', padding: 'var(--space-3) var(--space-5)', borderTop: '1px solid var(--color-border)', background: 'var(--color-surface)' }}>
              <span style={{ flex: '1 1 auto', fontSize: 'var(--text-sm)' }}>{picked.length === 1 ? '1 meeting selected' : `${picked.length} meetings selected`}</span>
              <Button size="sm" variant="ghost" onClick={() => setSelected([])}>Clear</Button>
              <Button size="sm" variant="primary" onClick={() => { dispatch({ type: 'OPEN_NEW_TASK_DRAFT', payload: deliverableDraft(picked) }); setSelected([]); }}>Create deliverable</Button>
            </div>
          )}
          {hidden > 0 && <div style={{ padding: 'var(--space-3) var(--space-5)', borderTop: '1px solid var(--color-border)' }}><Button size="sm" variant="ghost" onClick={() => setAll(true)}>Show {hidden} older</Button></div>}
          {trash.length > 0 && (
            <section aria-labelledby="meetings-trash" style={{ borderTop: '1px solid var(--color-border)', padding: 'var(--space-3) var(--space-5)' }}>
              <h3 id="meetings-trash" style={{ margin: 0, fontSize: 'var(--text-sm)', fontWeight: 600 }}>In the trash ({trash.length})</h3>
              <p style={{ margin: '2px 0 var(--space-2)', fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
                The trash is not erasure: deleted meetings wait here, still on this computer, until you delete them for good{retention?.enabled ? ', or System cleanup does 30 days after they were deleted' : ''}. Their confirmed records stay with their update.
              </p>
              <ul aria-label="Meetings in the trash" className="gtd-list">
                {trash.map((r) => (
                  <li key={r.id} className="gtd-list__row" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-2)', paddingLeft: 0, paddingRight: 0 }}>
                    <div style={{ flex: '1 1 220px', minWidth: 0 }}>
                      <div className="truncate" style={{ fontSize: 'var(--text-sm)', fontWeight: 600 }}>{r.title}</div>
                      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
                        {whenLabel(r, now)} · moved to the trash {r.held?.deleted?.at ? new Date(r.held.deleted.at).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) : ''}{r.held?.deleted?.by === 'system-cleanup' ? ' by System cleanup' : ''}
                      </div>
                    </div>
                    <Button size="sm" variant="secondary" loading={busy === `restore-${r.id}`} disabled={busy !== null}
                      onClick={() => act(`restore-${r.id}`, async () => { await apiPost(`/api/meetings/${r.id}/restore`); return `${r.title} is back.`; })}>Restore</Button>
                    <Button size="sm" variant="danger" disabled={busy !== null}
                      onClick={async () => {
                        if (!(await confirm({ title: `Delete "${r.title}" for good?`, message: 'Its transcript and notes are deleted from this computer. This cannot be undone. Its confirmed record stays with its update.', confirmLabel: 'Delete for good', tone: 'danger' }))) return;
                        void act(`purge-${r.id}`, async () => { await apiDelete(`/api/meetings/${r.id}/trash`); return `${r.title} is deleted for good.`; });
                      }}>Delete for good</Button>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {notice && <div style={{ padding: '0 var(--space-5) var(--space-3)' }}><Notice tone={notice.error ? 'critical' : 'success'}>{notice.text}</Notice></div>}
          <p style={{ margin: 0, padding: 'var(--space-3) var(--space-5)', borderTop: '1px solid var(--color-border)', fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
            {!retention?.keep_text
              ? 'Transcripts and notes are deleted when their review is done. Their confirmed records stay. Change this in Routines > System cleanup > Meetings.'
              : retention.enabled
                ? `Transcripts and notes are kept after review, then ${retention.action === 'delete' ? 'deleted for good' : 'moved to the trash'} ${retention.days} days after the meeting (Routines > System cleanup > Meetings).`
                : 'Transcripts and notes are kept after review until you delete them (the Meetings rule in Routines > System cleanup is off).'}
          </p>
        </>
      )}
    </Card>
  );
}
