import TaskMeetingSources from '@/components/board/TaskMeetingSources';
import { useDialogFocus } from '@/hooks/useDialogFocus';
import { sectionLabelStyle } from '@/components/task-form/styles';
import Input, { Select } from '@/components/common/Input';
import IconButton, { icons } from '@/components/common/IconButton';
import EmptyState from '@/components/common/EmptyState';
import { Tabs } from '@/components/common/Tabs';
import { useNotify } from '@/hooks/useNotify';
import { useConfirm } from '@/components/common/ConfirmDialog';
import React, { useState, useEffect, useCallback, useRef } from 'react';
import ReactDOM from 'react-dom';
import { useParams, useNavigate, useOutletContext } from 'react-router-dom';
import { useApi } from '../hooks/useApi';
import { useDataVersion } from '../store';
import { Task, Stakeholder, OfficeCheck } from '../types';
import Badge from '../components/common/Badge';
import Button from '../components/common/Button';
import LoadingSpinner from '../components/common/LoadingSpinner';
import MarkdownView from '../components/common/MarkdownView';
import OfficeCheckBadge from '../components/common/OfficeCheckBadge';
import MarkdownEditor from '../components/common/MarkdownEditor';
import StakeholderPicker from '../components/task-form/StakeholderPicker';
import DeliverableList from '../components/task-form/DeliverableList';
import { useRecordLauncher } from '../components/recording/RecordLauncher';
import { useRecorder } from '../components/recording/RecordingProvider';
import { apiPut, apiDelete } from '../utils/api';
import { isMeetingPrepTask, recordPrefillFromTask } from '../utils/meetingParticipants';
import { formatDate, formatPriorityLabel, formatStatusLabel } from '../utils/format';

/* ---- Tab type ------------------------------------------------------ */
type TaskTab = 'work' | 'files';

/* ---- Sidebar field ------------------------------------------------- */
function SidebarField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="gtd-field" role="group" aria-label={label}>
      <span className="gtd-field__label">{label}</span>
      {children}
    </div>
  );
}

/* ---- Inline-editable text ----------------------------------------- */
// Edits go straight into the task draft, so the header's "Save changes" saves them
// with everything else. "Done" only switches back to the rendered view.
function MarkdownSection({ label, content, onChange, closeSignal, mentions }: { label: string; content: string; onChange: (v: string) => void; closeSignal?: number; mentions?: boolean }) {
  const [editing, setEditing] = useState(false);
  const [original, setOriginal] = useState(content);

  // The task was saved: show the rendered text again.
  useEffect(() => { setEditing(false); }, [closeSignal]);

  const linkStyle: React.CSSProperties = {
    fontSize: 'var(--text-xs)', border: 'none', background: 'transparent', cursor: 'pointer', padding: 0,
  };

  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <h3 style={sectionLabelStyle}>
          {label}
        </h3>
        {editing ? (
          <>
            <button onClick={() => setEditing(false)} style={{ ...linkStyle, color: 'var(--color-accent)' }}>Done</button>
            <button
              onClick={() => { onChange(original); setEditing(false); }}
              style={{ ...linkStyle, color: 'var(--color-text-muted)' }}
            >
              Discard
            </button>
          </>
        ) : (
          <button onClick={() => { setOriginal(content); setEditing(true); }} style={{ ...linkStyle, color: 'var(--color-accent)' }}>
            Edit
          </button>
        )}
      </div>
      {editing ? (
        <MarkdownEditor value={content} onChange={onChange} rows={10} autoFocus mentions={mentions} placeholder={mentions ? 'Type @ to mention a stakeholder, template, context note, task or meeting' : undefined} />
      ) : (
        <MarkdownView content={content} />
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

function WorkTab({ task, onFieldChange, savedCount, pinError, onPinned }: { task: Task; onFieldChange: (field: string, value: unknown) => void; savedCount: number; pinError: string | null; onPinned: () => void }) {
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
    <div className="gtd-detail">
      <div className="gtd-detail__main">
        <MarkdownSection label="Objective" content={task.body ?? ''} onChange={saveField('body')} closeSignal={savedCount} mentions />
        {/\]\(\/meetings\//.test(task.body ?? '') && <TaskMeetingSources taskId={task.id} refreshKey={savedCount} pinError={pinError} onPinned={onPinned} />}
        <div style={{ marginBottom: 'var(--space-6)' }}>
          <DeliverableList
            items={task.deliverables}
            onChange={updateDeliverable}
            onRemove={removeDeliverable}
            onAdd={addDeliverable}
          />
        </div>
      </div>

      <aside className="gtd-detail__aside" aria-label="Task fields">
        <Select label="Status" size="sm" value={task.status} onChange={(v) => onFieldChange('status', v)}
          options={(['backlog', 'ready', 'in_progress', 'blocked', 'review', 'in_review', 'approved', 'done', 'archived'] as Task['status'][]).map((s) => ({ value: s, label: formatStatusLabel(s) }))} />
        <Select label="Priority" size="sm" value={task.priority} onChange={(v) => onFieldChange('priority', v)}
          options={(['critical', 'high', 'medium', 'low'] as Task['priority'][]).map((p) => ({ value: p, label: formatPriorityLabel(p) }))} />
        <Input label="Due date" type="date" size="sm" value={task.due_date ? task.due_date.slice(0, 10) : ''}
          onChange={(v) => onFieldChange('due_date', v || null)} />
        <SidebarField label="Slash command">
          <SlashCommandField taskId={task.id} />
        </SidebarField>
        <StakeholderPicker
          selected={resolvedStakeholders}
          onAdd={(s) => onFieldChange('stakeholders', [...(task.stakeholders ?? []), { ref: s.id, role: 'reviewer', key: false }])}
          onRemove={(id) => onFieldChange('stakeholders', (task.stakeholders ?? []).filter((x) => x.ref !== id))}
        />
      </aside>
    </div>
  );
}

/* ---- Context package tab ------------------------------------------ */
/* ---- Files tab ----------------------------------------------------- */
function FilesTab({ taskId }: { taskId: string }) {
  const confirm = useConfirm();
  const notify = useNotify();
  const { data: files, loading, refetch } = useApi<Array<{ name: string; size: number; modified: string; type: string; officeCheck?: OfficeCheck }>>(`/api/tasks/${taskId}/files`);
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
      notify.error(err, 'Could not upload the file. Try again.');
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const handleDelete = async (name: string) => {
    if (!(await confirm({ title: `Remove "${name}" from this task?`, message: 'The file is deleted from the task folder.', confirmLabel: 'Remove file', tone: 'danger' }))) return;
    try {
      const res = await fetch(`/api/tasks/${taskId}/files/${encodeURIComponent(name)}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(await res.text());
      refetch();
    } catch (err) {
      notify.error(err, 'Could not remove the file. Try again.');
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
              <OfficeCheckBadge check={f.officeCheck} />
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
  const confirm = useConfirm();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { refetchTasks } = useOutletContext<{ refetchTasks: () => void }>();
  const [tab, setTab] = useState<TaskTab>('work');
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [savedCount, setSavedCount] = useState(0);
  // The task saved, but its meetings could not be pinned: the meeting sources say so and offer a refresh.
  const [pinError, setPinError] = useState<string | null>(null);
  // Another task: its own diagnostics only.
  useEffect(() => { setPinError(null); }, [id]);

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
  const { openRecordDialogFor } = useRecordLauncher();
  const recorder = useRecorder();
  // Loaded with the page, so the button never opens the dialog late, or without the people it should name. The version
  // in the address sets `loading` during a refresh, so the button waits for the current list.
  const stakeholdersVersion = useDataVersion('stakeholders');
  const { data: people, loading: peopleLoading, error: peopleError } = useApi<Stakeholder[]>(`/api/stakeholders?v=${stakeholdersVersion}`);

  const panelRef = useDialogFocus(true, close, true);

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
      const saved = await apiPut<Task & { meeting_sources_error?: string }>(`/api/tasks/${id}`, localTask);
      setPinError(saved?.meeting_sources_error ?? null);
      editingRef.current = false;
      setSavedCount((n) => n + 1);
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
    if (!(await confirm({ title: `Delete "${localTask.title}"?`, message: 'The task and its files are deleted. This cannot be undone.', confirmLabel: 'Delete task', tone: 'danger' }))) return;
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

  const frame = (body: React.ReactNode, label = 'Task details') => ReactDOM.createPortal(
    <div className="gtd-modal" role="dialog" aria-modal="true" aria-label={label}>
      <div className="gtd-modal__scrim" aria-hidden="true" onClick={close} />
      <div ref={panelRef} tabIndex={-1} className="gtd-modal__panel gtd-modal__panel--detail">{body}</div>
    </div>,
    document.body
  );

  if (loading) return frame(<LoadingSpinner text="Loading task…" />);

  if (!localTask) return frame(
    <div style={{ padding: 'var(--space-6)' }}>
      <EmptyState title="Task not found" description="It may have been deleted or archived. Check the board or the archive."
        action={{ label: 'Back to the board', onClick: close }} />
    </div>
  );

  return frame(
    <>
      {/* Header */}
      <div className="gtd-modal__header" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 'var(--space-2)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
          <span className="mono" style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', background: 'var(--color-bg)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm)', padding: '1px 6px', flexShrink: 0 }}>
            {localTask.id}
          </span>
          <span style={{ flex: 1 }} />
          {isMeetingPrepTask(localTask) && (
            <Button
              variant="secondary" size="sm" disabled={recorder.active || !people || peopleLoading || !!peopleError}
              title={recorder.active ? 'A recording is running' : peopleError ? 'Could not load the stakeholders. Reload the page to try again.' : undefined}
              onClick={() => { if (people) openRecordDialogFor(recordPrefillFromTask(localTask, people)); }}
            >
              Record this meeting
            </Button>
          )}
          {isDirty && <Button variant="primary" size="sm" loading={saving} onClick={handleSave}>Save changes</Button>}
          <IconButton label="Delete task" icon={icons.trash} tone="danger" outline onClick={handleDelete} disabled={deleting} />
          <IconButton label="Close task" icon={icons.close} onClick={close} />
        </div>
        <input
          type="text"
          aria-label="Task title"
          className="gtd-title-input"
          value={localTask.title}
          onChange={(e) => handleFieldChange('title', e.target.value)}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
          <Badge variant={`priority-${localTask.priority}` as 'priority-critical'} size="md">
            {formatPriorityLabel(localTask.priority)}
          </Badge>
          <Badge variant={`status-${localTask.status}` as 'status-done'} size="md">
            {formatStatusLabel(localTask.status)}
          </Badge>
          {localTask.due_date && (
            <span style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)' }}>Due {formatDate(localTask.due_date)}</span>
          )}
        </div>
      </div>

      <Tabs label="Task sections" value={tab} onChange={setTab} idPrefix="task" items={tabs.map((t) => ({ id: t.key, label: t.label }))}
        style={{ padding: '0 var(--space-5)', flexShrink: 0 }} />

      <div id="task-panel" role="tabpanel" aria-labelledby={`task-tab-${tab}`}
        style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column', padding: 'var(--space-5)' }}>
        {tab === 'work' && <WorkTab task={localTask} onFieldChange={handleFieldChange} savedCount={savedCount} pinError={pinError} onPinned={() => setPinError(null)} />}
        {tab === 'files' && id && <FilesTab taskId={id} />}
      </div>
    </>,
    localTask.title
  );
}
