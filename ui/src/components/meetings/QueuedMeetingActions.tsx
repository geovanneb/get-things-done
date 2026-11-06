import { useLanguage } from '@/i18n/LanguageProvider';
import { tr } from '@/i18n/current';
import { rich } from '@/i18n/rich';
import React from 'react';
import Notice from '@/components/common/Notice';
import { useConfirm } from '@/components/common/ConfirmDialog';
import Button from '@/components/common/Button';
import { useRecorder } from '@/components/recording/RecordingProvider';
import { apiDelete, apiPost } from '@/utils/api';
import { formatRelativeTime } from '@/utils/format';
import type { MeetingDigest, QueuedMeeting, RecordingState, TranscriptionProgress } from '@/types';

function minutes(seconds: number): string {
  if (seconds < 60) return seconds < 1 ? tr('queuedMeetingActions.aMoment') : `${Math.max(1, Math.round(seconds))} s`;
  const m = Math.round(seconds / 60);
  return m < 60 ? tr('queuedMeetingActions.min', { m }) : tr('queuedMeetingActions.hMin', { floor: Math.floor(m / 60), padStart: String(m % 60).padStart(2, '0') });
}

/** One recording of a queued meeting: where its transcription stands, and what can be done about it. */
function RecordingLine({ meeting, file, state, progress, disabled, installed, speeds, names, chosen, runnable, onAction, onRead }: {
  meeting: QueuedMeeting; file: string; state: RecordingState; progress: TranscriptionProgress | null; disabled: boolean; installed: string[] | null; speeds: Record<string, number>;
  /** Model names by id, and the model chosen in Settings now. */
  names: Record<string, string>; chosen: string | null;
  /** The model each model really runs as here: a GPU model not verified here runs as its CPU counterpart. */
  runnable: Record<string, string>;
  onAction: (action: 'stop' | 'retry' | 'accept' | 'use-live', message: string, body?: Record<string, string>, stopFirst?: boolean) => void;
  onRead: () => void;
}) {
  const { t } = useLanguage();
  const confirm = useConfirm();
  let text: string;
  let tone = 'var(--color-text-muted)';
  const name = (id: string) => names[id] ?? id;
  // The model this recording will really be transcribed with, which is what it waits for.
  const target = state.target ? runnable[state.target.model] ?? state.target.model : null;
  // Fixed to a model that is not downloaded: it can switch to the one chosen now, when that one is.
  const missing = state.status === 'pending' && target !== null && Boolean(installed) && !installed!.includes(target);
  const switchTo = missing && chosen && chosen !== target && installed!.includes(chosen) ? chosen : null;
  if (state.status === 'running') {
    text = progress && progress.total > 0
      ? t('queuedMeetingActions.transcribingOf', { min: Math.min(99, Math.floor((progress.done / progress.total) * 100)), minutes: minutes(progress.total) })
      : progress ? t('queuedMeetingActions.transcribingLoadingTheModel') : t('queuedMeetingActions.transcribingInAnotherDashboard');
  } else if (missing) {
    text = t('queuedMeetingActions.waitsForWhichIsNot', { name: name(target!), value: switchTo ? t('queuedMeetingActions.orUse', { name: name(switchTo) }) : '' });
    tone = 'var(--color-warning)';
  } else if (state.status === 'pending') text = t('queuedMeetingActions.waitsForTranscriptionOneRecording');
  else if (state.status === 'stopped') { text = t('queuedMeetingActions.stoppedTheMeetingWaitsUntil'); tone = 'var(--color-warning)'; }
  else if (state.status === 'failed') { text = t('queuedMeetingActions.failed', { error: state.error ?? t('queuedMeetingActions.unknownError') }); tone = 'var(--color-critical)'; }
  else if (state.accepted) text = t('queuedMeetingActions.partialTranscriptUsedAsIt');
  else { text = t('queuedMeetingActions.partialTranscriptUseItAs', { value: state.error ? ` (${state.error})` : '' }); tone = 'var(--color-warning)'; }
  // A live transcript waits as a draft while the chosen model makes a more accurate one.
  const draft = state.draft;
  if (draft) {
    const accurate = state.status === 'running' ? text.replace(/^Transcribing/, 'being made')
      : state.status === 'pending' ? (missing ? t('queuedMeetingActions.waitsForWhichIsNot2', { name: name(target!) }) : t('queuedMeetingActions.waitsItsTurn'))
        : state.status === 'stopped' ? 'stopped'
          : state.status === 'failed' ? t('queuedMeetingActions.failed2', { error: state.error ?? t('queuedMeetingActions.unknownError') })
            : 'partial: use one of them, or try again';
    // From Test speed, when the model was tested; a model that has not been gives no estimate.
    const speed = target ? speeds[target] : undefined;
    const estimate = speed && state.status === 'pending' && tone !== 'var(--color-warning)' ? t('queuedMeetingActions.aboutOfWork', { minutes: minutes(draft.seconds / speed) }) : '';
    text = t('queuedMeetingActions.liveTranscriptReadyTheMore', { value: target ? ` (${name(target)})` : '', accurate, estimate });
  }
  return (
    <div style={{ flexBasis: '100%', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-2)', fontSize: 'var(--text-xs)' }}>
      <span className="mono truncate" style={{ color: 'var(--color-text-muted)', maxWidth: '40%' }}>{file}</span>
      <span role="status" style={{ flex: '1 1 200px', minWidth: 0, color: tone }}>{text}</span>
      {(state.status === 'running' || state.status === 'pending') && (
        <Button size="sm" variant="ghost" disabled={disabled}
          onClick={async () => {
            if (state.status === 'running' && !(await confirm({ title: `Stop transcribing ${file}?`, message: 'What was transcribed so far is not kept. You can start again later.', confirmLabel: 'Stop transcribing', tone: 'danger' }))) return;
            onAction('stop', `${file} will not be transcribed until you try again.`, state.generation ? { generation: state.generation } : undefined);
          }}>{t('meetingVersions.stop')}</Button>
      )}
      {switchTo && (
        <Button size="sm" variant="ghost" disabled={disabled}
          onClick={() => onAction('retry', `${file} will be transcribed with ${name(switchTo)}.`, { model: switchTo })}>{rich(t, 'queuedMeetingActions.use', { name: name(switchTo) })}</Button>
      )}
      {draft && (
        <Button size="sm" variant="ghost" onClick={onRead}>{t('queuedMeetingActions.readIt')}</Button>
      )}
      {draft && (
        <Button size="sm" variant="ghost" disabled={disabled}
          onClick={async () => {
            const running = state.status === 'running';
            if (running && !(await confirm({ title: 'Use the live transcript instead?', message: 'The more accurate transcript that is running now is stopped.', confirmLabel: 'Use the live transcript' }))) return;
            onAction('use-live', `${meeting.title} uses its live transcript and can go into a digest.`, { draft_sha256: draft.transcript_sha256, ...(state.generation ? { generation: state.generation } : {}) }, running);
          }}>{t('queuedMeetingActions.useTheLiveTranscript')}</Button>
      )}
      {state.status === 'partial' && !state.accepted && (
        <Button size="sm" variant="ghost" disabled={disabled}
          onClick={() => onAction('accept', `${meeting.title} can now go into a digest with the partial transcript.`)}>{t('queuedMeetingActions.useThisTranscript')}</Button>
      )}
      {(state.status === 'stopped' || state.status === 'failed' || (state.status === 'partial' && !state.accepted)) && (
        <Button size="sm" variant="ghost" disabled={disabled}
          onClick={() => onAction('retry', `${file} waits for transcription again.`)}>{t('retry')}</Button>
      )}
    </div>
  );
}

/** Audio arrived a moment ago: some page is recording it, even if not this one. */
export function recordingElsewhere(m: QueuedMeeting | MeetingDigest['queue'][number]): boolean {
  const last = m.live?.state === 'recording' ? m.live.last_block_at : null;
  return Boolean(last && Date.now() - Date.parse(last) < 30_000);
}

/**
 * What can be done about one queued meeting: the same actions the queue list had, one meeting at a time. Recording
 * interrupted (finish it), on hold (queue it again), each recording's transcription (stop, try again, use the live or
 * partial transcript), and removing it from the queue.
 */
export function QueuedMeetingActions({ meeting: m, job, onChanged, onRead, onRemoved }: {
  meeting: QueuedMeeting; job: MeetingDigest; onChanged: () => void; onRead: (file: string) => void; onRemoved: () => void;
}) {
  const { t } = useLanguage();
  const recorder = useRecorder();
  const confirm = useConfirm();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<{ text: string; error?: boolean } | null>(null);
  const act = async (kind: string, fn: () => Promise<string | void>) => {
    setBusy(kind);
    setNotice(null);
    try {
      const text = await fn();
      if (text) setNotice({ text });
      onChanged();
    } catch (err) {
      setNotice({ text: (err as Error).message, error: true });
      // Refused because things changed meanwhile: show them as they are now.
      onChanged();
    } finally {
      setBusy(null);
    }
  };
  const here = recorder.active && recorder.meetingId === m.id;
  const line = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-2)', fontSize: 'var(--text-xs)' } as const;

  return (
    <div className="gtd-stack" style={{ gap: 'var(--space-3)' }}>
      {m.status === 'draft' && <Notice tone="warning" title={t('queuedMeetingActions.notQueuedYet')}>{t('queuedMeetingActions.itsFilesAreUploadingOr')}</Notice>}
      {m.live && !here && (
        <div style={line}>
          <span role="status" style={{ flex: '1 1 200px', minWidth: 0, color: 'var(--color-warning)' }}>
            {m.live.state === 'damaged' ? t('queuedMeetingActions.itsRecordCannotBeRead')
              : recordingElsewhere(m) ? t('queuedMeetingActions.beingRecordedInAnotherPage')
              : t('queuedMeetingActions.savedItStaysUntilYou', { minutes: minutes(m.live.saved_bytes / 32_000), value: m.live.last_block_at ? t('queuedMeetingActions.lastAudio', { last_block_at: formatRelativeTime(m.live.last_block_at) }) : '' })}
          </span>
          {m.live.state !== 'damaged' && (
            <Button size="sm" variant="secondary" disabled={busy !== null}
              onClick={async () => {
                if (!(await confirm({ title: `Finish "${m.title}" with what was saved?`, message: 'A page still recording it is stopped.', confirmLabel: 'Finish recording' }))) return;
                void act('finish', async () => {
                  await apiPost(`/api/meeting-queue/${m.id}/recording/finish`, { recover: true, generation: m.live!.generation, queue: true });
                  return `${m.title} is saved and waits for its transcript.`;
                });
              }}>{t('queuedMeetingActions.finishRecording')}</Button>
          )}
        </div>
      )}
      {m.held && !m.in_digest && (
        <div style={line}>
          <span style={{ flex: '1 1 200px', color: 'var(--color-warning)' }}>{rich(t, 'queuedMeetingActions.onHold', { held: m.held })}</span>
          <Button size="sm" variant="secondary" disabled={busy !== null}
            onClick={() => act('queue', async () => { await apiPost(`/api/meeting-queue/${m.id}/queue`); return `${m.title} is queued again.`; })}>
            {t('queuedMeetingActions.queueAgain')}
          </Button>
        </div>
      )}
      <ul aria-label={t('queuedMeetingActions.filesOfThisMeeting')} className="gtd-list" style={{ border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)' }}>
        {m.files.map((f) => (
          <li key={f.name} className="gtd-list__row" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-2)', fontSize: 'var(--text-sm)' }}>
            <span className="mono truncate" style={{ flex: '1 1 200px', minWidth: 0 }}>{f.name}</span>
            <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>{f.recording ? t('queuedMeetingActions.recording') : t('queuedMeetingActions.file')}</span>
            {f.recording?.status === 'done' && f.recording.transcript && (
              <div style={{ ...line, flexBasis: '100%', color: 'var(--color-text-secondary)' }}>
                {t('queuedMeetingActions.transcriptReady')}{f.recording.accepted_live ? ' (the live one)' : ''}.
                <Button size="sm" variant="ghost" onClick={() => onRead(f.name)}>{t('queuedMeetingActions.readIt')}</Button>
              </div>
            )}
            {m.status === 'queued' && f.recording && f.recording.status !== 'done' && (
              <RecordingLine meeting={m} file={f.name} state={f.recording} onRead={() => onRead(f.name)}
                progress={job.transcription?.meeting === m.id && job.transcription.file === f.name ? job.transcription : null}
                installed={job.installed_models} speeds={job.model_speeds} names={job.model_names ?? {}} chosen={job.chosen_model ?? null} runnable={job.runnable_models ?? {}}
                disabled={busy !== null || m.in_digest}
                onAction={(action, message, body, stopFirst) => act(`${action}-${f.name}`, async () => {
                  const base = `/api/meeting-queue/${m.id}/recordings/${encodeURIComponent(f.name)}`;
                  // Stop exactly the job the page showed, then use the draft it showed.
                  if (stopFirst) await apiPost(`${base}/stop`, { generation: body?.['generation'] });
                  await apiPost(`${base}/${action}`, body);
                  return message;
                })} />
            )}
          </li>
        ))}
        {m.files.length === 0 && <li className="gtd-list__row" style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)' }}>{t('updateDetail.noFilesYet')}</li>}
      </ul>
      {notice && <Notice tone={notice.error ? 'critical' : 'success'}>{notice.text}</Notice>}
      <div>
        <Button size="sm" variant="danger" disabled={busy !== null || m.in_digest}
          title={m.in_digest ? t('queuedMeetingActions.aDigestIsBeingMade') : undefined}
          onClick={async () => {
            const ok = await confirm({ title: `Remove "${m.title}" from the queue?`, message: `The meeting of ${m.meeting_date} and its files are deleted. This cannot be undone.`, confirmLabel: 'Remove meeting', tone: 'danger' });
            if (!ok) return;
            void act('remove', async () => { await apiDelete(`/api/meeting-queue/${m.id}`); onRemoved(); });
          }}>{t('queuedMeetingActions.removeFromTheQueue')}</Button>
      </div>
    </div>
  );
}
