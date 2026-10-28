import React, { useEffect, useState, useCallback, useRef } from 'react';
import Button from '@/components/common/Button';
import Input from '@/components/common/Input';
import Modal from '@/components/common/Modal';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import Badge from '@/components/common/Badge';
import Toggle from '@/components/common/Toggle';
import { apiGet, apiPost, apiPut } from '@/utils/api';
import { formatDate, formatRelativeDate } from '@/utils/format';
import { useAppState, useAppDispatch } from '@/store';
import { Link, useSearchParams } from 'react-router-dom';
import { useApi } from '@/hooks/useApi';
import { cleanupSummary } from '@/components/routines/SystemCleanup';
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

function SectionCard({ title, children }: { title: string; children: React.ReactNode }) {
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
          margin: '0 0 20px 0',
          fontSize: 'var(--text-md)',
          fontFamily: 'var(--font-sans)',
          fontWeight: 600,
          color: 'var(--color-text)',
        }}
      >
        {title}
      </h2>
      {children}
    </div>
  );
}

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        padding: '10px 0',
        borderBottom: '1px solid var(--color-border)',
      }}
    >
      <span
        style={{
          width: '140px',
          flexShrink: 0,
          fontSize: 'var(--text-sm)',
          fontFamily: 'var(--font-sans)',
          fontWeight: 500,
          color: 'var(--color-text-secondary)',
        }}
      >
        {label}
      </span>
      {/* minWidth 0: lets long values (e.g. a workspace path) shrink and truncate instead of pushing past the card */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: '8px' }}>
        {children}
      </div>
    </div>
  );
}

function AboutRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'baseline',
        gap: '12px',
        padding: '10px 0',
        borderBottom: '1px solid var(--color-border)',
      }}
    >
      <span
        style={{
          width: '140px',
          flexShrink: 0,
          fontSize: 'var(--text-sm)',
          fontFamily: 'var(--font-sans)',
          fontWeight: 500,
          color: 'var(--color-text-secondary)',
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontSize: 'var(--text-sm)',
          fontFamily: mono ? 'var(--font-mono)' : 'var(--font-sans)',
          color: 'var(--color-text)',
          minWidth: 0,
          overflowWrap: 'anywhere',
        }}
      >
        {value}
      </span>
    </div>
  );
}

interface SegmentOption<T extends string> {
  value: T;
  label: string;
  icon?: React.ReactNode;
}

function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: T;
  options: Array<SegmentOption<T>>;
  onChange: (next: T) => void;
  ariaLabel: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      style={{
        display: 'inline-flex',
        gap: '2px',
        padding: '2px',
        background: 'var(--color-bg)',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-md)',
      }}
    >
      {options.map(option => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(option.value)}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              height: '28px',
              padding: '0 12px',
              borderRadius: 'var(--radius-sm)',
              background: selected ? 'var(--color-surface)' : 'transparent',
              color: selected ? 'var(--color-text)' : 'var(--color-text-secondary)',
              boxShadow: selected ? 'var(--shadow-sm)' : 'none',
              fontSize: 'var(--text-sm)',
              fontFamily: 'var(--font-sans)',
              fontWeight: selected ? 600 : 500,
              transition: 'background 0.12s, color 0.12s',
            }}
          >
            {option.icon}
            {option.label}
          </button>
        );
      })}
    </div>
  );
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

const THEME_OPTIONS: Array<SegmentOption<ThemeMode>> = [
  { value: 'light',  label: 'Light',  icon: ICON_SUN },
  { value: 'dark',   label: 'Dark',   icon: ICON_MOON },
  { value: 'system', label: 'System', icon: ICON_MONITOR },
];

const TEXT_SIZE_OPTIONS: Array<SegmentOption<TextSize>> = [
  { value: 'small',   label: 'Small' },
  { value: 'default', label: 'Default' },
  { value: 'large',   label: 'Large' },
];

function AccentPicker({ value, onChange }: { value: string; onChange: (next: typeof ACCENTS[number]['name']) => void }) {
  return (
    <div role="radiogroup" aria-label="Accent colour" style={{ display: 'flex', gap: '10px' }}>
      {ACCENTS.map(accent => {
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
  const { data, error } = useApi<SystemCleanup>('/api/routines/system-cleanup', []);
  return (
    <div style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)', lineHeight: 1.5, maxWidth: '62ch' }}>
      <p style={{ margin: 0 }}>
        The built-in <strong style={{ fontWeight: 600 }}>System cleanup</strong> routine reviews your memory and, only for the rules
        you turn on, archives or removes old finished items and empties the trash.
      </p>
      {data && (
        <p style={{ margin: '8px 0 0' }}>
          Now: {data.settings.enabled ? `${data.summary}.` : 'paused.'} {data.settings.memory_review.enabled ? 'Memory review on.' : 'Memory review off.'} {cleanupSummary(data.settings)}
        </p>
      )}
      {error && <p role="alert" style={{ margin: '8px 0 0', color: 'var(--color-critical)' }}>{error}</p>}
      <p style={{ margin: '8px 0 0' }}>
        <Link to="/routines#system-cleanup" style={{ color: 'var(--color-accent)', fontWeight: 600 }}>Change it under Routines</Link>
      </p>
    </div>
  );
}

function ValidationResultsList({ results }: { results: ValidationResult[] }) {
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
          No issues found. Workspace is valid.
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
                  fontSize: '11px',
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
            {status.ahead} ahead
          </span>
        )}
        {status.behind > 0 && (
          <span style={{ fontSize: 'var(--text-xs)', fontFamily: 'var(--font-sans)', color: 'var(--color-warning)', fontWeight: 500 }}>
            {status.behind} behind
          </span>
        )}
      </div>

      {/* File lists */}
      <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
        <FileGroup label="Staged"    files={status.staged}    color="var(--color-success)"      subtleBg="var(--color-success-subtle)"  />
        <FileGroup label="Modified"  files={status.modified}  color="var(--color-warning)"      subtleBg="var(--color-warning-subtle)"  />
        <FileGroup label="Untracked" files={status.untracked} color="var(--color-text-muted)"   subtleBg="var(--color-surface-hover)"   />
        {status.staged.length === 0 && status.modified.length === 0 && status.untracked.length === 0 && (
          <p style={{ margin: 0, fontSize: 'var(--text-sm)', fontFamily: 'var(--font-sans)', color: 'var(--color-text-muted)' }}>
            Working tree is clean.
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
            Recent Commits
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
  const { agenticVisualMode, showTaskIds, theme, accent, textSize } = useAppState();
  const dispatch = useAppDispatch();

  const [config,            setConfig]            = useState<WorkspaceConfig | null>(null);
  const [loading,           setLoading]           = useState(true);
  const [error,             setError]             = useState<string | null>(null);

  // Workspace name editing
  const [workspaceName,     setWorkspaceName]     = useState('');
  const [nameSaving,        setNameSaving]        = useState(false);
  const [nameSaved,         setNameSaved]         = useState(false);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
      setError(err instanceof Error ? err.message : 'Failed to load workspace config.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchConfig();
  }, [fetchConfig]);

  // ---- Workspace handlers ----

  const handleOpenInFinder = async () => {
    try {
      await apiPost('/api/workspace/open', {});
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
      setReinitError(err instanceof Error ? err.message : 'Re-initialization failed.');
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
      const { path: picked } = await apiPost<{ path: string | null }>('/api/workspace/pick-folder', {});
      if (picked) {
        setNewPath(picked);
        setNeedsInit(false);
      }
    } catch (err) {
      setChangeError(err instanceof Error ? err.message : 'Could not open the folder picker.');
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
      setChangeError(err instanceof Error ? err.message : 'Failed to change workspace.');
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
      setValidationError(err instanceof Error ? err.message : 'Validation failed.');
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
      setGitError(err instanceof Error ? err.message : 'Failed to fetch git status.');
    } finally {
      setLoadingGit(false);
    }
  };

  // ---- Render: loading ----

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '320px' }}>
        <LoadingSpinner />
      </div>
    );
  }

  // ---- Render: error ----

  if (error) {
    return (
      <div style={{ padding: '24px' }}>
        <div
          style={{
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
          }}
        >
          <span style={{ fontWeight: 700 }}>Error:</span>
          <span>{error}</span>
          <Button variant="ghost" onClick={fetchConfig} style={{ marginLeft: 'auto' }}>
            Retry
          </Button>
        </div>
      </div>
    );
  }

  // ---- Render: main ----

  return (
    <div style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '24px' }}>

      {/* Section 1: Workspace */}
      <SectionCard title="Workspace">
        <FieldRow label="Workspace Path">
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
            Change
          </Button>
        </FieldRow>

        <FieldRow label="Workspace Name">
          <Input
            value={workspaceName}
            onChange={v => setWorkspaceName(v)}
            onBlur={handleWorkspaceNameBlur}
            disabled={nameSaving}
            style={{ flex: 1 }}
          />
          {nameSaving && (
            <span style={{ fontSize: 'var(--text-xs)', fontFamily: 'var(--font-sans)', color: 'var(--color-text-muted)' }}>
              Saving...
            </span>
          )}
          {nameSaved && (
            <span style={{ fontSize: 'var(--text-xs)', fontFamily: 'var(--font-sans)', color: 'var(--color-success)', fontWeight: 500 }}>
              Saved
            </span>
          )}
        </FieldRow>

        <div style={{ marginTop: '20px', display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
          <Button variant="secondary" onClick={handleOpenInFinder}>
            Open in Finder
          </Button>
          <Button variant="secondary" onClick={handleValidate} disabled={loadingValidation}>
            {loadingValidation ? 'Validating...' : 'Validate Workspace'}
          </Button>
          <Button variant="danger" onClick={() => { setReinitError(null); setShowReinitModal(true); }}>
            Re-initialize Workspace
          </Button>
        </div>

        {validationError && (
          <div
            style={{
              marginTop: '16px',
              padding: '12px 16px',
              background: 'var(--color-critical-subtle)',
              border: '1px solid var(--color-critical)',
              borderRadius: 'var(--radius-md)',
              fontSize: 'var(--text-sm)',
              fontFamily: 'var(--font-sans)',
              color: 'var(--color-critical)',
            }}
          >
            {validationError}
          </div>
        )}

        {validationResults !== null && (
          <ValidationResultsList results={validationResults} />
        )}
      </SectionCard>

      {/* Section 2: Git */}
      <SectionCard title="Git">
        {config?.git_enabled === false ? (
          <p style={{ margin: 0, fontSize: 'var(--text-sm)', fontFamily: 'var(--font-sans)', color: 'var(--color-text-muted)' }}>
            Git is not enabled for this workspace.
          </p>
        ) : (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', marginBottom: '4px' }}>
              <span style={{ fontSize: 'var(--text-sm)', fontFamily: 'var(--font-sans)', color: 'var(--color-text-secondary)', fontWeight: 500 }}>
                Git enabled
              </span>
              <Badge variant="success">Active</Badge>
              <div style={{ marginLeft: 'auto' }}>
                <Button variant="secondary" onClick={handleViewGitStatus} disabled={loadingGit}>
                  {loadingGit ? 'Loading...' : gitStatus ? 'Hide Git Status' : 'View Git Status'}
                </Button>
              </div>
            </div>

            {gitError && (
              <div
                style={{
                  marginTop: '12px',
                  padding: '12px 16px',
                  background: 'var(--color-critical-subtle)',
                  border: '1px solid var(--color-critical)',
                  borderRadius: 'var(--radius-md)',
                  fontSize: 'var(--text-sm)',
                  fontFamily: 'var(--font-sans)',
                  color: 'var(--color-critical)',
                }}
              >
                {gitError}
              </div>
            )}

            {gitStatus && <GitStatusPanel status={gitStatus} />}
          </>
        )}
      </SectionCard>

      {/* Section 3: Appearance */}
      <SectionCard title="Cleanup and retention">
        <CleanupPointer />
      </SectionCard>

      <SectionCard title="Appearance">
        <FieldRow label="Theme">
          <SegmentedControl
            ariaLabel="Theme"
            value={theme}
            options={THEME_OPTIONS}
            onChange={next => dispatch({ type: 'SET_THEME', payload: next })}
          />
          {theme === 'system' && (
            <span style={{ fontSize: 'var(--text-xs)', fontFamily: 'var(--font-sans)', color: 'var(--color-text-muted)' }}>
              Following your OS setting ({resolveTheme('system')}).
            </span>
          )}
        </FieldRow>

        <FieldRow label="Accent Color">
          <AccentPicker
            value={accent}
            onChange={next => dispatch({ type: 'SET_ACCENT', payload: next })}
          />
        </FieldRow>

        <FieldRow label="Text Size">
          <SegmentedControl
            ariaLabel="Text size"
            value={textSize}
            options={TEXT_SIZE_OPTIONS}
            onChange={next => dispatch({ type: 'SET_TEXT_SIZE', payload: next })}
          />
        </FieldRow>

        <FieldRow label="Task IDs on Board">
          <Toggle
            id="show-task-ids"
            label="Show task IDs on board cards and in the list view"
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
          Appearance is stored in this browser, not in the workspace. Other people opening
          the same workspace keep their own settings.
        </p>
      </SectionCard>

      {/* Section 4: Experimental */}
      <SectionCard title="Experimental">
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
              Agentic Visual Mode
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
              Adds an <strong style={{ fontWeight: 600 }}>Agent Floor</strong> item to the sidebar,
              below Kaizen. It draws your workspace as a pixel-art office: the backlog is a stack of
              paper on a desk, agents walk over to pick up a task, read it, research it at the
              bookshelf and the terminal, then carry the finished sheet to the Done desk. Everything
              on screen is driven by real task files and live file-change events.
            </p>
          </div>
          <Toggle
            id="agentic-visual-mode"
            label="Agentic Visual Mode"
            checked={agenticVisualMode}
            onChange={(next) => dispatch({ type: 'SET_AGENTIC_VISUAL_MODE', payload: next })}
          />
        </div>
      </SectionCard>

      {/* Section 5: About */}
      <SectionCard title="About">
        <AboutRow label="Version"        value="1.0.0" />
        <AboutRow label="API"            value={window.location.host} mono />
        <AboutRow label="Workspace Path" value={config?.path ?? ''} mono />
        <AboutRow
          label="Last Validated"
          value={lastValidated ? formatDate(lastValidated.toISOString()) : 'Never'}
        />
      </SectionCard>

      {/* Change workspace modal */}
      <Modal
        isOpen={showChangeModal}
        onClose={() => { if (!switching) setShowChangeModal(false); }}
        title="Change Workspace"
      >
        <p
          style={{
            margin: '0 0 16px 0',
            fontSize: 'var(--text-sm)',
            fontFamily: 'var(--font-sans)',
            color: 'var(--color-text-secondary)',
            lineHeight: 1.6,
          }}
        >
          Point Get Things Done at another folder. Your current workspace stays on disk, untouched.
        </p>

        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '16px' }}>
          <Input
            value={newPath}
            onChange={v => { setNewPath(v); setNeedsInit(false); }}
            onKeyDown={e => { if (e.key === 'Enter' && newPath.trim() && !switching) handleSwitchWorkspace(); }}
            placeholder="/Users/you/Documents/my-workspace"
            aria-label="Workspace folder path"
            autoFocus
            disabled={switching}
            style={{ flex: 1 }}
            inputStyle={{ fontFamily: 'var(--font-mono)' }}
          />
          <Button variant="secondary" onClick={handleBrowse} disabled={switching || picking}>
            {picking ? 'Waiting...' : 'Browse...'}
          </Button>
        </div>

        {needsInit && (
          <div
            style={{
              marginBottom: '16px',
              padding: '10px 14px',
              background: 'var(--color-warning-subtle)',
              border: '1px solid var(--color-warning)',
              borderRadius: 'var(--radius-sm)',
              fontSize: 'var(--text-sm)',
              fontFamily: 'var(--font-sans)',
              color: 'var(--color-text)',
              lineHeight: 1.6,
            }}
          >
            This folder is not a Get Things Done workspace yet. Initialize it to create the
            workspace structure (tasks, stakeholders, context and so on). Existing files are kept.
          </div>
        )}

        {changeError && (
          <div
            style={{
              marginBottom: '16px',
              padding: '10px 14px',
              background: 'var(--color-critical-subtle)',
              border: '1px solid var(--color-critical)',
              borderRadius: 'var(--radius-sm)',
              fontSize: 'var(--text-sm)',
              fontFamily: 'var(--font-sans)',
              color: 'var(--color-critical)',
            }}
          >
            {changeError}
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
          <Button variant="ghost" onClick={() => setShowChangeModal(false)} disabled={switching}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={handleSwitchWorkspace}
            disabled={switching || !newPath.trim() || newPath.trim() === config?.path}
          >
            {switching ? 'Switching...' : needsInit ? 'Initialize and Switch' : 'Switch Workspace'}
          </Button>
        </div>
      </Modal>

      {/* Re-initialize confirm modal */}
      <Modal
        isOpen={showReinitModal}
        onClose={() => { if (!reinitializing) setShowReinitModal(false); }}
        title="Re-initialize Workspace"
      >
        <p
          style={{
            margin: '0 0 8px 0',
            fontSize: 'var(--text-sm)',
            fontFamily: 'var(--font-sans)',
            color: 'var(--color-text)',
            lineHeight: 1.6,
          }}
        >
          This will reset the workspace configuration to its initial state. Any custom settings
          may be overwritten.
        </p>
        <p
          style={{
            margin: '0 0 20px 0',
            fontSize: 'var(--text-sm)',
            fontFamily: 'var(--font-sans)',
            color: 'var(--color-text-secondary)',
            lineHeight: 1.6,
          }}
        >
          Are you sure you want to continue?
        </p>

        {reinitError && (
          <div
            style={{
              marginBottom: '16px',
              padding: '10px 14px',
              background: 'var(--color-critical-subtle)',
              border: '1px solid var(--color-critical)',
              borderRadius: 'var(--radius-sm)',
              fontSize: 'var(--text-sm)',
              fontFamily: 'var(--font-sans)',
              color: 'var(--color-critical)',
            }}
          >
            {reinitError}
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
          <Button variant="ghost" onClick={() => setShowReinitModal(false)} disabled={reinitializing}>
            Cancel
          </Button>
          <Button variant="danger" onClick={handleReinitialize} disabled={reinitializing}>
            {reinitializing ? 'Re-initializing...' : 'Re-initialize'}
          </Button>
        </div>
      </Modal>
    </div>
  );
}
