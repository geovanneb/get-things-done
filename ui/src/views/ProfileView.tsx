import React, { useEffect, useState, useCallback } from 'react';
import Button from '@/components/common/Button';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import MarkdownView from '@/components/common/MarkdownView';
import { apiGet, apiPut } from '@/utils/api';
import type { Profile } from '@/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}

const AVATAR_HUES = [20, 55, 150, 250, 300, 200];

function getAvatarColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = ((hash * 31) + name.charCodeAt(i)) & 0xffff;
  }
  const hue = AVATAR_HUES[hash % AVATAR_HUES.length];
  return `oklch(0.60 0.19 ${hue})`;
}

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
  { key: 'communication_style',    label: 'Communication Style',    rows: 4 },
  { key: 'decision_making',        label: 'Decision Making',        rows: 4 },
  { key: 'language_preferences',   label: 'Language Preferences',   rows: 2 },
  { key: 'recurring_expectations', label: 'Recurring Expectations', rows: 4 },
  { key: 'principles',             label: 'Principles',             rows: 4 },
];

const IDENTITY_FIELDS: Array<{ key: ProfileIdentityKey; label: string; placeholder: string }> = [
  { key: 'name',         label: 'Full Name',        placeholder: 'Your name' },
  { key: 'role',         label: 'Title / Position', placeholder: 'e.g. VP Operations' },
  { key: 'organization', label: 'Company',           placeholder: 'e.g. Acme Corporation' },
];

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function AvatarCircle({ name }: { name: string }) {
  return (
    <div
      aria-hidden="true"
      style={{
        width: '80px',
        height: '80px',
        borderRadius: '50%',
        background: getAvatarColor(name),
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'var(--color-text-on-accent)',
        fontSize: 'var(--text-xl)',
        fontFamily: 'var(--font-sans)',
        fontWeight: 700,
        flexShrink: 0,
        userSelect: 'none',
      }}
    >
      {getInitials(name || '?')}
    </div>
  );
}

function SectionCard({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        background: 'var(--color-surface)',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-lg)',
        padding: '24px',
      }}
    >
      <h2
        style={{
          margin: '0 0 12px 0',
          fontSize: 'var(--text-sm)',
          fontFamily: 'var(--font-sans)',
          fontWeight: 600,
          color: 'var(--color-text-secondary)',
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
        }}
      >
        {label}
      </h2>
      {children}
    </div>
  );
}

const textareaStyle: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  resize: 'vertical',
  background: 'var(--color-bg)',
  border: '1px solid var(--color-border-strong)',
  borderRadius: 'var(--radius-sm)',
  padding: '10px 12px',
  fontSize: 'var(--text-sm)',
  fontFamily: 'var(--font-sans)',
  color: 'var(--color-text)',
  lineHeight: 1.6,
  outline: 'none',
};

const inputStyle: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  background: 'var(--color-bg)',
  border: '1px solid var(--color-border-strong)',
  borderRadius: 'var(--radius-sm)',
  padding: '8px 12px',
  fontSize: 'var(--text-sm)',
  fontFamily: 'var(--font-sans)',
  color: 'var(--color-text)',
  outline: 'none',
};

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
      setError(err instanceof Error ? err.message : 'Failed to load profile.');
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
      setSaveError(err instanceof Error ? err.message : 'Failed to save profile.');
    } finally {
      setSaving(false);
    }
  };

  const handleChange = (key: ProfileSectionKey | ProfileIdentityKey, value: string) => {
    setFormData(prev => (prev ? { ...prev, [key]: value } : prev));
  };

  // ---- Loading ----
  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '320px' }}>
        <LoadingSpinner />
      </div>
    );
  }

  // ---- Error ----
  if (error) {
    return (
      <div style={{ maxWidth: '800px', margin: '0 auto', padding: '24px' }}>
        <div style={{
          background: 'var(--color-critical-subtle)',
          border: '1px solid var(--color-critical)',
          borderRadius: 'var(--radius-md)',
          padding: '16px 20px',
          color: 'var(--color-critical)',
          fontSize: 'var(--text-sm)',
          fontFamily: 'var(--font-sans)',
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
        }}>
          <span style={{ fontWeight: 700 }}>Error:</span>
          <span>{error}</span>
          <Button variant="ghost" onClick={fetchProfile} style={{ marginLeft: 'auto' }}>Retry</Button>
        </div>
      </div>
    );
  }

  if (!profile || !formData) return null;

  // ---- Main ----
  return (
    <div style={{
      maxWidth: '800px',
      margin: '0 auto',
      padding: '24px',
      display: 'flex',
      flexDirection: 'column',
      gap: '16px',
    }}>
      {/* Header card */}
      <div style={{
        background: 'var(--color-surface)',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-lg)',
        padding: '24px',
        display: 'flex',
        alignItems: editMode ? 'flex-start' : 'center',
        justifyContent: 'space-between',
        gap: '16px',
        flexWrap: 'wrap',
      }}>
        {/* Left: avatar + identity */}
        <div style={{ display: 'flex', alignItems: editMode ? 'flex-start' : 'center', gap: '20px', flex: 1 }}>
          <AvatarCircle name={formData.name || profile.name} />
          {editMode ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', flex: 1 }}>
              {IDENTITY_FIELDS.map(({ key, label, placeholder }) => (
                <div key={key}>
                  <label style={{
                    display: 'block',
                    fontSize: 'var(--text-xs)',
                    fontWeight: 600,
                    color: 'var(--color-text-secondary)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.06em',
                    marginBottom: '4px',
                  }}>
                    {label}
                  </label>
                  <input
                    type="text"
                    value={formData[key] || ''}
                    placeholder={placeholder}
                    disabled={saving}
                    onChange={e => handleChange(key, e.target.value)}
                    style={inputStyle}
                    onFocus={e => { e.currentTarget.style.borderColor = 'var(--color-accent)'; }}
                    onBlur={e => { e.currentTarget.style.borderColor = 'var(--color-border-strong)'; }}
                  />
                </div>
              ))}
            </div>
          ) : (
            <div>
              <div style={{
                fontSize: 'var(--text-xl)',
                fontFamily: 'var(--font-sans)',
                fontWeight: 700,
                color: 'var(--color-text)',
                lineHeight: 1.2,
              }}>
                {profile.name}
              </div>
              {profile.role && (
                <div style={{
                  fontSize: 'var(--text-md)',
                  fontFamily: 'var(--font-sans)',
                  color: 'var(--color-text-secondary)',
                  marginTop: '4px',
                }}>
                  {profile.role}
                </div>
              )}
              {profile.organization && (
                <div style={{
                  fontSize: 'var(--text-sm)',
                  fontFamily: 'var(--font-sans)',
                  color: 'var(--color-text-muted)',
                  marginTop: '2px',
                }}>
                  {profile.organization}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Right: actions */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {editMode ? (
            <>
              <Button variant="ghost" onClick={handleCancel} disabled={saving}>Cancel</Button>
              <Button variant="primary" onClick={handleSave} disabled={saving}>
                {saving ? 'Saving...' : 'Save Changes'}
              </Button>
            </>
          ) : (
            <Button variant="secondary" onClick={handleEdit}>Edit</Button>
          )}
        </div>
      </div>

      {/* Save error banner */}
      {saveError && (
        <div style={{
          background: 'var(--color-critical-subtle)',
          border: '1px solid var(--color-critical)',
          borderRadius: 'var(--radius-md)',
          padding: '12px 16px',
          color: 'var(--color-critical)',
          fontSize: 'var(--text-sm)',
          fontFamily: 'var(--font-sans)',
        }}>
          {saveError}
        </div>
      )}

      {/* Section cards */}
      {SECTIONS.map(({ key, label, rows }) => (
        <SectionCard key={key} label={label}>
          {editMode ? (
            <textarea
              rows={rows}
              value={formData[key] || ''}
              onChange={e => handleChange(key, e.target.value)}
              disabled={saving}
              style={textareaStyle}
              onFocus={e => { e.currentTarget.style.borderColor = 'var(--color-accent)'; }}
              onBlur={e => { e.currentTarget.style.borderColor = 'var(--color-border-strong)'; }}
            />
          ) : (
            <MarkdownView content={profile[key]} emptyText="Not set" compact />
          )}
        </SectionCard>
      ))}
    </div>
  );
}
