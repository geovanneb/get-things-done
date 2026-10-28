import React from 'react';
import { Link } from 'react-router-dom';
import Modal from '@/components/common/Modal';
import Button from '@/components/common/Button';
import Badge from '@/components/common/Badge';
import Toggle from '@/components/common/Toggle';
import { selectStyle, dateInputStyle, sectionLabelStyle, fieldLabelStyle } from '@/components/task-form/styles';
import { apiPost, apiPut } from '@/utils/api';
import { formatRelativeTime } from '@/utils/format';
import type {
  CleanupAction, CleanupPreview, CleanupRuleType, CleanupSettings, RoutineRun, RoutineSchedule, RoutineWeekday, SystemCleanup,
} from '@/types';

/** What each content type is, in the user's words, and what it may do. Mirrors RULE_ACTIONS on the server. */
export const RULES: { type: CleanupRuleType; label: string; hint: string; actions: CleanupAction[]; clock: string }[] = [
  { type: 'completed_tasks', label: 'Finished tasks', hint: 'Done tasks still on the board.', actions: ['archive', 'trash', 'delete'], clock: 'since finished' },
  { type: 'archived_tasks', label: 'Archived tasks', hint: 'Insights stop counting removed tasks.', actions: ['trash', 'delete'], clock: 'since archived' },
  { type: 'context_updates', label: 'Finished context updates', hint: 'Records of done updates. Updates whose materials you kept are skipped.', actions: ['trash', 'delete'], clock: 'since finished' },
  { type: 'kaizen', label: 'Closed kaizen proposals', hint: 'Applied or rejected. Open proposals are never touched.', actions: ['trash', 'delete'], clock: 'since closed' },
  { type: 'trash', label: 'Empty the trash', hint: 'Removed and replaced files the app keeps in .situation-board/trash/.', actions: ['delete'], clock: 'in the trash' },
];

const ACTION_LABEL: Record<CleanupAction, string> = { archive: 'Archive', trash: 'Move to trash', delete: 'Delete permanently' };
const NOUN: Record<CleanupRuleType, [string, string]> = {
  completed_tasks: ['finished task', 'finished tasks'],
  archived_tasks: ['archived task', 'archived tasks'],
  context_updates: ['context update record', 'context update records'],
  kaizen: ['kaizen proposal', 'kaizen proposals'],
  trash: ['trash item', 'trash items'],
};
const ACTION_PAST: Record<CleanupAction, string> = { archive: 'archived', trash: 'moved to the trash', delete: 'deleted' };

const WEEKDAYS: { id: RoutineWeekday; label: string }[] = [
  { id: 'mon', label: 'Monday' }, { id: 'tue', label: 'Tuesday' }, { id: 'wed', label: 'Wednesday' }, { id: 'thu', label: 'Thursday' },
  { id: 'fri', label: 'Friday' }, { id: 'sat', label: 'Saturday' }, { id: 'sun', label: 'Sunday' },
];

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
  const on = RULES.filter((r) => settings.rules[r.type].enabled);
  if (on.length === 0) return 'Never archives, trashes or deletes a file.';
  const text = on.map((r) => `${NOUN[r.type][1]} ${ACTION_PAST[settings.rules[r.type].action]} after ${settings.rules[r.type].older_than_days} days`).join(', ');
  return text.charAt(0).toUpperCase() + text.slice(1) + '.';
}

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

const cardStyle: React.CSSProperties = {
  border: '1px solid var(--color-border)', borderRadius: 'var(--radius-lg)', background: 'var(--color-surface)', padding: 16,
};

export function SystemCleanupCard({ job, onEdit, onChanged }: { job: SystemCleanup; onEdit: () => void; onChanged: () => void }) {
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
    <article id="system-cleanup" style={{ ...cardStyle, opacity: settings.enabled ? 1 : 0.75 }} aria-label="System cleanup">
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <h3 style={{ margin: 0, fontSize: 'var(--text-base)', fontWeight: 600 }}>System cleanup</h3>
            <Badge size="sm" variant="info">Built-in</Badge>
            {!settings.enabled && <Badge size="sm">Paused</Badge>}
            {failed && <Badge variant="critical" size="sm">Last run failed</Badge>}
          </div>
          <div style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)', marginTop: 4 }}>
            {job.summary}.{' '}
            {settings.memory_review.enabled ? 'Reviews your memory and suggests fixes for you to approve.' : 'Memory review is off.'}{' '}
            {cleanupSummary(settings)}
          </div>
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', marginTop: 6, display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            <span>Next: {settings.enabled ? (job.next_run_at ? formatWhen(job.next_run_at) : 'no more runs') : 'paused'}</span>
            {state.last_run_at && <span title={state.last_message}>Last: {formatRelativeTime(state.last_run_at)}</span>}
          </div>
          {job.open_review && (
            <div style={{ fontSize: 'var(--text-sm)', marginTop: 8 }}>
              Memory review <Link to={`/context/updates/${job.open_review}`} style={{ color: 'var(--color-accent)', fontWeight: 600 }}>{job.open_review}</Link> is waiting for you.
              No new review starts until it is done.
            </div>
          )}
          {failed && state.last_message && (
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-critical)', marginTop: 6 }}>{state.last_message}</div>
          )}
        </div>
        <Toggle
          label={settings.enabled ? 'Pause System cleanup' : 'Resume System cleanup'}
          checked={settings.enabled}
          disabled={busy !== null}
          onChange={(on) => act('toggle', async () => { await apiPut('/api/routines/system-cleanup', { enabled: on }); })}
        />
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <Button size="sm" variant="secondary" loading={busy === 'run'} disabled={busy !== null}
          title="Run it now with the saved settings, without waiting for the schedule"
          onClick={() => act('run', async () => (await apiPost<RoutineRun>('/api/routines/system-cleanup/run')).message)}>
          Run now
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

const numberStyle: React.CSSProperties = { ...dateInputStyle, width: 80 };
const hintStyle: React.CSSProperties = { fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', margin: '2px 0 0' };

function daysValue(v: string): number | string {
  return /^\d+$/.test(v.trim()) ? Number(v) : v;
}

export function SystemCleanupEditor({ isOpen, job, onClose, onSaved }: { isOpen: boolean; job: SystemCleanup | null; onClose: () => void; onSaved: () => void }) {
  const [draft, setDraft] = React.useState<CleanupSettings | null>(null);
  const [days, setDays] = React.useState<Record<string, string>>({});
  const [preview, setPreview] = React.useState<CleanupPreview | null>(null);
  const [previewing, setPreviewing] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!isOpen || !job) return;
    setDraft(structuredClone(job.settings));
    setDays(Object.fromEntries([
      ...RULES.map((r) => [r.type, String(job.settings.rules[r.type].older_than_days)]),
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
    rules: Object.fromEntries(RULES.map((r) => [r.type, { ...draft.rules[r.type], older_than_days: daysValue(days[r.type] ?? '') }])),
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
    const newlyPermanent = RULES.filter((r) => draft.rules[r.type].enabled && draft.rules[r.type].action === 'delete'
      && !(job.settings.rules[r.type].enabled && job.settings.rules[r.type].action === 'delete'));
    if (newlyPermanent.length) {
      const p = preview ?? await runPreview();
      if (!p) return;
      const lines = newlyPermanent.map((r) => `- ${r.label}: ${p.plan.counts[r.type]} now, older than ${days[r.type]} days`).join('\n');
      if (!window.confirm(`Delete permanently, without the trash?\n\n${lines}\n\nDeleted files cannot be restored. Choose "Move to trash" to keep a way back.`)) return;
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
    <Modal isOpen={isOpen} onClose={onClose} title="System cleanup" size="lg">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
        <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)' }}>
          A built-in routine that keeps your workspace tidy. By default it only suggests: it reviews your memory and opens a
          context update for you to approve. It archives or removes files only for the rules you turn on below.
        </p>

        <section aria-labelledby="sc-schedule">
          <h3 id="sc-schedule" style={{ ...sectionLabelStyle, margin: '0 0 8px' }}>When</h3>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-start' }}>
            <label style={{ flex: '1 1 160px' }}>
              <span style={fieldLabelStyle}>How often</span>
              <select style={selectStyle} value={cadence} onChange={(e) => setSchedule(e.target.value as Cadence, day, draft.schedule.time)}>
                <option value="weekly">Every week</option>
                <option value="biweekly">Every 2 weeks</option>
                <option value="monthly">Every month, the first</option>
              </select>
            </label>
            <label style={{ flex: '1 1 140px' }}>
              <span style={fieldLabelStyle}>Day</span>
              <select style={selectStyle} value={day} onChange={(e) => setSchedule(cadence, e.target.value as RoutineWeekday, draft.schedule.time)}>
                {WEEKDAYS.map((w) => <option key={w.id} value={w.id}>{w.label}</option>)}
              </select>
            </label>
            <label style={{ flex: '0 0 120px' }}>
              <span style={fieldLabelStyle}>Time</span>
              <input type="time" style={dateInputStyle} value={draft.schedule.time} onChange={(e) => setSchedule(cadence, day, e.target.value || '09:00')} />
            </label>
          </div>
          <p style={hintStyle}>Pick a time your computer is usually on. A missed run happens the next time the dashboard starts, once.</p>
        </section>

        <section aria-labelledby="sc-memory">
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
            <div style={{ flex: 1 }}>
              <h3 id="sc-memory" style={{ ...sectionLabelStyle, margin: 0 }}>Memory review</h3>
              <p style={{ ...hintStyle, fontSize: 'var(--text-sm)' }}>
                Scans context notes and stakeholders for duplicates, empty and old notes, and opens a context update marked
                <strong> System cleanup</strong>. Run the analyze command on it, and an agent proposes merges, moves and removals.
                Nothing changes until you approve. One review at a time.
              </p>
            </div>
            <Toggle label="Memory review" checked={draft.memory_review.enabled}
              onChange={(on) => setDraft({ ...draft, memory_review: { ...draft.memory_review, enabled: on } })} />
          </div>
          {draft.memory_review.enabled && (
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, fontSize: 'var(--text-sm)' }}>
              Flag notes not updated in
              <input aria-label="Days before a note counts as old" inputMode="numeric" style={numberStyle} value={days['stale'] ?? ''}
                onChange={(e) => setDays({ ...days, stale: e.target.value })} />
              days or more
            </label>
          )}
        </section>

        <section aria-labelledby="sc-files">
          <h3 id="sc-files" style={{ ...sectionLabelStyle, margin: 0 }}>File cleanup</h3>
          <p style={{ ...hintStyle, fontSize: 'var(--text-sm)', marginBottom: 8 }}>
            Off unless you turn a rule on. Only finished items are touched, each counted from its own date. "Move to trash"
            keeps a way back; "Delete permanently" does not. Tasks tagged <code style={{ fontFamily: 'var(--font-mono)' }}>{draft.keep_tag || 'keep'}</code> are never touched.
          </p>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {RULES.map((r) => {
              const rule = draft.rules[r.type];
              return (
                <div key={r.type} style={{ display: 'grid', gridTemplateColumns: '44px 1fr', columnGap: 8, rowGap: 6, padding: '10px 0', borderTop: '1px solid var(--color-border)' }}>
                  <Toggle label={`Clean up ${r.label.toLowerCase()}`} checked={rule.enabled} onChange={(on) => setRule(r.type, { enabled: on })} />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 'var(--text-sm)', fontWeight: 600 }}>{r.label}</div>
                    <div style={hintStyle}>{r.hint}</div>
                  </div>
                  {rule.enabled && (
                    <div style={{ gridColumn: 2, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', fontSize: 'var(--text-sm)' }}>
                      {r.actions.length > 1 ? (
                        <select aria-label={`${r.label}: action`} style={{ ...selectStyle, width: 'auto' }} value={rule.action}
                          onChange={(e) => setRule(r.type, { action: e.target.value as CleanupAction })}>
                          {r.actions.map((a) => <option key={a} value={a}>{ACTION_LABEL[a]}</option>)}
                        </select>
                      ) : <span style={{ fontWeight: 600 }}>{ACTION_LABEL.delete}</span>}
                      after
                      <input aria-label={`${r.label}: days`} inputMode="numeric" style={numberStyle} value={days[r.type] ?? ''}
                        onChange={(e) => { setDays({ ...days, [r.type]: e.target.value }); setPreview(null); }} />
                      days {r.clock}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>

        <details>
          <summary style={{ cursor: 'pointer', fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--color-text-secondary)' }}>Advanced</summary>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 10 }}>
            <label style={{ flex: '1 1 200px' }}>
              <span style={fieldLabelStyle}>Protect tasks with the tag</span>
              <input style={dateInputStyle} value={draft.keep_tag} placeholder="none"
                onChange={(e) => setDraft({ ...draft, keep_tag: e.target.value.trim() })} />
            </label>
            <label style={{ flex: '1 1 200px' }}>
              <span style={fieldLabelStyle}>At most this many items per run</span>
              <input inputMode="numeric" style={numberStyle} value={days['max'] ?? ''} onChange={(e) => setDays({ ...days, max: e.target.value })} />
              <p style={hintStyle}>A safety limit. The rest wait for the next run.</p>
            </label>
          </div>
        </details>

        <section aria-labelledby="sc-preview" style={{ background: 'var(--color-surface-raised, var(--color-surface))', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', padding: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <h3 id="sc-preview" style={{ ...sectionLabelStyle, margin: 0, flex: 1 }}>What a run would do now</h3>
            <Button size="sm" variant="secondary" loading={previewing} onClick={() => void runPreview()}>{preview ? 'Refresh' : 'Preview'}</Button>
          </div>
          {!preview && <p style={hintStyle}>Check these settings against your workspace before saving. A preview changes nothing.</p>}
          {preview && <PreviewResult preview={preview} settings={draft} />}
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

function PreviewResult({ preview, settings }: { preview: CleanupPreview; settings: CleanupSettings }) {
  const m = preview.memory;
  const items = preview.plan.items;
  return (
    <div style={{ fontSize: 'var(--text-sm)', marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
      {m && (
        <div>
          <strong>Memory review:</strong>{' '}
          {preview.open_review
            ? <>{preview.open_review} is still open, so no new review would start.</>
            : m.notes + m.stakeholders === 0
            ? 'no notes or stakeholders yet, so nothing to review.'
            : <>would open a review of {m.notes} notes and {m.stakeholders} stakeholders. The scan found {m.duplicates.length} possible
              duplicate{m.duplicates.length === 1 ? '' : 's'}, {m.stale.length} old and {m.thin.length} empty note{m.thin.length === 1 ? '' : 's'}.</>}
        </div>
      )}
      <div>
        <strong>Files:</strong>{' '}
        {RULES.every((r) => !settings.rules[r.type].enabled)
          ? 'no rule is on, so no file would change.'
          : items.length === 0
          ? 'nothing is old enough yet.'
          : RULES.filter((r) => settings.rules[r.type].enabled).map((r) => {
            const n = preview.plan.counts[r.type];
            return `${n} ${n === 1 ? NOUN[r.type][0] : NOUN[r.type][1]} ${ACTION_PAST[settings.rules[r.type].action]}`;
          }).join(', ') + '.'}
        {preview.plan.deferred > 0 && ` ${preview.plan.deferred} more would wait for the next run.`}
      </div>
      {items.length > 0 && (
        <ul style={{ margin: 0, paddingLeft: 18, maxHeight: 180, overflow: 'auto', fontSize: 'var(--text-xs)', color: 'var(--color-text-secondary)' }}>
          {items.slice(0, 50).map((i) => (
            <li key={`${i.type}-${i.id}`}>
              <span style={{ fontWeight: 600, color: i.action === 'delete' ? 'var(--color-critical)' : 'var(--color-text)' }}>{ACTION_LABEL[i.action]}</span>{' '}
              {i.title || i.id} <span style={{ color: 'var(--color-text-muted)' }}>({i.id}, {i.age_days} days)</span>
            </li>
          ))}
          {items.length > 50 && <li>and {items.length - 50} more</li>}
        </ul>
      )}
    </div>
  );
}
