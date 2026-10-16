import React, { useState, useEffect, useCallback, useRef } from 'react';
import ReactDOM from 'react-dom';
import { useParams, useNavigate, useOutletContext } from 'react-router-dom';
import { useApi } from '../hooks/useApi';
import { useDataVersion } from '../store';
import { Task, Stakeholder } from '../types';
import Badge from '../components/common/Badge';
import Button from '../components/common/Button';
import LoadingSpinner from '../components/common/LoadingSpinner';
import StakeholderPicker from '../components/task-form/StakeholderPicker';
import DeliverableList from '../components/task-form/DeliverableList';
import { selectStyle, dateInputStyle } from '../components/task-form/styles';
import { apiPut, apiDelete } from '../utils/api';
import { formatDate, formatPriorityLabel, formatStatusLabel } from '../utils/format';

/* ---- Tab type ------------------------------------------------------ */
type TaskTab = 'work' | 'files';

/* ---- Sidebar field ------------------------------------------------- */
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

/* ---- Inline-editable text ----------------------------------------- */
function MarkdownSection({ label, content, onSave }: { label: string; content: string; onSave?: (v: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(content);

  useEffect(() => { setVal(content); }, [content]);

  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <h3 style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--color-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          {label}
        </h3>
        {onSave && (
          <button
            onClick={() => {
              if (editing) { onSave(val); setEditing(false); }
              else setEditing(true);
            }}
            style={{
              fontSize: 'var(--text-xs)',
              color: 'var(--color-accent)',
              border: 'none', background: 'transparent', cursor: 'pointer', padding: 0,
            }}
          >
            {editing ? 'Save' : 'Edit'}
          </button>
        )}
        {editing && (
          <button
            onClick={() => { setVal(content); setEditing(false); }}
            style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', border: 'none', background: 'transparent', cursor: 'pointer', padding: 0 }}
          >
            Cancel
          </button>
        )}
      </div>
      {editing ? (
        <textarea
          value={val}
          onChange={(e) => setVal(e.target.value)}
          rows={6}
          autoFocus
          style={{
            width: '100%',
            padding: '10px',
            fontSize: 'var(--text-base)',
            fontFamily: 'var(--font-mono)',
            color: 'var(--color-text)',
            background: 'var(--color-surface)',
            border: '1px solid var(--color-border-strong)',
            borderRadius: 'var(--radius-md)',
            outline: 'none',
            resize: 'vertical',
            lineHeight: 1.5,
          }}
        />
      ) : (
        <div style={{ fontSize: 'var(--text-base)', color: 'var(--color-text)', lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>
          {content || <span style={{ color: 'var(--color-text-muted)', fontStyle: 'italic' }}>No content</span>}
        </div>
      )}
    </div>
  );
}

/* ---- Slash command field ------------------------------------------ */
function SlashCommandField({ taskId }: { taskId: string }) {
  const command = `/gtd-task ${taskId}`;
  const [copied, setCopied] = React.useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable
    }
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <code style={{
        flex: 1, fontSize: 'var(--text-xs)', fontFamily: 'var(--font-mono)',
        background: 'var(--color-bg)', border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-sm)', padding: '5px 8px',
        color: 'var(--color-text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        {command}
      </code>
      <button
        onClick={handleCopy}
        title="Copy command"
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
          width: 28, height: 28, border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm)',
          background: copied ? 'var(--color-success-subtle)' : 'var(--color-surface)', cursor: 'pointer',
          color: copied ? 'var(--color-success)' : 'var(--color-text-muted)', transition: 'all 0.15s',
        }}
      >
        {copied ? (
          <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true">
            <path d="M2 7l3 3 6-6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : (
          <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true">
            <rect x="4" y="4" width="8" height="8" rx="1" stroke="currentColor" strokeWidth="1.2" />
            <path d="M3 9H2a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v1" stroke="currentColor" strokeWidth="1.2" />
          </svg>
        )}
      </button>
    </div>
  );
}

/* ---- Work tab ------------------------------------------------------ */
function nextDeliverableId(deliverables: Task['deliverables']): string {
  const nums = deliverables
    .map((d) => { const m = d.id?.match(/^DEL-(\d+)$/); return m ? parseInt(m[1], 10) : 0; })
    .filter((n) => n > 0);
  const next = nums.length > 0 ? Math.max(...nums) + 1 : 1;
  return `DEL-${String(next).padStart(2, '0')}`;
}

function WorkTab({ task, onFieldChange }: { task: Task; onFieldChange: (field: string, value: unknown) => void }) {
  const { data: allStakeholders } = useApi<Stakeholder[]>('/api/stakeholders');

  const saveField = (field: string) => (value: unknown) => onFieldChange(field, value);

  const updateDeliverable = (index: number, patch: Partial<Task['deliverables'][number]>) => {
    const updated = task.deliverables.map((d, i) => i === index ? { ...d, ...patch } : d);
    onFieldChange('deliverables', updated);
  };

  const removeDeliverable = (index: number) => {
    onFieldChange('deliverables', task.deliverables.filter((_, i) => i !== index));
  };

  const addDeliverable = () => {
    const newItem: Task['deliverables'][number] = {
      id: nextDeliverableId(task.deliverables),
      status: 'pending',
    };
    onFieldChange('deliverables', [...task.deliverables, newItem]);
  };

  const resolvedStakeholders = (task.stakeholders ?? [])
    .map((s) => (allStakeholders ?? []).find((p) => p.id === s.ref))
    .filter((p): p is Stakeholder => !!p);

  return (
    <div style={{ display: 'flex', gap: 24, flex: 1, minHeight: 0 }}>
      {/* Main */}
      <div style={{ flex: 1, minWidth: 0, overflowY: 'auto', paddingRight: 4 }}>
        <MarkdownSection label="Objective" content={task.body ?? ''} onSave={saveField('body')} />

        {/* Deliverables */}
        <div style={{ marginBottom: 24 }}>
          <DeliverableList
            items={task.deliverables}
            onChange={updateDeliverable}
            onRemove={removeDeliverable}
            onAdd={addDeliverable}
          />
        </div>

      </div>

      {/* Sidebar */}
      <div style={{ width: 316, flexShrink: 0, overflowY: 'auto', paddingLeft: 4, borderLeft: '1px solid var(--color-border)' }}>
        <SidebarField label="Status">
          <select
            value={task.status}
            onChange={(e) => onFieldChange('status', e.target.value)}
            style={{ ...selectStyle, width: '100%', padding: '6px 10px', fontSize: 'var(--text-sm)', borderRadius: 'var(--radius-md)' }}
          >
            {(['backlog', 'ready', 'in_progress', 'blocked', 'review', 'in_review', 'approved', 'done', 'archived'] as Task['status'][]).map((s) => (
              <option key={s} value={s}>{formatStatusLabel(s)}</option>
            ))}
          </select>
        </SidebarField>

        <SidebarField label="Priority">
          <select
            value={task.priority}
            onChange={(e) => onFieldChange('priority', e.target.value)}
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
            value={task.due_date ? task.due_date.slice(0, 10) : ''}
            onChange={(e) => onFieldChange('due_date', e.target.value || null)}
            style={{ ...dateInputStyle, width: '100%' }}
          />
        </SidebarField>

        <SidebarField label="Slash Command">
          <SlashCommandField taskId={task.id} />
        </SidebarField>

        <StakeholderPicker
          selected={resolvedStakeholders}
          onAdd={(s) => onFieldChange('stakeholders', [...(task.stakeholders ?? []), { ref: s.id, role: 'reviewer', key: false }])}
          onRemove={(id) => onFieldChange('stakeholders', (task.stakeholders ?? []).filter((x) => x.ref !== id))}
        />


      </div>
    </div>
  );
}

/* ---- Context package tab ------------------------------------------ */
/* ---- Files tab ----------------------------------------------------- */
function FilesTab({ taskId }: { taskId: string }) {
  const { data: files, loading, refetch } = useApi<Array<{ name: string; size: number; modified: string; type: string }>>(`/api/tasks/${taskId}/files`);
  const [uploading, setUploading] = useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch(`/api/tasks/${taskId}/files`, { method: 'POST', body: form });
      if (!res.ok) throw new Error(await res.text());
      refetch();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const handleDelete = async (name: string) => {
    if (!window.confirm(`Remove "${name}" from this task?`)) return;
    try {
      const res = await fetch(`/api/tasks/${taskId}/files/${encodeURIComponent(name)}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(await res.text());
      refetch();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Delete failed');
    }
  };

  if (loading) return <LoadingSpinner />;

  return (
    <div style={{ flex: 1, overflowY: 'auto' }}>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
        <input ref={inputRef} type="file" style={{ display: 'none' }} onChange={handleUpload} />
        <Button size="sm" variant="secondary" loading={uploading} onClick={() => inputRef.current?.click()}>
          Attach file
        </Button>
      </div>
      {(!files || files.length === 0) ? (
        <div style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-sm)', padding: 4 }}>No files attached.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {files.map((f) => (
            <div key={f.name} style={{
              display: 'flex', alignItems: 'center', gap: 12,
              padding: '10px 14px',
              background: 'var(--color-surface)',
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-md)',
            }}>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" style={{ color: 'var(--color-text-muted)', flexShrink: 0 }}>
                <path d="M9 1.5H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5.5L9 1.5Z" stroke="currentColor" strokeWidth="1.2" />
                <path d="M9 1.5V5.5h4" stroke="currentColor" strokeWidth="1.2" />
              </svg>
              <span style={{ flex: 1, fontSize: 'var(--text-sm)', fontFamily: 'var(--font-mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
              <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', flexShrink: 0 }}>
                {(f.size / 1024).toFixed(1)} KB
              </span>
              <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', flexShrink: 0 }}>
                {formatDate(f.modified)}
              </span>
              <Badge size="sm">{f.type}</Badge>
              <button
                onClick={() => handleDelete(f.name)}
                title="Remove file"
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 22, height: 22, border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--color-text-muted)', padding: 0, flexShrink: 0 }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--color-critical)'; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--color-text-muted)'; }}
              >
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                  <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                </svg>
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}



/* ---- Main view ----------------------------------------------------- */
export default function TaskDetailView() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { refetchTasks } = useOutletContext<{ refetchTasks: () => void }>();
  const [tab, setTab] = useState<TaskTab>('work');
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Re-read the task when it changes on disk (agent updating status, deliverables)
  const tasksVersion = useDataVersion('tasks');
  const { data: task, loading, refetch } = useApi<Task>(`/api/tasks/${id}`, [id, tasksVersion]);
  const [localTask, setLocalTask] = useState<Task | null>(null);
  // Set while the user has unsaved edits, so a background refresh never
  // overwrites what they are typing.
  const editingRef = useRef(false);

  useEffect(() => {
    if (task && !editingRef.current) setLocalTask(task);
  }, [task]);

  const close = useCallback(() => navigate('/board'), [navigate]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        const tag = (document.activeElement as HTMLElement)?.tagName;
        if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') close();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [close]);

  const handleFieldChange = useCallback((field: string, value: unknown) => {
    editingRef.current = true;
    setLocalTask((prev) => {
      if (!prev) return prev;
      return { ...prev, [field]: value } as Task;
    });
  }, []);

  const handleSave = useCallback(async () => {
    if (!localTask || !id) return;
    setSaving(true);
    try {
      await apiPut(`/api/tasks/${id}`, localTask);
      editingRef.current = false;
      refetch();
      refetchTasks();
    } catch {
      // ignore for now
    } finally {
      setSaving(false);
    }
  }, [localTask, id, refetch, refetchTasks]);

  const handleDelete = useCallback(async () => {
    if (!id || !localTask) return;
    if (!window.confirm(`Delete task "${localTask.title}"? This cannot be undone.`)) return;
    setDeleting(true);
    try {
      await apiDelete(`/api/tasks/${id}`);
      refetchTasks();
      navigate('/board');
    } catch {
      setDeleting(false);
    }
  }, [id, localTask, navigate, refetchTasks]);

  const isDirty = JSON.stringify(task) !== JSON.stringify(localTask);

  const tabs: { key: TaskTab; label: string }[] = [
    { key: 'work', label: 'Work' },
    { key: 'files', label: 'Files' },
  ];

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

  if (loading) return ReactDOM.createPortal(
    <div role="dialog" aria-modal="true" style={overlayStyle}>
      <div onClick={close} style={{ position: 'absolute', inset: 0, background: 'var(--scrim)', backdropFilter: 'blur(2px)' }} />
      <div style={panelStyle}>
        <LoadingSpinner text="Loading task..." />
      </div>
    </div>,
    document.body
  );

  if (!localTask) return ReactDOM.createPortal(
    <div role="dialog" aria-modal="true" style={overlayStyle}>
      <div onClick={close} style={{ position: 'absolute', inset: 0, background: 'var(--scrim)', backdropFilter: 'blur(2px)' }} />
      <div style={panelStyle}>
        <div style={{ padding: 24, color: 'var(--color-text-muted)' }}>Task not found.</div>
      </div>
    </div>,
    document.body
  );

  return ReactDOM.createPortal(
    <div role="dialog" aria-modal="true" style={overlayStyle}>
      {/* Backdrop */}
      <div
        aria-hidden="true"
        onClick={close}
        style={{ position: 'absolute', inset: 0, background: 'var(--scrim)', backdropFilter: 'blur(2px)' }}
      />

      {/* Panel */}
      <div style={panelStyle}>
        {/* Header */}
        <div style={{
          padding: '12px 20px',
          borderBottom: '1px solid var(--color-border)',
          background: 'var(--color-surface)',
          flexShrink: 0,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <span style={{ fontSize: 'var(--text-xs)', fontFamily: 'var(--font-mono)', color: 'var(--color-text-muted)', background: 'var(--color-bg)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm)', padding: '1px 6px', flexShrink: 0 }}>
              {localTask.slug}
            </span>
            <span style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
              {localTask.title}
            </span>
            {/* Close button */}
            <button
              onClick={close}
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
                value={localTask.title}
                onChange={(e) => handleFieldChange('title', e.target.value)}
                style={{
                  display: 'block', width: '100%', marginBottom: 8,
                  fontSize: 'var(--text-lg)', fontWeight: 700, lineHeight: 1.3,
                  background: 'transparent', border: 'none', outline: 'none',
                  color: 'var(--color-text)', padding: 0,
                  borderBottom: '1px solid transparent',
                }}
                onFocus={(e) => { (e.currentTarget as HTMLInputElement).style.borderBottomColor = 'var(--color-border-strong)'; }}
                onBlur={(e) => { (e.currentTarget as HTMLInputElement).style.borderBottomColor = 'transparent'; }}
              />
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <Badge variant={`priority-${localTask.priority}` as 'priority-critical'} size="md">
                  {formatPriorityLabel(localTask.priority)}
                </Badge>
                <Badge variant={`status-${localTask.status}` as 'status-done'} size="md">
                  {formatStatusLabel(localTask.status)}
                </Badge>
                {localTask.due_date && (
                  <span style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)' }}>
                    Due {formatDate(localTask.due_date)}
                  </span>
                )}
              </div>
            </div>

            <div style={{ display: 'flex', gap: 8, flexShrink: 0, alignItems: 'center' }}>
              {isDirty && (
                <Button variant="primary" size="sm" loading={saving} onClick={handleSave}>
                  Save changes
                </Button>
              )}
              <button
                aria-label="Delete task"
                onClick={handleDelete}
                disabled={deleting}
                title="Delete task"
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  width: 32, height: 32, borderRadius: 'var(--radius-md)',
                  border: '1px solid var(--color-border)', background: 'transparent', cursor: 'pointer',
                  color: 'var(--color-text-muted)', opacity: deleting ? 0.5 : 1,
                }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--color-critical)'; (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--color-critical)'; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--color-text-muted)'; (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--color-border)'; }}
              >
                <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true">
                  <path d="M5 2h5M2 4h11M4.5 4l.5 8h5l.5-8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            </div>
          </div>
        </div>

        {/* Tabs */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 2,
          padding: '0 20px',
          borderBottom: '1px solid var(--color-border)',
          background: 'var(--color-surface)',
          flexShrink: 0,
        }}>
          {tabs.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              role="tab"
              aria-selected={tab === t.key}
              style={{
                padding: '10px 12px',
                fontSize: 'var(--text-sm)',
                fontWeight: tab === t.key ? 600 : 400,
                color: tab === t.key ? 'var(--color-text)' : 'var(--color-text-muted)',
                border: 'none',
                background: 'transparent',
                cursor: 'pointer',
                borderBottom: tab === t.key ? '2px solid var(--color-accent)' : '2px solid transparent',
                transition: 'color 0.1s',
              }}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column', padding: '20px' }}>
          {tab === 'work' && (
            <WorkTab task={localTask} onFieldChange={handleFieldChange} />
          )}
          {tab === 'files' && id && (
            <FilesTab taskId={id} />
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
