import React from 'react';
import Notice from '@/components/common/Notice';
import { useConfirm } from '@/components/common/ConfirmDialog';
import Button from '@/components/common/Button';
import { useRecorder } from '@/components/recording/RecordingProvider';
import { apiDelete, apiPost } from '@/utils/api';
import { formatRelativeTime } from '@/utils/format';
import type { MeetingDigest, QueuedMeeting, RecordingState, TranscriptionProgress } from '@/types';

function minutes(seconds: number): string {
  if (seconds < 60) return seconds < 1 ? 'a moment' : `${Math.max(1, Math.round(seconds))} s`;
  const m = Math.round(seconds / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
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
      ? `Transcribing: ${Math.min(99, Math.floor((progress.done / progress.total) * 100))}% of ${minutes(progress.total)}`
      : progress ? 'Transcribing: loading the model' : 'Transcribing in another dashboard';
  } else if (missing) {
    text = `Waits for ${name(target!)}, which is not downloaded: download it in Settings > Transcription${switchTo ? `, or use ${name(switchTo)}` : ''}`;
    tone = 'var(--color-warning)';
  } else if (state.status === 'pending') text = 'Waits for transcription; one recording at a time';
  else if (state.status === 'stopped') { text = 'Stopped: the meeting waits until you try again or remove it'; tone = 'var(--color-warning)'; }
  else if (state.status === 'failed') { text = `Failed: ${state.error ?? 'unknown error'}`; tone = 'var(--color-critical)'; }
  else if (state.accepted) text = 'Partial transcript, used as it is';
  else { text = `Partial transcript${state.error ? ` (${state.error})` : ''}: use it as it is, or try again`; tone = 'var(--color-warning)'; }
  // A live transcript waits as a draft while the chosen model makes a more accurate one.
  const draft = state.draft;
  if (draft) {
    const accurate = state.status === 'running' ? text.replace(/^Transcribing/, 'being made')
      : state.status === 'pending' ? (missing ? `waits for ${name(target!)}, which is not downloaded (Settings > Transcription)` : 'waits its turn')
        : state.status === 'stopped' ? 'stopped'
          : state.status === 'failed' ? `failed (${state.error ?? 'unknown error'})`
            : 'partial: use one of them, or try again';
    // From Test speed, when the model was tested; a model that has not been gives no estimate.
    const speed = target ? speeds[target] : undefined;
    const estimate = speed && state.status === 'pending' && tone !== 'var(--color-warning)' ? `, about ${minutes(draft.seconds / speed)} of work` : '';
    text = `Live transcript ready. The more accurate one${target ? ` (${name(target)})` : ''}: ${accurate}${estimate}`;
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
          }}>Stop</Button>
      )}
      {switchTo && (
        <Button size="sm" variant="ghost" disabled={disabled}
          onClick={() => onAction('retry', `${file} will be transcribed with ${name(switchTo)}.`, { model: switchTo })}>Use {name(switchTo)}</Button>
      )}
      {draft && (
        <Button size="sm" variant="ghost" onClick={onRead}>Read it</Button>
      )}
      {draft && (
        <Button size="sm" variant="ghost" disabled={disabled}
          onClick={async () => {
            const running = state.status === 'running';
            if (running && !(await confirm({ title: 'Use the live transcript instead?', message: 'The more accurate transcript that is running now is stopped.', confirmLabel: 'Use the live transcript' }))) return;
            onAction('use-live', `${meeting.title} uses its live transcript and can go into a digest.`, { draft_sha256: draft.transcript_sha256, ...(state.generation ? { generation: state.generation } : {}) }, running);
          }}>Use the live transcript</Button>
      )}
      {state.status === 'partial' && !state.accepted && (
        <Button size="sm" variant="ghost" disabled={disabled}
          onClick={() => onAction('accept', `${meeting.title} can now go into a digest with the partial transcript.`)}>Use this transcript</Button>
      )}
      {(state.status === 'stopped' || state.status === 'failed' || (state.status === 'partial' && !state.accepted)) && (
        <Button size="sm" variant="ghost" disabled={disabled}
          onClick={() => onAction('retry', `${file} waits for transcription again.`)}>Try again</Button>
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
      {m.status === 'draft' && <Notice tone="warning" title="Not queued yet.">Its files are uploading, or the upload stopped. Remove it and add the meeting again if nothing changes.</Notice>}
      {m.live && !here && (
        <div style={line}>
          <span role="status" style={{ flex: '1 1 200px', minWidth: 0, color: 'var(--color-warning)' }}>
            {m.live.state === 'damaged' ? 'Its record cannot be read; the audio is kept. Removing the meeting discards it.'
              : recordingElsewhere(m) ? 'Being recorded in another page or dashboard.'
              : `${minutes(m.live.saved_bytes / 32_000)} saved${m.live.last_block_at ? `, last audio ${formatRelativeTime(m.live.last_block_at)}` : ''}. It stays until you finish or discard it.`}
          </span>
          {m.live.state !== 'damaged' && (
            <Button size="sm" variant="secondary" disabled={busy !== null}
              onClick={async () => {
                if (!(await confirm({ title: `Finish "${m.title}" with what was saved?`, message: 'A page still recording it is stopped.', confirmLabel: 'Finish recording' }))) return;
                void act('finish', async () => {
                  await apiPost(`/api/meeting-queue/${m.id}/recording/finish`, { recover: true, generation: m.live!.generation, queue: true });
                  return `${m.title} is saved and waits for its transcript.`;
                });
              }}>Finish recording</Button>
          )}
        </div>
      )}
      {m.held && !m.in_digest && (
        <div style={line}>
          <span style={{ flex: '1 1 200px', color: 'var(--color-warning)' }}>On hold: {m.held}</span>
          <Button size="sm" variant="secondary" disabled={busy !== null}
            onClick={() => act('queue', async () => { await apiPost(`/api/meeting-queue/${m.id}/queue`); return `${m.title} is queued again.`; })}>
            Queue again
          </Button>
        </div>
      )}
      <ul aria-label="Files of this meeting" className="gtd-list" style={{ border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)' }}>
        {m.files.map((f) => (
          <li key={f.name} className="gtd-list__row" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-2)', fontSize: 'var(--text-sm)' }}>
            <span className="mono truncate" style={{ flex: '1 1 200px', minWidth: 0 }}>{f.name}</span>
            <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>{f.recording ? 'Recording' : 'File'}</span>
            {f.recording?.status === 'done' && f.recording.transcript && (
              <div style={{ ...line, flexBasis: '100%', color: 'var(--color-text-secondary)' }}>
                Transcript ready{f.recording.accepted_live ? ' (the live one)' : ''}.
                <Button size="sm" variant="ghost" onClick={() => onRead(f.name)}>Read it</Button>
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
        {m.files.length === 0 && <li className="gtd-list__row" style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)' }}>No files yet.</li>}
      </ul>
      {notice && <Notice tone={notice.error ? 'critical' : 'success'}>{notice.text}</Notice>}
      <div>
        <Button size="sm" variant="danger" disabled={busy !== null || m.in_digest}
          title={m.in_digest ? 'A digest is being made from it' : undefined}
          onClick={async () => {
            const ok = await confirm({ title: `Remove "${m.title}" from the queue?`, message: `The meeting of ${m.meeting_date} and its files are deleted. This cannot be undone.`, confirmLabel: 'Remove meeting', tone: 'danger' });
            if (!ok) return;
            void act('remove', async () => { await apiDelete(`/api/meeting-queue/${m.id}`); onRemoved(); });
          }}>Remove from the queue</Button>
      </div>
    </div>
  );
}
