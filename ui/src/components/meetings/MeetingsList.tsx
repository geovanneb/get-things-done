import { useLanguage } from '@/i18n/LanguageProvider';
import { rich } from '@/i18n/rich';
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
import { clockLine } from '@/utils/transcriptReading';
import { useAppDispatch } from '@/store';
import type { HistoryMeeting, MeetingDigest, MeetingSearchHit } from '@/types';

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

/**
 * The meetings whose transcripts and notes hold every word of `query`, asked of the server once typing pauses. Null
 * while there is nothing to ask (fewer than two characters) or no answer yet.
 */
function useSaidSearch(query: string): { hits: Map<string, MeetingSearchHit> | null; searching: boolean; error: string | null } {
  const { t } = useLanguage();
  const q = query.trim();
  const [state, setState] = React.useState<{ q: string; hits: Map<string, MeetingSearchHit> | null; error: string | null }>({ q: '', hits: null, error: null });
  React.useEffect(() => {
    if (q.length < 2) return undefined;
    const abort = new AbortController();
    const timer = setTimeout(() => {
      fetch(`/api/meetings/search?q=${encodeURIComponent(q)}`, { signal: abort.signal })
        .then(async (res) => {
          if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { message?: string } | null)?.message ?? t('meetingsList.theSearchFailed', { status: res.status }));
          return res.json() as Promise<{ results: MeetingSearchHit[] }>;
        })
        .then((body) => setState({ q, hits: new Map(body.results.map((h) => [h.id, h])), error: null }))
        .catch((err: Error) => { if (!abort.signal.aborted) setState({ q, hits: null, error: err.message }); });
    }, 300);
    return () => { clearTimeout(timer); abort.abort(); };
  }, [q]);
  const current = q.length >= 2 && state.q === q;
  return { hits: current ? state.hits : null, searching: q.length >= 2 && !current, error: current ? state.error : null };
}

/** `text` with each of `words` marked, ignoring case. */
function Marked({ text, words }: { text: string; words: string[] }) {
  const pattern = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).filter(Boolean).join('|');
  if (!pattern) return <>{text}</>;
  const parts = text.split(new RegExp(`(${pattern})`, 'gi'));
  return <>{parts.map((p, i) => (i % 2 ? <mark key={i} className="gtd-mark">{p}</mark> : <React.Fragment key={i}>{p}</React.Fragment>))}</>;
}

/** Where a meeting was found by what was said: the best place, and how many more. */
function Said({ hit, words }: { hit: MeetingSearchHit; words: string[] }) {
  const { t } = useLanguage();
  const s = hit.snippets[0];
  if (!s) return null;
  const more = hit.places - 1;
  return (
    <div style={{ marginTop: 2, fontSize: 'var(--text-xs)', color: 'var(--color-text-secondary)', overflowWrap: 'anywhere' }}>
      {s.time ? <span className="mono">{clockLine(s.time)} </span> : null}
      {s.speaker ? <strong style={{ fontWeight: 600 }}>{s.speaker}: </strong> : null}
      <Marked text={s.text} words={words} />
      {more > 0 && <span style={{ color: 'var(--color-text-muted)' }}> · {more === 1 ? t('meetingsList.1MorePlace') : t('meetingsList.morePlaces', { more })}</span>}
    </div>
  );
}

function Row({ row, now, selected, onSelect, said, words }: { row: MeetingRow; now: Date; selected: boolean; onSelect: (on: boolean) => void; said?: MeetingSearchHit | undefined; words: string[] }) {
  const { t } = useLanguage();
  const selectable = canMakeDeliverable(row);
  // Found by what was said: open the file it was found in, finding the words of the query that place holds.
  const first = said?.snippets[0];
  const inFirst = first ? words.filter((w) => `${first.speaker ?? ''} ${first.text}`.toLowerCase().includes(w)) : [];
  const href = first && row.href.startsWith('/meetings/') ? `${row.href}?${new URLSearchParams({ find: inFirst.join(' '), file: first.file })}` : row.href;
  return (
    <li className="gtd-list__row" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', columnGap: 'var(--space-4)', rowGap: 'var(--space-2)' }}>
      {/* Every row keeps the same indent, also one that cannot be picked yet (its review is still open). */}
      <span style={{ flex: '0 0 20px' }}>
        {selectable && <Checkbox checked={selected} onChange={onSelect} label={<span className="sr-only">{rich(t, 'meetingsList.select', { title: row.title })}</span>} />}
      </span>
      <span className="mono" style={{ flex: '0 0 64px', fontSize: 'var(--text-xs)', color: 'var(--color-text-secondary)' }}>{whenLabel(row, now)}</span>
      <div style={{ flex: '1 1 220px', minWidth: 0 }}>
        <Link to={href} className="gtd-link-strong truncate" style={{ display: 'block', fontSize: 'var(--text-sm)' }}>{row.title}</Link>
        <div className="truncate" style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
          {row.source}{row.people.length ? ` · ${row.people.join(', ')}` : ''}
          {row.textGone && <em> {t('meetingsList.transcriptNoLongerKept')}</em>}
        </div>
        {said && <Said hit={said} words={words} />}
      </div>
      <Status status={row.processing} label={t('meetingsList.processing')} />
      <Status status={row.review} label={t('shared.review')} />
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
  const { t } = useLanguage();
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
  const said = useSaidSearch(query);
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const found = matchingRows(rows.filter((r) => inFilter(r, filter)), query, new Set(said.hits?.keys() ?? []));
  const urgent = found.filter((r) => r.needsYou);
  const others = found.filter((r) => !r.needsYou);
  const limited = query.trim() || all ? found : [...urgent, ...others.slice(0, SHOWN)];
  const hidden = found.length - limited.length;
  const trash = rows.filter((r) => r.inTrash);
  // A meeting that left the list, or can no longer be used, is no longer picked.
  const picked = selected.flatMap((id) => rows.filter((r) => r.id === id && canMakeDeliverable(r)));
  const select = (id: string, on: boolean) => setSelected((prev) => (on ? [...prev.filter((x) => x !== id), id] : prev.filter((x) => x !== id)));
  const options: { value: MeetingFilter; label: string }[] = [
    { value: 'all', label: t('meetingsList.all', { amount: count('all') }) },
    { value: 'you', label: t('meetingsList.needsYou', { amount: count('you') }) },
    { value: 'progress', label: t('meetingsList.inProgress', { amount: count('progress') }) },
    { value: 'review', label: t('meetingsList.waitingForReview', { amount: count('review') }) },
    { value: 'reviewed', label: t('meetingsList.reviewed', { amount: count('reviewed') }) },
  ];

  const act = async (id: string, fn: () => Promise<string>) => {
    setBusy(id);
    setNotice(null);
    try { setNotice({ text: await fn() }); } catch (err) { setNotice({ text: (err as Error).message, error: true }); } finally { setBusy(null); onChanged(); }
  };

  return (
    <Card title={t('meetings')} padding="none" actions={actions}>
      {error && <div style={{ padding: 'var(--space-4) var(--space-5)' }}><Notice tone="critical" title={t('meetingsList.couldNotLoadTheMeetings')}>{error}</Notice></div>}
      {!job && !history && !error && <LoadingSpinner text={t('meetingsList.loadingMeetings')} />}
      {job && history && (
        <>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-3)', padding: 'var(--space-3) var(--space-5)', borderBottom: '1px solid var(--color-border)' }}>
            <SearchInput value={query} onChange={setQuery} placeholder={t('meetingsList.searchTitlesPeopleOrWhat')} size="sm" width={narrow ? '100%' : 300} />
            {narrow
              ? <Select label={t('meetingsList.show')} size="sm" value={filter} onChange={(v) => setFilter(v as MeetingFilter)} options={options} />
              : <SegmentedControl label={t('meetingsList.show')} value={filter} onChange={setFilter} options={options} />}
          </div>
          {said.error && (
            <div style={{ padding: 'var(--space-3) var(--space-5)' }}>
              <Notice tone="warning" title={t('meetingsList.couldNotSearchWhatWas')}>{rich(t, 'meetingsList.titlesDatesAndPeopleAre', { error: said.error })}</Notice>
            </div>
          )}
          {job.queue_problems.length > 0 && (
            <div style={{ padding: 'var(--space-3) var(--space-5)' }}>
              <Notice tone="critical" title={t('meetingsList.someMeetingsInTheQueue')}>{job.queue_problems.map((p) => `${p.id}: ${p.reason}`).join(' ')}</Notice>
            </div>
          )}
          {rows.filter((r) => !r.inTrash).length === 0 ? (
            <EmptyState size="compact" title={t('meetingsList.noMeetingsYet')}
              description={t('meetingsList.recordAMeetingOrAdd')} />
          ) : found.length === 0 && said.searching ? (
            <LoadingSpinner text={t('meetingsList.searchingWhatWasSaid')} />
          ) : found.length === 0 ? (
            <EmptyState size="compact" title={query ? t('meetingsList.noMeetingMatches', { query }) : t('meetingsList.noMeetingsHere')}
              description={query ? t('meetingsList.tryATitleADate') : t('meetingsList.chooseAnotherFilterToSee')}
              action={query ? { label: t('meetingsList.clearSearch'), onClick: () => setQuery('') } : { label: t('meetingsList.showAllMeetings'), onClick: () => setFilter('all') }} />
          ) : (
            groupRows(limited, now).map((g) => (
              <section key={g.label} aria-label={g.label}>
                <h3 style={{ margin: 0, padding: 'var(--space-2) var(--space-5)', fontSize: 'var(--text-xs)', fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--color-text-muted)', background: 'var(--color-bg)', borderBottom: '1px solid var(--color-border)' }}>{g.label}</h3>
                <ul aria-label={t('meetingsList.meetings', { label: g.label })} className="gtd-list">{g.rows.map((r) => <Row key={r.id} row={r} now={now} selected={selected.includes(r.id)} onSelect={(on) => select(r.id, on)} said={said.hits?.get(r.id)} words={words} />)}</ul>
              </section>
            ))
          )}
          {picked.length > 0 && (
            <div role="region" aria-label={t('meetingsList.selectedMeetings')} style={{ position: 'sticky', bottom: 0, zIndex: 'var(--z-sticky)', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-3)', padding: 'var(--space-3) var(--space-5)', borderTop: '1px solid var(--color-border)', background: 'var(--color-surface)' }}>
              <span style={{ flex: '1 1 auto', fontSize: 'var(--text-sm)' }}>{picked.length === 1 ? t('meetingsList.1MeetingSelected') : t('meetingsList.meetingsSelected', { length: picked.length })}</span>
              <Button size="sm" variant="ghost" onClick={() => setSelected([])}>{t('updateDetail.clear')}</Button>
              <Button size="sm" variant="primary" onClick={() => { dispatch({ type: 'OPEN_NEW_TASK_DRAFT', payload: deliverableDraft(picked) }); setSelected([]); }}>{t('meetingsList.createDeliverable')}</Button>
            </div>
          )}
          {hidden > 0 && <div style={{ padding: 'var(--space-3) var(--space-5)', borderTop: '1px solid var(--color-border)' }}><Button size="sm" variant="ghost" onClick={() => setAll(true)}>{rich(t, 'meetingsList.showOlder', { hidden: hidden })}</Button></div>}
          {trash.length > 0 && (
            <section aria-labelledby="meetings-trash" style={{ borderTop: '1px solid var(--color-border)', padding: 'var(--space-3) var(--space-5)' }}>
              <h3 id="meetings-trash" style={{ margin: 0, fontSize: 'var(--text-sm)', fontWeight: 600 }}>{rich(t, 'meetingsList.inTheTrash', { length: trash.length })}</h3>
              <p style={{ margin: '2px 0 var(--space-2)', fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
                {rich(t, 'meetingsList.theTrashIsNotErasure', { value: retention?.enabled ? t('meetingsList.orSystemCleanupDoes30') : '' })}
              </p>
              <ul aria-label={t('meetingsList.meetingsInTheTrash')} className="gtd-list">
                {trash.map((r) => (
                  <li key={r.id} className="gtd-list__row" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-2)', paddingLeft: 0, paddingRight: 0 }}>
                    <div style={{ flex: '1 1 220px', minWidth: 0 }}>
                      <div className="truncate" style={{ fontSize: 'var(--text-sm)', fontWeight: 600 }}>{r.title}</div>
                      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
                        {rich(t, 'meetingsList.movedToTheTrash', { whenLabel: whenLabel(r, now), value: r.held?.deleted?.at ? new Date(r.held.deleted.at).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) : '', value2: r.held?.deleted?.by === 'system-cleanup' ? t('meetingsList.bySystemCleanup') : '' })}
                      </div>
                    </div>
                    <Button size="sm" variant="secondary" loading={busy === `restore-${r.id}`} disabled={busy !== null}
                      onClick={() => act(`restore-${r.id}`, async () => { await apiPost(`/api/meetings/${r.id}/restore`); return `${r.title} is back.`; })}>{t('meetingsList.restore')}</Button>
                    <Button size="sm" variant="danger" disabled={busy !== null}
                      onClick={async () => {
                        if (!(await confirm({ title: `Delete "${r.title}" for good?`, message: 'Its transcript and notes are deleted from this computer. This cannot be undone. Its confirmed record stays with its update.', confirmLabel: 'Delete for good', tone: 'danger' }))) return;
                        void act(`purge-${r.id}`, async () => { await apiDelete(`/api/meetings/${r.id}/trash`); return `${r.title} is deleted for good.`; });
                      }}>{t('meetingsList.deleteForGood')}</Button>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {notice && <div style={{ padding: '0 var(--space-5) var(--space-3)' }}><Notice tone={notice.error ? 'critical' : 'success'}>{notice.text}</Notice></div>}
          <p style={{ margin: 0, padding: 'var(--space-3) var(--space-5)', borderTop: '1px solid var(--color-border)', fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
            {!retention?.keep_text
              ? t('meetingsList.transcriptsAndNotesAreDeleted')
              : retention.enabled
                ? t('meetingsList.transcriptsAndNotesAreKept', { value: retention.action === 'delete' ? t('meetingsList.deletedForGood') : t('meetingsList.movedToTheTrash2'), days: retention.days })
                : t('meetingsList.transcriptsAndNotesAreKept2')}
          </p>
        </>
      )}
    </Card>
  );
}
