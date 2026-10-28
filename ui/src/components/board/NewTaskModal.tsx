import React from 'react';
import ReactDOM from 'react-dom';
import Button from '@/components/common/Button';
import StakeholderPicker from '@/components/task-form/StakeholderPicker';
import DeliverableList from '@/components/task-form/DeliverableList';
import { DeliverableItem } from '@/components/task-form/DeliverableRow';
import { selectStyle, dateInputStyle, textareaStyle, sectionLabelStyle } from '@/components/task-form/styles';
import { apiPost } from '@/utils/api';
import { useApi } from '@/hooks/useApi';
import { formatStatusLabel, formatPriorityLabel } from '@/utils/format';
import MentionTextarea from '../common/MentionTextarea';
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
  /** Starting values, applied each time the form opens. */
  draft?: NewTaskDraft;
  /** `uploadErrors` lists the files that could not be attached; the task itself was created. */
  onCreated?: (task: Task, uploadErrors: string[]) => void;
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
  due_date: '',
  objective: draft?.objective ?? '',
  deliverables: (draft?.deliverables ?? []).map((d, i) => ({ ...d, id: `DEL-${String(i + 1).padStart(2, '0')}` })),
  preferred_agent: draft?.preferred_agent ?? '',
});

function SidebarField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{
        fontSize: 'var(--text-xs)',
        fontWeight: 600,
        color: 'var(--color-text-muted)',
        textTransform: 'uppercase',
        letterSpacing: '0.05em',
        marginBottom: 6,
      }}>
        {label}
      </div>
      {children}
    </div>
  );
}

export default function NewTaskModal({
  isOpen,
  onClose,
  defaultStatus,
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

  React.useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        const tag = (document.activeElement as HTMLElement)?.tagName;
        if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') onClose();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [isOpen, onClose]);

  const setField = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

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
      const created = await apiPost<Task>('/api/tasks', payload);
      const uploadErrors: string[] = [];
      for (let i = 0; i < files.length; i++) {
        setProgress(`Uploading ${i + 1} of ${files.length}...`);
        const failed = await uploadTaskFile(created.id, files[i]!);
        if (failed) uploadErrors.push(failed);
      }
      onCreated?.(created, uploadErrors);
      onClose();
    } catch (err: any) {
      setSaveError(err?.message ?? 'Failed to create task. Please try again.');
    } finally {
      setSaving(false);
      setProgress('');
    }
  };

  if (!isOpen) return null;

  const overlayStyle: React.CSSProperties = {
    position: 'fixed',
    inset: 0,
    zIndex: 1000,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  };

  const panelStyle: React.CSSProperties = {
    position: 'relative',
    zIndex: 1,
    width: 'min(92vw, 1200px)',
    height: 'min(92vh, 860px)',
    background: 'var(--color-surface)',
    borderRadius: 'var(--radius-xl)',
    border: '1px solid var(--color-border)',
    boxShadow: 'var(--shadow-lg)',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  };

  return ReactDOM.createPortal(
    <div role="dialog" aria-modal="true" aria-label="New Task" style={overlayStyle}>
      <div
        aria-hidden="true"
        onClick={onClose}
        style={{ position: 'absolute', inset: 0, background: 'var(--scrim)', backdropFilter: 'blur(2px)' }}
      />

      <div style={panelStyle}>
        {/* Header */}
        <div style={{
          padding: '12px 20px',
          borderBottom: '1px solid var(--color-border)',
          background: 'var(--color-surface)',
          flexShrink: 0,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <span style={{
              fontSize: 'var(--text-xs)',
              fontFamily: 'var(--font-mono)',
              color: 'var(--color-text-muted)',
              background: 'var(--color-bg)',
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-sm)',
              padding: '1px 6px',
              flexShrink: 0,
            }}>
              New Task
            </span>
            <span style={{ flex: 1 }} />
            <button
              onClick={onClose}
              aria-label="Close"
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                width: 28, height: 28, borderRadius: 'var(--radius-md)',
                border: 'none', background: 'transparent', cursor: 'pointer',
                color: 'var(--color-text-muted)', flexShrink: 0,
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'var(--color-surface-hover)'; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent'; }}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M4 4L12 12M12 4L4 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </button>
          </div>

          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <input
                type="text"
                value={form.title}
                onChange={(e) => {
                  setField('title', e.target.value);
                  if (titleError) setTitleError('');
                }}
                placeholder="What needs to get done?"
                style={{
                  display: 'block', width: '100%', marginBottom: titleError ? 4 : 8,
                  fontSize: 'var(--text-lg)', fontWeight: 700, lineHeight: 1.3,
                  background: 'transparent', border: 'none', outline: 'none',
                  color: 'var(--color-text)', padding: 0,
                  borderBottom: `1px solid ${titleError ? 'var(--color-critical)' : 'transparent'}`,
                }}
                onFocus={(e) => {
                  if (!titleError) (e.currentTarget as HTMLInputElement).style.borderBottomColor = 'var(--color-border-strong)';
                }}
                onBlur={(e) => {
                  if (!titleError) (e.currentTarget as HTMLInputElement).style.borderBottomColor = 'transparent';
                }}
              />
              {titleError && (
                <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-critical)', marginBottom: 4 }}>
                  {titleError}
                </div>
              )}
            </div>

            <div style={{ display: 'flex', gap: 8, flexShrink: 0, alignItems: 'center' }}>
              {saveError && (
                <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-critical)' }}>
                  {saveError}
                </span>
              )}
              {progress && (
                <span aria-live="polite" style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
                  {progress}
                </span>
              )}
              <Button variant="ghost" size="sm" onClick={onClose} disabled={saving}>
                Cancel
              </Button>
              <Button variant="primary" size="sm" loading={saving} onClick={handleSave}>
                Create Task
              </Button>
            </div>
          </div>
        </div>

        {/* Body: main + sidebar */}
        <div style={{ flex: 1, overflow: 'hidden', display: 'flex', padding: '20px', gap: 24, minHeight: 0 }}>
          {/* Main content */}
          <div style={{ flex: 1, minWidth: 0, overflowY: 'auto', paddingRight: 4 }}>
            {/* Objective */}
            <div style={{ marginBottom: 24 }}>
              <h3 style={{ ...sectionLabelStyle, marginBottom: 8 }}>Objective</h3>
              <MentionTextarea
                rows={6}
                value={form.objective}
                onChange={(v) => setField('objective', v)}
                placeholder="Describe the goal or context for this task... Type @ to mention a stakeholder, template, context note or task."
                style={textareaStyle}
              />
            </div>

            {/* Deliverables */}
            <div style={{ marginBottom: 24 }}>
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
            <div style={{ marginBottom: 24 }}>
              <h3 style={{ ...sectionLabelStyle, marginBottom: 8 }}>Files</h3>
              <DropZone onFiles={addFiles} compact />
              {files.length > 0 && (
                <ul style={{ listStyle: 'none', margin: '8px 0 0', padding: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {files.map((f) => (
                    <li key={`${f.name}-${f.size}`} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--text-sm)', padding: '4px 8px', background: 'var(--color-surface-hover)', borderRadius: 'var(--radius-sm)' }}>
                      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
                      <span style={{ fontSize: 'var(--text-xs)', color: f.size > MAX_FILE ? 'var(--color-critical)' : 'var(--color-text-muted)' }}>{formatBytes(f.size)}</span>
                      <button type="button" aria-label={`Remove ${f.name}`} disabled={saving} onClick={() => setFiles((prev) => prev.filter((p) => p !== f))}
                        style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--color-text-muted)', padding: '0 4px', fontSize: 'var(--text-base)' }}>×</button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          {/* Sidebar */}
          <div style={{ width: 316, flexShrink: 0, overflowY: 'auto', paddingLeft: 4, borderLeft: '1px solid var(--color-border)' }}>
            <SidebarField label="Status">
              <select
                value={form.status}
                onChange={(e) => setField('status', e.target.value as Task['status'])}
                style={{ ...selectStyle, width: '100%', padding: '6px 10px', fontSize: 'var(--text-sm)', borderRadius: 'var(--radius-md)' }}
              >
                {(['backlog', 'ready', 'in_progress', 'blocked', 'review', 'in_review', 'approved', 'done', 'archived'] as Task['status'][]).map((s) => (
                  <option key={s} value={s}>{formatStatusLabel(s)}</option>
                ))}
              </select>
            </SidebarField>

            <SidebarField label="Priority">
              <select
                value={form.priority}
                onChange={(e) => setField('priority', e.target.value as Task['priority'])}
                style={{ ...selectStyle, width: '100%', padding: '6px 10px', fontSize: 'var(--text-sm)', borderRadius: 'var(--radius-md)' }}
              >
                {(['critical', 'high', 'medium', 'low'] as Task['priority'][]).map((p) => (
                  <option key={p} value={p}>{formatPriorityLabel(p)}</option>
                ))}
              </select>
            </SidebarField>

            <SidebarField label="Due date">
              <input
                type="date"
                value={form.due_date}
                onChange={(e) => setField('due_date', e.target.value)}
                style={{ ...dateInputStyle, width: '100%' }}
              />
            </SidebarField>

            <SidebarField label="Preferred agent">
              <select
                aria-label="Preferred agent"
                value={form.preferred_agent}
                onChange={(e) => setField('preferred_agent', e.target.value)}
                style={{ ...selectStyle, width: '100%', padding: '6px 10px', fontSize: 'var(--text-sm)', borderRadius: 'var(--radius-md)' }}
              >
                <option value="">No preference</option>
                {form.preferred_agent && !(agents ?? []).some((a) => a.name === form.preferred_agent) && (
                  <option value={form.preferred_agent}>{form.preferred_agent}</option>
                )}
                {(agents ?? []).map((a) => <option key={a.name} value={a.name}>{a.name}</option>)}
              </select>
            </SidebarField>

            <StakeholderPicker
              selected={selectedStakeholders}
              onAdd={(s) => setSelectedStakeholders((prev) => [...prev, s])}
              onRemove={(id) => setSelectedStakeholders((prev) => prev.filter((s) => s.id !== id))}
            />
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
