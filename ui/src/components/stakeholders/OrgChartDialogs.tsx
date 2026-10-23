import React, { useEffect, useMemo, useState } from 'react';
import Avatar from '@/components/common/Avatar';
import Button from '@/components/common/Button';
import Input, { Textarea } from '@/components/common/Input';
import Modal from '@/components/common/Modal';
import type { OrgChart, OrgUnit, Stakeholder } from '@/types';
import { buildUnitTree, unitDescendants } from '@/utils/orgChart';
import type { UnitTreeNode } from '@/utils/orgChart';

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
// Placeholders
// ---------------------------------------------------------------------------

interface PlaceholderModalProps {
  isOpen: boolean;
  /** Current values when editing; undefined when adding one. */
  current?: { name: string; title?: string };
  /** Shown in the description when adding ("under Ava Lindqvist"). */
  managerName?: string | null;
  onClose: () => void;
  onSave: (name: string, title: string) => void;
}

export function PlaceholderModal({ isOpen, current, managerName, onClose, onSave }: PlaceholderModalProps) {
  const [name, setName] = useState('');
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!isOpen) return;
    setName(current?.name ?? '');
    setTitle(current?.title ?? '');
    setError(null);
  }, [isOpen, current]);
  function submit() {
    if (!name.trim()) { setError('Describe who this is, for example "Head of Sales (vacant)".'); return; }
    onSave(name.trim(), title.trim());
  }
  return (
    <Modal isOpen={isOpen} onClose={onClose} title={current ? 'Edit placeholder' : 'Add a placeholder'} size="sm">
      <p style={{ margin: '0 0 12px', fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)' }}>
        Someone who is not a stakeholder yet, or a role that is vacant{!current && managerName ? <>, reporting to <strong>{managerName}</strong></> : ''}.
        It lives only in this chart. You can turn it into a stakeholder later.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <Input label="Name or description *" value={name} onChange={setName} placeholder="Head of Sales (vacant)" autoFocus
          error={error ?? undefined} onKeyDown={(e) => { if (e.key === 'Enter') submit(); }} />
        <Input label="Title" value={title} onChange={setTitle} placeholder="Head of Sales"
          onKeyDown={(e) => { if (e.key === 'Enter') submit(); }} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={submit}>{current ? 'Save' : 'Add placeholder'}</Button>
      </div>
    </Modal>
  );
}

export interface NewStakeholderValues {
  name: string;
  role: string;
  organization: string;
}

interface MakeStakeholderModalProps {
  isOpen: boolean;
  initial: NewStakeholderValues;
  onClose: () => void;
  /** Creates the stakeholder and puts them in the placeholder's place; rejects with a message on failure. */
  onSubmit: (values: NewStakeholderValues) => Promise<void>;
}

export function MakeStakeholderModal({ isOpen, initial, onClose, onSubmit }: MakeStakeholderModalProps) {
  const [values, setValues] = useState<NewStakeholderValues>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (isOpen) { setValues(initial); setError(null); } }, [isOpen, initial]);
  const set = (key: keyof NewStakeholderValues) => (v: string) => setValues((x) => ({ ...x, [key]: v }));
  async function submit() {
    if (!values.name.trim()) { setError('Enter their name.'); return; }
    setSaving(true);
    setError(null);
    try {
      await onSubmit({ name: values.name.trim(), role: values.role.trim(), organization: values.organization.trim() });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the stakeholder.');
    } finally {
      setSaving(false);
    }
  }
  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Make stakeholder" size="sm">
      <p style={{ margin: '0 0 12px', fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)' }}>
        Creates a stakeholder and puts them in the placeholder's place in this chart, with the same manager, reports and unit.
        Other charts are not changed.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <Input label="Name *" value={values.name} onChange={set('name')} autoFocus error={error && !values.name.trim() ? error : undefined} />
        <Input label="Role" value={values.role} onChange={set('role')} />
        <Input label="Organization" value={values.organization} onChange={set('organization')} />
      </div>
      {error && values.name.trim() && <p role="alert" style={{ marginTop: 12, fontSize: 'var(--text-sm)', color: 'var(--color-critical)' }}>{error}</p>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button variant="primary" loading={saving} onClick={submit}>Create stakeholder</Button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

const selectStyle: React.CSSProperties = {
  width: '100%', height: 34, padding: '0 8px', fontSize: 'var(--text-sm)', color: 'var(--color-text)',
  background: 'var(--color-surface)', border: '1px solid var(--color-border-strong)', borderRadius: 'var(--radius-md)',
};
const fieldLabel: React.CSSProperties = { display: 'block', marginBottom: 4, fontSize: 'var(--text-sm)', fontWeight: 500, color: 'var(--color-text)' };

/** Units in tree order with their depth, for indented lists. */
function flatUnits(units: OrgUnit[]): Array<{ unit: OrgUnit; depth: number }> {
  const out: Array<{ unit: OrgUnit; depth: number }> = [];
  const walk = (nodes: UnitTreeNode[], depth: number) => nodes.forEach((n) => { out.push({ unit: n.unit, depth }); walk(n.children, depth + 1); });
  walk(buildUnitTree(units), 0);
  return out;
}

export interface UnitFormValues {
  name: string;
  parent: string | null;
  head: string | null;
}

interface UnitFormModalProps {
  isOpen: boolean;
  /** The unit being edited; null to create one. */
  editing: OrgUnit | null;
  /** Parent to start with when creating a sub-unit. */
  defaultParent?: string | null;
  units: OrgUnit[];
  /** Chart members who can lead a unit. */
  members: Stakeholder[];
  onClose: () => void;
  onSave: (values: UnitFormValues) => void;
}

export function UnitFormModal({ isOpen, editing, defaultParent, units, members, onClose, onSave }: UnitFormModalProps) {
  const [values, setValues] = useState<UnitFormValues>({ name: '', parent: null, head: null });
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!isOpen) return;
    setValues({ name: editing?.name ?? '', parent: editing ? editing.parent ?? null : defaultParent ?? null, head: editing?.head ?? null });
    setError(null);
  }, [isOpen, editing, defaultParent]);

  // A unit cannot sit inside itself or one of its own sub-units.
  const blocked = editing ? unitDescendants(units, editing.id) : new Set<string>();
  const parents = flatUnits(units).filter(({ unit }) => !blocked.has(unit.id));
  const sortedMembers = [...members].sort((a, b) => a.name.localeCompare(b.name));

  function submit() {
    if (!values.name.trim()) { setError('Give the unit a name.'); return; }
    onSave({ ...values, name: values.name.trim() });
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={editing ? `Edit ${editing.name}` : 'New unit'} size="sm">
      <p style={{ margin: '0 0 12px', fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)' }}>
        A department, team or other group. Units only group people; reporting lines stay as they are in the chart.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <Input label="Name *" value={values.name} onChange={(v) => setValues((x) => ({ ...x, name: v }))} placeholder="Engineering" autoFocus
          error={error ?? undefined} onKeyDown={(e) => { if (e.key === 'Enter') submit(); }} />
        <label>
          <span style={fieldLabel}>Part of</span>
          <select value={values.parent ?? ''} onChange={(e) => setValues((x) => ({ ...x, parent: e.target.value || null }))} style={selectStyle}>
            <option value="">Nothing (a top-level unit)</option>
            {parents.map(({ unit, depth }) => (
              <option key={unit.id} value={unit.id}>{'\u00a0\u00a0'.repeat(depth)}{unit.name}</option>
            ))}
          </select>
        </label>
        <label>
          <span style={fieldLabel}>Head</span>
          <select value={values.head ?? ''} onChange={(e) => setValues((x) => ({ ...x, head: e.target.value || null }))} style={selectStyle}>
            <option value="">Nobody</option>
            {sortedMembers.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
          <span style={{ display: 'block', marginTop: 4, fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
            Anyone in this chart. Leading a unit does not make them everyone's manager.
          </span>
        </label>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={submit}>{editing ? 'Save' : 'Create unit'}</Button>
      </div>
    </Modal>
  );
}

interface UnitPickerModalProps {
  isOpen: boolean;
  name: string;
  units: OrgUnit[];
  current?: string;
  onClose: () => void;
  /** null = no unit. */
  onPick: (unit: string | null) => void;
  /** Creates a top-level unit with this name and puts the person in it. */
  onCreate: (name: string) => void;
}

export function UnitPickerModal({ isOpen, name, units, current, onClose, onPick, onCreate }: UnitPickerModalProps) {
  const [newName, setNewName] = useState('');
  useEffect(() => { if (isOpen) setNewName(''); }, [isOpen]);
  const rowStyle = (active: boolean): React.CSSProperties => ({
    display: 'block', width: '100%', padding: '7px 10px', textAlign: 'left', border: 'none', cursor: 'pointer',
    borderRadius: 'var(--radius-sm)', fontSize: 'var(--text-sm)', color: 'var(--color-text)',
    background: active ? 'var(--color-accent-subtle)' : 'transparent', fontWeight: active ? 600 : 400,
  });
  return (
    <Modal isOpen={isOpen} onClose={onClose} title={`${name}: unit`} size="sm">
      <p style={{ margin: '0 0 10px', fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)' }}>
        Which department or team are they in? This does not change who they report to.
      </p>
      <div role="listbox" aria-label="Units" style={{ maxHeight: 300, overflowY: 'auto' }}>
        <button type="button" role="option" aria-selected={!current} style={rowStyle(!current)} onClick={() => onPick(null)}>
          <span style={{ color: 'var(--color-text-muted)' }}>No unit</span>
        </button>
        {flatUnits(units).map(({ unit, depth }) => (
          <button key={unit.id} type="button" role="option" aria-selected={current === unit.id} style={{ ...rowStyle(current === unit.id), paddingLeft: 10 + depth * 16 }}
            onClick={() => onPick(unit.id)}>
            {unit.name}
          </button>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--color-border)' }}>
        <div style={{ flex: 1 }}>
          <Input value={newName} onChange={setNewName} placeholder="New unit name" aria-label="New unit name"
            onKeyDown={(e) => { if (e.key === 'Enter' && newName.trim()) onCreate(newName.trim()); }} />
        </div>
        <Button variant="secondary" disabled={!newName.trim()} onClick={() => onCreate(newName.trim())}>Create and add</Button>
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
  /** Extra content under the list, e.g. "Add a placeholder instead". */
  footer?: React.ReactNode;
}

export function PersonPickerModal({ isOpen, title, description, people, noneLabel, emptyText, onClose, onPick, footer }: PersonPickerModalProps) {
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
      {footer && <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--color-border)' }}>{footer}</div>}
    </Modal>
  );
}
