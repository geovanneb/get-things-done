import { useLanguage } from '@/i18n/LanguageProvider';
import { tr } from '@/i18n/current';
import { rich } from '@/i18n/rich';
import React, { useCallback, useEffect, useState } from 'react';
import ReactDOM from 'react-dom';
import { Link, useNavigate, useOutletContext, useParams, useSearchParams } from 'react-router-dom';
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
import MeetingRelatedWork from '@/components/meetings/MeetingRelatedWork';
import { SpeakerNaming } from '@/components/meetings/SpeakerNaming';
import { TranscribeAgainDialog, TranscriptionNotice, VersionsSection } from '@/components/meetings/MeetingVersions';
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
import { readableTranscript, speakerLabelsOf, transcriptOnItsWay } from '@/utils/transcriptReading';
import type { MeetingDetail, MeetingDigest, MeetingRecord, QueuedMeeting, SpeakerName, Stakeholder, VersionSpeakers } from '@/types';

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
/** A file of the meeting as it is, wherever it is kept now: in its own folder or still in its update. */
const fileUrl = (meeting: string, file: string) => `/api/meetings/${encodeURIComponent(meeting)}/files/${encodeURIComponent(file)}`;
const day = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) : '');
const longDate = (date: string) => {
  const [y, m, d] = date.split('-').map(Number);
  return y && m && d ? new Date(y, m - 1, d).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }) : date || tr('meetingHistory.noDate');
};

function StatusBadge({ status }: { status: RowStatus }) {
  return status.tone ? <Badge size="md" variant={BADGE[status.tone]}>{status.label}</Badge> : null;
}

/** One track of steps in the side panel: done, now, or still to come. Status is in words, not only in colour. */
function Steps({ title, steps }: { title: string; steps: { label: string; detail?: React.ReactNode; state: 'done' | 'now' | 'later' }[] }) {
  const mark = { done: '✓', now: '•', later: '' } as const;
  return (
    <section aria-label={title} style={{ marginBottom: 'var(--space-5)' }}>
      <h3 style={{ margin: '0 0 var(--space-2)', fontSize: 'var(--text-base)', fontWeight: 600, color: 'var(--color-text)' }}>{title}</h3>
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
                {s.label}<span className="sr-only">{s.state === 'done' ? tr('meetingDetail.stepDone') : s.state === 'now' ? tr('meetingDetail.stepNow') : tr('meetingDetail.stepNext')}</span>
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
  const { t } = useLanguage();
  return (
    <section aria-label={t('meetingDetail.details')}>
      <h3 style={{ margin: '0 0 var(--space-2)', fontSize: 'var(--text-base)', fontWeight: 600, color: 'var(--color-text)' }}>{t('meetingDetail.details')}</h3>
      <dl style={{ display: 'grid', gridTemplateColumns: 'minmax(80px, auto) 1fr', gap: 'var(--space-1) var(--space-3)', margin: 0, fontSize: 'var(--text-sm)' }}>
        {rows.map(([k, v]) => <React.Fragment key={k}><dt style={{ color: 'var(--color-text-muted)' }}>{k}</dt><dd style={{ margin: 0, minWidth: 0 }}>{v}</dd></React.Fragment>)}
      </dl>
    </section>
  );
}

/** The text sources of a meeting to choose from in the Transcript tab, when there are several. */
function SourcePicker({ sources, value, onChange }: { sources: { key: string; label: string }[]; value: string; onChange: (key: string) => void }) {
  const { t } = useLanguage();
  if (sources.length < 2) return null;
  return <Select label={t('queuedMeetingActions.file')} size="sm" value={value} onChange={onChange} options={sources.map((s) => ({ value: s.key, label: s.label }))} />;
}

/** A meeting, opened from the Meetings list: like a task, with tabs and a side panel. Read-only, apart from keep and delete. */
export default function MeetingDetailView() {
  const { t } = useLanguage();
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

  if (!outlet.job) return frame(<LoadingSpinner text={t('meetingDetail.loadingTheMeeting')} />, t('importUpdateModal.meeting'));
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
      {/* Read-only: a correction of the record goes through review, as a context update. */}
      <h2 className="gtd-modal__title" style={{ margin: 0, fontSize: 'var(--text-lg)', fontWeight: 600 }}>{title}</h2>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
        {statuses.map((s) => <StatusBadge key={s.label} status={s} />)}
        <span style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)' }}>{line}</span>
      </div>
    </div>
  );
}

function Body({ tab, setTab, counts, main, aside }: { tab: MeetingTab; setTab: (t: MeetingTab) => void; counts: Partial<Record<MeetingTab, number>>; main: React.ReactNode; aside: React.ReactNode }) {
  const { t } = useLanguage();
  const items: { id: MeetingTab; label: string; count?: number }[] = [
    { id: 'transcript', label: t('transcriptReader.transcript') },
    { id: 'record', label: t('record') },
    { id: 'tasks', label: t('tasks'), ...(counts.tasks ? { count: counts.tasks } : {}) },
    { id: 'files', label: t('newTaskModal.files'), ...(counts.files ? { count: counts.files } : {}) },
  ];
  return (
    <>
      <Tabs label={t('meetingDetail.meetingSections')} value={tab} onChange={setTab} idPrefix="meeting" items={items} style={{ padding: '0 var(--space-5)', flexShrink: 0 }} />
      <div id="meeting-panel" role="tabpanel" aria-labelledby={`meeting-tab-${tab}`} style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column', padding: 'var(--space-5)' }}>
        <div className="gtd-detail">
          <div className="gtd-detail__main">{main}</div>
          <aside className="gtd-detail__aside" aria-label={t('meetingDetail.whereThisMeetingStands')}>{aside}</aside>
        </div>
      </div>
    </>
  );
}

// ---- a meeting still in the queue ------------------------------------------------------------------------------

function QueuedMeetingBody({ meeting: m, job, onClose, onChanged }: { meeting: QueuedMeeting; job: MeetingDigest; onClose: () => void; onChanged: () => void }) {
  const { t } = useLanguage();
  const recorder = useRecorder();
  const [tab, setTab] = useState<MeetingTab>('transcript');
  const processing = queueProcessing(m, {
    installed: job.installed_models ?? null, runnable: job.runnable_models ?? {}, progress: job.transcription ?? null,
    nextDigest: job.next_run_at && !job.open_digest ? new Date(job.next_run_at).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : null,
    recordingNow: (q) => (recorder.active && recorder.meetingId === q.id) || recordingElsewhere(q),
  });
  // What can be read: each recording's transcript (or its live draft), and transcripts or notes added as files.
  const sources = m.files.flatMap((f): { key: string; label: string; url: string; text: string; names: Record<string, string>; audio?: { url: string; label: string } }[] => {
    const r = f.recording;
    // The recording is in the queue until its digest takes it, so it can always be played with its transcript.
    const audio = { url: audioUrl(m.id, f.name), label: t('meetingDetail.recording', { name: f.name }) };
    if (r?.transcript && r.transcript_sha256) {
      const names = r.speaker_names && r.speaker_names.transcript_sha256 === r.transcript_sha256 ? r.speaker_names.names : [];
      return [{ key: f.name, label: t('meetingDetail.transcript', { name: f.name }), url: `/api/meeting-queue/${m.id}/transcripts/${encodeURIComponent(r.transcript)}`, text: r.transcript, names: Object.fromEntries(names.map((n) => [n.label, n.name])), audio }];
    }
    if (r?.draft) return [{ key: f.name, label: t('meetingDetail.liveTranscript', { name: f.name }), url: `/api/meeting-queue/${m.id}/transcripts/${encodeURIComponent(r.draft.transcript)}`, text: r.draft.transcript, names: {}, audio }];
    if (!r && TEXT.test(f.name) && !m.files.some((o) => o.recording?.transcript === f.name || o.recording?.draft?.transcript === f.name)) {
      return [{ key: f.name, label: f.name, url: `/api/meetings/${m.id}/text/${encodeURIComponent(f.name)}`, text: f.name, names: {} }];
    }
    return [];
  });
  // Found by a search: open the file it was found in, with the words to find.
  const [params] = useSearchParams();
  const found = params.get('find') ?? '';
  const [picked, setPicked] = useState<string>(() => sources.find((s) => s.text === params.get('file'))?.key ?? '');
  const shown = sources.find((s) => s.key === picked) ?? sources[0];
  const recorded = m.files.some((f) => f.recording);
  const transcribed = m.files.filter((f) => f.recording).every((f) => f.recording!.status === 'done' || (f.recording!.status === 'partial' && f.recording!.accepted));
  const period = meetingPeriod(m);

  // The speakers of the recording's final transcript: named here, with suggestions from remembered voices.
  const readable = shown ? readableTranscript(m, shown.key) : null;
  const speakerLabels = readable?.final ? speakerLabelsOf(m, readable.file, readable.sha256) : [];

  const main = tab === 'transcript' ? (
    <div className="gtd-stack" style={{ gap: 'var(--space-3)' }}>
      <SourcePicker sources={sources} value={shown?.key ?? ''} onChange={setPicked} />
      {readable?.final && speakerLabels.length > 0 && (
        <div>
          <SpeakerNaming source={{ kind: 'queue', meeting: m.id, file: readable.file, transcript_sha256: readable.sha256 }}
            transcriptUrl={shown?.url} {...(shown?.audio ? { audioUrl: shown.audio.url } : {})}
            hint={m.in_digest ? undefined : t('transcriptReader.nameWhoSpokeOrLeave')}
            labels={speakerLabels} names={readable.names} suggestions={readable.suggestions ?? []} rememberable={readable.rememberable ?? []}
            modelSha={readable.modelSha ?? null} participants={m.participants ?? []} editable={!m.in_digest}
            onName={async (label, person) => { await apiPut(`/api/meeting-queue/${m.id}/recordings/${encodeURIComponent(readable.file)}/speakers`, { transcript_sha256: readable.sha256, names: { [label]: person } }); }}
            onChanged={onChanged} />
        </div>
      )}
      {shown ? <MeetingText key={shown.url} url={shown.url} names={shown.names} initialFind={found} {...(shown.audio ? { audio: shown.audio } : {})} />
        : transcriptOnItsWay(m) ? <LoadingSpinner text={t('meetingDetail.theTranscriptAppearsHereWhen')} />
          : <EmptyState size="compact" title={t('meetingDetail.nothingToReadYet')} description={t('meetingDetail.thisMeetingHasNoTranscript')} action={{ label: t('meetingDetail.showTheFiles'), onClick: () => setTab('files') }} />}
    </div>
  ) : tab === 'record' ? (
    <EmptyState size="compact" title={t('meetingDetail.noRecordYet')} description={t('meetingDetail.whenItsDigestIsAnalyzed')} />
  ) : tab === 'tasks' ? (
    <div style={{ overflowY: 'auto' }}>
      <EmptyState size="compact" title={t('meetingDetail.noTasksFromThisMeeting')} description={t('meetingDetail.tasksComeFromTheAction')} />
      <MeetingRelatedWork meetingId={m.id} />
    </div>
  ) : (
    <QueuedMeetingActions meeting={m} job={job} onChanged={onChanged} onRemoved={() => { onChanged(); onClose(); }}
      onRead={(file) => { setPicked(file); setTab('transcript'); }} />
  );

  const aside = (
    <>
      <Steps title={t('meetingsList.processing')} steps={[
        { label: recorded ? t('meetingHistory.recorded') : t('meetingDetail.added'), detail: `${longDate(m.meeting_date)}${period ? `, ${period}` : ''}`, state: m.live ? 'now' : 'done' },
        ...(recorded ? [{ label: t('meetingDetail.transcribed'), detail: transcribed ? undefined : processing.label, state: transcribed ? 'done' as const : 'now' as const }] : []),
        { label: m.in_digest ? t('meetingHistory.goingIntoADigest') : t('meetingDetail.waitsForTheDigest'), detail: processing.detail, state: !transcribed || m.live ? 'later' as const : 'now' as const },
      ]} />
      <Steps title={t('shared.review')} steps={[
        { label: t('analysisRun.analyzed'), state: 'later' },
        { label: t('meetingHistory.recordConfirmed'), state: 'later' },
        { label: t('meetingHistory.contextUpdated'), state: 'later' },
      ]} />
      <Details rows={[
        [t('updateDetail.date'), longDate(m.meeting_date)],
        [t('meetingDetail.source'), recorded ? t('meetingHistory.recorded') : t('meetingHistory.uploadedFiles')],
        ...(m.participants?.length ? [[t('meetingDetail.expected'), joinNames(m.participants)] as [string, React.ReactNode]] : []),
      ]} />
    </>
  );

  return (
    <>
      <Header id={m.id} title={m.title} statuses={[processing]} line={`${longDate(m.meeting_date)}${period ? ` · ${period}` : ''}${m.participants?.length ? ` · ${joinNames(m.participants)}` : ''}`}
        actions={<IconButton label={t('meetingDetail.closeMeeting')} icon={icons.close} onClick={onClose} />} />
      <Body tab={tab} setTab={setTab} counts={{ files: m.files.length }} main={main} aside={aside} />
    </>
  );
}

// ---- a meeting held by a context update ------------------------------------------------------------------------

function HeldMeetingBody({ id, outlet, onClose, frame }: { id: string; outlet: MeetingsOutlet; onClose: () => void; frame: (body: React.ReactNode, label: string) => React.ReactNode }) {
  const { t } = useLanguage();
  const confirm = useConfirm();
  const notify = useNotify();
  const dispatch = useAppDispatch();
  const updatesVersion = useDataVersion('context-updates');
  const { data, error, refetch } = useApi<MeetingDetail>(`/api/meetings/${encodeURIComponent(id)}`, [updatesVersion]);
  const [tab, setTab] = useState<MeetingTab>('transcript');
  // Found by a search: open the file it was found in, with the words to find.
  const [params] = useSearchParams();
  const found = params.get('find') ?? '';
  const [picked, setPicked] = useState(() => params.get('file') ?? '');
  const [busy, setBusy] = useState(false);
  const [again, setAgain] = useState<string | null>(null);
  const navigate = useNavigate();
  // While a Transcribe again waits or runs, look again every few seconds: its progress, and its new version.
  const transcribing = data?.transcription && data.transcription.status !== 'failed';
  useEffect(() => {
    if (!transcribing) return;
    const timer = window.setInterval(refetch, 3000);
    return () => window.clearInterval(timer);
  }, [transcribing, refetch]);

  if (error && !data) {
    const message = (() => { try { return (JSON.parse(error) as { message?: string }).message ?? error; } catch { return error; } })();
    return <>{frame(
      <div style={{ padding: 'var(--space-6)' }}>
        <EmptyState title={t('meetingDetail.meetingNotFound')} description={t('meetingDetail.itMayHaveBeenRemoved', { message })} action={{ label: t('meetingDetail.backToTheMeetings'), onClick: onClose }} />
      </div>, t('meetingDetail.meetingNotFound'))}</>;
  }
  if (!data) return <>{frame(<LoadingSpinner text={t('meetingDetail.loadingTheMeeting')} />, t('importUpdateModal.meeting'))}</>;

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
  // The record shown is the current version: a correction's once one counts. Its files stay with the original update.
  const versions = h.correction;
  const holds = !versions || versions.state === 'original' || versions.state === 'corrected';
  // No task from a disputed record: the versions must hold.
  const canCreate = record?.confirmation === 'confirmed' && done && holds;
  const canCorrect = canCreate && h.review_state === 'final' && holds && !versions?.open.length;
  // The current correction's old values may still be in the context: an update for the AI tool to find them.
  const followUp = async () => {
    setBusy(true);
    try {
      const created = await apiPost<{ id: string }>(`/api/context-updates/${recordOwner}/follow-up`);
      notify.success(t('meetingDetail.openedAnalyzeItToFind', { id: created.id }));
      navigate(`/context/updates/${created.id}`);
    } catch (err) { notify.error(err, t('meetingDetail.couldNotStartAFollow')); } finally { setBusy(false); }
  };
  const suggest = async () => {
    setBusy(true);
    try {
      const started = await apiPost<{ id: string }>(`/api/meetings/${encodeURIComponent(h.id)}/corrections`);
      notify.success(t('meetingDetail.openedAnalyzeItToGet', { id: started.id }));
      navigate(`/context/updates/${started.id}`);
    } catch (err) { notify.error(err, t('meetingDetail.couldNotStartACorrection')); changed(); } finally { setBusy(false); }
  };
  const recordOwner = h.record_owner?.update_id ?? h.update_id;
  const createTask = async (r: MeetingRecord, item: number) => {
    const ownerRef = r.action_items[item]?.owner;
    let owner: Stakeholder | undefined;
    if (ownerRef?.ref && ownerRef.ref !== 'me' && ownerRef.ref_found) owner = await apiGet<Stakeholder>(`/api/stakeholders/${ownerRef.ref}`).catch(() => undefined);
    // The same conversion as in Context > Updates: a draft task the user checks before creating it.
    dispatch({ type: 'OPEN_NEW_TASK_DRAFT', payload: meetingActionDraft({ id: recordOwner }, r, item, owner) });
  };
  const keptUntil = (() => {
    const r = outlet.retention;
    if (!done || !h.has_text || h.kept || !r?.keep_text || !r.enabled || !h.retention_start) return null;
    const [y, m, d] = h.retention_start.split('-').map(Number);
    return new Date(y!, m! - 1, d! + r.days).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
  })();

  const remove = async () => {
    const ok = await confirm({
      title: t('meetingDetail.moveToTheTrash', { title: h.title }),
      message: t('meetingDetail.itsTranscriptAndNotesGo', { update_id: h.update_id }),
      confirmLabel: t('systemCleanup.moveToTrash'), tone: 'danger',
    });
    if (ok) void run(() => apiDelete(`/api/meetings/${h.id}`), t('meetingDetail.isInTheTrash', { title: h.title }), t('meetingDetail.couldNotDeleteTheMeeting'));
  };

  const trashNotice = h.deleted && (
    <Notice tone="warning" title={h.deleted.in_trash ? t('meetingDetail.thisMeetingIsInThe') : t('meetingDetail.thisMeetingSTextWas')}
      action={h.deleted.in_trash ? (
        <span style={{ display: 'inline-flex', gap: 'var(--space-2)' }}>
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => void run(() => apiPost(`/api/meetings/${h.id}/restore`), `${h.title} is back.`, 'Could not restore the meeting. Try again.')}>{t('meetingsList.restore')}</Button>
          <Button size="sm" variant="danger" disabled={busy} onClick={async () => {
            if (!(await confirm({ title: `Delete "${h.title}" for good?`, message: 'Its transcript and notes are deleted from this computer. This cannot be undone.', confirmLabel: 'Delete for good', tone: 'danger' }))) return;
            void run(() => apiDelete(`/api/meetings/${h.id}/trash`), `${h.title} is deleted for good.`, 'Could not delete the meeting. Try again.');
          }}>{t('meetingsList.deleteForGood')}</Button>
        </span>
      ) : undefined}>
      {rich(t, 'meetingDetail.deletedItOnItsRecord', { value: h.deleted.by === 'system-cleanup' ? t('systemCleanup') : t('updateDetail.you2'), day: day(h.deleted.at), update_id: h.update_id })}
    </Notice>
  );

  const modelNames = outlet.job?.model_names ?? {};
  // A Transcribe again version numbers its speakers anew: they are named for that version, apart from the record.
  const current = data.versions.find((v) => v.current);
  const versionSpeakers = shown && current?.speakers && current.speakers.recording === shown.file ? current.speakers : null;
  const main = (
    <div className="gtd-stack" style={{ gap: 'var(--space-3)' }}>
      {trashNotice}
      <TranscriptionNotice detail={data} names={modelNames} busy={busy}
        onStop={() => void run(() => apiDelete(`/api/meetings/${encodeURIComponent(h.id)}/transcriptions`), data.transcription?.status === 'failed' ? 'Dismissed.' : 'Stopped. Nothing of it was kept.', 'Could not stop it. Try again.')} />
      {tab === 'transcript' && (shown ? (
        <>
          <SourcePicker sources={readable.map((s) => ({ key: s.file, label: s.kind === 'recording' ? t('meetingDetail.transcript', { name: s.name }) : s.name }))} value={shown.file} onChange={setPicked} />
          {versionSpeakers && (
            <VersionSpeakersPanel meetingId={h.id} version={current!.id} speakers={versionSpeakers} editable={!h.deleted} onChanged={changed}
              transcriptUrl={`/api/meetings/${encodeURIComponent(h.id)}/text/${encodeURIComponent(shown.file)}`}
              {...(shown.playable ? { audioUrl: audioUrl(h.id, shown.file) } : {})} />
          )}
          <MeetingText key={`${shown.file}:${current?.id ?? ''}`} url={`/api/meetings/${encodeURIComponent(h.id)}/text/${encodeURIComponent(shown.file)}`} initialFind={found}
            names={Object.fromEntries((versionSpeakers?.names ?? []).map((n) => [n.label, n.name]))}
            {...(shown.playable ? { audio: { url: audioUrl(h.id, shown.file), label: t('meetingDetail.recording', { name: shown.name }) } } : {})} />
          {shown.kind === 'recording' && !shown.playable && (
            <p style={{ margin: 0, fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
              {t('meetingDetail.onlyTheTranscriptOfThis')}
            </p>
          )}
        </>
      ) : (
        <>
          {!h.deleted && firstMissing?.missing && (
            <Notice tone="warning" title={t('meetingDetail.theTranscriptOfThisMeeting')}>
              {firstMissing.missing}{record ? t('meetingDetail.itsRecordIsStillHere') : ''}
            </Notice>
          )}
          <EmptyState size="compact" title={t('meetingDetail.noTranscript')}
            description={h.deleted ? t('meetingDetail.restoreTheMeetingToRead') : t('meetingDetail.ifYouStillHaveThe')}
            {...(record ? { action: { label: t('meetingDetail.readTheRecord'), onClick: () => setTab('record') } } : {})} />
        </>
      ))}
      {tab === 'record' && (
        record ? (
          <>
            {h.review_state === 'provisional' && (
              <Notice tone="info" title={t('meetingDetail.provisionalThisRecordIsStill')}
                action={h.update.status === 'in_review' ? <Link to={`/context/updates/${h.update_id}`} className="gtd-btn gtd-btn--secondary gtd-btn--sm">{t('meetingDetail.reviewIt')}</Link> : undefined}>
                {rich(t, 'meetingDetail.untilThenItCanStill', { value: h.update.status === 'in_review' ? t('meetingDetail.confirmOrRejectItWith', { update_id: h.update_id }) : t('meetingDetail.itBecomesFinalWhenIs', { update_id: h.update_id }) })}
              </Notice>
            )}
            {versions && (versions.state === 'conflict' || versions.state === 'broken') ? (
              <Notice tone="warning" title={versions.state === 'conflict' ? t('meetingDetail.twoCorrectionsOfThisRecord') : t('meetingDetail.aVersionOfThisRecord')}
                action={<Link to={`/context/updates/${versions.original.update_id}`} className="gtd-btn gtd-btn--secondary gtd-btn--sm">{t('meetingDetail.openTheOriginal')}</Link>}>
                {versions.state === 'conflict'
                  ? t('meetingDetail.twoCorrectionsWereMadeFrom')
                  : t('meetingDetail.aCorrectionBuildsOnA')}
              </Notice>
            ) : versions?.open.length ? (
              <Notice tone="info" title={t('meetingDetail.aCorrectionOfThisRecord')}
                action={<Link to={`/context/updates/${versions.open[0]}`} className="gtd-btn gtd-btn--secondary gtd-btn--sm">{rich(t, 'meetingDetail.open', { value: versions.open[0] })}</Link>}>
                {t('meetingDetail.theRecordBelowStaysThe')}
              </Notice>
            ) : null}
            {versions?.state === 'corrected' && (
              <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)' }}>
                {t('meetingDetail.corrected')}{versions.head_at ? t('meetingDetail.on', { day: day(versions.head_at) }) : ''} {t('meetingDetail.in')} <Link to={`/context/updates/${recordOwner}`} className="gtd-link">{recordOwner}</Link>.
                {' '}<Link to={`/context/updates/${versions.original.update_id}`} className="gtd-link">{t('meetingDetail.seeTheOriginalRecord')}</Link>.
                {versions.head_changed && <>{' '}<Button size="sm" variant="secondary" disabled={busy} onClick={() => void followUp()}>{t('updateDetail.checkTheContext')}</Button></>}
              </p>
            )}
            <MeetingRecordCard record={record} reviewing={false} confirmation={record.confirmation}
              onChoose={() => {}} onSpeaker={() => {}} {...(canCreate ? { onCreateTask: (item: number) => void createTask(record, item) } : {})} />
            <p style={{ margin: 0, fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
              {rich(t, 'meetingDetail.fromTasksComeOnlyFrom', { link: <Link to={`/context/updates/${recordOwner}`} className="gtd-link">{recordOwner}</Link> })}
            </p>
            {canCorrect && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
                <Button size="sm" variant="secondary" disabled={busy} onClick={() => void suggest()}>{t('meetingDetail.suggestCorrections')}</Button>
                <span style={{ flex: '1 1 240px', fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
                  {t('meetingDetail.aMisheardNameAWrong')}
                </span>
              </div>
            )}
          </>
        ) : versions?.state === 'broken' ? (
          <Notice tone="warning" title={t('meetingDetail.theOriginalRecordOfThis')}
            action={<Link to={`/context/updates/${h.update_id}`} className="gtd-btn gtd-btn--secondary gtd-btn--sm">{rich(t, 'meetingDetail.open2', { update_id: h.update_id })}</Link>}>
            {t('meetingDetail.correctionsOfItAreStill')}
          </Notice>
        ) : h.record_state === 'ambiguous' ? (
          <Notice tone="info" title={t('meetingDetail.itIsNotClearWhich')}
            action={<Link to={`/context/updates/${h.update_id}`} className="gtd-btn gtd-btn--secondary gtd-btn--sm">{rich(t, 'meetingDetail.open2', { update_id: h.update_id })}</Link>}>
            {t('meetingDetail.noneOfThisDigestS')} {unlinked.map((r) => r.title || r.id).join('; ')}.
          </Notice>
        ) : (
          <EmptyState size="compact" title={t('meetingDetail.noRecordYet')}
            description={done ? t('meetingDetail.thisMeetingWasReviewedWithout') : t('meetingDetail.whenItsUpdateIsAnalyzed')} />
        )
      )}
      {tab === 'tasks' && (items.length ? (
        <ul aria-label={t('updateDetail.actionItems')} className="gtd-list" style={{ border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)' }}>
          {items.map((a, i) => (
            <li key={i} className="gtd-list__row" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-2)', fontSize: 'var(--text-sm)' }}>
              <span style={{ flex: '1 1 240px', minWidth: 0 }}>{a.description}{a.owner ? <span style={{ color: 'var(--color-text-muted)' }}> · {a.owner.name}</span> : null}{a.due_date ? <span style={{ color: 'var(--color-text-muted)' }}> {rich(t, 'updateDetail.by', { due_date: a.due_date })}</span> : null}</span>
              {a.task_ref ? (a.task_found === false ? <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>{rich(t, 'meetingDetail.noLongerExists', { task_ref: a.task_ref })}</span>
                : <Link to={`/board/task/${a.task_ref}`} className="gtd-link mono" style={{ fontSize: 'var(--text-xs)' }}>{a.task_ref}</Link>)
                : canCreate ? <Button size="sm" variant="secondary" onClick={() => void createTask(record!, i)}>{t('newTaskModal.createTask')}</Button>
                  : <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>{!holds ? t('meetingDetail.onceItsVersionsAgree') : record?.confirmation === 'confirmed' ? t('meetingDetail.afterTheReviewIsDone') : t('meetingDetail.onceTheRecordIsConfirmed')}</span>}
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState size="compact" title={t('meetingDetail.noTasksFromThisMeeting2')} description={record ? t('meetingDetail.itsRecordHasNoAction') : t('meetingDetail.tasksComeFromTheAction2')} />
      ))}
      {tab === 'tasks' && <MeetingRelatedWork meetingId={h.id} />}
      {tab === 'files' && (
        <ul aria-label={t('queuedMeetingActions.filesOfThisMeeting')} className="gtd-list" style={{ border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)' }}>
          {sources.map((s) => (
            <li key={s.file} className="gtd-list__row" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-2)', fontSize: 'var(--text-sm)' }}>
              <span className="mono truncate" style={{ flex: '1 1 200px', minWidth: 0 }}>{s.name}</span>
              <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>{{ transcript: t('transcriptReader.transcript'), recording: t('queuedMeetingActions.recording'), notes: t('orgChartsPanel.notes'), file: t('queuedMeetingActions.file') }[s.kind]}</span>
              {s.playable && <Button size="sm" variant="secondary" onClick={() => { setPicked(s.file); setTab('transcript'); }}>{t('meetingDetail.play')}</Button>}
              {s.playable && data.versions.length > 0 && !h.deleted && (
                <Button size="sm" variant="ghost" disabled={busy || Boolean(transcribing)} onClick={() => setAgain(s.file)}>{t('meetingDetail.transcribeAgain')}</Button>
              )}
              {s.present && (s.kind !== 'recording' || s.playable)
                ? <a href={fileUrl(h.id, s.file)} target="_blank" rel="noreferrer" className="gtd-btn gtd-btn--ghost gtd-btn--sm">{t('meetingDetail.open3')}</a>
                : s.present
                  ? <em style={{ flexBasis: '100%', fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>{t('meetingDetail.itsAudioIsNotKept')}</em>
                  : <em style={{ flexBasis: '100%', fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>{s.missing}</em>}
            </li>
          ))}
          {sources.length === 0 && <li className="gtd-list__row" style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)' }}>{t('meetingDetail.noFilesAreRecordedFor')}</li>}
        </ul>
      )}
    </div>
  );

  const reviewed = h.record?.confirmation;
  const aside = (
    <>
      <Steps title={t('meetingsList.processing')} steps={h.origin === 'digest' ? [
        { label: h.recorded ? t('meetingHistory.recorded') : t('meetingDetail.added'), detail: longDate(h.meeting_date), state: 'done' },
        ...(h.recorded ? [{ label: t('meetingDetail.transcribed'), state: 'done' as const }] : []),
        { label: t('meetingHistory.inADigest'), detail: <><Link to={`/context/updates/${h.update_id}`} className="gtd-link">{h.update_id}</Link>{h.update.created_at ? `, ${day(h.update.created_at)}` : ''}</>, state: 'done' },
      ] : [
        { label: t('meetingHistory.importedAsAnUpdate'), detail: <><Link to={`/context/updates/${h.update_id}`} className="gtd-link">{h.update_id}</Link>{h.update.created_at ? `, ${day(h.update.created_at)}` : ''}</>, state: 'done' },
      ]} />
      <Steps title={t('shared.review')} steps={[
        { label: t('analysisRun.analyzed'), detail: day(h.update.analyzed_at) || undefined, state: h.update.analyzed_at || h.update.status !== 'ready' && h.update.status !== 'analyzing' ? 'done' : 'now' },
        { label: reviewed === 'rejected' ? t('meetingHistory.recordRejected') : t('meetingHistory.recordConfirmed'), detail: h.record?.confirmed_at ? day(h.record.confirmed_at) : !h.record && done ? t('meetingDetail.noRecordOfThisMeeting') : undefined,
          state: reviewed ? 'done' : h.update.status === 'in_review' ? 'now' : done ? 'done' : 'later' },
        { label: done ? (h.update.context_changed ? t('meetingHistory.contextUpdated') : t('meetingHistory.noContextChanges')) : t('meetingHistory.contextUpdated'), detail: day(h.update.applied_at) || undefined, state: done ? 'done' : 'later' },
      ]} />
      <VersionsSection detail={data} names={modelNames} busy={busy}
        onChoose={(version) => void run(() => apiPut(`/api/meetings/${encodeURIComponent(h.id)}/version`, { version }).then(() => undefined), version === 'v1' ? 'The reviewed transcript is in use again.' : `Version ${version.slice(1)} is in use.`, 'Could not change the version. Try again.')} />
      {done && h.has_text && !h.deleted && (
        <section aria-label={t('meetingDetail.keep')} style={{ marginBottom: 'var(--space-5)' }}>
          <Checkbox checked={h.kept} disabled={busy} label={t('meetingDetail.keepThisMeeting')}
            description={t('meetingDetail.systemCleanupNeverMovesIt')}
            onChange={(keep) => void run(() => apiPut(`/api/meetings/${h.id}/keep`, { keep }).then(() => undefined), keep ? 'System cleanup will keep this meeting.' : 'System cleanup may remove this meeting again.', 'Could not change this. Try again.')} />
        </section>
      )}
      <Details rows={[
        [t('updateDetail.date'), longDate(h.meeting_date)],
        [t('meetingDetail.source'), h.origin === 'update' ? t('meetingHistory.importedAsAnUpdate') : h.recorded ? t('meetingHistory.recorded') : t('meetingHistory.uploadedFiles')],
        [t('updateDetail.update'), <Link key="u" to={`/context/updates/${h.update_id}`} className="gtd-link">{h.update_id}</Link>],
        ...(keptUntil ? [[t('meetingDetail.keptUntil'), keptUntil] as [string, React.ReactNode]] : []),
      ]} />
    </>
  );

  return <>{frame(
    <>
      <Header id={h.id} title={h.title} statuses={[historyProcessing(h), historyReview(h)]}
        line={`${longDate(h.meeting_date)}${h.people.length ? ` · ${h.people.join(', ')}` : ''}`}
        actions={<>
          {canDelete && <IconButton label={t('meetingDetail.deleteMeeting')} icon={icons.trash} tone="danger" outline disabled={busy} onClick={() => void remove()} />}
          <IconButton label={t('meetingDetail.closeMeeting')} icon={icons.close} onClick={onClose} />
        </>} />
      <Body tab={tab} setTab={setTab} counts={{ tasks: items.filter((a) => a.task_ref).length, files: sources.length }} main={main} aside={aside} />
      <TranscribeAgainDialog key={again ?? ''} file={again} job={outlet.job} onClose={() => setAgain(null)}
        onStart={async (file, model) => {
          try {
            await apiPost(`/api/meetings/${encodeURIComponent(h.id)}/transcriptions`, { file, model });
            notify.success('It will be transcribed again. The reviewed transcript stays in use until you choose the new one.');
            changed();
          } catch (err) { notify.error(err, 'Could not start the transcription. Try again.'); throw err; }
        }} />
    </>,
    h.title,
  )}</>;
}

/**
 * The speakers of a Transcribe again version: named here for this version's transcript (the meeting's record keeps the
 * names it was reviewed with), with suggestions from remembered voices.
 */
function VersionSpeakersPanel({ meetingId, version, speakers, editable, onChanged, transcriptUrl, audioUrl: clipUrl }: {
  meetingId: string; version: string; speakers: VersionSpeakers; editable: boolean; onChanged: () => void; transcriptUrl: string; audioUrl?: string;
}) {
  const { t } = useLanguage();
  if (!speakers.labels.length) return null;
  const name = async (label: string, person: Omit<SpeakerName, 'label'> | null) => {
    await apiPut(`/api/meetings/${encodeURIComponent(meetingId)}/versions/${version}/speakers`, { transcript_sha256: speakers.transcript_sha256, names: { [label]: person } });
  };
  return (
    <div>
      <SpeakerNaming source={{ kind: 'folder', meeting: meetingId, version, transcript_sha256: speakers.transcript_sha256 }}
        transcriptUrl={transcriptUrl} {...(clipUrl ? { audioUrl: clipUrl } : {})}
        hint={t('meetingDetail.speakersOfNumberedAnewBy', { version })}
        labels={speakers.labels.map((l) => l.label)} names={speakers.names} suggestions={speakers.suggestions}
        rememberable={speakers.audio_kept ? speakers.labels.filter((l) => l.can_remember).map((l) => l.label) : []}
        modelSha={speakers.model_sha256} editable={editable} onName={name} onChanged={onChanged} />
    </div>
  );
}
