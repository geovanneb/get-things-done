import React, { useEffect, useState, useCallback, useRef } from 'react';
import Button from '@/components/common/Button';
import Input from '@/components/common/Input';
import Modal from '@/components/common/Modal';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import Badge from '@/components/common/Badge';
import { apiGet, apiPost, apiPut } from '@/utils/api';
import { formatDate, formatRelativeDate } from '@/utils/format';
import type { WorkspaceConfig, GitStatus, ValidationResult } from '@/types';

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
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: '8px' }}>
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
        }}
      >
        {value}
      </span>
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
            style={{
              flex: 1,
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
          <Button variant="ghost" onClick={() => alert('Not implemented')}>
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
      <SectionCard title="Appearance">
        <p style={{ margin: 0, fontSize: 'var(--text-sm)', fontFamily: 'var(--font-sans)', color: 'var(--color-text-muted)', fontStyle: 'italic' }}>
          Theme customization coming soon.
        </p>
      </SectionCard>

      {/* Section 4: About */}
      <SectionCard title="About">
        <AboutRow label="Version"        value="1.0.0" />
        <AboutRow label="API"            value={window.location.host} mono />
        <AboutRow label="Workspace Path" value={config?.path ?? ''} mono />
        <AboutRow
          label="Last Validated"
          value={lastValidated ? formatDate(lastValidated.toISOString()) : 'Never'}
        />
      </SectionCard>

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
