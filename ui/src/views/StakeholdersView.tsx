import React, { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import Avatar from '@/components/common/Avatar';
import Button from '@/components/common/Button';
import IconButton, { icons } from '@/components/common/IconButton';
import Notice from '@/components/common/Notice';
import Page, { PageHeader } from '@/components/common/Page';
import { Tabs } from '@/components/common/Tabs';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { useNotify } from '@/hooks/useNotify';
import EmptyState from '@/components/common/EmptyState';
import Input, { SearchInput, Textarea } from '@/components/common/Input';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import Modal, { FormActions } from '@/components/common/Modal';
import OrgChartsPanel from '@/components/stakeholders/OrgChartsPanel';
import { apiDelete, apiPost, apiPut } from '@/utils/api';
import type { RememberedVoice, Stakeholder } from '@/types';
import { useRememberedVoices, VoiceBadge } from '@/components/stakeholders/VoiceTag';

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
    <th scope="col" aria-sort={active ? (currentDir === 'asc' ? 'ascending' : 'descending') : undefined}
      style={{ textAlign: align, color: active ? 'var(--color-text)' : undefined }}>
      <button type="button" className="gtd-sort-btn" onClick={() => onSort(sortKey)}>
        {label}
        <SortArrow active={active} dir={currentDir} />
      </button>
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
      setFormError('Enter a name.');
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
      setFormError(err instanceof Error ? err.message : 'Could not save. Try again.');
    } finally {
      setSaving(false);
    }
  }

  const noun = type === 'groups' ? 'group' : 'individual';
  return (
    <Modal isOpen={isOpen} onClose={onClose} title={editing ? `Edit ${editing.name}` : `Add ${noun}`} size="lg" keepWhileTyping
      footer={
        <FormActions>
          <Button variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button variant="primary" type="submit" form="stakeholder-form" loading={saving}>
            {editing ? 'Save changes' : `Add ${noun}`}
          </Button>
        </FormActions>
      }>
      <form id="stakeholder-form" onSubmit={handleSubmit} noValidate className="gtd-stack">
        {formError && form.name.trim() && <Notice tone="critical">{formError}</Notice>}
        <div className="gtd-form-grid">
          <Input label="Name" required value={form.name} onChange={(v) => setField('name', v)} placeholder="Jane Smith" autoFocus
            error={formError && !form.name.trim() ? 'Enter a name.' : undefined} style={{ gridColumn: '1 / -1' }} />
          <Input label="Role" value={form.role} onChange={(v) => setField('role', v)} placeholder="VP of Engineering" />
          <Input label="Organization" value={form.organization} onChange={(v) => setField('organization', v)} placeholder="Acme Corp" />
          <Input label="Email" type="email" autoComplete="off" value={form.email} onChange={(v) => setField('email', v)} placeholder="jane@acme.com" style={{ gridColumn: '1 / -1' }} />
          <Textarea label="What matters" value={form.what_matters} onChange={(v) => setField('what_matters', v)}
            placeholder="What this person cares about most" rows={3} style={{ gridColumn: '1 / -1' }} />
          <Textarea label="Notes" hint="Markdown is supported." value={form.notes} onChange={(v) => setField('notes', v)}
            placeholder="Context, history, how the relationship works" rows={4} style={{ gridColumn: '1 / -1' }} />
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
  /** Their voice is remembered on this computer (Recognize known voices). */
  voice?: RememberedVoice;
  onEdit: () => void;
  onDelete: () => void;
}

function StakeholderRow({ stakeholder: s, voice, onEdit, onDelete }: RowProps) {
  const missing = <span style={{ color: 'var(--color-text-muted)' }} aria-label="Not set">—</span>;
  return (
    <tr>
      <td>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Avatar name={s.name} size="md" />
          <Link to={`/stakeholders/${s.id}`} className="gtd-link-strong">{s.name}</Link>
          <VoiceBadge voice={voice} />
        </div>
      </td>
      <td style={{ color: 'var(--color-text-secondary)' }}>{s.role || missing}</td>
      <td style={{ color: 'var(--color-text-secondary)' }}>{s.organization || missing}</td>
      <td style={{ maxWidth: 260 }}>
        <span title={s.what_matters} className="truncate" style={{ display: 'block', color: 'var(--color-text-secondary)' }}>
          {s.what_matters || missing}
        </span>
      </td>
      <td style={{ textAlign: 'right' }}>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 2 }}>
          <IconButton label={`Edit ${s.name}`} icon={icons.edit} onClick={onEdit} />
          <IconButton label={`Delete ${s.name}`} icon={icons.trash} tone="danger" onClick={onDelete} />
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
  const { voices } = useRememberedVoices();

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

  const confirm = useConfirm();
  const notify = useNotify();

  async function handleDelete(s: Stakeholder) {
    const label = tab === 'groups' ? 'group' : 'individual';
    const confirmed = await confirm({
      title: `Delete ${s.name}?`,
      message: `The ${label} is removed from your stakeholders. Tasks that mention them keep the reference. This cannot be undone.`,
      confirmLabel: `Delete ${label}`,
      tone: 'danger',
    });
    if (!confirmed) return;
    try {
      await apiDelete(`/api/stakeholders/${s.id}`);
      if (tab === 'groups') setGroups((prev) => prev.filter((x) => x.id !== s.id));
      else setPeople((prev) => prev.filter((x) => x.id !== s.id));
    } catch (err: unknown) {
      notify.error(err, `Could not delete the ${label}. Try again.`);
    }
  }

  const activeList = tab === 'groups' ? groups : people;

  const filtered = activeList.filter((s) => {
    const q = search.toLowerCase();
    return s.name.toLowerCase().includes(q) || (s.role ?? '').toLowerCase().includes(q) || (s.organization ?? '').toLowerCase().includes(q);
  });

  const sorted = sortStakeholders(filtered, sortKey, sortDir);

  const setTab = (t: TabType) => {
    setParams((previous) => { const next = new URLSearchParams(previous); next.set('tab', t); return next; });
    setSearch('');
  };
  const noun = tab === 'groups' ? 'group' : 'individual';

  return (
    <Page width={tab === 'charts' ? 'full' : 'default'}>
      <div>
        <Tabs label="Stakeholder views" value={tab} onChange={setTab} idPrefix="stakeholders"
          items={[
            { id: 'people', label: 'Individuals', count: loading ? undefined : people.length },
            { id: 'groups', label: 'Groups', count: loading ? undefined : groups.length },
            { id: 'charts', label: 'Org charts' },
          ]} />
      </div>

      <div id="stakeholders-panel" role="tabpanel" aria-labelledby={`stakeholders-tab-${tab}`} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        {tab !== 'charts' && (
          <PageHeader
            description={tab === 'groups'
              ? 'Teams, boards and committees you work with, so agents can address them as a group.'
              : 'The people your work is for. Agents read what matters to each one before they write.'}
            actions={<>
              <SearchInput value={search} onChange={setSearch} placeholder={`Search ${tab === 'groups' ? 'groups' : 'individuals'}`} />
              <Button variant="primary" icon={icons.plus} onClick={() => { setEditing(null); setModalOpen(true); }}>Add {noun}</Button>
            </>}
          />
        )}

        {fetchError && <Notice tone="critical" title="Could not load stakeholders." action={<Button size="sm" onClick={fetchStakeholders}>Try again</Button>}>{fetchError}</Notice>}

        {loading && <LoadingSpinner text="Loading stakeholders…" />}

        {!loading && tab === 'charts' && <OrgChartsPanel stakeholders={[...people, ...groups]} initialChartId={params.get('chart')}
          onStakeholderCreated={(s) => setPeople((prev) => [...prev, s])} />}

        {!loading && tab !== 'charts' && !fetchError && (
          <div className="gtd-card">
            {sorted.length === 0 ? (
              <EmptyState
                title={search ? `No ${noun}s match "${search}"` : `No ${noun}s yet`}
                description={search ? 'Try another name, role or organization.' : `Add the ${noun}s your work is for. Agents use what matters to them.`}
                action={search ? { label: 'Clear search', onClick: () => setSearch('') } : { label: `Add ${noun}`, onClick: () => { setEditing(null); setModalOpen(true); } }}
              />
            ) : (
              <div className="gtd-table-wrap">
                <table className="gtd-table">
                  <thead>
                    <tr>
                      <SortHeader label="Name" sortKey="name" currentKey={sortKey} currentDir={sortDir} onSort={handleSort} />
                      <SortHeader label="Role" sortKey="role" currentKey={sortKey} currentDir={sortDir} onSort={handleSort} />
                      <SortHeader label="Organization" sortKey="organization" currentKey={sortKey} currentDir={sortDir} onSort={handleSort} />
                      <th scope="col">What matters</th>
                      <th scope="col" style={{ textAlign: 'right' }}><span className="sr-only">Actions</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {sorted.map((s) => (
                      <StakeholderRow key={s.id} stakeholder={s} voice={voices.get(s.id)}
                        onEdit={() => { setEditing(s); setModalOpen(true); }}
                        onDelete={() => handleDelete(s)} />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>

      <StakeholderModal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        editing={editing}
        onSaved={fetchStakeholders}
        type={tab === 'groups' ? 'groups' : 'people'}
      />
    </Page>
  );
}
