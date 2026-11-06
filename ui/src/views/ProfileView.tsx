import { useLanguage } from '@/i18n/LanguageProvider';
import { tr } from '@/i18n/current';
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

const SECTIONS = (): SectionConfig[] => ([
  { key: 'responsibilities',       label: tr('profile.responsibilities'),       rows: 6 },
  { key: 'communication_style',    label: tr('profile.communicationStyle'),    rows: 4 },
  { key: 'decision_making',        label: tr('profile.decisionMaking'),        rows: 4 },
  { key: 'language_preferences',   label: tr('profile.languagePreferences'),   rows: 2 },
  { key: 'recurring_expectations', label: tr('profile.recurringExpectations'), rows: 4 },
  { key: 'principles',             label: tr('profile.principles'),             rows: 4 },
]);

const IDENTITY_FIELDS = (): Array<{ key: ProfileIdentityKey; label: string; placeholder: string }> => ([
  { key: 'name',         label: tr('boardColumnsEditor.name'),        placeholder: tr('profile.yourName') },
  { key: 'role',         label: tr('orgChartDialogs.role'), placeholder: tr('profile.eGVpOperations') },
  { key: 'organization', label: tr('orgChartDialogs.organization'),         placeholder: tr('profile.eGAcmeCorporation') },
]);

// ---------------------------------------------------------------------------
// Main view
// ---------------------------------------------------------------------------

export default function ProfileView() {
  const { t } = useLanguage();
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
      setError(err instanceof Error ? err.message : t('profile.theServerDidNotAnswer'));
    } finally {
      setLoading(false);
    }
  }, [t]);

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
      setSaveError(err instanceof Error ? err.message : t('profile.couldNotSaveYourProfile'));
    } finally {
      setSaving(false);
    }
  };

  const handleChange = (key: ProfileSectionKey | ProfileIdentityKey, value: string) => {
    setFormData(prev => (prev ? { ...prev, [key]: value } : prev));
  };

  if (loading) return <LoadingSpinner text={t('profile.loadingYourProfile')} />;

  if (error) {
    return (
      <Page width="narrow">
        <Notice tone="critical" title={t('profile.couldNotLoadYourProfile')} action={<Button size="sm" onClick={fetchProfile}>{t('retry')}</Button>}>{error}</Notice>
      </Page>
    );
  }

  if (!profile || !formData) return null;

  const actions = editMode ? (
    <FormActions>
      <Button variant="ghost" onClick={handleCancel} disabled={saving}>{t('cancel')}</Button>
      <Button variant="primary" onClick={handleSave} loading={saving}>{t('orgChartDialogs.saveChanges')}</Button>
    </FormActions>
  ) : (
    <Button variant="secondary" onClick={handleEdit}>{t('profile.editProfile')}</Button>
  );

  return (
    <Page width="narrow">
      <PageHeader description={t('profile.whoYouAreAndHow')} actions={actions} />

      {saveError && <Notice tone="critical" title={t('profile.yourChangesAreNotSaved')}>{saveError}</Notice>}

      <Card>
        {editMode ? (
          <div style={{ display: 'flex', gap: 'var(--space-5)', alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <Avatar name={formData.name || profile.name || '?'} size="xl" />
            <div className="gtd-stack" style={{ flex: '1 1 260px', gap: 'var(--space-3)' }}>
              {IDENTITY_FIELDS().map(({ key, label, placeholder }) => (
                <Input key={key} label={label} value={formData[key] || ''} placeholder={placeholder} disabled={saving}
                  required={key === 'name'} onChange={(v) => handleChange(key, v)} />
              ))}
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 'var(--space-5)', alignItems: 'center' }}>
            <Avatar name={profile.name || '?'} size="xl" />
            <div style={{ minWidth: 0 }}>
              <h2 style={{ fontSize: 'var(--text-xl)', fontWeight: 600, lineHeight: 'var(--leading-tight)', overflowWrap: 'anywhere' }}>{profile.name}</h2>
              {profile.role && <p style={{ fontSize: 'var(--text-md)', color: 'var(--color-text-secondary)', marginTop: 'var(--space-1)' }}>{profile.role}</p>}
              {profile.organization && <p style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)', marginTop: 2 }}>{profile.organization}</p>}
            </div>
          </div>
        )}
      </Card>

      {SECTIONS().map(({ key, label, rows }) => (
        <Card key={key} title={label}>
          {editMode ? (
            <Textarea aria-label={label} rows={rows} value={formData[key] || ''} onChange={(v) => handleChange(key, v)} disabled={saving} />
          ) : (
            <MarkdownView content={profile[key]} emptyText={t('profile.notSet')} compact />
          )}
        </Card>
      ))}

      {editMode && actions}
    </Page>
  );
}
