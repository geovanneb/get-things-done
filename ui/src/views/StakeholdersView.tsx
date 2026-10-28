import React, { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import Avatar from '@/components/common/Avatar';
// Badge removed — counts shown inside TabBar directly
import Button from '@/components/common/Button';
import EmptyState from '@/components/common/EmptyState';
import Input, { Textarea } from '@/components/common/Input';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import Modal from '@/components/common/Modal';
import OrgChartsPanel from '@/components/stakeholders/OrgChartsPanel';
import { apiDelete, apiPost, apiPut } from '@/utils/api';
import type { Stakeholder } from '@/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SortKey = 'name' | 'role' | 'organization';
type SortDir = 'asc' | 'desc';

interface FormState {
  name: string;
  role: string;
  organization: string;
  email: string;
  what_matters: string;
  notes: string;
}

const EMPTY_FORM: FormState = {
  name: '',
  role: '',
  organization: '',
  email: '',
  what_matters: '',
  notes: '',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sortStakeholders(list: Stakeholder[], key: SortKey, dir: SortDir): Stakeholder[] {
  return [...list].sort((a, b) => {
    const av = (a[key] ?? '').toString().toLowerCase();
    const bv = (b[key] ?? '').toString().toLowerCase();
    if (av < bv) return dir === 'asc' ? -1 : 1;
    if (av > bv) return dir === 'asc' ? 1 : -1;
    return 0;
  });
}

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

function SortArrow({ active, dir }: { active: boolean; dir: SortDir }) {
  if (!active) {
    return (
      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" style={{ opacity: 0.25 }}>
        <path d="M5 2 L8 7 L2 7 Z" fill="currentColor" />
      </svg>
    );
  }
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      {dir === 'asc' ? (
        <path d="M5 2 L8 7 L2 7 Z" fill="currentColor" />
      ) : (
        <path d="M5 8 L8 3 L2 3 Z" fill="currentColor" />
      )}
    </svg>
  );
}

function PencilIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true">
      <path d="M11.5 1.5l2 2-9 9H2.5v-2l9-9z" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true">
      <path d="M2 4h11M5 4V2.5a.5.5 0 0 1 .5-.5h4a.5.5 0 0 1 .5.5V4M6 7v4M9 7v4M3 4l.8 8.5a.5.5 0 0 0 .5.5h6.4a.5.5 0 0 0 .5-.5L12 4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true">
      <circle cx="6.5" cy="6.5" r="4" stroke="currentColor" strokeWidth="1.3" />
      <path d="M9.5 9.5 L13 13" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Sortable column header
// ---------------------------------------------------------------------------

interface SortHeaderProps {
  label: string;
  sortKey: SortKey;
  currentKey: SortKey;
  currentDir: SortDir;
  onSort: (key: SortKey) => void;
  align?: 'left' | 'right';
}

function SortHeader({ label, sortKey, currentKey, currentDir, onSort, align = 'left' }: SortHeaderProps) {
  const active = currentKey === sortKey;
  return (
    <th
      scope="col"
      onClick={() => onSort(sortKey)}
      style={{
        padding: '10px 16px',
        textAlign: align,
        fontSize: 'var(--text-xs)',
        fontWeight: 600,
        color: active ? 'var(--color-text)' : 'var(--color-text-muted)',
        letterSpacing: '0.04em',
        textTransform: 'uppercase',
        cursor: 'pointer',
        userSelect: 'none',
        whiteSpace: 'nowrap',
      }}
    >
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        {label}
        <SortArrow active={active} dir={currentDir} />
      </span>
    </th>
  );
}

// ---------------------------------------------------------------------------
// Add / Edit modal
// ---------------------------------------------------------------------------

interface StakeholderModalProps {
  isOpen: boolean;
  onClose: () => void;
  editing: Stakeholder | null;
  onSaved: () => void;
  type: ListTab;
}

function StakeholderModal({ isOpen, onClose, editing, onSaved, type }: StakeholderModalProps) {
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    if (editing) {
      setForm({
        name: editing.name,
        role: editing.role ?? '',
        organization: editing.organization ?? '',
        email: editing.email ?? '',
        what_matters: editing.what_matters ?? '',
        notes: editing.notes ?? '',
      });
    } else {
      setForm(EMPTY_FORM);
    }
    setFormError(null);
  }, [isOpen, editing]);

  function setField(key: keyof FormState, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim()) {
      setFormError('Name is required.');
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      const payload = {
        name: form.name.trim(),
        role: form.role.trim(),
        organization: form.organization.trim(),
        email: form.email.trim() || undefined,
        what_matters: form.what_matters.trim(),
        notes: form.notes.trim() || undefined,
      };
      if (editing) {
        await apiPut(`/api/stakeholders/${editing.id}`, payload);
      } else {
        await apiPost('/api/stakeholders', { ...payload, type });
      }
      onSaved();
      onClose();
    } catch (err: unknown) {
      setFormError(err instanceof Error ? err.message : 'An error occurred.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={editing ? `Edit ${type === 'groups' ? 'Group' : 'Individual'}` : `Add ${type === 'groups' ? 'Group' : 'Individual'}`} size="lg">
      <form onSubmit={handleSubmit} noValidate>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <div style={{ gridColumn: '1 / -1' }}>
            <Input label="Name *" value={form.name} onChange={(v) => setField('name', v)} placeholder="Jane Smith" autoFocus
              error={formError && !form.name.trim() ? 'Required' : undefined} />
          </div>

          <Input label="Role" value={form.role} onChange={(v) => setField('role', v)} placeholder="VP of Engineering" />
          <Input label="Organization" value={form.organization} onChange={(v) => setField('organization', v)} placeholder="Acme Corp" />
          <div style={{ gridColumn: '1 / -1' }}>
            <Input label="Email" type="email" value={form.email} onChange={(v) => setField('email', v)} placeholder="jane@acme.com" />
          </div>

          <div style={{ gridColumn: '1 / -1' }}>
            <Textarea label="What matters" value={form.what_matters} onChange={(v) => setField('what_matters', v)}
              placeholder="What this person cares about most..." rows={3} />
          </div>

          <div style={{ gridColumn: '1 / -1' }}>
            <Textarea label="Notes (markdown)" value={form.notes} onChange={(v) => setField('notes', v)}
              placeholder="Additional context, history, relationship notes..." rows={4} />
          </div>
        </div>

        {formError && (
          <p role="alert" style={{ marginTop: 12, fontSize: 'var(--text-sm)', color: 'var(--color-critical)' }}>
            {formError}
          </p>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20, paddingTop: 16, borderTop: '1px solid var(--color-border)' }}>
          <Button variant="ghost" onClick={onClose} type="button">Cancel</Button>
          <Button variant="primary" type="submit" loading={saving}>
            {editing ? 'Save changes' : `Add ${type === 'groups' ? 'group' : 'individual'}`}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Table row
// ---------------------------------------------------------------------------

interface RowProps {
  stakeholder: Stakeholder;
  isLast: boolean;
  onEdit: () => void;
  onDelete: () => void;
}

function StakeholderRow({ stakeholder: s, isLast, onEdit, onDelete }: RowProps) {
  const [hovered, setHovered] = useState(false);

  const tdStyle: React.CSSProperties = {
    padding: '12px 16px',
    verticalAlign: 'middle',
    borderBottom: isLast ? 'none' : '1px solid var(--color-border)',
    background: hovered ? 'var(--color-surface-hover)' : 'transparent',
    transition: 'background 0.1s',
  };

  return (
    <tr onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
      <td style={tdStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Avatar name={s.name} size="md" />
          <Link to={`/stakeholders/${s.id}`}
            style={{ fontWeight: 600, color: 'var(--color-text)', textDecoration: 'none' }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLAnchorElement).style.textDecoration = 'underline'; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLAnchorElement).style.textDecoration = 'none'; }}>
            {s.name}
          </Link>
        </div>
      </td>

      <td style={tdStyle}>
        <span style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--text-sm)' }}>
          {s.role || <span style={{ color: 'var(--color-text-muted)' }}>—</span>}
        </span>
      </td>

      <td style={tdStyle}>
        <span style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--text-sm)' }}>
          {s.organization || <span style={{ color: 'var(--color-text-muted)' }}>—</span>}
        </span>
      </td>

      <td style={{ ...tdStyle, maxWidth: 220 }}>
        <span title={s.what_matters} style={{ display: 'block', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis', fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)' }}>
          {s.what_matters || <span style={{ color: 'var(--color-text-muted)' }}>—</span>}
        </span>
      </td>

      <td style={{ ...tdStyle, textAlign: 'right' }}>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 4 }}>
          <Button variant="ghost" size="sm" onClick={onEdit} aria-label={`Edit ${s.name}`} icon={<PencilIcon />} />
          <Button variant="ghost" size="sm" onClick={onDelete} aria-label={`Delete ${s.name}`} icon={<TrashIcon />}
            style={{ color: 'var(--color-critical)' }} />
        </div>
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

type ListTab = 'people' | 'groups';
type TabType = ListTab | 'charts';

interface TabBarProps {
  active: TabType;
  peopleCt: number;
  groupsCt: number;
  onChange: (t: TabType) => void;
}

function TabBar({ active, peopleCt, groupsCt, onChange }: TabBarProps) {
  const tabs: { key: TabType; label: string; count?: number }[] = [
    { key: 'people', label: 'Individuals', count: peopleCt },
    { key: 'groups', label: 'Groups', count: groupsCt },
    { key: 'charts', label: 'Org charts' },
  ];
  return (
    <div
      role="tablist"
      aria-label="Stakeholder type"
      style={{
        display: 'inline-flex',
        gap: 2,
        background: 'var(--color-bg)',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-md)',
        padding: 3,
      }}
    >
      {tabs.map(({ key, label, count }) => {
        const isActive = active === key;
        return (
          <button
            key={key}
            role="tab"
            aria-selected={isActive}
            onClick={() => onChange(key)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '5px 14px',
              border: 'none',
              borderRadius: 'var(--radius-sm)',
              background: isActive ? 'var(--color-surface)' : 'transparent',
              boxShadow: isActive ? '0 1px 3px color-mix(in oklch, var(--color-text) 12%, transparent)' : 'none',
              color: isActive ? 'var(--color-text)' : 'var(--color-text-muted)',
              fontWeight: isActive ? 600 : 400,
              fontSize: 'var(--text-sm)',
              cursor: 'pointer',
              transition: 'all 0.15s ease',
              whiteSpace: 'nowrap',
            }}
          >
            {label}
            {count !== undefined && <span
              style={{
                fontSize: 'var(--text-xs)',
                fontWeight: 600,
                padding: '0 5px',
                borderRadius: 9,
                background: isActive ? 'var(--color-accent-subtle)' : 'var(--color-surface-hover)',
                color: isActive ? 'var(--color-accent)' : 'var(--color-text-muted)',
                minWidth: 18,
                textAlign: 'center',
              }}
            >
              {count}
            </span>}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main view
// ---------------------------------------------------------------------------

export default function StakeholdersView() {
  const [params, setParams] = useSearchParams();
  const tab: TabType = params.get('tab') === 'charts' ? 'charts' : params.get('tab') === 'groups' ? 'groups' : 'people';
  const [people, setPeople] = useState<Stakeholder[]>([]);
  const [groups, setGroups] = useState<Stakeholder[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Stakeholder | null>(null);

  async function fetchStakeholders() {
    try {
      setFetchError(null);
      const [peopleData, groupsData] = await Promise.all([
        fetch('/api/stakeholders?type=people').then((r) => { if (!r.ok) throw new Error('Failed to load'); return r.json(); }),
        fetch('/api/stakeholders?type=groups').then((r) => { if (!r.ok) throw new Error('Failed to load'); return r.json(); }),
      ]);
      setPeople(peopleData);
      setGroups(groupsData);
    } catch (err: unknown) {
      setFetchError(err instanceof Error ? err.message : 'Failed to load stakeholders.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { fetchStakeholders(); }, []);

  function handleSort(key: SortKey) {
    if (key === sortKey) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(key); setSortDir('asc'); }
  }

  async function handleDelete(s: Stakeholder) {
    const label = tab === 'groups' ? 'group' : 'stakeholder';
    const confirmed = window.confirm(`Delete "${s.name}"? This cannot be undone.`);
    if (!confirmed) return;
    try {
      await apiDelete(`/api/stakeholders/${s.id}`);
      if (tab === 'groups') setGroups((prev) => prev.filter((x) => x.id !== s.id));
      else setPeople((prev) => prev.filter((x) => x.id !== s.id));
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : `Delete ${label} failed.`);
    }
  }

  const activeList = tab === 'groups' ? groups : people;

  const filtered = activeList.filter((s) => {
    const q = search.toLowerCase();
    return s.name.toLowerCase().includes(q) || (s.role ?? '').toLowerCase().includes(q) || (s.organization ?? '').toLowerCase().includes(q);
  });

  const sorted = sortStakeholders(filtered, sortKey, sortDir);

  const thPlain: React.CSSProperties = {
    padding: '10px 16px', textAlign: 'left', fontSize: 'var(--text-xs)', fontWeight: 600,
    color: 'var(--color-text-muted)', letterSpacing: '0.04em', textTransform: 'uppercase', whiteSpace: 'nowrap',
  };

  return (
    <div style={{ padding: 16, maxWidth: 1200, margin: '0 auto', boxSizing: 'border-box' }}>
      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
        <h1 style={{ fontSize: 'var(--text-xl)', fontWeight: 700, color: 'var(--color-text)', margin: 0 }}>
          Stakeholders
        </h1>
        {!loading && (
          <TabBar
            active={tab}
            peopleCt={people.length}
            groupsCt={groups.length}
            onChange={(t) => { setParams((previous) => { const next = new URLSearchParams(previous); next.set('tab', t); return next; }); setSearch(''); }}
          />
        )}
        {tab === 'charts' ? <div style={{ flex: 1 }} /> : <>
        <div style={{ flex: 1, minWidth: 200 }}>
          <Input
            value={search}
            onChange={setSearch}
            placeholder={`Search ${tab === 'groups' ? 'groups' : 'individuals'}…`}
            icon={<SearchIcon />}
            aria-label={`Search ${tab}`}
          />
        </div>
        <Button variant="primary" onClick={() => { setEditing(null); setModalOpen(true); }}>
          + Add {tab === 'groups' ? 'Group' : 'Individual'}
        </Button>
        </>}
      </div>

      {fetchError && (
        <p role="alert" style={{ color: 'var(--color-critical)', fontSize: 'var(--text-sm)', marginBottom: 16 }}>{fetchError}</p>
      )}

      {loading && <div style={{ display: 'flex', justifyContent: 'center', padding: '48px 0' }}><LoadingSpinner /></div>}

      {!loading && tab === 'charts' && <OrgChartsPanel stakeholders={[...people, ...groups]} initialChartId={params.get('chart')}
        onStakeholderCreated={(s) => setPeople((prev) => [...prev, s])} />}

      {!loading && tab !== 'charts' && (
        <div style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-lg)', overflow: 'hidden' }}>
          {sorted.length === 0 ? (
            <EmptyState
              title={search ? `No ${tab} match your search` : `No ${tab} yet`}
              description={search ? 'Try a different search term.' : `Add your first ${tab === 'groups' ? 'group' : 'individual'} to get started.`}
            />
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--text-base)' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--color-border)', background: 'var(--color-bg)' }}>
                    <SortHeader label="Name" sortKey="name" currentKey={sortKey} currentDir={sortDir} onSort={handleSort} />
                    <SortHeader label="Role" sortKey="role" currentKey={sortKey} currentDir={sortDir} onSort={handleSort} />
                    <SortHeader label="Organization" sortKey="organization" currentKey={sortKey} currentDir={sortDir} onSort={handleSort} />
                    <th scope="col" style={thPlain}>What matters</th>
                    <th scope="col" style={{ ...thPlain, textAlign: 'right' }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((s, i) => (
                    <StakeholderRow key={s.id} stakeholder={s} isLast={i === sorted.length - 1}
                      onEdit={() => { setEditing(s); setModalOpen(true); }}
                      onDelete={() => handleDelete(s)} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      <StakeholderModal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        editing={editing}
        onSaved={fetchStakeholders}
        type={tab === 'groups' ? 'groups' : 'people'}
      />
    </div>
  );
}
