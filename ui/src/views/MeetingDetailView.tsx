import React, { useCallback, useState } from 'react';
import ReactDOM from 'react-dom';
import { Link, useNavigate, useOutletContext, useParams } from 'react-router-dom';
import Badge from '@/components/common/Badge';
import Button from '@/components/common/Button';
import EmptyState from '@/components/common/EmptyState';
import IconButton, { icons } from '@/components/common/IconButton';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import Notice from '@/components/common/Notice';
import { Checkbox, Select } from '@/components/common/Input';
import { Tabs } from '@/components/common/Tabs';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { MeetingRecordCard } from '@/components/context-updates/UpdateDetail';
import { MeetingText } from '@/components/meetings/MeetingText';
import { QueuedMeetingActions, recordingElsewhere } from '@/components/meetings/QueuedMeetingActions';
import { useRecorder } from '@/components/recording/RecordingProvider';
import { useDialogFocus } from '@/hooks/useDialogFocus';
import { useApi } from '@/hooks/useApi';
import { useNotify } from '@/hooks/useNotify';
import { useAppDispatch, useDataVersion } from '@/store';
import { apiDelete, apiGet, apiPost, apiPut } from '@/utils/api';
import { historyProcessing, historyReview, queueProcessing, type RowStatus, type StatusTone } from '@/utils/meetingHistory';
import { meetingActionDraft } from '@/utils/meetingAction';
import { joinNames } from '@/utils/meetingParticipants';
import { meetingPeriod } from '@/utils/meetingQueue';
import { transcriptOnItsWay } from '@/utils/transcriptReading';
import type { MeetingDetail, MeetingDigest, MeetingRecord, QueuedMeeting, Stakeholder } from '@/types';

/** What the Meetings page hands its dialog: the queue it already has, and System cleanup's Meetings settings. */
export interface MeetingsOutlet {
  job: MeetingDigest | null;
  retention: { keep_text: boolean | null; enabled: boolean; days: number; action: string } | null;
  onChanged: () => void;
}

type MeetingTab = 'transcript' | 'record' | 'tasks' | 'files';
const BADGE: Record<StatusTone, string> = { critical: 'error', info: 'info', warning: 'warning', accent: 'accent-subtle', muted: 'muted', success: 'success' };
const TEXT = /\.(vtt|txt|md|docx)$/i;
/** A recording of a meeting, to play: the server sends only audio files of that meeting. */
const audioUrl = (meeting: string, file: string) => `/api/meetings/${encodeURIComponent(meeting)}/audio/${encodeURIComponent(file)}`;
const day = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) : '');
const longDate = (date: string) => {
  const [y, m, d] = date.split('-').map(Number);
  return y && m && d ? new Date(y, m - 1, d).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }) : date || 'No date';
};

function StatusBadge({ status }: { status: RowStatus }) {
  return status.tone ? <Badge size="md" variant={BADGE[status.tone]}>{status.label}</Badge> : null;
}

/** One track of steps in the side panel: done, now, or still to come. Status is in words, not only in colour. */
function Steps({ title, steps }: { title: string; steps: { label: string; detail?: React.ReactNode; state: 'done' | 'now' | 'later' }[] }) {
  const mark = { done: '✓', now: '•', later: '' } as const;
  return (
    <section aria-label={title} style={{ marginBottom: 'var(--space-5)' }}>
      <h3 style={{ margin: '0 0 var(--space-2)', fontSize: 'var(--text-xs)', fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--color-text-muted)' }}>{title}</h3>
      <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
        {steps.map((s) => (
          <li key={s.label} style={{ display: 'grid', gridTemplateColumns: '20px 1fr', gap: 'var(--space-2)', alignItems: 'start' }}>
            <span aria-hidden="true" style={{
              width: 20, height: 20, borderRadius: 'var(--radius-full)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 'var(--text-xs)', fontWeight: 600,
              background: s.state === 'done' ? 'var(--color-success)' : 'var(--color-surface)',
              color: s.state === 'done' ? 'var(--color-text-on-accent)' : s.state === 'now' ? 'var(--color-info)' : 'var(--color-text-muted)',
              border: `2px solid ${s.state === 'done' ? 'var(--color-success)' : s.state === 'now' ? 'var(--color-info)' : 'var(--color-border)'}`,
            }}>{mark[s.state]}</span>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: s.state === 'later' ? 'var(--color-text-muted)' : 'var(--color-text)' }}>
                {s.label}<span className="sr-only">{s.state === 'done' ? ' (done)' : s.state === 'now' ? ' (now)' : ' (to come)'}</span>
              </div>
              {s.detail && <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>{s.detail}</div>}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function Details({ rows }: { rows: [string, React.ReactNode][] }) {
  return (
    <section aria-label="Details">
      <h3 style={{ margin: '0 0 var(--space-2)', fontSize: 'var(--text-xs)', fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--color-text-muted)' }}>Details</h3>
      <dl style={{ display: 'grid', gridTemplateColumns: 'minmax(80px, auto) 1fr', gap: 'var(--space-1) var(--space-3)', margin: 0, fontSize: 'var(--text-sm)' }}>
        {rows.map(([k, v]) => <React.Fragment key={k}><dt style={{ color: 'var(--color-text-muted)' }}>{k}</dt><dd style={{ margin: 0, minWidth: 0 }}>{v}</dd></React.Fragment>)}
      </dl>
    </section>
  );
}

/** The text sources of a meeting to choose from in the Transcript tab, when there are several. */
function SourcePicker({ sources, value, onChange }: { sources: { key: string; label: string }[]; value: string; onChange: (key: string) => void }) {
  if (sources.length < 2) return null;
  return <Select label="File" size="sm" value={value} onChange={onChange} options={sources.map((s) => ({ value: s.key, label: s.label }))} />;
}

/** A meeting, opened from the Meetings list: like a task, with tabs and a side panel. Read-only, apart from keep and delete. */
export default function MeetingDetailView() {
  const { id = '' } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const outlet = useOutletContext<MeetingsOutlet>();
  const close = useCallback(() => navigate('/meetings'), [navigate]);
  const panelRef = useDialogFocus(true, close, true);
  const queued = outlet.job?.queue.find((m) => m.id === id) ?? null;

  const frame = (body: React.ReactNode, label: string) => ReactDOM.createPortal(
    <div className="gtd-modal" role="dialog" aria-modal="true" aria-label={label}>
      <div className="gtd-modal__scrim" aria-hidden="true" onClick={close} />
      <div ref={panelRef} tabIndex={-1} className="gtd-modal__panel gtd-modal__panel--detail">{body}</div>
    </div>,
    document.body,
  );

  if (!outlet.job) return frame(<LoadingSpinner text="Loading the meeting…" />, 'Meeting');
  if (queued) return frame(<QueuedMeetingBody meeting={queued} job={outlet.job} onClose={close} onChanged={outlet.onChanged} />, queued.title);
  return <HeldMeetingBody id={id} outlet={outlet} onClose={close} frame={frame} />;
}

function Header({ id, title, statuses, line, actions }: { id: string; title: string; statuses: RowStatus[]; line: string; actions?: React.ReactNode }) {
  return (
    <div className="gtd-modal__header" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 'var(--space-2)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
        <span className="mono" style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', background: 'var(--color-bg)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm)', padding: '1px 6px', flexShrink: 0 }}>{id}</span>
        <span style={{ flex: 1 }} />
        {actions}
      </div>
      {/* Read-only for now: corrections to a meeting will go through review. */}
      <h2 className="gtd-modal__title" style={{ margin: 0, fontSize: 'var(--text-lg)', fontWeight: 600 }}>{title}</h2>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
        {statuses.map((s) => <StatusBadge key={s.label} status={s} />)}
        <span style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)' }}>{line}</span>
      </div>
    </div>
  );
}

function Body({ tab, setTab, counts, main, aside }: { tab: MeetingTab; setTab: (t: MeetingTab) => void; counts: Partial<Record<MeetingTab, number>>; main: React.ReactNode; aside: React.ReactNode }) {
  const items: { id: MeetingTab; label: string; count?: number }[] = [
    { id: 'transcript', label: 'Transcript' },
    { id: 'record', label: 'Record' },
    { id: 'tasks', label: 'Tasks', ...(counts.tasks ? { count: counts.tasks } : {}) },
    { id: 'files', label: 'Files', ...(counts.files ? { count: counts.files } : {}) },
  ];
  return (
    <>
      <Tabs label="Meeting sections" value={tab} onChange={setTab} idPrefix="meeting" items={items} style={{ padding: '0 var(--space-5)', flexShrink: 0 }} />
      <div id="meeting-panel" role="tabpanel" aria-labelledby={`meeting-tab-${tab}`} style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column', padding: 'var(--space-5)' }}>
        <div className="gtd-detail">
          <div className="gtd-detail__main">{main}</div>
          <aside className="gtd-detail__aside" aria-label="Where this meeting stands">{aside}</aside>
        </div>
      </div>
    </>
  );
}

// ---- a meeting still in the queue ------------------------------------------------------------------------------

function QueuedMeetingBody({ meeting: m, job, onClose, onChanged }: { meeting: QueuedMeeting; job: MeetingDigest; onClose: () => void; onChanged: () => void }) {
  const recorder = useRecorder();
  const [tab, setTab] = useState<MeetingTab>('transcript');
  const processing = queueProcessing(m, {
    installed: job.installed_models ?? null, runnable: job.runnable_models ?? {}, progress: job.transcription ?? null,
    nextDigest: job.next_run_at && !job.open_digest ? new Date(job.next_run_at).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : null,
    recordingNow: (q) => (recorder.active && recorder.meetingId === q.id) || recordingElsewhere(q),
  });
  // What can be read: each recording's transcript (or its live draft), and transcripts or notes added as files.
  const sources = m.files.flatMap((f): { key: string; label: string; url: string; names: Record<string, string>; audio?: { url: string; label: string } }[] => {
    const r = f.recording;
    // The recording is in the queue until its digest takes it, so it can always be played with its transcript.
    const audio = { url: audioUrl(m.id, f.name), label: `Recording ${f.name}` };
    if (r?.transcript && r.transcript_sha256) {
      const names = r.speaker_names && r.speaker_names.transcript_sha256 === r.transcript_sha256 ? r.speaker_names.names : [];
      return [{ key: f.name, label: `${f.name}, transcript`, url: `/api/meeting-queue/${m.id}/transcripts/${encodeURIComponent(r.transcript)}`, names: Object.fromEntries(names.map((n) => [n.label, n.name])), audio }];
    }
    if (r?.draft) return [{ key: f.name, label: `${f.name}, live transcript`, url: `/api/meeting-queue/${m.id}/transcripts/${encodeURIComponent(r.draft.transcript)}`, names: {}, audio }];
    if (!r && TEXT.test(f.name) && !m.files.some((o) => o.recording?.transcript === f.name || o.recording?.draft?.transcript === f.name)) {
      return [{ key: f.name, label: f.name, url: `/api/meetings/${m.id}/text/${encodeURIComponent(f.name)}`, names: {} }];
    }
    return [];
  });
  const [picked, setPicked] = useState<string>('');
  const shown = sources.find((s) => s.key === picked) ?? sources[0];
  const recorded = m.files.some((f) => f.recording);
  const transcribed = m.files.filter((f) => f.recording).every((f) => f.recording!.status === 'done' || (f.recording!.status === 'partial' && f.recording!.accepted));
  const period = meetingPeriod(m);

  const main = tab === 'transcript' ? (
    <div className="gtd-stack" style={{ gap: 'var(--space-3)' }}>
      <SourcePicker sources={sources} value={shown?.key ?? ''} onChange={setPicked} />
      {shown ? <MeetingText key={shown.url} url={shown.url} names={shown.names} {...(shown.audio ? { audio: shown.audio } : {})} />
        : transcriptOnItsWay(m) ? <LoadingSpinner text="The transcript appears here when transcription finishes." />
          : <EmptyState size="compact" title="Nothing to read yet" description="This meeting has no transcript or notes that can be shown here. Its files are in the Files tab." action={{ label: 'Show the files', onClick: () => setTab('files') }} />}
    </div>
  ) : tab === 'record' ? (
    <EmptyState size="compact" title="No record yet" description="When its digest is analyzed, your AI tool drafts a record of this meeting: decisions, open questions and action items. You confirm it in Context > Updates." />
  ) : tab === 'tasks' ? (
    <EmptyState size="compact" title="No tasks from this meeting yet" description="Tasks come from the action items of its confirmed record, after the digest is reviewed." />
  ) : (
    <QueuedMeetingActions meeting={m} job={job} onChanged={onChanged} onRemoved={() => { onChanged(); onClose(); }}
      onRead={(file) => { setPicked(file); setTab('transcript'); }} />
  );

  const aside = (
    <>
      <Steps title="Processing" steps={[
        { label: recorded ? 'Recorded' : 'Added', detail: `${longDate(m.meeting_date)}${period ? `, ${period}` : ''}`, state: m.live ? 'now' : 'done' },
        ...(recorded ? [{ label: 'Transcribed', detail: transcribed ? undefined : processing.label, state: transcribed ? 'done' as const : 'now' as const }] : []),
        { label: m.in_digest ? 'Going into a digest' : 'Waits for the digest', detail: processing.detail, state: !transcribed || m.live ? 'later' as const : 'now' as const },
      ]} />
      <Steps title="Review" steps={[
        { label: 'Analyzed', state: 'later' },
        { label: 'Record confirmed', state: 'later' },
        { label: 'Context updated', state: 'later' },
      ]} />
      <Details rows={[
        ['Date', longDate(m.meeting_date)],
        ['Source', recorded ? 'Recorded' : 'Uploaded files'],
        ...(m.participants?.length ? [['Expected', joinNames(m.participants)] as [string, React.ReactNode]] : []),
      ]} />
    </>
  );

  return (
    <>
      <Header id={m.id} title={m.title} statuses={[processing]} line={`${longDate(m.meeting_date)}${period ? ` · ${period}` : ''}${m.participants?.length ? ` · ${joinNames(m.participants)}` : ''}`}
        actions={<IconButton label="Close meeting" icon={icons.close} onClick={onClose} />} />
      <Body tab={tab} setTab={setTab} counts={{ files: m.files.length }} main={main} aside={aside} />
    </>
  );
}

// ---- a meeting held by a context update ------------------------------------------------------------------------

function HeldMeetingBody({ id, outlet, onClose, frame }: { id: string; outlet: MeetingsOutlet; onClose: () => void; frame: (body: React.ReactNode, label: string) => React.ReactNode }) {
  const confirm = useConfirm();
  const notify = useNotify();
  const dispatch = useAppDispatch();
  const updatesVersion = useDataVersion('context-updates');
  const { data, error, refetch } = useApi<MeetingDetail>(`/api/meetings/${encodeURIComponent(id)}`, [updatesVersion]);
  const [tab, setTab] = useState<MeetingTab>('transcript');
  const [picked, setPicked] = useState('');
  const [busy, setBusy] = useState(false);

  if (error && !data) {
    const message = (() => { try { return (JSON.parse(error) as { message?: string }).message ?? error; } catch { return error; } })();
    return <>{frame(
      <div style={{ padding: 'var(--space-6)' }}>
        <EmptyState title="Meeting not found" description={`${message} It may have been removed with its update. Go back to the list to see the others.`} action={{ label: 'Back to the meetings', onClick: onClose }} />
      </div>, 'Meeting not found')}</>;
  }
  if (!data) return <>{frame(<LoadingSpinner text="Loading the meeting…" />, 'Meeting')}</>;

  const { meeting: h, record, update_records: unlinked, sources } = data;
  const changed = () => { refetch(); outlet.onChanged(); };
  const run = async (fn: () => Promise<void>, done: string, failed: string) => {
    setBusy(true);
    try { await fn(); notify.success(done); changed(); } catch (err) { notify.error(err, failed); } finally { setBusy(false); }
  };
  const done = h.update.status === 'done';
  const canDelete = done && h.has_text && !h.deleted;
  const readable = sources.filter((s) => s.readable && s.present);
  const shown = readable.find((s) => s.file === picked) ?? readable[0];
  const firstMissing = sources.find((s) => s.readable && !s.present) ?? sources.find((s) => !s.present);
  const items = record?.action_items ?? [];
  const canCreate = record?.confirmation === 'confirmed' && done;
  const createTask = async (r: MeetingRecord, item: number) => {
    const ownerRef = r.action_items[item]?.owner;
    let owner: Stakeholder | undefined;
    if (ownerRef?.ref && ownerRef.ref !== 'me' && ownerRef.ref_found) owner = await apiGet<Stakeholder>(`/api/stakeholders/${ownerRef.ref}`).catch(() => undefined);
    // The same conversion as in Context > Updates: a draft task the user checks before creating it.
    dispatch({ type: 'OPEN_NEW_TASK_DRAFT', payload: meetingActionDraft({ id: h.update_id }, r, item, owner) });
  };
  const keptUntil = (() => {
    const r = outlet.retention;
    if (!done || !h.has_text || h.kept || !r?.keep_text || !r.enabled || !h.retention_start) return null;
    const [y, m, d] = h.retention_start.split('-').map(Number);
    return new Date(y!, m! - 1, d! + r.days).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
  })();

  const remove = async () => {
    const ok = await confirm({
      title: `Move "${h.title}" to the trash?`,
      message: `Its transcript and notes go to the trash. You can restore them from the Meetings list until they are deleted for good. Its confirmed record stays in ${h.update_id}, because your context was built from it.`,
      confirmLabel: 'Move to trash', tone: 'danger',
    });
    if (ok) void run(() => apiDelete(`/api/meetings/${h.id}`), `${h.title} is in the trash.`, 'Could not delete the meeting. Try again.');
  };

  const trashNotice = h.deleted && (
    <Notice tone="warning" title={h.deleted.in_trash ? 'This meeting is in the trash.' : 'This meeting\'s text was deleted for good.'}
      action={h.deleted.in_trash ? (
        <span style={{ display: 'inline-flex', gap: 'var(--space-2)' }}>
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => void run(() => apiPost(`/api/meetings/${h.id}/restore`), `${h.title} is back.`, 'Could not restore the meeting. Try again.')}>Restore</Button>
          <Button size="sm" variant="danger" disabled={busy} onClick={async () => {
            if (!(await confirm({ title: `Delete "${h.title}" for good?`, message: 'Its transcript and notes are deleted from this computer. This cannot be undone.', confirmLabel: 'Delete for good', tone: 'danger' }))) return;
            void run(() => apiDelete(`/api/meetings/${h.id}/trash`), `${h.title} is deleted for good.`, 'Could not delete the meeting. Try again.');
          }}>Delete for good</Button>
        </span>
      ) : undefined}>
      {h.deleted.by === 'system-cleanup' ? 'System cleanup' : 'You'} deleted it on {day(h.deleted.at)}. Its record stays in {h.update_id}.
    </Notice>
  );

  const main = (
    <div className="gtd-stack" style={{ gap: 'var(--space-3)' }}>
      {trashNotice}
      {tab === 'transcript' && (shown ? (
        <>
          <SourcePicker sources={readable.map((s) => ({ key: s.file, label: s.kind === 'recording' ? `${s.name}, transcript` : s.name }))} value={shown.file} onChange={setPicked} />
          <MeetingText key={shown.file} url={`/api/meetings/${encodeURIComponent(h.id)}/text/${encodeURIComponent(shown.file)}`}
            {...(shown.playable ? { audio: { url: audioUrl(h.id, shown.file), label: `Recording ${shown.name}` } } : {})} />
          {shown.kind === 'recording' && !shown.playable && (
            <p style={{ margin: 0, fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
              Only the transcript of this recording is kept, so it cannot be played. Recordings are kept when Keep recordings is on in Settings &gt; Transcription.
            </p>
          )}
        </>
      ) : (
        <>
          {!h.deleted && firstMissing?.missing && (
            <Notice tone="warning" title="The transcript of this meeting is no longer here.">
              {firstMissing.missing}{record ? ' Its record is still here, in the Record tab.' : ''}
            </Notice>
          )}
          <EmptyState size="compact" title="No transcript"
            description={h.deleted ? 'Restore the meeting to read it again.' : 'If you still have the transcript, add it again in Context > Updates. It goes through review like any other import.'}
            {...(record ? { action: { label: 'Read the record', onClick: () => setTab('record') } } : {})} />
        </>
      ))}
      {tab === 'record' && (
        record ? (
          <>
            {h.review_state === 'provisional' && (
              <Notice tone="info" title="Provisional: this record is still under review."
                action={h.update.status === 'in_review' ? <Link to={`/context/updates/${h.update_id}`} className="gtd-btn gtd-btn--secondary gtd-btn--sm">Review it</Link> : undefined}>
                {h.update.status === 'in_review' ? `Confirm or reject it with the rest of ${h.update_id}.` : `It becomes final when ${h.update_id} is done.`} Until then it can still change.
              </Notice>
            )}
            <MeetingRecordCard record={record} reviewing={false} confirmation={record.confirmation}
              onChoose={() => {}} onSpeaker={() => {}} {...(canCreate ? { onCreateTask: (item: number) => void createTask(record, item) } : {})} />
            <p style={{ margin: 0, fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
              From <Link to={`/context/updates/${h.update_id}`} className="gtd-link">{h.update_id}</Link>. Tasks come only from a confirmed record, through the same step as in Context &gt; Updates.
            </p>
          </>
        ) : h.record_state === 'ambiguous' ? (
          <Notice tone="info" title="It is not clear which record is this meeting's."
            action={<Link to={`/context/updates/${h.update_id}`} className="gtd-btn gtd-btn--secondary gtd-btn--sm">Open {h.update_id}</Link>}>
            None of this digest's records names this meeting or only its files, so none is shown here as its own. Its records: {unlinked.map((r) => r.title || r.id).join('; ')}.
          </Notice>
        ) : (
          <EmptyState size="compact" title="No record yet"
            description={done ? 'This meeting was reviewed without a record.' : 'When its update is analyzed, your AI tool drafts a record of this meeting. You confirm it in Context > Updates.'} />
        )
      )}
      {tab === 'tasks' && (items.length ? (
        <ul aria-label="Action items" className="gtd-list" style={{ border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)' }}>
          {items.map((a, i) => (
            <li key={i} className="gtd-list__row" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-2)', fontSize: 'var(--text-sm)' }}>
              <span style={{ flex: '1 1 240px', minWidth: 0 }}>{a.description}{a.owner ? <span style={{ color: 'var(--color-text-muted)' }}> · {a.owner.name}</span> : null}{a.due_date ? <span style={{ color: 'var(--color-text-muted)' }}> · by {a.due_date}</span> : null}</span>
              {a.task_ref ? (a.task_found === false ? <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>{a.task_ref} (no longer exists)</span>
                : <Link to={`/board/task/${a.task_ref}`} className="gtd-link mono" style={{ fontSize: 'var(--text-xs)' }}>{a.task_ref}</Link>)
                : canCreate ? <Button size="sm" variant="secondary" onClick={() => void createTask(record!, i)}>Create task</Button>
                  : <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>{record?.confirmation === 'confirmed' ? 'After the review is done' : 'Once the record is confirmed'}</span>}
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState size="compact" title="No tasks from this meeting" description={record ? 'Its record has no action items.' : 'Tasks come from the action items of its confirmed record.'} />
      ))}
      {tab === 'files' && (
        <ul aria-label="Files of this meeting" className="gtd-list" style={{ border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)' }}>
          {sources.map((s) => (
            <li key={s.file} className="gtd-list__row" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-2)', fontSize: 'var(--text-sm)' }}>
              <span className="mono truncate" style={{ flex: '1 1 200px', minWidth: 0 }}>{s.name}</span>
              <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>{{ transcript: 'Transcript', recording: 'Recording', notes: 'Notes', file: 'File' }[s.kind]}</span>
              {s.playable && <Button size="sm" variant="secondary" onClick={() => { setPicked(s.file); setTab('transcript'); }}>Play</Button>}
              {s.present && (s.kind !== 'recording' || s.playable)
                ? <a href={`/api/context-updates/${h.update_id}/materials/${encodeURIComponent(s.file)}`} target="_blank" rel="noreferrer" className="gtd-btn gtd-btn--ghost gtd-btn--sm">Open</a>
                : s.present
                  ? <em style={{ flexBasis: '100%', fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>Its audio is not kept. Its transcript is in the Transcript tab.</em>
                  : <em style={{ flexBasis: '100%', fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>{s.missing}</em>}
            </li>
          ))}
          {sources.length === 0 && <li className="gtd-list__row" style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)' }}>No files are recorded for this meeting.</li>}
        </ul>
      )}
    </div>
  );

  const reviewed = h.record?.confirmation;
  const aside = (
    <>
      <Steps title="Processing" steps={h.origin === 'digest' ? [
        { label: h.recorded ? 'Recorded' : 'Added', detail: longDate(h.meeting_date), state: 'done' },
        ...(h.recorded ? [{ label: 'Transcribed', state: 'done' as const }] : []),
        { label: 'In a digest', detail: <><Link to={`/context/updates/${h.update_id}`} className="gtd-link">{h.update_id}</Link>{h.update.created_at ? `, ${day(h.update.created_at)}` : ''}</>, state: 'done' },
      ] : [
        { label: 'Imported as an update', detail: <><Link to={`/context/updates/${h.update_id}`} className="gtd-link">{h.update_id}</Link>{h.update.created_at ? `, ${day(h.update.created_at)}` : ''}</>, state: 'done' },
      ]} />
      <Steps title="Review" steps={[
        { label: 'Analyzed', detail: day(h.update.analyzed_at) || undefined, state: h.update.analyzed_at || h.update.status !== 'ready' && h.update.status !== 'analyzing' ? 'done' : 'now' },
        { label: reviewed === 'rejected' ? 'Record rejected' : 'Record confirmed', detail: h.record?.confirmed_at ? day(h.record.confirmed_at) : !h.record && done ? 'No record of this meeting' : undefined,
          state: reviewed ? 'done' : h.update.status === 'in_review' ? 'now' : done ? 'done' : 'later' },
        { label: done ? (h.update.context_changed ? 'Context updated' : 'No context changes') : 'Context updated', detail: day(h.update.applied_at) || undefined, state: done ? 'done' : 'later' },
      ]} />
      {done && h.has_text && !h.deleted && (
        <section aria-label="Keep" style={{ marginBottom: 'var(--space-5)' }}>
          <Checkbox checked={h.kept} disabled={busy} label="Keep this meeting"
            description="System cleanup never moves it to the trash. You can still delete it yourself."
            onChange={(keep) => void run(() => apiPut(`/api/meetings/${h.id}/keep`, { keep }).then(() => undefined), keep ? 'System cleanup will keep this meeting.' : 'System cleanup may remove this meeting again.', 'Could not change this. Try again.')} />
        </section>
      )}
      <Details rows={[
        ['Date', longDate(h.meeting_date)],
        ['Source', h.origin === 'update' ? 'Imported as an update' : h.recorded ? 'Recorded' : 'Uploaded files'],
        ['Update', <Link key="u" to={`/context/updates/${h.update_id}`} className="gtd-link">{h.update_id}</Link>],
        ...(keptUntil ? [['Kept until', keptUntil] as [string, React.ReactNode]] : []),
      ]} />
    </>
  );

  return <>{frame(
    <>
      <Header id={h.id} title={h.title} statuses={[historyProcessing(h), historyReview(h)]}
        line={`${longDate(h.meeting_date)}${h.people.length ? ` · ${h.people.join(', ')}` : ''}`}
        actions={<>
          {canDelete && <IconButton label="Delete meeting" icon={icons.trash} tone="danger" outline disabled={busy} onClick={() => void remove()} />}
          <IconButton label="Close meeting" icon={icons.close} onClick={onClose} />
        </>} />
      <Body tab={tab} setTab={setTab} counts={{ tasks: items.filter((a) => a.task_ref).length, files: sources.length }} main={main} aside={aside} />
    </>,
    h.title,
  )}</>;
}
