import { useDialogFocus } from '@/hooks/useDialogFocus';
import React from 'react';
import ReactDOM from 'react-dom';
import Button from '@/components/common/Button';
import StakeholderPicker from '@/components/task-form/StakeholderPicker';
import DeliverableList from '@/components/task-form/DeliverableList';
import { DeliverableItem } from '@/components/task-form/DeliverableRow';
import { sectionLabelStyle } from '@/components/task-form/styles';
import Input, { Field, Select } from '@/components/common/Input';
import IconButton, { icons } from '@/components/common/IconButton';
import Notice from '@/components/common/Notice';
import { apiPost } from '@/utils/api';
import { useApi } from '@/hooks/useApi';
import { formatStatusLabel, formatPriorityLabel } from '@/utils/format';
import MentionTextarea from '../common/MentionTextarea';
import DictateButton from '@/components/common/DictateButton';
import { withDictation } from '@/utils/dictation';
import { DropZone } from '@/components/context-updates/ImportUpdateModal';
import { formatBytes } from '@/components/context-updates/shared';
import type { Task, Stakeholder, NewTaskDraft, ClaudeAgent } from '@/types';

const MAX_FILE = 50 * 1024 * 1024;

/** Uploads one file to a task; resolves to an error message, or null when it worked. */
async function uploadTaskFile(taskId: string, file: File): Promise<string | null> {
  const form = new FormData();
  form.append('file', file);
  try {
    const res = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/files`, { method: 'POST', body: form });
    if (res.ok) return null;
    const body = await res.json().catch(() => null) as { message?: string; error?: string } | null;
    return `${file.name}: ${body?.message ?? body?.error ?? `upload failed (${res.status})`}`;
  } catch {
    return `${file.name}: upload failed`;
  }
}

interface NewTaskModalProps {
  isOpen: boolean;
  onClose: () => void;
  defaultStatus?: Task['status'];
  /** The board column the form was opened from. Sent only if the status is left as opened, or it would not fit. */
  boardColumn?: string;
  /** Starting values, applied each time the form opens. */
  draft?: NewTaskDraft;
  /**
   * `uploadErrors` lists the files that could not be attached; the task itself was created. `existing` is
   * true when the draft's meeting action item already had a task, which is returned instead of a new one.
   */
  onCreated?: (task: Task, uploadErrors: string[], existing?: boolean) => void;
}

interface FormState {
  title: string;
  status: Task['status'];
  priority: Task['priority'];
  due_date: string;
  objective: string;
  deliverables: DeliverableItem[];
  preferred_agent: string;
}

const defaultForm = (defaultStatus?: Task['status'], draft?: NewTaskDraft): FormState => ({
  title: draft?.title ?? '',
  status: defaultStatus ?? 'backlog',
  priority: 'medium',
  due_date: draft?.due_date ?? '',
  objective: draft?.objective ?? '',
  deliverables: (draft?.deliverables ?? []).map((d, i) => ({ ...d, id: `DEL-${String(i + 1).padStart(2, '0')}` })),
  preferred_agent: draft?.preferred_agent ?? '',
});

export default function NewTaskModal({
  isOpen,
  onClose,
  defaultStatus,
  boardColumn,
  draft,
  onCreated,
}: NewTaskModalProps) {
  const [form, setForm] = React.useState<FormState>(() => defaultForm(defaultStatus, draft));
  const [titleError, setTitleError] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [saveError, setSaveError] = React.useState('');
  const [selectedStakeholders, setSelectedStakeholders] = React.useState<Stakeholder[]>([]);
  // Files picked before the task exists; they are uploaded right after it is created.
  const [files, setFiles] = React.useState<File[]>([]);
  const [progress, setProgress] = React.useState('');
  const { data: agents } = useApi<ClaudeAgent[]>('/api/agents');

  React.useEffect(() => {
    if (isOpen) {
      setForm(defaultForm(defaultStatus, draft));
      setTitleError('');
      setSaveError('');
      setSelectedStakeholders(draft?.stakeholders ?? []);
      setFiles([]);
      setProgress('');
    }
  }, [isOpen, defaultStatus, draft]);

  const panelRef = useDialogFocus(isOpen, saving ? () => {} : onClose, true);

  const setField = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  // Added to what the field holds when the text arrives, not when recording began: typing meanwhile is kept.
  const addDictation = React.useCallback((text: string) => {
    setForm((prev) => ({ ...prev, objective: withDictation(prev.objective, text) }));
  }, []);

  const addDeliverable = () => {
    // No format here — it comes from the output template the user picks.
    const next = form.deliverables.length + 1;
    setField('deliverables', [...form.deliverables, { id: `DEL-${String(next).padStart(2, '0')}` }]);
  };

  const updateDeliverable = (index: number, patch: Partial<DeliverableItem>) => {
    setField('deliverables', form.deliverables.map((d, i) => i === index ? { ...d, ...patch } : d));
  };

  const removeDeliverable = (index: number) => {
    setField('deliverables', form.deliverables.filter((_, i) => i !== index));
  };

  const addFiles = (incoming: File[]) => {
    setFiles((prev) => [...prev, ...incoming.filter((f) => !prev.some((p) => p.name === f.name && p.size === f.size))]);
  };

  const tooBig = files.filter((f) => f.size > MAX_FILE);

  const validate = (): boolean => {
    if (!form.title.trim()) {
      setTitleError('Title is required.');
      return false;
    }
    setTitleError('');
    if (tooBig.length) {
      setSaveError(`Remove files over 50 MB: ${tooBig.map((f) => f.name).join(', ')}`);
      return false;
    }
    return true;
  };

  const handleSave = async () => {
    if (saving || !validate()) return;
    setSaving(true);
    setSaveError('');
    try {
      const payload = {
        title: form.title.trim(),
        status: form.status,
        board_column: boardColumn && form.status === defaultStatus ? boardColumn : undefined,
        priority: form.priority,
        task_type: 'ad_hoc',
        due_date: form.due_date || undefined,
        tags: [],
        preferred_agent: form.preferred_agent || undefined,
        stakeholders: selectedStakeholders.map((s) => ({
          ref: s.id,
          role: 'stakeholder',
          key: false,
        })),
        body: form.objective.trim() || undefined,
        deliverables: form.deliverables.map((d, i) => ({
          id: `DEL-${String(i + 1).padStart(2, '0')}`,
          format: d.format,
          template_ref: d.template_ref,
          status: 'pending' as const,
        })),
        contexts: [],
      };
      // From a meeting action item, the server creates the task and links the item in one step, or returns
      // the task the item already has.
      const action = draft?.meeting_action;
      let created: Task;
      let existing = false;
      if (action) {
        const result = await apiPost<{ task: Task; created: boolean }>(
          `/api/context-updates/${action.update_id}/meeting-records/${action.record_id}/tasks`,
          { item: action.item, revision: action.revision, task: payload },
        );
        created = result.task;
        existing = !result.created;
      } else {
        created = await apiPost<Task>('/api/tasks', payload);
      }
      const uploadErrors: string[] = [];
      for (let i = 0; i < (existing ? 0 : files.length); i++) {
        setProgress(`Uploading ${i + 1} of ${files.length}...`);
        const failed = await uploadTaskFile(created.id, files[i]!);
        if (failed) uploadErrors.push(failed);
      }
      onCreated?.(created, uploadErrors, existing);
      onClose();
    } catch (err: any) {
      setSaveError(err?.message ?? 'Could not create the task. Try again.');
    } finally {
      setSaving(false);
      setProgress('');
    }
  };

  if (!isOpen) return null;

  const statuses = ['backlog', 'ready', 'in_progress', 'blocked', 'review', 'in_review', 'approved', 'done', 'archived'] as Task['status'][];
  const agentOptions = [
    { value: '', label: 'No preference' },
    ...(form.preferred_agent && !(agents ?? []).some((a) => a.name === form.preferred_agent) ? [{ value: form.preferred_agent, label: form.preferred_agent }] : []),
    ...(agents ?? []).map((a) => ({ value: a.name, label: a.name })),
  ];

  return ReactDOM.createPortal(
    <div className="gtd-modal" role="dialog" aria-modal="true" aria-labelledby="new-task-heading">
      <div className="gtd-modal__scrim" aria-hidden="true" onClick={onClose} />

      <div ref={panelRef} tabIndex={-1} className="gtd-modal__panel gtd-modal__panel--detail">
        {/* Header */}
        <div className="gtd-modal__header" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 'var(--space-2)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
            <h2 id="new-task-heading" className="gtd-modal__title" style={{ flex: 1 }}>New task</h2>
            {progress && <span aria-live="polite" style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>{progress}</span>}
            <Button variant="ghost" size="sm" onClick={onClose} disabled={saving}>Cancel</Button>
            <Button variant="primary" size="sm" loading={saving} onClick={handleSave}>Create task</Button>
            <IconButton label="Close dialog" icon={icons.close} onClick={onClose} disabled={saving} />
          </div>
          <input
            type="text"
            aria-label="Task title"
            aria-required="true"
            aria-invalid={titleError ? true : undefined}
            aria-describedby={titleError ? 'new-task-title-error' : undefined}
            className="gtd-title-input"
            value={form.title}
            onChange={(e) => {
              setField('title', e.target.value);
              if (titleError) setTitleError('');
            }}
            placeholder="What needs to get done?"
            style={titleError ? { borderColor: 'var(--color-critical)' } : undefined}
          />
          {titleError && <span id="new-task-title-error" className="gtd-field__error">{titleError}</span>}
        </div>

        {/* Body: main + sidebar */}
        <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column', padding: 'var(--space-5)', gap: 'var(--space-4)', minHeight: 0 }}>
          {saveError && <Notice tone="critical" title="The task was not created.">{saveError}</Notice>}
          <div className="gtd-detail">
            <div className="gtd-detail__main">
              <Field label="Objective" htmlFor="new-task-objective" hint="Type @ to mention a stakeholder, template, context note, task or meeting." style={{ marginBottom: 'var(--space-6)' }}>
                <MentionTextarea
                  id="new-task-objective"
                  className="gtd-control"
                  rows={6}
                  value={form.objective}
                  onChange={(v) => setField('objective', v)}
                  placeholder="Describe the goal or context for this task"
                />
                <DictateButton fieldName="objective" onText={addDictation} />
              </Field>

              <div style={{ marginBottom: 'var(--space-6)' }}>
                <DeliverableList
                  items={form.deliverables}
                  onChange={updateDeliverable}
                  onRemove={removeDeliverable}
                  onAdd={addDeliverable}
                  label="Output type"
                  emptyText="No outputs defined yet."
                />
              </div>

              {/* Files: attached right after the task is created */}
              <div style={{ marginBottom: 'var(--space-6)' }}>
                <h3 style={{ ...sectionLabelStyle, marginBottom: 'var(--space-2)' }}>Files</h3>
                <DropZone onFiles={addFiles} compact />
                {files.length > 0 && (
                  <ul style={{ listStyle: 'none', margin: 'var(--space-2) 0 0', padding: 0, display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
                    {files.map((f) => (
                      <li key={`${f.name}-${f.size}`} style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', fontSize: 'var(--text-sm)', padding: '2px 4px 2px 8px', background: 'var(--color-surface-hover)', borderRadius: 'var(--radius-sm)' }}>
                        <span className="truncate" style={{ flex: 1, minWidth: 0 }}>{f.name}</span>
                        <span style={{ fontSize: 'var(--text-xs)', color: f.size > MAX_FILE ? 'var(--color-critical)' : 'var(--color-text-muted)' }}>{formatBytes(f.size)}</span>
                        <IconButton label={`Remove ${f.name}`} icon={icons.close} tone="danger" disabled={saving} onClick={() => setFiles((prev) => prev.filter((p) => p !== f))} />
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>

            <aside className="gtd-detail__aside" aria-label="Task fields">
              <Select label="Status" size="sm" value={form.status} onChange={(v) => setField('status', v as Task['status'])}
                options={statuses.map((s) => ({ value: s, label: formatStatusLabel(s) }))} />
              <Select label="Priority" size="sm" value={form.priority} onChange={(v) => setField('priority', v as Task['priority'])}
                options={(['critical', 'high', 'medium', 'low'] as Task['priority'][]).map((p) => ({ value: p, label: formatPriorityLabel(p) }))} />
              <Input label="Due date" type="date" size="sm" value={form.due_date} onChange={(v) => setField('due_date', v)} />
              <Select label="Preferred agent" size="sm" value={form.preferred_agent} onChange={(v) => setField('preferred_agent', v)} options={agentOptions} />
              <StakeholderPicker
                selected={selectedStakeholders}
                onAdd={(s) => setSelectedStakeholders((prev) => [...prev, s])}
                onRemove={(id) => setSelectedStakeholders((prev) => prev.filter((s) => s.id !== id))}
              />
            </aside>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
