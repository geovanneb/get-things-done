import React from 'react';
import Modal from '@/components/common/Modal';
import Button from '@/components/common/Button';
import MentionTextarea from '@/components/common/MentionTextarea';
import StakeholderPicker from '@/components/task-form/StakeholderPicker';
import DeliverableList from '@/components/task-form/DeliverableList';
import { DeliverableItem } from '@/components/task-form/DeliverableRow';
import { selectStyle, dateInputStyle, textareaStyle, sectionLabelStyle, fieldLabelStyle } from '@/components/task-form/styles';
import { apiGet, apiPatch, apiPost } from '@/utils/api';
import { formatPriorityLabel } from '@/utils/format';
import { useApi } from '@/hooks/useApi';
import type { ClaudeAgent, Routine, RoutinePreview, RoutineSchedule, RoutineWeekday, Stakeholder } from '@/types';

const WEEKDAYS: { id: RoutineWeekday; short: string; long: string }[] = [
  { id: 'mon', short: 'M', long: 'Monday' },
  { id: 'tue', short: 'T', long: 'Tuesday' },
  { id: 'wed', short: 'W', long: 'Wednesday' },
  { id: 'thu', short: 'T', long: 'Thursday' },
  { id: 'fri', short: 'F', long: 'Friday' },
  { id: 'sat', short: 'S', long: 'Saturday' },
  { id: 'sun', short: 'S', long: 'Sunday' },
];
const ORDINALS = [
  { value: 1, label: 'first' }, { value: 2, label: 'second' }, { value: 3, label: 'third' },
  { value: 4, label: 'fourth' }, { value: -1, label: 'last' },
];

interface Draft {
  title: string;
  enabled: boolean;
  catch_up: Routine['catch_up'];
  paused_until: string;
  preferred_agent: string;
  frequency: RoutineSchedule['frequency'];
  interval: string;
  weekdays: RoutineWeekday[];
  monthlyBy: 'day' | 'weekday';
  month_day: string;
  month_week: number;
  month_weekday: RoutineWeekday;
  time: string;
  starts_on: string;
  ends_on: string;
  taskTitle: string;
  priority: Routine['task']['priority'];
  status: Routine['task']['status'];
  tags: string;
  due_offset_days: string;
  body: string;
  deliverables: DeliverableItem[];
}

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function weekdayOf(date: string): RoutineWeekday {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return WEEKDAYS[(new Date(y, m - 1, d).getDay() + 6) % 7]!.id;
}

function emptyDraft(): Draft {
  const start = today();
  return {
    title: '', enabled: true, catch_up: 'latest', paused_until: '', preferred_agent: '',
    frequency: 'weekly', interval: '1', weekdays: [weekdayOf(start)], monthlyBy: 'day',
    month_day: String(Number(start.slice(8))), month_week: 1, month_weekday: weekdayOf(start),
    time: '09:00', starts_on: start, ends_on: '',
    taskTitle: '', priority: 'medium', status: 'backlog', tags: '', due_offset_days: '', body: '', deliverables: [],
  };
}

function fromRoutine(r: Routine): Draft {
  const s = r.schedule;
  return {
    title: r.title, enabled: r.enabled, catch_up: r.catch_up, paused_until: r.paused_until ?? '', preferred_agent: r.task.preferred_agent ?? '',
    frequency: s.frequency, interval: String(s.interval), weekdays: s.weekdays.length ? s.weekdays : [weekdayOf(s.starts_on)],
    monthlyBy: s.month_weekday ? 'weekday' : 'day',
    month_day: String(s.month_day ?? Number(s.starts_on.slice(8))), month_week: s.month_week ?? 1,
    month_weekday: s.month_weekday ?? weekdayOf(s.starts_on),
    time: s.time, starts_on: s.starts_on, ends_on: s.ends_on ?? '',
    taskTitle: r.task.title, priority: r.task.priority, status: r.task.status, tags: r.task.tags.join(', '),
    due_offset_days: r.task.due_offset_days === null ? '' : String(r.task.due_offset_days),
    body: r.task.body, deliverables: r.task.deliverables.map((d) => ({ ...d })),
  };
}

function scheduleOf(d: Draft): Record<string, unknown> {
  const base = { frequency: d.frequency, interval: Number(d.interval), time: d.time, starts_on: d.starts_on, ends_on: d.ends_on || null };
  if (d.frequency === 'weekly') return { ...base, weekdays: d.weekdays };
  if (d.frequency === 'monthly') {
    return d.monthlyBy === 'weekday'
      ? { ...base, month_week: d.month_week, month_weekday: d.month_weekday }
      : { ...base, month_day: Number(d.month_day) };
  }
  return base;
}

/** Common schedules, built from the start date the way calendar apps do. */
function presets(d: Draft): { label: string; apply: Partial<Draft> }[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.starts_on)) return [];
  const wd = weekdayOf(d.starts_on);
  const dayName = WEEKDAYS.find((w) => w.id === wd)!.long;
  return [
    { label: 'Every weekday', apply: { frequency: 'weekly', interval: '1', weekdays: ['mon', 'tue', 'wed', 'thu', 'fri'] } },
    { label: `Weekly on ${dayName}`, apply: { frequency: 'weekly', interval: '1', weekdays: [wd] } },
    { label: `Every 2 weeks on ${dayName}`, apply: { frequency: 'weekly', interval: '2', weekdays: [wd] } },
    { label: `Monthly on day ${Number(d.starts_on.slice(8))}`, apply: { frequency: 'monthly', interval: '1', monthlyBy: 'day', month_day: String(Number(d.starts_on.slice(8))) } },
  ];
}

const fieldStyle: React.CSSProperties = { ...dateInputStyle };
const rowStyle: React.CSSProperties = { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' };
const hintStyle: React.CSSProperties = { fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', marginTop: 4 };

function Field({ label, children, hint, htmlFor }: { label: string; children: React.ReactNode; hint?: string; htmlFor?: string }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <label htmlFor={htmlFor} style={fieldLabelStyle}>{label}</label>
      {children}
      {hint && <div style={hintStyle}>{hint}</div>}
    </div>
  );
}

function formatRun(at: string): string {
  return new Date(at).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

interface RoutineEditorProps {
  isOpen: boolean;
  routine: Routine | null;
  onClose: () => void;
  onSaved: (routine: Routine) => void;
}

export default function RoutineEditor({ isOpen, routine, onClose, onSaved }: RoutineEditorProps) {
  const [draft, setDraft] = React.useState<Draft>(emptyDraft);
  const [stakeholders, setStakeholders] = React.useState<Stakeholder[]>([]);
  const loadedStakeholderIds = React.useRef(new Set<string>());
  const [stakeholdersLoading, setStakeholdersLoading] = React.useState(false);
  const [preview, setPreview] = React.useState<RoutinePreview | null>(null);
  const [previewError, setPreviewError] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState('');
  const { data: agents } = useApi<ClaudeAgent[]>('/api/agents');
  const ids = { pause: React.useId(), agent: React.useId(), name: React.useId(), task: React.useId(), time: React.useId(), start: React.useId(), end: React.useId(), every: React.useId(), due: React.useId(), tags: React.useId() };

  React.useEffect(() => {
    if (!isOpen) return;
    setDraft(routine ? fromRoutine(routine) : emptyDraft());
    setError('');
    let cancelled = false;
    setStakeholders([]);
    loadedStakeholderIds.current = new Set();
    setStakeholdersLoading(Boolean(routine?.task.stakeholders.length));
    if (routine?.task.stakeholders.length) {
      const refs = new Set(routine.task.stakeholders.map((s) => s.ref));
      apiGet<Stakeholder[]>('/api/stakeholders')
        .then((all) => {
          if (!cancelled) {
            loadedStakeholderIds.current = new Set((all ?? []).map((s) => s.id));
            setStakeholders((all ?? []).filter((s) => refs.has(s.id)));
            setStakeholdersLoading(false);
          }
        })
        .catch((err: Error) => { if (!cancelled) setError(`Could not load stakeholders: ${err.message}. Reopen this routine to retry.`); });
    }
    return () => { cancelled = true; };
  }, [isOpen, routine]);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((prev) => ({ ...prev, [key]: value }));

  // Live summary and next runs, computed by the same code that runs the routine.
  const scheduleKey = JSON.stringify([scheduleOf(draft), draft.due_offset_days, draft.paused_until]);
  React.useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      apiPost<RoutinePreview>('/api/routines/preview', { schedule: scheduleOf(draft), due_offset_days: draft.due_offset_days, paused_until: draft.paused_until || null })
        .then((p) => { if (!cancelled) { setPreview(p); setPreviewError(''); } })
        .catch((err: Error) => { if (!cancelled) { setPreview(null); setPreviewError(err.message); } });
    }, 250);
    return () => { cancelled = true; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, scheduleKey]);

  const toggleWeekday = (id: RoutineWeekday) => {
    const next = draft.weekdays.includes(id) ? draft.weekdays.filter((d) => d !== id) : [...draft.weekdays, id];
    set('weekdays', next);
  };

  const handleSave = async () => {
    if (stakeholdersLoading) return;
    if (!draft.taskTitle.trim()) { setError('Give the task a title.'); return; }
    setSaving(true);
    setError('');
    const payload = {
      title: draft.title.trim(),
      enabled: draft.enabled,
      catch_up: draft.catch_up,
      paused_until: draft.paused_until || null,
      schedule: scheduleOf(draft),
      task: {
        title: draft.taskTitle.trim(),
        priority: draft.priority,
        status: draft.status,
        tags: draft.tags.split(',').map((t) => t.trim()).filter(Boolean),
        due_offset_days: draft.due_offset_days === '' ? null : Number(draft.due_offset_days),
        body: draft.body,
        preferred_agent: draft.preferred_agent || null,
        // Not editable here yet: keep what the routine file already says (set by hand or by an agent).
        task_type: routine?.task.task_type ?? 'ad_hoc',
        contexts: routine?.task.contexts ?? [],
        confidentiality: routine?.task.confidentiality ?? null,
        stakeholders: [
          ...stakeholders.map((s) => routine?.task.stakeholders.find((existing) => existing.ref === s.id)
            ?? { ref: s.id, role: 'stakeholder', key: false }),
          // Keep references to deleted/missing stakeholders when editing unrelated fields.
          ...(routine?.task.stakeholders.filter((s) => !stakeholders.some((selected) => selected.id === s.ref)
            && !loadedStakeholderIds.current.has(s.ref)) ?? []),
        ],
        deliverables: draft.deliverables.map((d) => ({ format: d.format, template_ref: d.template_ref })),
      },
    };
    try {
      const saved = routine
        ? await apiPatch<Routine>(`/api/routines/${routine.id}`, payload)
        : await apiPost<Routine>('/api/routines', payload);
      onSaved(saved);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const chip = (active: boolean): React.CSSProperties => ({
    padding: '4px 10px', borderRadius: 'var(--radius-full, 999px)', fontSize: 'var(--text-xs)', cursor: 'pointer',
    border: `1px solid ${active ? 'var(--color-accent)' : 'var(--color-border-strong)'}`,
    background: active ? 'var(--color-accent-subtle)' : 'var(--color-surface)',
    color: active ? 'var(--color-accent)' : 'var(--color-text-secondary)',
    fontWeight: 500,
  });

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={routine ? `Edit routine ${routine.id}` : 'New routine'} size="xl">
      <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', maxHeight: '70vh', overflowY: 'auto', paddingRight: 4 }}>
        {/* Task the routine creates */}
        <div style={{ flex: '1 1 380px', minWidth: 0 }}>
          <h3 style={{ ...sectionLabelStyle, marginBottom: 12 }}>Task it creates</h3>
          <Field label="Task title" htmlFor={ids.task} hint="You can use {{date}} for the scheduled run date and {{due_date}} for the due date (YYYY-MM-DD).">
            <input id={ids.task} style={fieldStyle} value={draft.taskTitle} placeholder="Prepare steering sync ({{due_date}})"
              onChange={(e) => set('taskTitle', e.target.value)} />
          </Field>
          <Field label="Objective" hint="Copied into every task as written. Type @ to mention a stakeholder, template, context note or task.">
            <MentionTextarea rows={5} style={textareaStyle} value={draft.body} placeholder="What the task is for, what to bring, what good looks like."
              onChange={(v) => set('body', v)} />
          </Field>
          <div style={{ display: 'flex', gap: 12 }}>
            <div style={{ flex: 1 }}>
              <Field label="Priority">
                <select aria-label="Priority" style={selectStyle} value={draft.priority} onChange={(e) => set('priority', e.target.value as Draft['priority'])}>
                  {(['critical', 'high', 'medium', 'low'] as const).map((p) => <option key={p} value={p}>{formatPriorityLabel(p)}</option>)}
                </select>
              </Field>
            </div>
            <div style={{ flex: 1 }}>
              <Field label="Lands in">
                <select aria-label="Lands in" style={selectStyle} value={draft.status} onChange={(e) => set('status', e.target.value as Draft['status'])}>
                  <option value="backlog">Backlog</option>
                  <option value="ready">Ready</option>
                </select>
              </Field>
            </div>
          </div>
          <Field label="Due" htmlFor={ids.due}>
            <div style={rowStyle}>
              <select aria-label="Due date" style={{ ...selectStyle, width: 'auto' }} value={draft.due_offset_days === '' ? 'none' : 'offset'}
                onChange={(e) => set('due_offset_days', e.target.value === 'none' ? '' : (draft.due_offset_days || '0'))}>
                <option value="none">No due date</option>
                <option value="offset">Due after the run</option>
              </select>
              {draft.due_offset_days !== '' && (
                <>
                  <input id={ids.due} type="number" min={0} max={365} style={{ ...fieldStyle, width: 80 }} value={draft.due_offset_days}
                    onChange={(e) => set('due_offset_days', e.target.value)} />
                  <span style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)' }}>days later (0 = same day)</span>
                </>
              )}
            </div>
          </Field>
          <Field label="Preferred agent" htmlFor={ids.agent} hint="Optional. The agent that should work on each task.">
            <select id={ids.agent} style={selectStyle} value={draft.preferred_agent} onChange={(e) => set('preferred_agent', e.target.value)}>
              <option value="">No preference</option>
              {draft.preferred_agent && !(agents ?? []).some((a) => a.name === draft.preferred_agent) && (
                <option value={draft.preferred_agent}>{draft.preferred_agent}</option>
              )}
              {(agents ?? []).map((a) => <option key={a.name} value={a.name}>{a.name}</option>)}
            </select>
          </Field>
          <Field label="Tags" htmlFor={ids.tags} hint="Separate with commas.">
            <input id={ids.tags} style={fieldStyle} value={draft.tags} placeholder="meeting-prep" onChange={(e) => set('tags', e.target.value)} />
          </Field>
          <div style={{ marginBottom: 14 }}>
            <StakeholderPicker
              selected={stakeholders}
              onAdd={(s) => setStakeholders((prev) => [...prev, s])}
              onRemove={(id) => setStakeholders((prev) => prev.filter((s) => s.id !== id))}
            />
          </div>
          <DeliverableList
            items={draft.deliverables}
            onChange={(i, patch) => set('deliverables', draft.deliverables.map((d, j) => (j === i ? { ...d, ...patch } : d)))}
            onRemove={(i) => set('deliverables', draft.deliverables.filter((_, j) => j !== i))}
            onAdd={() => set('deliverables', [...draft.deliverables, { id: `DEL-${String(draft.deliverables.length + 1).padStart(2, '0')}` }])}
            label="Output type"
            emptyText="No outputs defined yet."
          />
        </div>

        {/* Schedule */}
        <div style={{ flex: '1 1 340px', minWidth: 0 }}>
          <h3 style={{ ...sectionLabelStyle, marginBottom: 12 }}>Schedule</h3>
          <div style={{ ...rowStyle, marginBottom: 14 }} role="group" aria-label="Common schedules">
            {presets(draft).map((p) => (
              <button key={p.label} type="button" style={chip(false)} onClick={() => setDraft((prev) => ({ ...prev, ...p.apply }))}>{p.label}</button>
            ))}
          </div>

          <Field label="Repeat every" htmlFor={ids.every}>
            <div style={rowStyle}>
              <input id={ids.every} type="number" min={1} max={99} style={{ ...fieldStyle, width: 72 }} value={draft.interval}
                onChange={(e) => set('interval', e.target.value)} />
              <select aria-label="Unit" style={{ ...selectStyle, width: 'auto' }} value={draft.frequency}
                onChange={(e) => set('frequency', e.target.value as Draft['frequency'])}>
                <option value="daily">{draft.interval === '1' ? 'day' : 'days'}</option>
                <option value="weekly">{draft.interval === '1' ? 'week' : 'weeks'}</option>
                <option value="monthly">{draft.interval === '1' ? 'month' : 'months'}</option>
              </select>
            </div>
          </Field>

          {draft.frequency === 'weekly' && (
            <Field label="On">
              <div style={rowStyle} role="group" aria-label="Days of the week">
                {WEEKDAYS.map((w) => (
                  <button key={w.id} type="button" aria-pressed={draft.weekdays.includes(w.id)} aria-label={w.long} title={w.long}
                    style={{ ...chip(draft.weekdays.includes(w.id)), width: 32, height: 32, padding: 0 }} onClick={() => toggleWeekday(w.id)}>
                    {w.short}
                  </button>
                ))}
              </div>
            </Field>
          )}

          {draft.frequency === 'monthly' && (
            <Field label="On">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <label style={{ ...rowStyle, fontSize: 'var(--text-sm)' }}>
                  <input type="radio" checked={draft.monthlyBy === 'day'} onChange={() => set('monthlyBy', 'day')} />
                  Day
                  <select aria-label="Day of the month" style={{ ...selectStyle, width: 'auto' }} value={draft.month_day} disabled={draft.monthlyBy !== 'day'}
                    onChange={(e) => set('month_day', e.target.value)}>
                    {Array.from({ length: 31 }, (_, i) => <option key={i + 1} value={String(i + 1)}>{i + 1}</option>)}
                    <option value="-1">last day</option>
                  </select>
                </label>
                <label style={{ ...rowStyle, fontSize: 'var(--text-sm)' }}>
                  <input type="radio" checked={draft.monthlyBy === 'weekday'} onChange={() => set('monthlyBy', 'weekday')} />
                  The
                  <select aria-label="Which week" style={{ ...selectStyle, width: 'auto' }} value={draft.month_week} disabled={draft.monthlyBy !== 'weekday'}
                    onChange={(e) => set('month_week', Number(e.target.value))}>
                    {ORDINALS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                  <select aria-label="Weekday" style={{ ...selectStyle, width: 'auto' }} value={draft.month_weekday} disabled={draft.monthlyBy !== 'weekday'}
                    onChange={(e) => set('month_weekday', e.target.value as RoutineWeekday)}>
                    {WEEKDAYS.map((w) => <option key={w.id} value={w.id}>{w.long}</option>)}
                  </select>
                </label>
              </div>
            </Field>
          )}

          <div style={{ display: 'flex', gap: 12 }}>
            <div style={{ flex: 1 }}>
              <Field label="At" htmlFor={ids.time}>
                <input id={ids.time} type="time" style={fieldStyle} value={draft.time} onChange={(e) => set('time', e.target.value)} />
              </Field>
            </div>
            <div style={{ flex: 1 }}>
              <Field label="Starts" htmlFor={ids.start}>
                <input id={ids.start} type="date" style={fieldStyle} value={draft.starts_on} onChange={(e) => set('starts_on', e.target.value)} />
              </Field>
            </div>
            <div style={{ flex: 1 }}>
              <Field label="Ends" htmlFor={ids.end} hint={draft.ends_on ? undefined : 'Never'}>
                <input id={ids.end} type="date" style={fieldStyle} value={draft.ends_on} onChange={(e) => set('ends_on', e.target.value)} />
              </Field>
            </div>
          </div>

          <Field label="If runs were missed while the computer was off">
            <select aria-label="Missed runs" style={selectStyle} value={draft.catch_up} onChange={(e) => set('catch_up', e.target.value as Draft['catch_up'])}>
              <option value="latest">Create only the latest (recommended)</option>
              <option value="all">Create each missed run (up to the latest 12)</option>
              <option value="skip">Skip them (only create on the scheduled day)</option>
            </select>
          </Field>

          <Field label="Pause until" htmlFor={ids.pause} hint={draft.paused_until ? 'Runs before this day are skipped, not caught up. It resumes on its own.' : 'Optional. For a long absence.'}>
            <input id={ids.pause} type="date" style={fieldStyle} value={draft.paused_until} onChange={(e) => set('paused_until', e.target.value)} />
          </Field>

          <Field label="Routine name" htmlFor={ids.name} hint="Optional. Defaults to the task title.">
            <input id={ids.name} style={fieldStyle} value={draft.title} placeholder="Steering sync prep" onChange={(e) => set('title', e.target.value)} />
          </Field>

          <div aria-live="polite" style={{ padding: 12, borderRadius: 'var(--radius-md)', background: 'var(--color-bg)', border: '1px solid var(--color-border)' }}>
            {previewError ? (
              <div style={{ fontSize: 'var(--text-sm)', color: 'var(--color-critical)' }}>{previewError}</div>
            ) : preview ? (
              <>
                <div style={{ fontSize: 'var(--text-sm)', fontWeight: 600, marginBottom: 8 }}>
                  {preview.summary}
                  {draft.due_offset_days !== '' && `, due ${draft.due_offset_days === '0' ? 'the same day' : `${draft.due_offset_days} day${draft.due_offset_days === '1' ? '' : 's'} later`}`}
                </div>
                <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', marginBottom: 4 }}>Next runs</div>
                <ul style={{ listStyle: 'none', margin: 0, padding: 0, fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)' }}>
                  {preview.next_runs.length === 0 && <li>No runs remain within these dates.</li>}
                  {preview.next_runs.map((r) => (
                    <li key={r.at} style={{ padding: '2px 0' }}>
                      {formatRun(r.at)}{r.due_date && <span style={{ color: 'var(--color-text-muted)' }}> · due {r.due_date}</span>}
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <div style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)' }}>Working out the next runs...</div>
            )}
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8, marginTop: 16 }}>
        {error && <span role="alert" style={{ fontSize: 'var(--text-sm)', color: 'var(--color-critical)', marginRight: 'auto' }}>{error}</span>}
        <Button variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
        <Button variant="primary" loading={saving} disabled={stakeholdersLoading} onClick={handleSave}>{routine ? 'Save routine' : 'Create routine'}</Button>
      </div>
    </Modal>
  );
}
