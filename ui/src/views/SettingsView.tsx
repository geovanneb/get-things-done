import { scheduleText } from '@/i18n/serverText';
import { tr } from '@/i18n/current';
import { rich } from '@/i18n/rich';
import { useLanguage } from '../i18n/LanguageProvider';
import LanguageSettings from '../components/settings/LanguageSettings';
import React, { useEffect, useState, useCallback, useRef } from 'react';
import Button from '@/components/common/Button';
import Input, { FieldRow } from '@/components/common/Input';
import Card from '@/components/common/Card';
import Notice from '@/components/common/Notice';
import Page from '@/components/common/Page';
import { SegmentedControl } from '@/components/common/Tabs';
import Modal, { FormActions } from '@/components/common/Modal';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import Badge from '@/components/common/Badge';
import Toggle from '@/components/common/Toggle';
import { apiDelete, apiGet, apiPost, apiPut } from '@/utils/api';
import { openWorkspaceFolder, pickFolder } from '@/utils/desktop';
import { formatDate, formatRelativeDate } from '@/utils/format';
import { useAppState, useAppDispatch } from '@/store';
import { Link, useSearchParams } from 'react-router-dom';
import { useApi } from '@/hooks/useApi';
import { cleanupSummary } from '@/components/routines/SystemCleanup';
import WorkspaceAvatar from '@/components/layout/WorkspaceAvatar';
import WorkspaceIconCrop from '@/components/layout/WorkspaceIconCrop';
import UpdatesSettings from '@/components/settings/UpdatesSettings';
import InstructionUpdates from '@/components/settings/InstructionUpdates';
import RunNoticeSettings from '@/components/settings/RunNoticeSettings';
import TranscriptionSettings from '@/components/settings/TranscriptionSettings';
import SidebarSettings from '@/components/settings/SidebarSettings';
import { ACCENTS, accentSwatch, resolveTheme } from '@/utils/theme';
import type { ThemeMode, TextSize } from '@/utils/theme';
import type { WorkspaceConfig, GitStatus, ValidationResult, SystemCleanup } from '@/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function groupValidationResults(results: ValidationResult[]) {
  return {
    error:   results.filter(r => r.level === 'error'),
    warning: results.filter(r => r.level === 'warning'),
    info:    results.filter(r => r.level === 'info'),
  };
}

interface LevelVisuals {
  icon: string;
  color: string;
  subtleBg: string;
}

const LEVEL_VISUALS: Record<'error' | 'warning' | 'info', LevelVisuals> = {
  error:   { icon: 'X', color: 'var(--color-critical)', subtleBg: 'var(--color-critical-subtle)' },
  warning: { icon: '!', color: 'var(--color-warning)',  subtleBg: 'var(--color-warning-subtle)'  },
  info:    { icon: 'i', color: 'var(--color-info)',     subtleBg: 'var(--color-info-subtle)'     },
};

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function AboutRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <FieldRow label={label}>
      <span style={{ fontSize: 'var(--text-sm)', fontFamily: mono ? 'var(--font-mono)' : undefined, color: 'var(--color-text)', minWidth: 0, overflowWrap: 'anywhere' }}>
        {value}
      </span>
    </FieldRow>
  );
}

interface SegmentOption<T extends string> {
  value: T;
  label: string;
  icon?: React.ReactNode;
}

const ICON_SUN = (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <circle cx="8" cy="8" r="3.1" stroke="currentColor" strokeWidth="1.3" />
    <path
      d="M8 1v1.6M8 13.4V15M15 8h-1.6M2.6 8H1M12.9 3.1l-1.1 1.1M4.2 11.8l-1.1 1.1M12.9 12.9l-1.1-1.1M4.2 4.2L3.1 3.1"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
    />
  </svg>
);

const ICON_MOON = (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path
      d="M13.5 9.6A5.9 5.9 0 0 1 6.4 2.5a5.9 5.9 0 1 0 7.1 7.1Z"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinejoin="round"
    />
  </svg>
);

const ICON_MONITOR = (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <rect x="1.6" y="2.6" width="12.8" height="8.6" rx="1.2" stroke="currentColor" strokeWidth="1.3" />
    <path d="M5.6 14h4.8M8 11.2V14" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
  </svg>
);

const THEME_OPTIONS = (): Array<SegmentOption<ThemeMode>> => ([
  { value: 'light',  label: tr('light'),  icon: ICON_SUN },
  { value: 'dark',   label: tr('dark'),   icon: ICON_MOON },
  { value: 'system', label: tr('system'), icon: ICON_MONITOR },
]);

const TEXT_SIZE_OPTIONS = (): Array<SegmentOption<TextSize>> => ([
  { value: 'small',   label: tr('small') },
  { value: 'default', label: tr('default') },
  { value: 'large',   label: tr('large') },
]);

function AccentPicker({ value, onChange }: { value: string; onChange: (next: ReturnType<typeof ACCENTS>[number]['name']) => void }) {
  const { t } = useLanguage();
  return (
    <div role="radiogroup" aria-label={t('accentColour')} style={{ display: 'flex', gap: '10px' }}>
      {ACCENTS().map(accent => {
        const selected = accent.name === value;
        return (
          <button
            key={accent.name}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={accent.label}
            title={accent.label}
            onClick={() => onChange(accent.name)}
            style={{
              width: '26px',
              height: '26px',
              borderRadius: '50%',
              background: accentSwatch(accent.name),
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
              boxShadow: selected
                ? '0 0 0 2px var(--color-surface), 0 0 0 4px var(--color-text)'
                : 'none',
              transition: 'box-shadow 0.12s',
            }}
          >
            {/* A check, so the selection does not read by colour alone. */}
            {selected && (
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                <path
                  d="M2.5 6.3L4.8 8.6L9.5 3.9"
                  // design-exception: the swatches keep one mid lightness in both themes, so the check is always white
                  stroke="oklch(1 0 0)"
                  strokeWidth="1.9"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** Retention lives with the routine that enforces it; Settings only says where, and what it does now. */
function CleanupPointer() {
  const { t } = useLanguage();
  const { data, error } = useApi<SystemCleanup>('/api/routines/system-cleanup', []);
  return (
    <div style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)', lineHeight: 1.5, maxWidth: '62ch' }}>
      <p style={{ margin: 0 }}>
        {rich(t, 'cleanupIntro', { routine: <strong style={{ fontWeight: 600 }}>{t('systemCleanup')}</strong> })}
      </p>
      {data && (
        <p style={{ margin: '8px 0 0' }}>
          {t('nowStatus', { status: data.settings.enabled ? `${scheduleText(data.summary)}.` : t('paused') })} {data.settings.memory_review.enabled ? t('memoryReviewOn') : t('memoryReviewOff')} {cleanupSummary(data.settings)}
        </p>
      )}
      {error && <p role="alert" style={{ margin: '8px 0 0', color: 'var(--color-critical)' }}>{error}</p>}
      <p style={{ margin: '8px 0 0' }}>
        <Link to="/routines#system-cleanup" style={{ color: 'var(--color-accent)', fontWeight: 600 }}>{t('changeUnderRoutines')}</Link>
      </p>
    </div>
  );
}

function ValidationResultsList({ results }: { results: ValidationResult[] }) {
  const { t } = useLanguage();
  const grouped = groupValidationResults(results);
  const order: Array<'error' | 'warning' | 'info'> = ['error', 'warning', 'info'];

  return (
    <div
      style={{
        marginTop: '16px',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-md)',
        overflow: 'hidden',
      }}
    >
      {results.length === 0 ? (
        <div
          style={{
            padding: '16px',
            textAlign: 'center',
            fontSize: 'var(--text-sm)',
            fontFamily: 'var(--font-sans)',
            color: 'var(--color-success)',
          }}
        >
          {t('noIssues')}
        </div>
      ) : (
        order.flatMap(level => {
          const items = grouped[level];
          if (items.length === 0) return [];
          const v = LEVEL_VISUALS[level];
          return items.map((result, idx) => (
            <div
              key={`${level}-${idx}`}
              style={{
                padding: '12px 16px',
                background: v.subtleBg,
                borderBottom: '1px solid var(--color-border)',
                display: 'grid',
                gridTemplateColumns: '24px 1fr',
                gap: '10px',
                alignItems: 'start',
              }}
            >
              <div
                style={{
                  width: '20px',
                  height: '20px',
                  borderRadius: '50%',
                  background: v.color,
                  color: 'var(--color-text-on-accent)',
                  fontSize: 'var(--text-xs)',
                  fontFamily: 'var(--font-sans)',
                  fontWeight: 700,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                  marginTop: '1px',
                }}
              >
                {v.icon}
              </div>
              <div>
                <span
                  style={{
                    fontSize: 'var(--text-sm)',
                    fontFamily: 'var(--font-sans)',
                    fontWeight: 600,
                    color: v.color,
                    marginRight: '8px',
                  }}
                >
                  {result.rule}
                </span>
                <span
                  style={{
                    fontSize: 'var(--text-sm)',
                    fontFamily: 'var(--font-sans)',
                    color: 'var(--color-text)',
                  }}
                >
                  {result.message}
                </span>
                {result.path && (
                  <div
                    style={{
                      marginTop: '4px',
                      fontSize: 'var(--text-xs)',
                      fontFamily: 'var(--font-mono)',
                      color: 'var(--color-text-muted)',
                    }}
                  >
                    {result.path}
                  </div>
                )}
              </div>
            </div>
          ));
        })
      )}
    </div>
  );
}

function FileGroup({ label, files, color, subtleBg }: { label: string; files: string[]; color: string; subtleBg: string }) {
  if (files.length === 0) return null;
  return (
    <div>
      <div
        style={{
          fontSize: 'var(--text-xs)',
          fontFamily: 'var(--font-sans)',
          fontWeight: 600,
          color,
          marginBottom: '6px',
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
        }}
      >
        {label} ({files.length})
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
        {files.map(f => (
          <div
            key={f}
            style={{
              fontSize: 'var(--text-xs)',
              fontFamily: 'var(--font-mono)',
              color,
              background: subtleBg,
              padding: '3px 8px',
              borderRadius: 'var(--radius-sm)',
            }}
          >
            {f}
          </div>
        ))}
      </div>
    </div>
  );
}

function GitStatusPanel({ status }: { status: GitStatus }) {
  const { t } = useLanguage();
  return (
    <div
      style={{
        marginTop: '16px',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-md)',
        overflow: 'hidden',
      }}
    >
      {/* Branch + indicators */}
      <div
        style={{
          padding: '14px 16px',
          background: 'var(--color-accent-subtle)',
          borderBottom: '1px solid var(--color-border)',
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
          flexWrap: 'wrap',
        }}
      >
        <Badge variant="default">{status.branch}</Badge>
        {status.ahead > 0 && (
          <span style={{ fontSize: 'var(--text-xs)', fontFamily: 'var(--font-sans)', color: 'var(--color-success)', fontWeight: 500 }}>
            {t('gitAhead', { count: status.ahead })}
          </span>
        )}
        {status.behind > 0 && (
          <span style={{ fontSize: 'var(--text-xs)', fontFamily: 'var(--font-sans)', color: 'var(--color-warning)', fontWeight: 500 }}>
            {t('gitBehind', { count: status.behind })}
          </span>
        )}
      </div>

      {/* File lists */}
      <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
        <FileGroup label={t('staged')}    files={status.staged}    color="var(--color-success)"      subtleBg="var(--color-success-subtle)"  />
        <FileGroup label={t('modified')}  files={status.modified}  color="var(--color-warning)"      subtleBg="var(--color-warning-subtle)"  />
        <FileGroup label={t('untracked')} files={status.untracked} color="var(--color-text-muted)"   subtleBg="var(--color-surface-hover)"   />
        {status.staged.length === 0 && status.modified.length === 0 && status.untracked.length === 0 && (
          <p style={{ margin: 0, fontSize: 'var(--text-sm)', fontFamily: 'var(--font-sans)', color: 'var(--color-text-muted)' }}>
            {t('treeClean')}
          </p>
        )}
      </div>

      {/* Recent commits */}
      {status.recent_commits && status.recent_commits.length > 0 && (
        <div style={{ borderTop: '1px solid var(--color-border)', padding: '16px' }}>
          <div
            style={{
              fontSize: 'var(--text-xs)',
              fontFamily: 'var(--font-sans)',
              fontWeight: 600,
              color: 'var(--color-text-secondary)',
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              marginBottom: '10px',
            }}
          >
            {t('recentCommits')}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {status.recent_commits.slice(0, 5).map(commit => (
              <div
                key={commit.hash}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '60px 1fr auto',
                  gap: '10px',
                  alignItems: 'start',
                }}
              >
                <span
                  style={{
                    fontSize: 'var(--text-xs)',
                    fontFamily: 'var(--font-mono)',
                    color: 'var(--color-accent)',
                    background: 'var(--color-accent-subtle)',
                    padding: '2px 6px',
                    borderRadius: 'var(--radius-sm)',
                    letterSpacing: '0.04em',
                  }}
                >
                  {commit.hash.slice(0, 7)}
                </span>
                <span style={{ fontSize: 'var(--text-sm)', fontFamily: 'var(--font-sans)', color: 'var(--color-text)', lineHeight: 1.4 }}>
                  {commit.message}
                  <span style={{ display: 'block', fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', marginTop: '2px' }}>
                    {commit.author}
                  </span>
                </span>
                <span
                  style={{ fontSize: 'var(--text-xs)', fontFamily: 'var(--font-sans)', color: 'var(--color-text-muted)', whiteSpace: 'nowrap' }}
                  title={formatDate(commit.date)}
                >
                  {formatRelativeDate(commit.date)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main view
// ---------------------------------------------------------------------------

export default function SettingsView() {
  const { t } = useLanguage();
  const { agenticVisualMode, showTaskIds, theme, accent, textSize, workspace } = useAppState();
  const dispatch = useAppDispatch();

  const [config,            setConfig]            = useState<WorkspaceConfig | null>(null);
  const [loading,           setLoading]           = useState(true);
  const [error,             setError]             = useState<string | null>(null);

  // Workspace name editing
  const [workspaceName,     setWorkspaceName]     = useState('');
  const [nameSaving,        setNameSaving]        = useState(false);
  const [nameSaved,         setNameSaved]         = useState(false);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Workspace picture: the chosen file opens the crop dialog
  const [iconFile,          setIconFile]          = useState<File | null>(null);
  const [iconError,         setIconError]         = useState<string | null>(null);
  const iconInputRef = useRef<HTMLInputElement>(null);

  // Reinit modal
  const [showReinitModal,   setShowReinitModal]   = useState(false);
  const [reinitializing,    setReinitializing]    = useState(false);
  const [reinitError,       setReinitError]       = useState<string | null>(null);

  // Change workspace modal
  const [showChangeModal,   setShowChangeModal]   = useState(false);
  const [newPath,           setNewPath]           = useState('');
  const [needsInit,         setNeedsInit]         = useState(false);
  const [switching,         setSwitching]         = useState(false);
  const [picking,           setPicking]           = useState(false);
  const [changeError,       setChangeError]       = useState<string | null>(null);

  // Validation
  const [validationResults, setValidationResults] = useState<ValidationResult[] | null>(null);
  const [loadingValidation, setLoadingValidation] = useState(false);
  const [validationError,   setValidationError]   = useState<string | null>(null);
  const [lastValidated,     setLastValidated]     = useState<Date | null>(null);

  // Git status
  const [gitStatus,         setGitStatus]         = useState<GitStatus | null>(null);
  const [loadingGit,        setLoadingGit]        = useState(false);
  const [gitError,          setGitError]          = useState<string | null>(null);

  // ---- Fetch workspace config ----

  const fetchConfig = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiGet<WorkspaceConfig>('/api/workspace');
      setConfig(data);
      setWorkspaceName(data.name);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('configLoadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    fetchConfig();
  }, [fetchConfig]);

  // ---- Workspace handlers ----

  const handleOpenInFinder = async () => {
    try {
      await openWorkspaceFolder();
    } catch {
      // fire and forget
    }
  };

  const handleReinitialize = async () => {
    setReinitializing(true);
    setReinitError(null);
    try {
      await apiPost('/api/workspace/reinitialize', {});
      setShowReinitModal(false);
      await fetchConfig();
    } catch (err) {
      setReinitError(err instanceof Error ? err.message : t('reinitFailed'));
    } finally {
      setReinitializing(false);
    }
  };

  const openChangeModal = () => {
    setNewPath(config?.path ?? '');
    setNeedsInit(false);
    setChangeError(null);
    setShowChangeModal(true);
  };

  // "Open another folder..." in the sidebar's workspace switcher lands here with ?change=1.
  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => {
    if (!config || searchParams.get('change') !== '1') return;
    openChangeModal();
    setSearchParams({}, { replace: true });
  }, [config, searchParams]);

  const handleBrowse = async () => {
    setPicking(true);
    setChangeError(null);
    try {
      const picked = await pickFolder();
      if (picked) {
        setNewPath(picked);
        setNeedsInit(false);
      }
    } catch (err) {
      setChangeError(err instanceof Error ? err.message : t('folderPickerFailed'));
    } finally {
      setPicking(false);
    }
  };

  const handleSwitchWorkspace = async () => {
    setSwitching(true);
    setChangeError(null);
    try {
      const res = await fetch('/api/workspace/switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ path: newPath, initialize: needsInit }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.status === 409 && body.needs_init) {
        setNeedsInit(true);
        setNewPath(body.path ?? newPath);
        return;
      }
      if (!res.ok) {
        setChangeError(body.error || `HTTP ${res.status}`);
        return;
      }
      // Every view caches data from the old workspace, so a full reload is the simplest reset.
      window.location.reload();
    } catch (err) {
      setChangeError(err instanceof Error ? err.message : t('changeWorkspaceFailed'));
    } finally {
      setSwitching(false);
    }
  };

  const handleValidate = async () => {
    setLoadingValidation(true);
    setValidationError(null);
    setValidationResults(null);
    try {
      const results = await apiGet<ValidationResult[]>('/api/workspace/validate');
      setValidationResults(results);
      setLastValidated(new Date());
    } catch (err) {
      setValidationError(err instanceof Error ? err.message : t('validationFailed'));
    } finally {
      setLoadingValidation(false);
    }
  };

  const handleWorkspaceNameBlur = async () => {
    if (!config) return;
    const trimmed = workspaceName.trim();
    if (!trimmed) {
      setWorkspaceName(config.name);
      return;
    }
    if (trimmed === config.name) return;
    setNameSaving(true);
    try {
      await apiPut('/api/workspace', { name: trimmed });
      setConfig(prev => (prev ? { ...prev, name: trimmed } : prev));
      setNameSaved(true);
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
      savedTimerRef.current = setTimeout(() => setNameSaved(false), 2000);
    } catch {
      setWorkspaceName(config.name);
    } finally {
      setNameSaving(false);
    }
  };

  // The sidebar reads the workspace from the store, so a new picture shows there straight away.
  const applyIconVersion = (iconVersion: string | null) => {
    setConfig(prev => (prev ? { ...prev, icon_version: iconVersion } : prev));
    const base = workspace ?? config;
    if (base) dispatch({ type: 'SET_WORKSPACE', payload: { ...base, icon_version: iconVersion } });
  };

  const handleIconChosen = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null;
    e.target.value = ''; // picking the same file again still fires a change
    if (!file) return;
    setIconError(null);
    if (file.size > 25 * 1024 * 1024) {
      setIconError(t('pictureTooLarge'));
      return;
    }
    setIconFile(file);
  };

  const handleRemoveIcon = async () => {
    setIconError(null);
    try {
      await apiDelete('/api/workspace/icon');
      applyIconVersion(null);
    } catch (err) {
      setIconError(err instanceof Error ? err.message : t('pictureRemoveFailed'));
    }
  };

  // ---- Git handler ----

  const handleViewGitStatus = async () => {
    if (gitStatus) {
      setGitStatus(null);
      return;
    }
    setLoadingGit(true);
    setGitError(null);
    try {
      const status = await apiGet<GitStatus>('/api/workspace/git/status');
      setGitStatus(status);
    } catch (err) {
      setGitError(err instanceof Error ? err.message : t('gitFetchFailed'));
    } finally {
      setLoadingGit(false);
    }
  };

  // ---- Render: loading ----

  if (loading) return <LoadingSpinner text={t('loadingSettings')} />;

  // ---- Render: error ----

  if (error) {
    return (
      <Page width="narrow">
        <Notice tone="critical" title={t('settingsLoadError')} action={<Button size="sm" onClick={fetchConfig}>{t('retry')}</Button>}>{error}</Notice>
      </Page>
    );
  }

  // ---- Render: main ----

  return (
    <Page width="narrow">

      {/* Section 1: Workspace */}
      <Card title={t('workspace')}>
        <FieldRow label={t('workspacePath')}>
          <div
            title={config?.path ?? ''}
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: 'var(--text-sm)',
              fontFamily: 'var(--font-mono)',
              color: 'var(--color-text)',
              background: 'var(--color-bg)',
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-sm)',
              padding: '7px 10px',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {config?.path ?? ''}
          </div>
          <Button variant="ghost" onClick={openChangeModal}>
            {t('change')}
          </Button>
        </FieldRow>

        <FieldRow label={t('workspaceName')} htmlFor="settings-workspace-name">
          <Input
            id="settings-workspace-name"
            value={workspaceName}
            onChange={v => setWorkspaceName(v)}
            onBlur={handleWorkspaceNameBlur}
            disabled={nameSaving}
            style={{ flex: 1 }}
          />
          {nameSaving && (
            <span style={{ fontSize: 'var(--text-xs)', fontFamily: 'var(--font-sans)', color: 'var(--color-text-muted)' }}>
              {t('saving')}
            </span>
          )}
          {nameSaved && (
            <span style={{ fontSize: 'var(--text-xs)', fontFamily: 'var(--font-sans)', color: 'var(--color-success)', fontWeight: 500 }}>
              {t('saved')}
            </span>
          )}
        </FieldRow>

        <FieldRow label={t('workspacePicture')}>
          <WorkspaceAvatar name={workspaceName || config?.name || ''} path={config?.path ?? ''} iconVersion={config?.icon_version} size={36} />
          <input
            ref={iconInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            onChange={handleIconChosen}
            style={{ display: 'none' }}
          />
          <Button variant="ghost" onClick={() => iconInputRef.current?.click()}>
            {config?.icon_version ? t('changePicture') : t('choosePicture')}
          </Button>
          {config?.icon_version && (
            <Button variant="ghost" onClick={handleRemoveIcon}>
              {t('remove')}
            </Button>
          )}
          <span style={{ fontSize: 'var(--text-xs)', fontFamily: 'var(--font-sans)', color: iconError ? 'var(--color-critical)' : 'var(--color-text-muted)', minWidth: 0 }}>
            {iconError ?? t('pictureHint')}
          </span>
        </FieldRow>

        <div style={{ marginTop: '20px', display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
          <Button variant="secondary" onClick={handleOpenInFinder}>
            {t('openInFinder')}
          </Button>
          <Button variant="secondary" onClick={handleValidate} disabled={loadingValidation}>
            {loadingValidation ? t('validating') : t('validateWorkspace')}
          </Button>
          <Button variant="danger" onClick={() => { setReinitError(null); setShowReinitModal(true); }}>
            {t('reinitWorkspace')}
          </Button>
        </div>

        {validationError && (
          <Notice tone="critical" style={{ marginTop: 'var(--space-4)' }}>{validationError}</Notice>
        )}

        {validationResults !== null && (
          <ValidationResultsList results={validationResults} />
        )}
      </Card>

      {/* Section 2: Git */}
      <Card title="Git">
        {config?.git_enabled === false ? (
          <p style={{ margin: 0, fontSize: 'var(--text-sm)', fontFamily: 'var(--font-sans)', color: 'var(--color-text-muted)' }}>
            {config.git_installed === false
              ? t('gitMissing')
              : t('gitDisabled')}
          </p>
        ) : (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', marginBottom: '4px' }}>
              <span style={{ fontSize: 'var(--text-sm)', fontFamily: 'var(--font-sans)', color: 'var(--color-text-secondary)', fontWeight: 500 }}>
                {t('gitEnabled')}
              </span>
              <Badge variant="success">{t('active')}</Badge>
              <div style={{ marginLeft: 'auto' }}>
                <Button variant="secondary" onClick={handleViewGitStatus} disabled={loadingGit}>
                  {loadingGit ? t('loading') : gitStatus ? t('hideGitStatus') : t('viewGitStatus')}
                </Button>
              </div>
            </div>

            {gitError && (
              <Notice tone="critical" style={{ marginTop: 'var(--space-4)' }}>{gitError}</Notice>
            )}

            {gitStatus && <GitStatusPanel status={gitStatus} />}
          </>
        )}
      </Card>

      {/* Section 3: Appearance */}
      <Card title={t('cleanupRetention')}>
        <CleanupPointer />
      </Card>

      <Card title={t('notifications')}>
        <RunNoticeSettings />
      </Card>

      <Card title={t('transcription')}>
        <TranscriptionSettings />
      </Card>

      <Card title={t('appearance')}>
        <LanguageSettings />
        <FieldRow label={t('theme')}>
          <SegmentedControl
            label={t('theme')}
            value={theme}
            options={THEME_OPTIONS().map(option => ({ ...option, label: t(option.value) }))}
            onChange={next => dispatch({ type: 'SET_THEME', payload: next })}
          />
          {theme === 'system' && (
            <span style={{ fontSize: 'var(--text-xs)', fontFamily: 'var(--font-sans)', color: 'var(--color-text-muted)' }}>
              {t('systemTheme', { theme: t(resolveTheme('system')) })}
            </span>
          )}
        </FieldRow>

        <FieldRow label={t('accent')}>
          <AccentPicker
            value={accent}
            onChange={next => dispatch({ type: 'SET_ACCENT', payload: next })}
          />
        </FieldRow>

        <FieldRow label={t('textSize')}>
          <SegmentedControl
            label={t('textSize')}
            value={textSize}
            options={TEXT_SIZE_OPTIONS().map(option => ({ ...option, label: t(option.value) }))}
            onChange={next => dispatch({ type: 'SET_TEXT_SIZE', payload: next })}
          />
        </FieldRow>

        <FieldRow label={t('sidebar')}>
          <SidebarSettings />
        </FieldRow>

        <FieldRow label={t('taskIds')}>
          <Toggle
            id="show-task-ids"
            label={t('showTaskIds')}
            checked={showTaskIds}
            onChange={(next) => dispatch({ type: 'SET_SHOW_TASK_IDS', payload: next })}
          />
        </FieldRow>

        <p
          style={{
            margin: '16px 0 0 0',
            fontSize: 'var(--text-xs)',
            fontFamily: 'var(--font-sans)',
            color: 'var(--color-text-muted)',
            lineHeight: 1.5,
          }}
        >
          {t('appearanceHint')}
        </p>
      </Card>

      {/* Section 4: Experimental */}
      <Card title={t('experimental')}>
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: '16px',
            padding: '4px 0',
          }}
        >
          <div style={{ flex: 1 }}>
            <label
              htmlFor="agentic-visual-mode"
              style={{
                display: 'block',
                fontSize: 'var(--text-sm)',
                fontFamily: 'var(--font-sans)',
                fontWeight: 600,
                color: 'var(--color-text)',
                cursor: 'pointer',
              }}
            >
              {t('agenticMode')}
            </label>
            <p
              style={{
                margin: '4px 0 0 0',
                fontSize: 'var(--text-sm)',
                fontFamily: 'var(--font-sans)',
                color: 'var(--color-text-secondary)',
                lineHeight: 1.5,
                maxWidth: '62ch',
              }}
            >
              {rich(t, 'agenticModeHint', { floor: <strong style={{ fontWeight: 600 }}>{t('agent-floor')}</strong> })}
            </p>
          </div>
          <Toggle
            id="agentic-visual-mode"
            label={t('agenticMode')}
            checked={agenticVisualMode}
            onChange={(next) => dispatch({ type: 'SET_AGENTIC_VISUAL_MODE', payload: next })}
          />
        </div>
      </Card>

      <div id="updates">
        <Card title={t('updates')}>
          <UpdatesSettings />
        </Card>
      </div>
      <InstructionUpdates />

      {/* Section 5: About */}
      <Card title={t('about')}>
        <AboutRow label={t('version')}        value={config?.app_version ?? ''} />
        <AboutRow label="API"            value={window.location.host} mono />
        <AboutRow label={t('workspacePath')} value={config?.path ?? ''} mono />
        <AboutRow
          label={t('lastValidated')}
          value={lastValidated ? formatDate(lastValidated.toISOString()) : t('never')}
        />
      </Card>

      {/* Change workspace modal */}
      <Modal
        isOpen={showChangeModal}
        onClose={() => { if (!switching) setShowChangeModal(false); }}
        title={t('changeWorkspace')}
        description={t('changeWorkspaceHint')}
        footer={
          <FormActions>
            <Button variant="ghost" onClick={() => setShowChangeModal(false)} disabled={switching}>{t('cancel')}</Button>
            <Button variant="primary" onClick={handleSwitchWorkspace} loading={switching}
              disabled={!newPath.trim() || newPath.trim() === config?.path}>
              {needsInit ? t('initAndSwitch') : t('switchWorkspace')}
            </Button>
          </FormActions>
        }
      >
        <div className="gtd-stack">
          <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <Input
              label={t('workspaceFolder')}
              value={newPath}
              onChange={v => { setNewPath(v); setNeedsInit(false); }}
              onKeyDown={e => { if (e.key === 'Enter' && newPath.trim() && !switching) handleSwitchWorkspace(); }}
              placeholder="/Users/you/Documents/my-workspace"
              autoFocus
              disabled={switching}
              style={{ flex: '1 1 260px' }}
              inputStyle={{ fontFamily: 'var(--font-mono)' }}
            />
            <Button variant="secondary" onClick={handleBrowse} loading={picking} disabled={switching}>{t('browse')}</Button>
          </div>

          {needsInit && (
            <Notice tone="warning" title={t('notWorkspaceYet')}>
              {t('initFolderHint')}
            </Notice>
          )}

          {changeError && <Notice tone="critical">{changeError}</Notice>}
        </div>
      </Modal>

      <WorkspaceIconCrop
        file={iconFile}
        onClose={() => setIconFile(null)}
        onSaved={(iconVersion) => { applyIconVersion(iconVersion); setIconFile(null); }}
      />

      {/* Re-initialize confirm modal */}
      <Modal
        isOpen={showReinitModal}
        onClose={() => { if (!reinitializing) setShowReinitModal(false); }}
        title={t('reinitConfirm')}
        size="sm"
        role="alertdialog"
        footer={
          <FormActions>
            <Button variant="ghost" onClick={() => setShowReinitModal(false)} disabled={reinitializing} autoFocus>{t('cancel')}</Button>
            <Button variant="danger" onClick={handleReinitialize} loading={reinitializing}>{t('reinit')}</Button>
          </FormActions>
        }
      >
        <div className="gtd-stack">
          <p style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)', lineHeight: 'var(--leading-normal)' }}>
            {t('reinitMessage')}
          </p>
          {reinitError && <Notice tone="critical">{reinitError}</Notice>}
        </div>
      </Modal>
    </Page>
  );
}
