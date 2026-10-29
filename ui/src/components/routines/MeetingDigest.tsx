import React from 'react';
import { Link } from 'react-router-dom';
import Modal from '@/components/common/Modal';
import Button from '@/components/common/Button';
import Badge from '@/components/common/Badge';
import Toggle from '@/components/common/Toggle';
import { dateInputStyle, sectionLabelStyle, fieldLabelStyle } from '@/components/task-form/styles';
import { apiDelete, apiPost, apiPut } from '@/utils/api';
import { formatRelativeTime } from '@/utils/format';
import type { MeetingDigest, MeetingDigestSettings, RoutineRun, RoutineWeekday } from '@/types';

const WEEKDAYS: { id: RoutineWeekday; short: string }[] = [
  { id: 'mon', short: 'Mon' }, { id: 'tue', short: 'Tue' }, { id: 'wed', short: 'Wed' }, { id: 'thu', short: 'Thu' },
  { id: 'fri', short: 'Fri' }, { id: 'sat', short: 'Sat' }, { id: 'sun', short: 'Sun' },
];

const cardStyle: React.CSSProperties = {
  border: '1px solid var(--color-border)', borderRadius: 'var(--radius-lg)', background: 'var(--color-surface)', padding: 16,
};
const hintStyle: React.CSSProperties = { fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', margin: '2px 0 0' };

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function MeetingDigestCard({ job, onEdit, onChanged }: { job: MeetingDigest; onEdit: () => void; onChanged: () => void }) {
  const [busy, setBusy] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<{ text: string; error?: boolean } | null>(null);
  const { settings, state } = job;
  const failed = state.last_status === 'error';
  const queued = job.queue.filter((m) => m.status === 'queued' && !m.held);
  const held = job.queue.filter((m) => m.held).length;
  const drafts = job.queue.filter((m) => m.status === 'draft').length;

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
            {job.summary}. Collects the meetings you queued into one context update, at most {settings.max_meetings} at a time.
            A day without queued meetings makes nothing.
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
            <li key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--text-sm)', padding: '4px 8px', background: 'var(--color-surface-hover)', borderRadius: 'var(--radius-sm)' }}>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>{m.meeting_date}</span>
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.title}</span>
              <span title={m.held ?? undefined} style={{ fontSize: 'var(--text-xs)', color: m.held ? 'var(--color-warning)' : 'var(--color-text-muted)' }}>
                {m.status === 'draft' ? 'uploading' : m.in_digest ? 'going into a digest' : m.held ? 'on hold' : `${m.files.length} file${m.files.length === 1 ? '' : 's'}`}
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
        <Button size="sm" variant="ghost" onClick={onEdit} disabled={busy !== null}>Settings</Button>
        {notice && (
          <span role={notice.error ? 'alert' : 'status'} style={{ fontSize: 'var(--text-xs)', color: notice.error ? 'var(--color-critical)' : 'var(--color-text-muted)' }}>
            {notice.text}
          </span>
        )}
      </div>
    </article>
  );
}

export function MeetingDigestEditor({ isOpen, job, onClose, onSaved }: { isOpen: boolean; job: MeetingDigest | null; onClose: () => void; onSaved: () => void }) {
  const [draft, setDraft] = React.useState<MeetingDigestSettings | null>(null);
  const [max, setMax] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Filled once when the editor opens: the job is fetched again on every queue or update change, and a
  // background refresh must not undo what is being edited.
  const loaded = job !== null;
  const settings = React.useRef(job?.settings);
  settings.current = job?.settings;
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
          below, the queued meetings become one context update. Run the analyze command on it, and an agent drafts a record per
          meeting and proposes context changes for you to approve. No AI runs by itself.
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
        </section>

        <section aria-labelledby="md-size">
          <h3 id="md-size" style={{ ...sectionLabelStyle, margin: 0 }}>Size</h3>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, fontSize: 'var(--text-sm)' }}>
            At most
            <input aria-label="Meetings per digest" inputMode="numeric" style={{ ...dateInputStyle, width: 80 }} value={max} onChange={(e) => setMax(e.target.value)} />
            meetings per digest (up to {job.max_meetings_limit})
          </label>
          <p style={hintStyle}>The oldest meetings go first; the rest wait for the next digest.</p>
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
