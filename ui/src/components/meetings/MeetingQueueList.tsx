import React from 'react';
import Badge from '@/components/common/Badge';
import EmptyState from '@/components/common/EmptyState';
import Notice from '@/components/common/Notice';
import { SearchInput } from '@/components/common/Input';
import IconButton, { icons } from '@/components/common/IconButton';
import { useConfirm } from '@/components/common/ConfirmDialog';
import Button from '@/components/common/Button';
import { useRecorder } from '@/components/recording/RecordingProvider';
import { apiDelete, apiPost } from '@/utils/api';
import { formatRelativeTime } from '@/utils/format';
import { joinNames } from '@/utils/meetingParticipants';
import { matching, meetingPeriod, SHOWN_MEETINGS, visibleMeetings } from '@/utils/meetingQueue';
import type { MeetingDigest, QueuedMeeting, RecordingState, TranscriptionProgress } from '@/types';

/** A recording whose transcript can go into a digest: done, or partial and used as it is. */
function transcribed(r: RecordingState): boolean {
  return r.status === 'done' || (r.status === 'partial' && Boolean(r.accepted));
}

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

/** The meetings on their way into a digest: their recordings, transcripts and what can be done about them. */
export function MeetingQueueList({ job, onChanged, onRead, onRecord }: { job: MeetingDigest; onChanged: () => void; onRead: (meeting: string, file: string) => void; onRecord?: () => void }) {
  const recorder = useRecorder();
  const confirm = useConfirm();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<{ text: string; error?: boolean; meeting?: string } | null>(null);
  // A notice about a meeting that has left the queue (digested or removed) no longer holds.
  React.useEffect(() => {
    if (notice?.meeting && !job.queue.some((m) => m.id === notice.meeting)) setNotice(null);
  }, [job.queue, notice]);
  const [query, setQuery] = React.useState('');
  const [all, setAll] = React.useState(false);
  // What needs you is always there; a search shows every match; otherwise the newest few, and the rest on request.
  const { shown, hidden } = visibleMeetings(job.queue, query, all, job.installed_models ?? null, SHOWN_MEETINGS, job.runnable_models ?? {});
  const found = matching(job.queue, query);
  const act = async (kind: string, fn: () => Promise<string | void>) => {
    setBusy(kind);
    setNotice(null);
    try {
      const text = await fn();
      if (text) setNotice({ text, meeting: kind.match(/MQ-\d+-\d+/)?.[0] });
      onChanged();
    } catch (err) {
      setNotice({ text: (err as Error).message, error: true, meeting: kind.match(/MQ-\d+-\d+/)?.[0] });
      // Refused because things changed meanwhile: show them as they are now.
      onChanged();
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      {(job.queue_problems.length > 0 || job.queue.length > SHOWN_MEETINGS || query) && (
        <div className="gtd-stack" style={{ gap: 'var(--space-3)', padding: 'var(--space-3) var(--space-5)', borderBottom: '1px solid var(--color-border)' }}>
          {job.queue_problems.length > 0 && (
            <Notice tone="critical" title="Some meetings in the queue cannot be read.">
              {job.queue_problems.map((p) => `${p.id}: ${p.reason}`).join(' ')}
            </Notice>
          )}
          {(job.queue.length > SHOWN_MEETINGS || query) && (
            <SearchInput value={query} onChange={setQuery} placeholder="Search meetings by title, date or person" width={360} size="sm" />
          )}
        </div>
      )}
      {job.queue.length > 0 && found.length === 0 && (
        <EmptyState size="compact" title={`No meeting matches "${query}"`} description="Try a title, a date or a name." action={{ label: 'Clear search', onClick: () => setQuery('') }} />
      )}
      {found.length > 0 ? (
        <ul aria-label="Meeting queue" className="gtd-list">
          {shown.map((m) => (
            <li key={m.id} className="gtd-list__row" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-2)', fontSize: 'var(--text-sm)' }}>
              <span className="mono" style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>{m.meeting_date}{meetingPeriod(m) ? ` ${meetingPeriod(m)}` : ''}</span>
              <span className="truncate" style={{ flex: 1, minWidth: 0, fontWeight: 500 }}>{m.title}</span>
              {m.participants?.length ? <span style={{ flexBasis: '100%', order: 1, fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>Expected: {joinNames(m.participants)}</span> : null}
              <span title={m.held ?? undefined}>
                <Badge size="sm" variant={m.live && !(recorder.active && recorder.meetingId === m.id) && !recordingElsewhere(m) ? 'warning' : m.held || m.status === 'draft' ? 'warning' : m.live ? 'error' : m.in_digest ? 'info' : 'muted'}>
                  {m.live ? (recorder.active && recorder.meetingId === m.id ? 'Recording' : recordingElsewhere(m) ? 'Recording in another page' : 'Recording interrupted') : m.status === 'draft' ? 'Not queued yet' : m.in_digest ? 'Going into a digest' : m.held ? 'On hold'
                    : m.files.some((f) => f.recording && !transcribed(f.recording)) ? 'Waiting for transcription' : `${m.files.length} file${m.files.length === 1 ? '' : 's'}`}
                </Badge>
              </span>
              {m.status === 'draft' && <span style={{ flexBasis: '100%', order: 1, fontSize: 'var(--text-xs)', color: 'var(--color-warning)' }}>Its files are uploading, or the upload stopped.</span>}
              {m.held && !m.in_digest && (
                <Button size="sm" variant="ghost" disabled={busy !== null}
                  onClick={() => act(`queue-${m.id}`, async () => { await apiPost(`/api/meeting-queue/${m.id}/queue`); return `${m.title} is queued again.`; })}>
                  Queue again
                </Button>
              )}
              <IconButton label={`Remove ${m.title} from the queue`} icon={icons.close} tone="danger" disabled={busy !== null || m.in_digest}
                onClick={async () => {
                  const ok = await confirm({ title: `Remove "${m.title}" from the queue?`, message: `The meeting of ${m.meeting_date} and its files are deleted. This cannot be undone.`, confirmLabel: 'Remove meeting', tone: 'danger' });
                  if (!ok) return;
                  void act(`remove-${m.id}`, async () => { await apiDelete(`/api/meeting-queue/${m.id}`); });
                }} />
              {m.live && !(recorder.active && recorder.meetingId === m.id) && (
                <div style={{ flexBasis: '100%', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-2)', fontSize: 'var(--text-xs)' }}>
                  <span role="status" style={{ flex: '1 1 200px', minWidth: 0, color: 'var(--color-warning)' }}>
                    {m.live.state === 'damaged' ? 'Its record cannot be read; the audio is kept. Removing the meeting discards it.'
                      : recordingElsewhere(m) ? 'Being recorded in another page or dashboard.'
                      : `${minutes(m.live.saved_bytes / 32_000)} saved${m.live.last_block_at ? `, last audio ${formatRelativeTime(m.live.last_block_at)}` : ''}. It stays until you finish or discard it.`}
                  </span>
                  {m.live.state !== 'damaged' && (
                    <Button size="sm" variant="ghost" disabled={busy !== null}
                      onClick={async () => {
                        if (!(await confirm({ title: `Finish "${m.title}" with what was saved?`, message: 'A page still recording it is stopped.', confirmLabel: 'Finish recording' }))) return;
                        void act(`finish-${m.id}`, async () => {
                          await apiPost(`/api/meeting-queue/${m.id}/recording/finish`, { recover: true, generation: m.live!.generation, queue: true });
                          return `${m.title} is saved and waits for its transcript.`;
                        });
                      }}>Finish</Button>
                  )}
                </div>
              )}
              {m.files.filter((f) => f.recording?.status === 'done' && f.recording.transcript).map((f) => (
                <div key={`read-${f.name}`} style={{ flexBasis: '100%', display: 'flex', alignItems: 'center', gap: 'var(--space-2)', fontSize: 'var(--text-xs)', color: 'var(--color-text-secondary)' }}>
                  Transcript of {f.name} ready{f.recording!.accepted_live ? ' (the live one)' : ''}.
                  <Button size="sm" variant="ghost" onClick={() => onRead(m.id, f.name)}>Read it</Button>
                </div>
              ))}
              {m.status === 'queued' && m.files.filter((f) => f.recording && !(f.recording.status === 'done')).map((f) => (
                <RecordingLine key={f.name} meeting={m} file={f.name} state={f.recording!} onRead={() => onRead(m.id, f.name)}
                  progress={job.transcription?.meeting === m.id && job.transcription.file === f.name ? job.transcription : null}
                  installed={job.installed_models} speeds={job.model_speeds} names={job.model_names ?? {}} chosen={job.chosen_model ?? null} runnable={job.runnable_models ?? {}}
                  disabled={busy !== null || m.in_digest}
                  onAction={(action, message, body, stopFirst) => act(`${action}-${m.id}-${f.name}`, async () => {
                    const base = `/api/meeting-queue/${m.id}/recordings/${encodeURIComponent(f.name)}`;
                    // Stop exactly the job the page showed, then use the draft it showed.
                    if (stopFirst) await apiPost(`${base}/stop`, { generation: body?.['generation'] });
                    await apiPost(`${base}/${action}`, body);
                    return message;
                  })} />
              ))}
            </li>
          ))}
        </ul>
      ) : job.queue.length === 0 && (
        <EmptyState size="compact" title="No meetings in the queue"
          description="Record a meeting, or add a recording or transcript under Context > Updates. Queued meetings go into the next digest."
          action={onRecord ? { label: 'Record a meeting', onClick: onRecord } : undefined} />
      )}
      {(hidden > 0 || (all && !query.trim() && found.length > SHOWN_MEETINGS) || notice) && (
        <div className="gtd-stack" style={{ gap: 'var(--space-2)', padding: 'var(--space-3) var(--space-5)', borderTop: '1px solid var(--color-border)' }}>
          {hidden > 0 && <div><Button size="sm" variant="ghost" onClick={() => setAll(true)}>Show {hidden} older</Button></div>}
          {all && !query.trim() && found.length > SHOWN_MEETINGS && <div><Button size="sm" variant="ghost" onClick={() => setAll(false)}>Show fewer</Button></div>}
          {notice && <Notice tone={notice.error ? 'critical' : 'success'}>{notice.text}</Notice>}
        </div>
      )}
    </>
  );
}
