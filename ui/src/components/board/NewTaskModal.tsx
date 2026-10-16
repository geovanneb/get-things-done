import React from 'react';
import ReactDOM from 'react-dom';
import Button from '@/components/common/Button';
import StakeholderPicker from '@/components/task-form/StakeholderPicker';
import DeliverableList from '@/components/task-form/DeliverableList';
import { DeliverableItem } from '@/components/task-form/DeliverableRow';
import { selectStyle, dateInputStyle, textareaStyle, sectionLabelStyle } from '@/components/task-form/styles';
import { apiPost } from '@/utils/api';
import { formatStatusLabel, formatPriorityLabel } from '@/utils/format';
import type { Task, Stakeholder } from '@/types';

interface NewTaskModalProps {
  isOpen: boolean;
  onClose: () => void;
  defaultStatus?: Task['status'];
  onCreated?: (task: Task) => void;
}

interface FormState {
  title: string;
  status: Task['status'];
  priority: Task['priority'];
  due_date: string;
  objective: string;
  deliverables: DeliverableItem[];
}

const defaultForm = (defaultStatus?: Task['status']): FormState => ({
  title: '',
  status: defaultStatus ?? 'backlog',
  priority: 'medium',
  due_date: '',
  objective: '',
  deliverables: [],
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
  onCreated,
}: NewTaskModalProps) {
  const [form, setForm] = React.useState<FormState>(() => defaultForm(defaultStatus));
  const [titleError, setTitleError] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [saveError, setSaveError] = React.useState('');
  const [selectedStakeholders, setSelectedStakeholders] = React.useState<Stakeholder[]>([]);

  React.useEffect(() => {
    if (isOpen) {
      setForm(defaultForm(defaultStatus));
      setTitleError('');
      setSaveError('');
      setSelectedStakeholders([]);
    }
  }, [isOpen, defaultStatus]);

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

  const validate = (): boolean => {
    if (!form.title.trim()) {
      setTitleError('Title is required.');
      return false;
    }
    setTitleError('');
    return true;
  };

  const handleSave = async () => {
    if (!validate()) return;
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
      onCreated?.(created);
      onClose();
    } catch (err: any) {
      setSaveError(err?.message ?? 'Failed to create task. Please try again.');
    } finally {
      setSaving(false);
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
              <textarea
                rows={6}
                value={form.objective}
                onChange={(e) => setField('objective', e.target.value)}
                placeholder="Describe the goal or context for this task..."
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
