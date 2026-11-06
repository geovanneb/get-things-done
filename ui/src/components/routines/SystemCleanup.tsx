import { scheduleText } from '@/i18n/serverText';
import { useLanguage } from '@/i18n/LanguageProvider';
import { currentLocale, tr } from '@/i18n/current';
import { rich } from '@/i18n/rich';
import React from 'react';
import Card from '@/components/common/Card';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { Link } from 'react-router-dom';
import Modal from '@/components/common/Modal';
import Button from '@/components/common/Button';
import Badge from '@/components/common/Badge';
import Toggle from '@/components/common/Toggle';
import { Checkbox } from '@/components/common/Input';
import { selectStyle, dateInputStyle, sectionLabelStyle, fieldLabelStyle } from '@/components/task-form/styles';
import { apiPost, apiPut } from '@/utils/api';
import { formatRelativeTime } from '@/utils/format';
import type {
  CleanupAction, CleanupPreview, CleanupRuleType, CleanupSettings, RoutineRun, RoutineSchedule, RoutineWeekday, SystemCleanup,
} from '@/types';

/** What each content type is, in the user's words, and what it may do. Mirrors RULE_ACTIONS on the server. */
export const RULES = (): { type: CleanupRuleType; label: string; hint: string; actions: CleanupAction[]; clock: string }[] => ([
  { type: 'completed_tasks', label: tr('systemCleanup.finishedTasks'), hint: tr('systemCleanup.doneTasksStillOnThe'), actions: ['archive', 'trash', 'delete'], clock: tr('systemCleanup.sinceFinished') },
  { type: 'archived_tasks', label: tr('systemCleanup.archivedTasks'), hint: tr('systemCleanup.insightsStopCountingRemovedTasks'), actions: ['trash', 'delete'], clock: tr('systemCleanup.sinceArchived') },
  { type: 'context_updates', label: tr('systemCleanup.finishedContextUpdates'), hint: tr('systemCleanup.recordsOfDoneUpdatesUpdates'), actions: ['trash', 'delete'], clock: tr('systemCleanup.sinceFinished') },
  { type: 'meetings', label: tr('meetings'), hint: tr('systemCleanup.transcriptsNotesAndKeptRecordings'), actions: ['trash', 'delete'], clock: tr('systemCleanup.sinceTheMeeting') },
  { type: 'kaizen', label: tr('systemCleanup.finishedKaizenNotes'), hint: tr('systemCleanup.notesAlreadyOpenedAsA'), actions: ['trash', 'delete'], clock: tr('systemCleanup.sinceClosed') },
  { type: 'trash', label: tr('systemCleanup.emptyTheTrash'), hint: tr('systemCleanup.removedAndReplacedFilesThe'), actions: ['delete'], clock: tr('systemCleanup.inTheTrash') },
]);

const ACTION_LABEL = (): Record<CleanupAction, string> => ({ archive: tr('systemCleanup.archive'), trash: tr('systemCleanup.moveToTrash'), delete: tr('systemCleanup.deletePermanently') });
const NOUN = (): Record<CleanupRuleType, [string, string]> => ({
  completed_tasks: [tr('systemCleanup.finishedTask'), tr('systemCleanup.finishedTasks2')],
  archived_tasks: [tr('systemCleanup.archivedTask'), tr('systemCleanup.archivedTasks2')],
  context_updates: [tr('systemCleanup.contextUpdateRecord'), tr('systemCleanup.contextUpdateRecords')],
  meetings: ['meeting', 'meetings'],
  kaizen: [tr('systemCleanup.kaizenNote'), tr('systemCleanup.kaizenNotes')],
  trash: [tr('systemCleanup.trashItem'), tr('systemCleanup.trashItems')],
});
const ACTION_PAST = (): Record<CleanupAction, string> => ({ archive: 'archived', trash: tr('meetingsList.movedToTheTrash2'), delete: 'deleted' });

const WEEKDAYS = (): { id: RoutineWeekday; label: string }[] => ([
  { id: 'mon', label: tr('calendarModel.monday') }, { id: 'tue', label: tr('calendarModel.tuesday') }, { id: 'wed', label: tr('calendarModel.wednesday') }, { id: 'thu', label: tr('calendarModel.thursday') },
  { id: 'fri', label: tr('calendarModel.friday') }, { id: 'sat', label: tr('calendarModel.saturday') }, { id: 'sun', label: tr('calendarModel.sunday') },
]);

type Cadence = 'weekly' | 'biweekly' | 'monthly';

function cadenceOf(s: RoutineSchedule): Cadence {
  if (s.frequency === 'monthly') return 'monthly';
  return s.interval === 2 ? 'biweekly' : 'weekly';
}

function weekdayOf(s: RoutineSchedule): RoutineWeekday {
  return s.month_weekday ?? s.weekdays[0] ?? 'mon';
}

function scheduleFor(cadence: Cadence, day: RoutineWeekday, time: string, base: RoutineSchedule): RoutineSchedule {
  const common = { time, starts_on: base.starts_on, ends_on: null, month_day: null };
  if (cadence === 'monthly') return { ...common, frequency: 'monthly', interval: 1, weekdays: [], month_week: 1, month_weekday: day };
  return { ...common, frequency: 'weekly', interval: cadence === 'biweekly' ? 2 : 1, weekdays: [day], month_week: null, month_weekday: null };
}

/** One line on what the job does with files, e.g. "Finished tasks after 30 days: archive". */
export function cleanupSummary(settings: CleanupSettings): string {
  const on = RULES().filter((r) => settings.rules[r.type].enabled);
  if (on.length === 0) return tr('systemCleanup.neverArchivesTrashesOrDeletes');
  const text = on.map((r) => tr('systemCleanup.afterDays', { value: NOUN()[r.type][1], value2: ACTION_PAST()[settings.rules[r.type].action], older_than_days: settings.rules[r.type].older_than_days })).join(', ');
  return text.charAt(0).toUpperCase() + text.slice(1) + '.';
}

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString(currentLocale(), { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function SystemCleanupCard({ job, onEdit, onChanged }: { job: SystemCleanup; onEdit: () => void; onChanged: () => void }) {
  const { t } = useLanguage();
  const [busy, setBusy] = React.useState<'toggle' | 'run' | null>(null);
  const [notice, setNotice] = React.useState<{ text: string; error?: boolean } | null>(null);
  const { settings, state } = job;
  const failed = state.last_status === 'error';

  const act = async (kind: 'toggle' | 'run', fn: () => Promise<string | void>) => {
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
    <Card as="article" padding="compact" id="system-cleanup" aria-label={t('systemCleanup')}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <h3 style={{ margin: 0, fontSize: 'var(--text-base)', fontWeight: 600 }}>{t('systemCleanup')}</h3>
            <Badge size="sm" variant="info">{t('meetingDigest.builtIn')}</Badge>
            {!settings.enabled && <Badge size="sm">{t('meetingDigest.paused')}</Badge>}
            {failed && <Badge variant="critical" size="sm">{t('meetingDigest.lastRunFailed')}</Badge>}
          </div>
          <div style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)', marginTop: 4 }}>
            {scheduleText(job.summary)}.{' '}
            {settings.memory_review.enabled ? t('systemCleanup.reviewsYourMemoryAndSuggests') : t('systemCleanup.memoryReviewIsOff')}{' '}
            {cleanupSummary(settings)}
          </div>
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', marginTop: 6, display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            <span>{rich(t, 'meetingDigest.next', { value: settings.enabled ? (job.next_run_at ? formatWhen(job.next_run_at) : t('meetingDigest.noMoreRuns')) : 'paused' })}</span>
            {state.last_run_at && <span title={state.last_message}>{rich(t, 'meetingDigest.last', { last_run_at: formatRelativeTime(state.last_run_at) })}</span>}
          </div>
          {job.open_review && (
            <div style={{ fontSize: 'var(--text-sm)', marginTop: 8 }}>
              {rich(t, 'systemCleanup.memoryReviewIsWaitingFor', { link: <Link to={`/context/updates/${job.open_review}`} style={{ color: 'var(--color-accent)', fontWeight: 600 }}>{job.open_review}</Link> })}
            </div>
          )}
          {failed && state.last_message && (
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-critical)', marginTop: 6 }}>{state.last_message}</div>
          )}
        </div>
        <Toggle
          label={settings.enabled ? t('systemCleanup.pauseSystemCleanup') : t('systemCleanup.resumeSystemCleanup')}
          checked={settings.enabled}
          disabled={busy !== null}
          onChange={(on) => act('toggle', async () => { await apiPut('/api/routines/system-cleanup', { enabled: on }); })}
        />
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <Button size="sm" variant="secondary" loading={busy === 'run'} disabled={busy !== null}
          title={t('systemCleanup.runItNowWithThe')}
          onClick={() => act('run', async () => (await apiPost<RoutineRun>('/api/routines/system-cleanup/run')).message)}>
          {t('systemCleanup.runNow')}
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

const numberStyle: React.CSSProperties = { ...dateInputStyle, width: 80 };
const hintStyle: React.CSSProperties = { fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', margin: '2px 0 0' };

function daysValue(v: string): number | string {
  return /^\d+$/.test(v.trim()) ? Number(v) : v;
}

export function SystemCleanupEditor({ isOpen, job, onClose, onSaved }: { isOpen: boolean; job: SystemCleanup | null; onClose: () => void; onSaved: () => void }) {
  const { t } = useLanguage();
  const confirm = useConfirm();
  const [draft, setDraft] = React.useState<CleanupSettings | null>(null);
  const [days, setDays] = React.useState<Record<string, string>>({});
  const [preview, setPreview] = React.useState<CleanupPreview | null>(null);
  const [previewing, setPreviewing] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Seed the draft once per opening. The page refetches the job whenever routines or context
  // updates change on disk, and reseeding on every new job object would drop unsaved edits.
  const seeded = React.useRef(false);
  React.useEffect(() => {
    if (!isOpen) { seeded.current = false; return; }
    if (!job || seeded.current) return;
    seeded.current = true;
    setDraft(structuredClone(job.settings));
    setDays(Object.fromEntries([
      ...RULES().map((r) => [r.type, String(job.settings.rules[r.type].older_than_days)]),
      ['stale', String(job.settings.memory_review.stale_after_days)],
      ['max', String(job.settings.max_items_per_run)],
    ]));
    setPreview(null);
    setError(null);
  }, [isOpen, job]);

  if (!job || !draft) return null;

  /** The draft as the API takes it: day fields as typed, so the server explains a bad value. */
  const payload = () => ({
    ...draft,
    memory_review: { ...draft.memory_review, stale_after_days: daysValue(days['stale'] ?? '') },
    max_items_per_run: daysValue(days['max'] ?? ''),
    rules: Object.fromEntries(RULES().map((r) => [r.type, { ...draft.rules[r.type], older_than_days: daysValue(days[r.type] ?? '') }])),
  });

  const setRule = (type: CleanupRuleType, patch: Partial<CleanupSettings['rules'][CleanupRuleType]>) => {
    setDraft({ ...draft, rules: { ...draft.rules, [type]: { ...draft.rules[type], ...patch } } });
    setPreview(null);
  };

  const runPreview = async (): Promise<CleanupPreview | null> => {
    setPreviewing(true);
    setError(null);
    try {
      const p = await apiPost<CleanupPreview>('/api/routines/system-cleanup/preview', { settings: payload() });
      setPreview(p);
      return p;
    } catch (err) {
      setError((err as Error).message);
      return null;
    } finally {
      setPreviewing(false);
    }
  };

  const save = async () => {
    // Permanent deletion that was not on before gets one specific confirmation, with the count from a preview.
    const newlyPermanent = RULES().filter((r) => draft.rules[r.type].enabled && draft.rules[r.type].action === 'delete'
      && !(job.settings.rules[r.type].enabled && job.settings.rules[r.type].action === 'delete'));
    if (newlyPermanent.length) {
      const p = preview ?? await runPreview();
      if (!p) return;
      const lines = newlyPermanent.map((r) => t('systemCleanup.nowOlderThanDays', { label: r.label, value: p.plan.counts[r.type], value2: days[r.type] })).join('\n');
      const ok = await confirm({
        title: t('systemCleanup.deletePermanentlyWithoutTheTrash'),
        message: t('systemCleanup.deletedFilesCannotBeRestored', { lines }),
        confirmLabel: t('systemCleanup.deletePermanently'),
        tone: 'danger',
      });
      if (!ok) return;
    }
    setSaving(true);
    setError(null);
    try {
      await apiPut('/api/routines/system-cleanup', payload());
      onSaved();
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const cadence = cadenceOf(draft.schedule);
  const day = weekdayOf(draft.schedule);
  const setSchedule = (c: Cadence, d: RoutineWeekday, time: string) => setDraft({ ...draft, schedule: scheduleFor(c, d, time, draft.schedule) });

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={t('systemCleanup')} size="lg">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
        <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)' }}>
          {t('systemCleanup.aBuiltInRoutineThat')}
        </p>

        <section aria-labelledby="sc-schedule">
          <h3 id="sc-schedule" style={{ ...sectionLabelStyle, margin: '0 0 8px' }}>{t('meetingDigest.when')}</h3>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-start' }}>
            <label style={{ flex: '1 1 160px' }}>
              <span style={fieldLabelStyle}>{t('systemCleanup.howOften')}</span>
              <select style={selectStyle} value={cadence} onChange={(e) => setSchedule(e.target.value as Cadence, day, draft.schedule.time)}>
                <option value="weekly">{t('systemCleanup.everyWeek')}</option>
                <option value="biweekly">{t('systemCleanup.every2Weeks')}</option>
                <option value="monthly">{t('systemCleanup.everyMonthTheFirst')}</option>
              </select>
            </label>
            <label style={{ flex: '1 1 140px' }}>
              <span style={fieldLabelStyle}>{t('routineEditor.day')}</span>
              <select style={selectStyle} value={day} onChange={(e) => setSchedule(cadence, e.target.value as RoutineWeekday, draft.schedule.time)}>
                {WEEKDAYS().map((w) => <option key={w.id} value={w.id}>{w.label}</option>)}
              </select>
            </label>
            <label style={{ flex: '0 0 120px' }}>
              <span style={fieldLabelStyle}>{t('meetingDigest.time')}</span>
              <input type="time" style={dateInputStyle} value={draft.schedule.time} onChange={(e) => setSchedule(cadence, day, e.target.value || '09:00')} />
            </label>
          </div>
          <p style={hintStyle}>{t('systemCleanup.pickATimeYourComputer')}</p>
        </section>

        <section aria-labelledby="sc-memory">
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
            <div style={{ flex: 1 }}>
              <h3 id="sc-memory" style={{ ...sectionLabelStyle, margin: 0 }}>{t('systemCleanup.memoryReview')}</h3>
              <p style={{ ...hintStyle, fontSize: 'var(--text-sm)' }}>
                {rich(t, 'systemCleanup.scansContextNotesAndStakeholders', { strong: <strong> {t('systemCleanup')}</strong> })}
              </p>
            </div>
            <Toggle label={t('systemCleanup.memoryReview')} checked={draft.memory_review.enabled}
              onChange={(on) => setDraft({ ...draft, memory_review: { ...draft.memory_review, enabled: on } })} />
          </div>
          {draft.memory_review.enabled && (
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, fontSize: 'var(--text-sm)' }}>
              {t('systemCleanup.flagNotesNotUpdatedIn')}
              <input aria-label={t('systemCleanup.daysBeforeANoteCounts')} inputMode="numeric" style={numberStyle} value={days['stale'] ?? ''}
                onChange={(e) => setDays({ ...days, stale: e.target.value })} />
              {t('systemCleanup.daysOrMore')}
            </label>
          )}
        </section>

        <section aria-labelledby="sc-files">
          <h3 id="sc-files" style={{ ...sectionLabelStyle, margin: 0 }}>{t('systemCleanup.fileCleanup')}</h3>
          <p style={{ ...hintStyle, fontSize: 'var(--text-sm)', marginBottom: 8 }}>
            {rich(t, 'systemCleanup.offUnlessYouTurnA', { code: <code style={{ fontFamily: 'var(--font-mono)' }}>{draft.keep_tag || 'keep'}</code> })}
          </p>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {RULES().map((r) => {
              const rule = draft.rules[r.type];
              return (
                <div key={r.type} style={{ display: 'grid', gridTemplateColumns: '44px 1fr', columnGap: 8, rowGap: 6, padding: '10px 0', borderTop: '1px solid var(--color-border)' }}>
                  <Toggle label={t('systemCleanup.cleanUp', { toLowerCase: r.label.toLowerCase() })} checked={rule.enabled} onChange={(on) => setRule(r.type, { enabled: on })} />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 'var(--text-sm)', fontWeight: 600 }}>{r.label}</div>
                    <div style={hintStyle}>{r.hint}</div>
                  </div>
                  {rule.enabled && (
                    <div style={{ gridColumn: 2, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', fontSize: 'var(--text-sm)' }}>
                      {r.actions.length > 1 ? (
                        <select aria-label={t('systemCleanup.action', { label: r.label })} style={{ ...selectStyle, width: 'auto' }} value={rule.action}
                          onChange={(e) => setRule(r.type, { action: e.target.value as CleanupAction })}>
                          {r.actions.map((a) => <option key={a} value={a}>{ACTION_LABEL()[a]}</option>)}
                        </select>
                      ) : <span style={{ fontWeight: 600 }}>{ACTION_LABEL().delete}</span>}
                      {t('systemCleanup.after')}
                      <input aria-label={t('systemCleanup.days', { label: r.label })} inputMode="numeric" style={numberStyle} value={days[r.type] ?? ''}
                        onChange={(e) => { setDays({ ...days, [r.type]: e.target.value }); setPreview(null); }} />
                      {t('systemCleanup.days2')} {r.clock}
                    </div>
                  )}
                  {r.type === 'meetings' && (
                    <div style={{ gridColumn: 2 }}>
                      <Checkbox checked={draft.meetings.keep_text === true}
                        onChange={(on) => { setDraft({ ...draft, meetings: { keep_text: on } }); setPreview(null); }}
                        label={t('systemCleanup.keepMeetingTranscriptsAndNotes')}
                        description={t('systemCleanup.onlyTheMeetingTextNot')} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>

        <details>
          <summary style={{ cursor: 'pointer', fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--color-text-secondary)' }}>{t('systemCleanup.advanced')}</summary>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 10 }}>
            <label style={{ flex: '1 1 200px' }}>
              <span style={fieldLabelStyle}>{t('systemCleanup.protectTasksWithTheTag')}</span>
              <input style={dateInputStyle} value={draft.keep_tag} placeholder="none"
                onChange={(e) => setDraft({ ...draft, keep_tag: e.target.value.trim() })} />
            </label>
            <label style={{ flex: '1 1 200px' }}>
              <span style={fieldLabelStyle}>{t('systemCleanup.atMostThisManyItems')}</span>
              <input inputMode="numeric" style={numberStyle} value={days['max'] ?? ''} onChange={(e) => setDays({ ...days, max: e.target.value })} />
              <p style={hintStyle}>{t('systemCleanup.aSafetyLimitTheRest')}</p>
            </label>
          </div>
        </details>

        <section aria-labelledby="sc-preview" style={{ background: 'var(--color-surface-raised, var(--color-surface))', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', padding: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <h3 id="sc-preview" style={{ ...sectionLabelStyle, margin: 0, flex: 1 }}>{t('systemCleanup.whatARunWouldDo')}</h3>
            <Button size="sm" variant="secondary" loading={previewing} onClick={() => void runPreview()}>{preview ? t('systemCleanup.refresh') : t('preview')}</Button>
          </div>
          {!preview && <p style={hintStyle}>{t('systemCleanup.checkTheseSettingsAgainstYour')}</p>}
          {preview && <PreviewResult preview={preview} settings={draft} />}
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

function PreviewResult({ preview, settings }: { preview: CleanupPreview; settings: CleanupSettings }) {
  const { t } = useLanguage();
  const m = preview.memory;
  const items = preview.plan.items;
  return (
    <div style={{ fontSize: 'var(--text-sm)', marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
      {m && (
        <div>
          <strong>{t('systemCleanup.memoryReview2')}</strong>{' '}
          {preview.open_review
            ? <>{rich(t, 'systemCleanup.isStillOpenSoNo', { open_review: preview.open_review })}</>
            : m.notes + m.stakeholders === 0
            ? t('systemCleanup.noNotesOrStakeholdersYet')
            : t('systemCleanup.previewReview', { notes: m.notes, stakeholders: m.stakeholders, duplicates: m.duplicates.length, stale: m.stale.length, thin: m.thin.length })}
        </div>
      )}
      <div>
        <strong>{t('systemCleanup.files')}</strong>{' '}
        {RULES().every((r) => !settings.rules[r.type].enabled)
          ? t('systemCleanup.noRuleIsOnSo')
          : items.length === 0
          ? t('systemCleanup.nothingIsOldEnoughYet')
          : RULES().filter((r) => settings.rules[r.type].enabled).map((r) => {
            const n = preview.plan.counts[r.type];
            return `${n} ${n === 1 ? NOUN()[r.type][0] : NOUN()[r.type][1]} ${ACTION_PAST()[settings.rules[r.type].action]}`;
          }).join(', ') + '.'}
        {preview.plan.deferred > 0 && t('systemCleanup.moreWouldWaitForThe', { deferred: preview.plan.deferred })}
      </div>
      {items.length > 0 && (
        <ul style={{ margin: 0, paddingLeft: 18, maxHeight: 180, overflow: 'auto', fontSize: 'var(--text-xs)', color: 'var(--color-text-secondary)' }}>
          {items.slice(0, 50).map((i) => (
            <li key={`${i.type}-${i.id}`}>
              <span style={{ fontWeight: 600, color: i.action === 'delete' ? 'var(--color-critical)' : 'var(--color-text)' }}>{ACTION_LABEL()[i.action]}</span>{' '}
              {i.title || i.id} <span style={{ color: 'var(--color-text-muted)' }}>{rich(t, 'systemCleanup.days3', { id: i.id, age_days: i.age_days })}</span>
            </li>
          ))}
          {items.length > 50 && <li>{rich(t, 'dayTooltip.andMore', { value: items.length - 50 })}</li>}
        </ul>
      )}
    </div>
  );
}
