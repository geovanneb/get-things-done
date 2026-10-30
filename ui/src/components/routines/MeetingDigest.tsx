import React from 'react';
import { Link } from 'react-router-dom';
import Modal from '@/components/common/Modal';
import Button from '@/components/common/Button';
import Badge from '@/components/common/Badge';
import Toggle from '@/components/common/Toggle';
import { dateInputStyle, sectionLabelStyle, fieldLabelStyle } from '@/components/task-form/styles';
import { apiDelete, apiGet, apiPost, apiPut } from '@/utils/api';
import { formatRelativeTime } from '@/utils/format';
import { useRecorder } from '@/components/recording/RecordingProvider';
import { RecordMeetingModal } from '@/components/recording/RecordMeetingModal';
import type { MeetingDigest, MeetingDigestSettings, QueuedMeeting, RecordingState, RoutineRun, RoutineWeekday, RunnerStatus, TranscriptionProgress } from '@/types';

const WEEKDAYS: { id: RoutineWeekday; short: string }[] = [
  { id: 'mon', short: 'Mon' }, { id: 'tue', short: 'Tue' }, { id: 'wed', short: 'Wed' }, { id: 'thu', short: 'Thu' },
  { id: 'fri', short: 'Fri' }, { id: 'sat', short: 'Sat' }, { id: 'sun', short: 'Sun' },
];

/** Text per digest, in characters of readable text: a meeting averages about 30,000 an hour with its pauses. */
const CHARACTERS_PER_HOUR = 30_000;
const TEXT_SIZES = [100_000, 200_000, 400_000, 800_000, 1_600_000];

const cardStyle: React.CSSProperties = {
  border: '1px solid var(--color-border)', borderRadius: 'var(--radius-lg)', background: 'var(--color-surface)', padding: 16,
};
const hintStyle: React.CSSProperties = { fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', margin: '2px 0 0' };

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/** A recording whose transcript can go into a digest: done, or partial and used as it is. */
function transcribed(r: RecordingState): boolean {
  return r.status === 'done' || (r.status === 'partial' && Boolean(r.accepted));
}

function minutes(seconds: number): string {
  const m = Math.round(seconds / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

/** One recording of a queued meeting: where its transcription stands, and what can be done about it. */
function RecordingLine({ meeting, file, state, progress, disabled, onAction }: {
  meeting: QueuedMeeting; file: string; state: RecordingState; progress: TranscriptionProgress | null; disabled: boolean;
  onAction: (action: 'stop' | 'retry' | 'accept', message: string) => void;
}) {
  let text: string;
  let tone = 'var(--color-text-muted)';
  if (state.status === 'running') {
    text = progress && progress.total > 0
      ? `Transcribing: ${Math.min(99, Math.floor((progress.done / progress.total) * 100))}% of ${minutes(progress.total)}`
      : progress ? 'Transcribing: loading the model' : 'Transcribing in another dashboard';
  } else if (state.status === 'pending') text = 'Waits for transcription; one recording at a time';
  else if (state.status === 'stopped') { text = 'Stopped: the meeting waits until you try again or remove it'; tone = 'var(--color-warning)'; }
  else if (state.status === 'failed') { text = `Failed: ${state.error ?? 'unknown error'}`; tone = 'var(--color-critical)'; }
  else if (state.accepted) text = 'Partial transcript, used as it is';
  else { text = `Partial transcript${state.error ? ` (${state.error})` : ''}: use it as it is, or try again`; tone = 'var(--color-warning)'; }
  return (
    <div style={{ flexBasis: '100%', display: 'flex', alignItems: 'center', gap: 8, paddingLeft: 12, fontSize: 'var(--text-xs)' }}>
      <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--color-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '40%' }}>{file}</span>
      <span role="status" style={{ flex: 1, minWidth: 0, color: tone }}>{text}</span>
      {(state.status === 'running' || state.status === 'pending') && (
        <Button size="sm" variant="ghost" disabled={disabled}
          onClick={() => {
            if (state.status === 'running' && !window.confirm(`Stop transcribing ${file}? What was transcribed so far is not kept.`)) return;
            onAction('stop', `${file} will not be transcribed until you try again.`);
          }}>Stop</Button>
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

export function MeetingDigestCard({ job, onEdit, onChanged }: { job: MeetingDigest; onEdit: () => void; onChanged: () => void }) {
  const [busy, setBusy] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<{ text: string; error?: boolean } | null>(null);
  const { settings, state } = job;
  const failed = state.last_status === 'error';
  const queued = job.queue.filter((m) => m.status === 'queued' && !m.held);
  const held = job.queue.filter((m) => m.held).length;
  const drafts = job.queue.filter((m) => m.status === 'draft').length;
  const hours = Math.max(1, Math.round(settings.max_characters / CHARACTERS_PER_HOUR));

  const recorder = useRecorder();
  const [recording, setRecording] = React.useState(false);
  const act = async (kind: string, fn: () => Promise<string | void>) => {
    setBusy(kind);
    setNotice(null);
    try {
      const text = await fn();
      if (text) setNotice({ text });
      onChanged();
    } catch (err) {
      setNotice({ text: (err as Error).message, error: true });
    } finally {
      setBusy(null);
    }
  };

  return (
    <article id="meeting-digest" style={{ ...cardStyle, opacity: settings.enabled ? 1 : 0.75 }} aria-label="Meeting digest">
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <h3 style={{ margin: 0, fontSize: 'var(--text-base)', fontWeight: 600 }}>Meeting digest</h3>
            <Badge size="sm" variant="info">Built-in</Badge>
            {!settings.enabled && <Badge size="sm">Paused</Badge>}
            {failed && <Badge variant="critical" size="sm">Last run failed</Badge>}
          </div>
          <div style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)', marginTop: 4 }}>
            {job.summary}. Collects the meetings you queued into one context update, at most {settings.max_meetings} at a time
            and about {hours} hour{hours > 1 ? 's' : ''} of meetings.
            A day without queued meetings makes nothing.{settings.after_each_meeting ? ' Also right after each meeting.' : ''}{settings.auto_analyze ? ' Each new digest is analyzed automatically.' : ''}
          </div>
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', marginTop: 6, display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            <span>Next: {settings.enabled ? (job.next_run_at ? formatWhen(job.next_run_at) : 'no more runs') : 'paused'}</span>
            {state.last_run_at && <span title={state.last_message}>Last: {formatRelativeTime(state.last_run_at)}</span>}
            <span>{queued.length === 0 ? 'Queue empty' : `${queued.length} meeting${queued.length === 1 ? '' : 's'} queued`}{held > 0 ? `, ${held} on hold` : ''}{drafts > 0 ? `, ${drafts} still uploading` : ''}</span>
          </div>
          {job.open_digest && (
            <div style={{ fontSize: 'var(--text-sm)', marginTop: 8 }}>
              Digest <Link to={`/context/updates/${job.open_digest}`} style={{ color: 'var(--color-accent)', fontWeight: 600 }}>{job.open_digest}</Link> is waiting for you.
              No new digest starts until it is done; queued meetings wait.
            </div>
          )}
          {settings.auto_analyze && state.analysis && state.analysis.update_id === job.open_digest && (
            <div style={{ fontSize: 'var(--text-xs)', marginTop: 4, color: state.analysis.status === 'not_started' ? 'var(--color-critical)' : 'var(--color-text-muted)' }}>
              {state.analysis.message}
            </div>
          )}
          {failed && state.last_message && (
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-critical)', marginTop: 6 }}>{state.last_message}</div>
          )}
          {job.queue_problems.length > 0 && (
            <div role="alert" style={{ fontSize: 'var(--text-xs)', color: 'var(--color-critical)', marginTop: 6 }}>
              {job.queue_problems.map((p) => `${p.id}: ${p.reason}`).join(' ')}
            </div>
          )}
        </div>
        <Toggle
          label={settings.enabled ? 'Pause Meeting digest' : 'Resume Meeting digest'}
          checked={settings.enabled}
          disabled={busy !== null}
          onChange={(on) => act('toggle', async () => { await apiPut('/api/routines/meeting-digest', { enabled: on }); })}
        />
      </div>

      {job.queue.length > 0 && (
        <ul aria-label="Meeting queue" style={{ listStyle: 'none', margin: '12px 0 0', padding: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {job.queue.map((m) => (
            <li key={m.id} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, fontSize: 'var(--text-sm)', padding: '4px 8px', background: 'var(--color-surface-hover)', borderRadius: 'var(--radius-sm)' }}>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>{m.meeting_date}</span>
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.title}</span>
              <span title={m.held ?? undefined} style={{ fontSize: 'var(--text-xs)', color: m.held ? 'var(--color-warning)' : 'var(--color-text-muted)' }}>
                {m.live ? (recorder.active && recorder.meetingId === m.id ? 'recording' : 'recording interrupted') : m.status === 'draft' ? 'uploading' : m.in_digest ? 'going into a digest' : m.held ? 'on hold'
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
              {m.status === 'queued' && m.files.filter((f) => f.recording && !(f.recording.status === 'done')).map((f) => (
                <RecordingLine key={f.name} meeting={m} file={f.name} state={f.recording!}
                  progress={job.transcription?.meeting === m.id && job.transcription.file === f.name ? job.transcription : null}
                  disabled={busy !== null || m.in_digest}
                  onAction={(action, message) => act(`${action}-${m.id}-${f.name}`, async () => {
                    await apiPost(`/api/meeting-queue/${m.id}/recordings/${encodeURIComponent(f.name)}/${action}`);
                    return message;
                  })} />
              ))}
            </li>
          ))}
        </ul>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <Button size="sm" variant="secondary" loading={busy === 'run'} disabled={busy !== null || queued.length === 0}
          title={queued.length === 0 ? 'The queue is empty' : 'Make a digest from the queue now, without waiting for the schedule'}
          onClick={() => act('run', async () => (await apiPost<RoutineRun>('/api/routines/meeting-digest/run')).message)}>
          Make digest now
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setRecording(true)} disabled={recorder.active}>Record a meeting</Button>
        <Button size="sm" variant="ghost" onClick={onEdit} disabled={busy !== null}>Settings</Button>
        {notice && (
          <span role={notice.error ? 'alert' : 'status'} style={{ fontSize: 'var(--text-xs)', color: notice.error ? 'var(--color-critical)' : 'var(--color-text-muted)' }}>
            {notice.text}
          </span>
        )}
      </div>
      <RecordMeetingModal isOpen={recording} onClose={() => setRecording(false)} />
    </article>
  );
}

export function MeetingDigestEditor({ isOpen, job, onClose, onSaved }: { isOpen: boolean; job: MeetingDigest | null; onClose: () => void; onSaved: () => void }) {
  const [draft, setDraft] = React.useState<MeetingDigestSettings | null>(null);
  const [max, setMax] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [runner, setRunner] = React.useState<RunnerStatus | null>(null);

  // Filled once when the editor opens: the job is fetched again on every queue or update change, and a
  // background refresh must not undo what is being edited.
  const loaded = job !== null;
  const settings = React.useRef(job?.settings);
  settings.current = job?.settings;
  React.useEffect(() => {
    if (!isOpen) return;
    let live = true;
    apiGet<RunnerStatus>('/api/runner').then((s) => { if (live) setRunner(s); }, () => { if (live) setRunner(null); });
    return () => { live = false; };
  }, [isOpen]);

  React.useEffect(() => {
    if (!isOpen) { setDraft(null); return; }
    if (!loaded || !settings.current) return;
    setDraft(structuredClone(settings.current));
    setMax(String(settings.current.max_meetings));
    setError(null);
  }, [isOpen, loaded]);

  if (!job || !draft) return null;

  const days = draft.schedule.weekdays;
  const toggleDay = (day: RoutineWeekday) => {
    const next = days.includes(day) ? days.filter((d) => d !== day) : [...days, day];
    setDraft({ ...draft, schedule: { ...draft.schedule, frequency: 'weekly', interval: 1, weekdays: WEEKDAYS.map((w) => w.id).filter((d) => next.includes(d)), month_week: null, month_weekday: null, month_day: null } });
  };

  const save = async () => {
    if (days.length === 0) { setError('Pick at least one day.'); return; }
    setSaving(true);
    setError(null);
    try {
      await apiPut('/api/routines/meeting-digest', { ...draft, max_meetings: /^\d+$/.test(max.trim()) ? Number(max) : max });
      onSaved();
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Meeting digest" size="md">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
        <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)' }}>
          A built-in routine for meetings. Add a meeting to the queue from <strong>Import</strong> in Context updates; on the days
          below, the queued meetings become one context update. The analysis drafts a record per meeting and proposes context
          changes for you to approve: you run it, or the dashboard starts it for you (below).
        </p>

        <section aria-labelledby="md-schedule">
          <h3 id="md-schedule" style={{ ...sectionLabelStyle, margin: '0 0 8px' }}>When</h3>
          <div role="group" aria-label="Days" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {WEEKDAYS.map((w) => (
              <label key={w.id} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 'var(--text-sm)', padding: '4px 8px', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm)', cursor: 'pointer' }}>
                <input type="checkbox" checked={days.includes(w.id)} onChange={() => toggleDay(w.id)} />
                {w.short}
              </label>
            ))}
          </div>
          <label style={{ display: 'block', marginTop: 10, width: 120 }}>
            <span style={fieldLabelStyle}>Time</span>
            <input type="time" style={dateInputStyle} value={draft.schedule.time}
              onChange={(e) => setDraft({ ...draft, schedule: { ...draft.schedule, time: e.target.value || '18:00' } })} />
          </label>
          <p style={hintStyle}>
            After your last meeting of the day is a good time. If the computer was off, one digest is made the next time the
            dashboard starts; nothing in the queue is lost. While a digest waits for your review, new meetings wait in the queue.
          </p>
          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginTop: 10, fontSize: 'var(--text-sm)', cursor: 'pointer' }}>
            <input type="checkbox" checked={draft.after_each_meeting} onChange={(e) => setDraft({ ...draft, after_each_meeting: e.target.checked })} style={{ marginTop: 3 }} />
            <span>Also make a digest right after each meeting</span>
          </label>
          <p style={hintStyle}>
            Within a minute of a meeting being queued, any day and time, when no digest waits for your review. Meetings queued
            while one waits go into the next digest as soon as it is done. Useful with automatic analysis below.
          </p>
        </section>

        <section aria-labelledby="md-size">
          <h3 id="md-size" style={{ ...sectionLabelStyle, margin: 0 }}>Size</h3>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, fontSize: 'var(--text-sm)' }}>
            At most
            <input aria-label="Meetings per digest" inputMode="numeric" style={{ ...dateInputStyle, width: 80 }} value={max} onChange={(e) => setMax(e.target.value)} />
            meetings per digest (up to {job.max_meetings_limit})
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, fontSize: 'var(--text-sm)' }}>
            Text per digest
            <select aria-label="Text per digest" style={{ ...dateInputStyle, width: 'auto' }} value={draft.max_characters}
              onChange={(e) => setDraft({ ...draft, max_characters: Number(e.target.value) })}>
              {TEXT_SIZES.includes(draft.max_characters) ? null : (
                <option value={draft.max_characters}>{draft.max_characters.toLocaleString()} characters</option>
              )}
              {TEXT_SIZES.map((n) => <option key={n} value={n}>About {Math.round(n / CHARACTERS_PER_HOUR)} hours of meetings ({n.toLocaleString()} characters)</option>)}
            </select>
          </label>
          <p style={hintStyle}>
            The oldest meetings go first; the rest wait for the next digest. One analysis reads the whole digest, so long
            days are spread over several digests; a full-day meeting is about 250,000 characters. A meeting longer than this
            on its own gets a digest of its own.
          </p>
        </section>

        <section aria-labelledby="md-analysis">
          <h3 id="md-analysis" style={{ ...sectionLabelStyle, margin: 0 }}>Analysis</h3>
          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginTop: 8, fontSize: 'var(--text-sm)', cursor: 'pointer' }}>
            <input type="checkbox" checked={draft.auto_analyze} onChange={(e) => setDraft({ ...draft, auto_analyze: e.target.checked })} style={{ marginTop: 3 }} />
            <span>Analyze each new digest automatically</span>
          </label>
          <p style={hintStyle}>
            As soon as a digest is made, the dashboard runs the analysis with {runner?.label ?? 'Claude Code'} on your own plan, as
            <strong> Run analysis</strong> on the digest&apos;s page does, so the proposals are ready when you look. Nothing changes in
            your context until you approve each proposal. If another run is going, it starts after it; if it cannot start, the
            card says why and you start it yourself.
          </p>
          {draft.auto_analyze && runner && runner.problems.length > 0 && (
            <p role="alert" style={{ ...hintStyle, color: 'var(--color-critical)' }}>{runner.problems[0]!.message}</p>
          )}
        </section>

        {error && <div role="alert" style={{ color: 'var(--color-critical)', fontSize: 'var(--text-sm)' }}>{error}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={saving} onClick={() => void save()}>Save</Button>
        </div>
      </div>
    </Modal>
  );
}
