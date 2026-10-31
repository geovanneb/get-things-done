import React from 'react';
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
  const m = Math.round(seconds / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

/** One recording of a queued meeting: where its transcription stands, and what can be done about it. */
function RecordingLine({ meeting, file, state, progress, disabled, installed, speeds, names, chosen, onAction, onRead }: {
  meeting: QueuedMeeting; file: string; state: RecordingState; progress: TranscriptionProgress | null; disabled: boolean; installed: string[] | null; speeds: Record<string, number>;
  /** Model names by id, and the model chosen in Settings now. */
  names: Record<string, string>; chosen: string | null;
  onAction: (action: 'stop' | 'retry' | 'accept' | 'use-live', message: string, body?: Record<string, string>, stopFirst?: boolean) => void;
  onRead: () => void;
}) {
  let text: string;
  let tone = 'var(--color-text-muted)';
  const name = (id: string) => names[id] ?? id;
  // Fixed to a model that is not downloaded: it can switch to the one chosen now, when that one is.
  const missing = state.status === 'pending' && Boolean(state.target) && Boolean(installed) && !installed!.includes(state.target!.model);
  const switchTo = missing && chosen && chosen !== state.target!.model && installed!.includes(chosen) ? chosen : null;
  if (state.status === 'running') {
    text = progress && progress.total > 0
      ? `Transcribing: ${Math.min(99, Math.floor((progress.done / progress.total) * 100))}% of ${minutes(progress.total)}`
      : progress ? 'Transcribing: loading the model' : 'Transcribing in another dashboard';
  } else if (missing) {
    text = `Waits for ${name(state.target!.model)}, which is not downloaded: download it in Settings > Transcription${switchTo ? `, or use ${name(switchTo)}` : ''}`;
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
      : state.status === 'pending' ? (missing ? `waits for ${name(state.target!.model)}, which is not downloaded (Settings > Transcription)` : 'waits its turn')
        : state.status === 'stopped' ? 'stopped'
          : state.status === 'failed' ? `failed (${state.error ?? 'unknown error'})`
            : 'partial: use one of them, or try again';
    // From Test speed, when the model was tested; a model that has not been gives no estimate.
    const speed = state.target ? speeds[state.target.model] : undefined;
    const estimate = speed && state.status === 'pending' && tone !== 'var(--color-warning)' ? `, about ${minutes(draft.seconds / speed)} of work` : '';
    text = `Live transcript ready. The more accurate one${state.target ? ` (${name(state.target.model)})` : ''}: ${accurate}${estimate}`;
  }
  return (
    <div style={{ flexBasis: '100%', display: 'flex', alignItems: 'center', gap: 8, paddingLeft: 12, fontSize: 'var(--text-xs)' }}>
      <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--color-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '40%' }}>{file}</span>
      <span role="status" style={{ flex: 1, minWidth: 0, color: tone }}>{text}</span>
      {(state.status === 'running' || state.status === 'pending') && (
        <Button size="sm" variant="ghost" disabled={disabled}
          onClick={() => {
            if (state.status === 'running' && !window.confirm(`Stop transcribing ${file}? What was transcribed so far is not kept.`)) return;
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
          onClick={() => {
            const running = state.status === 'running';
            if (running && !window.confirm('Stop the more accurate transcript and use the live one instead?')) return;
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
export function MeetingQueueList({ job, onChanged, onRead }: { job: MeetingDigest; onChanged: () => void; onRead: (meeting: string, file: string) => void }) {
  const recorder = useRecorder();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<{ text: string; error?: boolean } | null>(null);
  const [query, setQuery] = React.useState('');
  const [all, setAll] = React.useState(false);
  // What needs you is always there; a search shows every match; otherwise the newest few, and the rest on request.
  const { shown, hidden } = visibleMeetings(job.queue, query, all, job.installed_models ?? null);
  const found = matching(job.queue, query);
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

  return (
    <>
      {job.queue_problems.length > 0 && (
        <div role="alert" style={{ fontSize: 'var(--text-xs)', color: 'var(--color-critical)', marginBottom: 8 }}>
          {job.queue_problems.map((p) => `${p.id}: ${p.reason}`).join(' ')}
        </div>
      )}
      {(job.queue.length > SHOWN_MEETINGS || query) && (
        <input type="search" aria-label="Search meetings" placeholder="Search by title, date or person" value={query} onChange={(e) => setQuery(e.target.value)}
          style={{ width: '100%', maxWidth: 360, marginTop: 4, padding: '4px 8px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--color-border)', background: 'var(--color-surface)', color: 'var(--color-text)', fontSize: 'var(--text-sm)' }} />
      )}
      {job.queue.length > 0 && found.length === 0 && (
        <p style={{ margin: '8px 0 0', fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)' }}>No meeting matches “{query}”.</p>
      )}
      {found.length > 0 ? (
        <ul aria-label="Meeting queue" style={{ listStyle: 'none', margin: '12px 0 0', padding: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {shown.map((m) => (
            <li key={m.id} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, fontSize: 'var(--text-sm)', padding: '4px 8px', background: 'var(--color-surface-hover)', borderRadius: 'var(--radius-sm)' }}>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>{m.meeting_date}{meetingPeriod(m) ? ` ${meetingPeriod(m)}` : ''}</span>
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.title}</span>
              {m.participants?.length ? <span style={{ flexBasis: '100%', order: 1, fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>Expected: {joinNames(m.participants)}</span> : null}
              <span title={m.held ?? undefined} style={{ fontSize: 'var(--text-xs)', color: m.held ? 'var(--color-warning)' : 'var(--color-text-muted)' }}>
                {m.live ? (recorder.active && recorder.meetingId === m.id ? 'recording' : recordingElsewhere(m) ? 'recording in another page' : 'recording interrupted') : m.status === 'draft' ? 'uploading' : m.in_digest ? 'going into a digest' : m.held ? 'on hold'
                  : m.files.some((f) => f.recording && !transcribed(f.recording)) ? 'waiting for transcription' : `${m.files.length} file${m.files.length === 1 ? '' : 's'}`}
              </span>
              {m.held && !m.in_digest && (
                <Button size="sm" variant="ghost" disabled={busy !== null}
                  onClick={() => act(`queue-${m.id}`, async () => { await apiPost(`/api/meeting-queue/${m.id}/queue`); return `${m.title} is queued again.`; })}>
                  Queue again
                </Button>
              )}
              <button type="button" aria-label={`Remove ${m.title} from the queue`} disabled={busy !== null || m.in_digest}
                onClick={() => {
                  if (!window.confirm(`Remove "${m.title}" (${m.meeting_date}) and its files from the queue?`)) return;
                  void act(`remove-${m.id}`, async () => { await apiDelete(`/api/meeting-queue/${m.id}`); });
                }}
                style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--color-text-muted)', padding: '0 4px', fontSize: 'var(--text-base)' }}>×</button>
              {m.live && !(recorder.active && recorder.meetingId === m.id) && (
                <div style={{ flexBasis: '100%', display: 'flex', alignItems: 'center', gap: 8, paddingLeft: 12, fontSize: 'var(--text-xs)' }}>
                  <span role="status" style={{ flex: 1, minWidth: 0, color: 'var(--color-warning)' }}>
                    {m.live.state === 'damaged' ? 'Its record cannot be read; the audio is kept. Removing the meeting discards it.'
                      : recordingElsewhere(m) ? 'Being recorded in another page or dashboard.'
                      : `${Math.round(m.live.saved_bytes / 32_000 / 60)} min saved${m.live.last_block_at ? `, last audio ${formatRelativeTime(m.live.last_block_at)}` : ''}. It stays until you finish or discard it.`}
                  </span>
                  {m.live.state !== 'damaged' && (
                    <Button size="sm" variant="ghost" disabled={busy !== null}
                      onClick={() => {
                        if (!window.confirm(`Finish "${m.title}" with what was saved? A page still recording it is stopped.`)) return;
                        void act(`finish-${m.id}`, async () => {
                          await apiPost(`/api/meeting-queue/${m.id}/recording/finish`, { recover: true, generation: m.live!.generation, queue: true });
                          return `${m.title} is saved and waits for its transcript.`;
                        });
                      }}>Finish</Button>
                  )}
                </div>
              )}
              {m.files.filter((f) => f.recording?.status === 'done' && f.recording.transcript).map((f) => (
                <div key={`read-${f.name}`} style={{ flexBasis: '100%', display: 'flex', alignItems: 'center', gap: 8, paddingLeft: 12, fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
                  Transcript ready{f.recording!.accepted_live ? ' (the live one)' : ''}.
                  <Button size="sm" variant="ghost" onClick={() => onRead(m.id, f.name)}>Read it</Button>
                </div>
              ))}
              {m.status === 'queued' && m.files.filter((f) => f.recording && !(f.recording.status === 'done')).map((f) => (
                <RecordingLine key={f.name} meeting={m} file={f.name} state={f.recording!} onRead={() => onRead(m.id, f.name)}
                  progress={job.transcription?.meeting === m.id && job.transcription.file === f.name ? job.transcription : null}
                  installed={job.installed_models} speeds={job.model_speeds} names={job.model_names ?? {}} chosen={job.chosen_model ?? null}
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
        <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)' }}>No meetings in the queue. Record one, or add one under Context &gt; Updates.</p>
      )}
      {hidden > 0 && (
        <Button size="sm" variant="ghost" onClick={() => setAll(true)}>Show {hidden} older</Button>
      )}
      {all && !query.trim() && found.length > SHOWN_MEETINGS && (
        <Button size="sm" variant="ghost" onClick={() => setAll(false)}>Show fewer</Button>
      )}
      {notice && <p role={notice.error ? 'alert' : 'status'} style={{ margin: '8px 0 0', fontSize: 'var(--text-sm)', color: notice.error ? 'var(--color-critical)' : 'var(--color-text-muted)' }}>{notice.text}</p>}
    </>
  );
}
