import { useEffect, useState, useCallback } from 'react';
import Button from '@/components/common/Button';
import Avatar from '@/components/common/Avatar';
import Card from '@/components/common/Card';
import Input, { Textarea } from '@/components/common/Input';
import { FormActions } from '@/components/common/Modal';
import Notice from '@/components/common/Notice';
import Page, { PageHeader } from '@/components/common/Page';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import MarkdownView from '@/components/common/MarkdownView';
import { apiGet, apiPut } from '@/utils/api';
import type { Profile } from '@/types';

// ---------------------------------------------------------------------------
// Section config
// ---------------------------------------------------------------------------

type ProfileSectionKey =
  | 'responsibilities'
  | 'communication_style'
  | 'decision_making'
  | 'language_preferences'
  | 'recurring_expectations'
  | 'principles';

type ProfileIdentityKey = 'name' | 'role' | 'organization';

interface SectionConfig {
  key: ProfileSectionKey;
  label: string;
  rows: number;
}

const SECTIONS: SectionConfig[] = [
  { key: 'responsibilities',       label: 'Responsibilities',       rows: 6 },
  { key: 'communication_style',    label: 'Communication style',    rows: 4 },
  { key: 'decision_making',        label: 'Decision making',        rows: 4 },
  { key: 'language_preferences',   label: 'Language preferences',   rows: 2 },
  { key: 'recurring_expectations', label: 'Recurring expectations', rows: 4 },
  { key: 'principles',             label: 'Principles',             rows: 4 },
];

const IDENTITY_FIELDS: Array<{ key: ProfileIdentityKey; label: string; placeholder: string }> = [
  { key: 'name',         label: 'Name',        placeholder: 'Your name' },
  { key: 'role',         label: 'Role', placeholder: 'e.g. VP Operations' },
  { key: 'organization', label: 'Organization',         placeholder: 'e.g. Acme Corporation' },
];

// ---------------------------------------------------------------------------
// Main view
// ---------------------------------------------------------------------------

export default function ProfileView() {
  const [profile,   setProfile]   = useState<Profile | null>(null);
  const [formData,  setFormData]  = useState<Profile | null>(null);
  const [editMode,  setEditMode]  = useState(false);
  const [loading,   setLoading]   = useState(true);
  const [saving,    setSaving]    = useState(false);
  const [error,     setError]     = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const fetchProfile = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiGet<Profile>('/api/profile');
      setProfile(data);
      setFormData(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The server did not answer.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchProfile(); }, [fetchProfile]);

  const handleEdit = () => {
    if (profile) setFormData({ ...profile });
    setSaveError(null);
    setEditMode(true);
  };

  const handleCancel = () => {
    setFormData(profile ? { ...profile } : null);
    setSaveError(null);
    setEditMode(false);
  };

  const handleSave = async () => {
    if (!formData) return;
    setSaving(true);
    setSaveError(null);
    try {
      const updated = await apiPut<Profile>('/api/profile', formData);
      setProfile(updated ?? formData);
      setEditMode(false);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Could not save your profile. Try again.');
    } finally {
      setSaving(false);
    }
  };

  const handleChange = (key: ProfileSectionKey | ProfileIdentityKey, value: string) => {
    setFormData(prev => (prev ? { ...prev, [key]: value } : prev));
  };

  if (loading) return <LoadingSpinner text="Loading your profile…" />;

  if (error) {
    return (
      <Page width="narrow">
        <Notice tone="critical" title="Could not load your profile." action={<Button size="sm" onClick={fetchProfile}>Try again</Button>}>{error}</Notice>
      </Page>
    );
  }

  if (!profile || !formData) return null;

  const actions = editMode ? (
    <FormActions>
      <Button variant="ghost" onClick={handleCancel} disabled={saving}>Cancel</Button>
      <Button variant="primary" onClick={handleSave} loading={saving}>Save changes</Button>
    </FormActions>
  ) : (
    <Button variant="secondary" onClick={handleEdit}>Edit profile</Button>
  );

  return (
    <Page width="narrow">
      <PageHeader description="Who you are and how you work. Agents read this before they write anything for you." actions={actions} />

      {saveError && <Notice tone="critical" title="Your changes are not saved.">{saveError}</Notice>}

      <Card>
        {editMode ? (
          <div style={{ display: 'flex', gap: 'var(--space-5)', alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <Avatar name={formData.name || profile.name || '?'} size="xl" />
            <div className="gtd-stack" style={{ flex: '1 1 260px', gap: 'var(--space-3)' }}>
              {IDENTITY_FIELDS.map(({ key, label, placeholder }) => (
                <Input key={key} label={label} value={formData[key] || ''} placeholder={placeholder} disabled={saving}
                  required={key === 'name'} onChange={(v) => handleChange(key, v)} />
              ))}
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 'var(--space-5)', alignItems: 'center' }}>
            <Avatar name={profile.name || '?'} size="xl" />
            <div style={{ minWidth: 0 }}>
              <h2 style={{ fontSize: 'var(--text-xl)', fontWeight: 700, lineHeight: 'var(--leading-tight)', overflowWrap: 'anywhere' }}>{profile.name}</h2>
              {profile.role && <p style={{ fontSize: 'var(--text-md)', color: 'var(--color-text-secondary)', marginTop: 'var(--space-1)' }}>{profile.role}</p>}
              {profile.organization && <p style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)', marginTop: 2 }}>{profile.organization}</p>}
            </div>
          </div>
        )}
      </Card>

      {SECTIONS.map(({ key, label, rows }) => (
        <Card key={key} title={label}>
          {editMode ? (
            <Textarea aria-label={label} rows={rows} value={formData[key] || ''} onChange={(v) => handleChange(key, v)} disabled={saving} />
          ) : (
            <MarkdownView content={profile[key]} emptyText="Not set" compact />
          )}
        </Card>
      ))}

      {editMode && actions}
    </Page>
  );
}
