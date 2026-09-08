import { useState, useRef, useEffect } from 'react';
import { useApi } from '../../hooks/useApi';
import { GitStatus } from '../../types';

export default function GitIndicator() {
  const { data: git } = useApi<GitStatus>('/api/workspace/git/status', []);
  const [open, setOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (
        popoverRef.current && !popoverRef.current.contains(e.target as Node) &&
        buttonRef.current && !buttonRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  if (!git || !git.is_repo) return null;

  const totalChanged = git.modified.length + git.staged.length + git.untracked.length;

  return (
    <div style={{ position: 'relative' }}>
      <button
        ref={buttonRef}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="true"
        aria-label={`Git: ${git.branch}, ${totalChanged} changed files`}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '0 8px',
          height: 28,
          borderRadius: 'var(--radius-md)',
          border: '1px solid var(--color-border)',
          background: 'transparent',
          fontSize: 'var(--text-xs)',
          color: 'var(--color-text-secondary)',
          cursor: 'pointer',
          fontFamily: 'var(--font-mono)',
          transition: 'background 0.1s',
        }}
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <circle cx="7" cy="2" r="1.5" stroke="currentColor" strokeWidth="1.2" />
          <circle cx="3" cy="10" r="1.5" stroke="currentColor" strokeWidth="1.2" />
          <circle cx="11" cy="10" r="1.5" stroke="currentColor" strokeWidth="1.2" />
          <path d="M7 3.5V7M7 7L3 8.5M7 7L11 8.5" stroke="currentColor" strokeWidth="1.2" />
        </svg>
        <span className="truncate" style={{ maxWidth: 80 }}>{git.branch}</span>
        {totalChanged > 0 && (
          <span style={{
            background: 'var(--color-warning-subtle)',
            color: 'var(--color-warning)',
            borderRadius: 'var(--radius-sm)',
            padding: '0 4px',
            fontSize: 'var(--text-xs)',
            fontFamily: 'var(--font-sans)',
          }}>
            {totalChanged}
          </span>
        )}
      </button>

      {open && (
        <div
          ref={popoverRef}
          role="dialog"
          aria-label="Git status"
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            right: 0,
            width: 320,
            background: 'var(--color-surface)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-lg)',
            boxShadow: '0 8px 32px oklch(0.1 0 0 / 0.12)',
            zIndex: 500,
            overflow: 'hidden',
          }}
        >
          <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--color-border)' }}>
            <div style={{ fontSize: 'var(--text-sm)', fontWeight: 600 }}>Git Status</div>
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', fontFamily: 'var(--font-mono)', marginTop: 2 }}>
              {git.branch}
              {git.ahead > 0 && ` ↑${git.ahead}`}
              {git.behind > 0 && ` ↓${git.behind}`}
            </div>
          </div>

          <div style={{ maxHeight: 280, overflowY: 'auto', padding: '8px 14px' }}>
            {git.staged.length > 0 && (
              <FileGroup label="Staged" files={git.staged} color="var(--color-success)" />
            )}
            {git.modified.length > 0 && (
              <FileGroup label="Modified" files={git.modified} color="var(--color-warning)" />
            )}
            {git.untracked.length > 0 && (
              <FileGroup label="Untracked" files={git.untracked} color="var(--color-text-muted)" />
            )}
            {totalChanged === 0 && (
              <div style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)', padding: '8px 0' }}>
                Working tree is clean.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function FileGroup({ label, files, color }: { label: string; files: string[]; color: string }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 'var(--text-xs)', fontWeight: 600, color, marginBottom: 4 }}>{label}</div>
      {files.map((f) => (
        <div
          key={f}
          style={{
            fontSize: 'var(--text-xs)',
            fontFamily: 'var(--font-mono)',
            color: 'var(--color-text-secondary)',
            padding: '2px 0',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={f}
        >
          {f}
        </div>
      ))}
    </div>
  );
}
