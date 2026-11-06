import { scheduleText } from '@/i18n/serverText';
import { useLanguage } from '@/i18n/LanguageProvider';
import { currentLocale, tr } from '@/i18n/current';
import { rich } from '@/i18n/rich';
import React from 'react';
import Card from '@/components/common/Card';
import { Link } from 'react-router-dom';
import Modal from '@/components/common/Modal';
import Button from '@/components/common/Button';
import Badge from '@/components/common/Badge';
import Toggle from '@/components/common/Toggle';
import { dateInputStyle, sectionLabelStyle, fieldLabelStyle } from '@/components/task-form/styles';
import { apiGet, apiPost, apiPut } from '@/utils/api';
import { formatRelativeTime } from '@/utils/format';
import type { MeetingDigest, MeetingDigestSettings, RoutineRun, RoutineWeekday, RunnerStatus } from '@/types';

const WEEKDAYS = (): { id: RoutineWeekday; short: string }[] => ([
  { id: 'mon', short: tr('yearGrid.mon') }, { id: 'tue', short: tr('calendarModel.tue') }, { id: 'wed', short: tr('yearGrid.wed') }, { id: 'thu', short: tr('calendarModel.thu') },
  { id: 'fri', short: tr('yearGrid.fri') }, { id: 'sat', short: tr('calendarModel.sat') }, { id: 'sun', short: tr('calendarModel.sun') },
]);

/** Text per digest, in characters of readable text: a meeting averages about 30,000 an hour with its pauses. */
const CHARACTERS_PER_HOUR = 30_000;
const TEXT_SIZES = [100_000, 200_000, 400_000, 800_000, 1_600_000];

const hintStyle: React.CSSProperties = { fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', margin: '2px 0 0' };

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString(currentLocale(), { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function MeetingDigestCard({ job, onEdit, onChanged }: { job: MeetingDigest; onEdit: () => void; onChanged: () => void }) {
  const { t } = useLanguage();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<{ text: string; error?: boolean } | null>(null);
  const { settings, state } = job;
  const failed = state.last_status === 'error';
  const queued = job.queue.filter((m) => m.status === 'queued' && !m.held);
  const held = job.queue.filter((m) => m.held).length;
  const drafts = job.queue.filter((m) => m.status === 'draft').length;
  const hours = Math.max(1, Math.round(settings.max_characters / CHARACTERS_PER_HOUR));

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
    <Card as="article" padding="compact" id="meeting-digest" aria-label={t('meetingDigest.meetingDigest')}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <h3 style={{ margin: 0, fontSize: 'var(--text-base)', fontWeight: 600 }}>{t('meetingDigest.meetingDigest')}</h3>
            <Badge size="sm" variant="info">{t('meetingDigest.builtIn')}</Badge>
            {!settings.enabled && <Badge size="sm">{t('meetingDigest.paused')}</Badge>}
            {failed && <Badge variant="critical" size="sm">{t('meetingDigest.lastRunFailed')}</Badge>}
          </div>
          <div style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)', marginTop: 4 }}>
            {rich(t, 'meetingDigest.collectsTheMeetingsYouQueued', { summary: scheduleText(job.summary), max_meetings: settings.max_meetings, hours: t('meetingDigest.hoursCount', { count: hours }), value2: settings.after_each_meeting ? t('meetingDigest.alsoRightAfterEachMeeting') : '', value3: settings.auto_analyze ? t('meetingDigest.eachNewDigestIsAnalyzed') : '' })}
          </div>
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', marginTop: 6, display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            <span>{rich(t, 'meetingDigest.next', { value: settings.enabled ? (job.next_run_at ? formatWhen(job.next_run_at) : t('meetingDigest.noMoreRuns')) : 'paused' })}</span>
            {state.last_run_at && <span title={state.last_message}>{rich(t, 'meetingDigest.last', { last_run_at: formatRelativeTime(state.last_run_at) })}</span>}
            <span>{queued.length === 0 ? t('meetingDigest.queueEmpty') : t('meetingDigest.meetingsQueued', { count: queued.length })}{held > 0 ? t('meetingDigest.onHold', { held }) : ''}{drafts > 0 ? t('meetingDigest.notQueued', { drafts }) : ''}</span>
          </div>
          {job.open_digest && (
            <div style={{ fontSize: 'var(--text-sm)', marginTop: 8 }}>
              {rich(t, 'meetingDigest.digestIsWaitingForYou', { link: <Link to={`/context/updates/${job.open_digest}`} style={{ color: 'var(--color-accent)', fontWeight: 600 }}>{job.open_digest}</Link> })}
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
          <div style={{ fontSize: 'var(--text-sm)', marginTop: 8 }}>
            {rich(t, 'meetingDigest.toRecordAndToSee', { link: <Link to="/meetings" style={{ color: 'var(--color-accent)' }}>{t('meetingDigest.openMeetings')}</Link> })}
          </div>
        </div>
        <Toggle
          label={settings.enabled ? t('meetingDigest.pauseMeetingDigest') : t('meetingDigest.resumeMeetingDigest')}
          checked={settings.enabled}
          disabled={busy !== null}
          onChange={(on) => act('toggle', async () => { await apiPut('/api/routines/meeting-digest', { enabled: on }); })}
        />
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <Button size="sm" variant="secondary" loading={busy === 'run'} disabled={busy !== null || queued.length === 0}
          title={queued.length === 0 ? t('meetingDigest.theQueueIsEmpty') : t('meetingDigest.makeADigestFromThe')}
          onClick={() => act('run', async () => (await apiPost<RoutineRun>('/api/routines/meeting-digest/run')).message)}>
          {t('meetingDigest.makeDigestNow')}
        </Button>
        <Button size="sm" variant="ghost" onClick={onEdit} disabled={busy !== null}>{t('settings')}</Button>
        {notice && (
          <span role={notice.error ? 'alert' : 'status'} style={{ fontSize: 'var(--text-xs)', color: notice.error ? 'var(--color-critical)' : 'var(--color-text-muted)' }}>
            {notice.text}
          </span>
        )}
      </div>
    </Card>
  );
}

export function MeetingDigestEditor({ isOpen, job, onClose, onSaved }: { isOpen: boolean; job: MeetingDigest | null; onClose: () => void; onSaved: () => void }) {
  const { t } = useLanguage();
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
    setDraft({ ...draft, schedule: { ...draft.schedule, frequency: 'weekly', interval: 1, weekdays: WEEKDAYS().map((w) => w.id).filter((d) => next.includes(d)), month_week: null, month_weekday: null, month_day: null } });
  };

  const save = async () => {
    if (days.length === 0) { setError(t('meetingDigest.pickAtLeastOneDay')); return; }
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
    <Modal isOpen={isOpen} onClose={onClose} title={t('meetingDigest.meetingDigest')} size="md">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
        <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)' }}>
          {rich(t, 'meetingDigest.aBuiltInRoutineFor', { strong: <strong>{t('meetings')}</strong>, strong2: <strong>{t('meetingDigest.import')}</strong> })}
        </p>

        <section aria-labelledby="md-schedule">
          <h3 id="md-schedule" style={{ ...sectionLabelStyle, margin: '0 0 8px' }}>{t('meetingDigest.when')}</h3>
          <div role="group" aria-label={t('meetingDigest.days')} style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {WEEKDAYS().map((w) => (
              <label key={w.id} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 'var(--text-sm)', padding: '4px 8px', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm)', cursor: 'pointer' }}>
                <input type="checkbox" checked={days.includes(w.id)} onChange={() => toggleDay(w.id)} />
                {w.short}
              </label>
            ))}
          </div>
          <label style={{ display: 'block', marginTop: 10, width: 120 }}>
            <span style={fieldLabelStyle}>{t('meetingDigest.time')}</span>
            <input type="time" style={dateInputStyle} value={draft.schedule.time}
              onChange={(e) => setDraft({ ...draft, schedule: { ...draft.schedule, time: e.target.value || '18:00' } })} />
          </label>
          <p style={hintStyle}>
            {t('meetingDigest.afterYourLastMeetingOf')}
          </p>
          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginTop: 10, fontSize: 'var(--text-sm)', cursor: 'pointer' }}>
            <input type="checkbox" checked={draft.after_each_meeting} onChange={(e) => setDraft({ ...draft, after_each_meeting: e.target.checked })} style={{ marginTop: 3 }} />
            <span>{t('meetingDigest.alsoMakeADigestRight')}</span>
          </label>
          <p style={hintStyle}>
            {t('meetingDigest.withinAMinuteOfA')}
          </p>
        </section>

        <section aria-labelledby="md-size">
          <h3 id="md-size" style={{ ...sectionLabelStyle, margin: 0 }}>{t('meetingDigest.size')}</h3>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, fontSize: 'var(--text-sm)' }}>
            {t('meetingDigest.atMost')}
            <input aria-label={t('meetingDigest.meetingsPerDigest')} inputMode="numeric" style={{ ...dateInputStyle, width: 80 }} value={max} onChange={(e) => setMax(e.target.value)} />
            {t('meetingDigest.meetingsPerDigestUpTo')} {job.max_meetings_limit})
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, fontSize: 'var(--text-sm)' }}>
            {t('meetingDigest.textPerDigest')}
            <select aria-label={t('meetingDigest.textPerDigest')} style={{ ...dateInputStyle, width: 'auto' }} value={draft.max_characters}
              onChange={(e) => setDraft({ ...draft, max_characters: Number(e.target.value) })}>
              {TEXT_SIZES.includes(draft.max_characters) ? null : (
                <option value={draft.max_characters}>{rich(t, 'meetingDigest.characters', { toLocaleString: draft.max_characters.toLocaleString(currentLocale()) })}</option>
              )}
              {TEXT_SIZES.map((n) => <option key={n} value={n}>{rich(t, 'meetingDigest.aboutHoursOfMeetingsCharacters', { round: Math.round(n / CHARACTERS_PER_HOUR), toLocaleString: n.toLocaleString(currentLocale()) })}</option>)}
            </select>
          </label>
          <p style={hintStyle}>
            {t('meetingDigest.theOldestMeetingsGoFirst')}
          </p>
        </section>

        <section aria-labelledby="md-analysis">
          <h3 id="md-analysis" style={{ ...sectionLabelStyle, margin: 0 }}>{t('analysisRun.analysis')}</h3>
          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginTop: 8, fontSize: 'var(--text-sm)', cursor: 'pointer' }}>
            <input type="checkbox" checked={draft.auto_analyze} onChange={(e) => setDraft({ ...draft, auto_analyze: e.target.checked })} style={{ marginTop: 3 }} />
            <span>{t('meetingDigest.analyzeEachNewDigestAutomatically')}</span>
          </label>
          <p style={hintStyle}>
            {rich(t, 'meetingDigest.asSoonAsADigest', { label: runner?.label ?? 'Claude Code', strong: <strong> {t('analysisRun.runAnalysis')}</strong> })}
          </p>
          {draft.auto_analyze && runner && runner.problems.length > 0 && (
            <p role="alert" style={{ ...hintStyle, color: 'var(--color-critical)' }}>{runner.problems[0]!.message}</p>
          )}
        </section>

        {error && <div role="alert" style={{ color: 'var(--color-critical)', fontSize: 'var(--text-sm)' }}>{error}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Button variant="ghost" onClick={onClose}>{t('cancel')}</Button>
          <Button variant="primary" loading={saving} onClick={() => void save()}>{t('updateDetail.save')}</Button>
        </div>
      </div>
    </Modal>
  );
}
