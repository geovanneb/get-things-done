import React, { useEffect, useMemo, useState } from 'react';
import Avatar from '@/components/common/Avatar';
import Button from '@/components/common/Button';
import Input, { Textarea } from '@/components/common/Input';
import Modal from '@/components/common/Modal';
import type { OrgChart, Stakeholder } from '@/types';

// ---------------------------------------------------------------------------
// Title in this chart
// ---------------------------------------------------------------------------

interface TitleModalProps {
  isOpen: boolean;
  name: string;
  /** The stakeholder's role from their profile (the fallback). */
  profileRole?: string;
  current?: string;
  onClose: () => void;
  onSave: (title: string) => void;
}

export function TitleModal({ isOpen, name, profileRole, current, onClose, onSave }: TitleModalProps) {
  const [value, setValue] = useState('');
  useEffect(() => { if (isOpen) setValue(current ?? ''); }, [isOpen, current]);
  return (
    <Modal isOpen={isOpen} onClose={onClose} title={`${name}: title in this chart`} size="sm">
      <p style={{ margin: '0 0 12px', fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)' }}>
        Shown on the card and read by agents for this organization only. Their profile role stays as it is
        {profileRole ? <> (<strong>{profileRole}</strong>)</> : null}. Leave empty to use the profile role.
      </p>
      <Input value={value} onChange={setValue} placeholder={profileRole || 'Title'} autoFocus aria-label="Title in this chart"
        onKeyDown={(e) => { if (e.key === 'Enter') onSave(value); }} />
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
        {current && <Button variant="ghost" onClick={() => onSave('')}>Use profile role</Button>}
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={() => onSave(value)}>Save</Button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Create / edit chart details
// ---------------------------------------------------------------------------

export interface ChartFormValues {
  name: string;
  organization: string;
  description: string;
  notes: string;
  /** Create only: add every stakeholder whose organization matches. */
  prefill: boolean;
}

interface ChartFormModalProps {
  isOpen: boolean;
  editing: OrgChart | null;
  stakeholders: Stakeholder[];
  onClose: () => void;
  onSubmit: (values: ChartFormValues) => Promise<void>;
}

export function ChartFormModal({ isOpen, editing, stakeholders, onClose, onSubmit }: ChartFormModalProps) {
  const [values, setValues] = useState<ChartFormValues>({ name: '', organization: '', description: '', notes: '', prefill: true });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setValues({
      name: editing?.name ?? '',
      organization: editing?.organization ?? '',
      description: editing?.description ?? '',
      notes: editing?.notes ?? '',
      prefill: true,
    });
    setError(null);
  }, [isOpen, editing]);

  const organizations = useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of stakeholders) {
      const org = s.organization?.trim();
      if (org) counts.set(org, (counts.get(org) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [stakeholders]);

  const matching = values.organization.trim()
    ? stakeholders.filter((s) => s.organization?.trim().toLowerCase() === values.organization.trim().toLowerCase()).length
    : 0;

  const set = <K extends keyof ChartFormValues>(key: K, value: ChartFormValues[K]) => setValues((v) => ({ ...v, [key]: value }));

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!values.name.trim()) { setError('Give the chart a name.'); return; }
    setSaving(true);
    setError(null);
    try {
      await onSubmit(values);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the chart.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={editing ? 'Edit org chart' : 'New org chart'} size="lg">
      <form onSubmit={handleSubmit} noValidate>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <Input label="Chart name *" value={values.name} onChange={(v) => set('name', v)} placeholder="Leadership team" autoFocus
            error={error && !values.name.trim() ? 'Required' : undefined} />
          <div>
            <Input label="Company or organization" value={values.organization}
              onChange={(v) => {
                set('organization', v);
                if (!values.name.trim() || values.name === values.organization) set('name', v);
              }}
              placeholder="Acme Corp" />
            {organizations.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6 }}>
                {organizations.slice(0, 6).map(([org, count]) => (
                  <button key={org} type="button" onClick={() => {
                    set('organization', org);
                    if (!values.name.trim() || values.name === values.organization) set('name', org);
                  }}
                    style={{
                      fontSize: 'var(--text-xs)', padding: '2px 8px', borderRadius: 999, cursor: 'pointer',
                      border: '1px solid var(--color-border)',
                      background: values.organization === org ? 'var(--color-accent-subtle)' : 'transparent',
                      color: values.organization === org ? 'var(--color-accent)' : 'var(--color-text-secondary)',
                    }}>
                    {org} · {count}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div style={{ gridColumn: '1 / -1' }}>
            <Input label="Description" value={values.description} onChange={(v) => set('description', v)}
              placeholder="Executive team and their direct reports" />
          </div>
          <div style={{ gridColumn: '1 / -1' }}>
            <Textarea label="Notes (markdown)" value={values.notes} onChange={(v) => set('notes', v)} rows={3}
              placeholder="Anything agents should know: informal influence, upcoming changes, dotted lines..." />
          </div>
          {!editing && matching > 0 && (
            <label style={{ gridColumn: '1 / -1', display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--text-sm)', color: 'var(--color-text)', cursor: 'pointer' }}>
              <input type="checkbox" checked={values.prefill} onChange={(e) => set('prefill', e.target.checked)} />
              Add the {matching} {matching === 1 ? 'stakeholder' : 'stakeholders'} from {values.organization.trim()} to start with
            </label>
          )}
        </div>

        {error && <p role="alert" style={{ marginTop: 12, fontSize: 'var(--text-sm)', color: 'var(--color-critical)' }}>{error}</p>}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20, paddingTop: 16, borderTop: '1px solid var(--color-border)' }}>
          <Button variant="ghost" type="button" onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" loading={saving}>{editing ? 'Save changes' : 'Create chart'}</Button>
        </div>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Pick a person (add a report, change a manager)
// ---------------------------------------------------------------------------

interface PersonPickerModalProps {
  isOpen: boolean;
  title: string;
  description?: string;
  people: Stakeholder[];
  /** Shown as a first option, e.g. "Top of the chart". */
  noneLabel?: string;
  emptyText: string;
  onClose: () => void;
  onPick: (id: string | null) => void;
}

export function PersonPickerModal({ isOpen, title, description, people, noneLabel, emptyText, onClose, onPick }: PersonPickerModalProps) {
  const [query, setQuery] = useState('');
  useEffect(() => { if (isOpen) setQuery(''); }, [isOpen]);

  const q = query.trim().toLowerCase();
  const filtered = people.filter((p) =>
    !q || p.name.toLowerCase().includes(q) || (p.role ?? '').toLowerCase().includes(q) || (p.organization ?? '').toLowerCase().includes(q));

  const rowStyle: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '8px 10px', textAlign: 'left',
    border: 'none', background: 'transparent', borderRadius: 'var(--radius-sm)', cursor: 'pointer',
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={title} size="md">
      {description && <p style={{ margin: '0 0 12px', fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)' }}>{description}</p>}
      <Input value={query} onChange={setQuery} placeholder="Search by name, role or organization" autoFocus aria-label="Search people"
        onKeyDown={(e) => { if (e.key === 'Enter' && filtered.length > 0) onPick(filtered[0].id); }} />
      <div style={{ marginTop: 10, maxHeight: 360, overflowY: 'auto' }}>
        {noneLabel && !q && (
          <button type="button" style={rowStyle} onClick={() => onPick(null)}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-surface-hover)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}>
            <span style={{ width: 32, height: 32, borderRadius: '50%', border: '1px dashed var(--color-border-strong)', flexShrink: 0 }} />
            <span style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text)' }}>{noneLabel}</span>
          </button>
        )}
        {filtered.map((p) => (
          <button key={p.id} type="button" style={rowStyle} onClick={() => onPick(p.id)}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-surface-hover)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}>
            <Avatar name={p.name} size="md" initials={p.avatar_initials} />
            <span style={{ minWidth: 0 }}>
              <span style={{ display: 'block', fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--color-text)' }}>{p.name}</span>
              <span style={{ display: 'block', fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
                {[p.role, p.organization].filter(Boolean).join(' · ') || p.id}
              </span>
            </span>
          </button>
        ))}
        {filtered.length === 0 && (
          <p style={{ padding: '12px 10px', margin: 0, fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)' }}>
            {q ? 'Nobody matches that search.' : emptyText}
          </p>
        )}
      </div>
    </Modal>
  );
}
