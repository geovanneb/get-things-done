import { useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useAppState, useAppDispatch } from '../../store';
import Button from '../common/Button';
import GitIndicator from '../common/GitIndicator';
import { apiPost } from '../../utils/api';
import { RecordButton } from '@/components/recording/RecordButton';

const VIEW_LABELS: Record<string, string> = {
  '/situation': 'Situation',
  '/board': 'Board',
  '/stakeholders': 'Stakeholders',
  '/outputs': 'Outputs',
  '/context': 'Context',
  '/agents': 'Agents & Skills',
  '/insights': 'Insights',
  '/routines': 'Routines',
  '/agent-floor': 'Agent Floor',
  '/profile': 'Profile',
  '/settings': 'Settings',
};

function getBreadcrumb(pathname: string): { label: string; sub?: string } {
  if (pathname.startsWith('/board/task/')) {
    return { label: 'Board', sub: 'Task' };
  }
  if (pathname.startsWith('/stakeholders/') && pathname !== '/stakeholders') {
    return { label: 'Stakeholders', sub: 'Detail' };
  }
  const label = Object.entries(VIEW_LABELS).find(([path]) => pathname.startsWith(path))?.[1] ?? 'App';
  return { label };
}

export default function Header() {
  const location = useLocation();
  const { isSearchOpen, workspace, validationCount } = useAppState();
  const dispatch = useAppDispatch();
  const crumb = getBreadcrumb(location.pathname);
  const isMac = navigator.platform.toLowerCase().includes('mac');

  const [openingClaude, setOpeningClaude] = useState(false);

  const handleOpenClaude = async () => {
    setOpeningClaude(true);
    try {
      await apiPost<{ opened: boolean; command: string }>('/api/workspace/open-claude');
      dispatch({
        type: 'ADD_NOTIFICATION',
        payload: { type: 'success', message: 'Claude Code opened in a new terminal window.' },
      });
    } catch (err) {
      // Terminal launch failed — fall back to handing the user the command.
      const command = `cd "${workspace?.path ?? '.'}" && claude`;
      let copied = false;
      try {
        await navigator.clipboard.writeText(command);
        copied = true;
      } catch {
        // clipboard unavailable
      }
      dispatch({
        type: 'ADD_NOTIFICATION',
        payload: {
          type: 'warning',
          message: copied
            ? `Could not open a terminal automatically. Command copied to clipboard: ${command}`
            : `Could not open a terminal automatically. Run: ${command}`,
        },
      });
      void err;
    } finally {
      setOpeningClaude(false);
    }
  };

  const handleNewTask = () => {
    dispatch({ type: 'OPEN_NEW_TASK_MODAL' });
  };

  return (
    <header
      className="app-header"
      style={{
        height: 'var(--header-height)',
        background: 'var(--header-bg)',
        borderBottom: '1px solid var(--header-border)',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '0 20px',
        flexShrink: 0,
      }}
    >
      {/* Breadcrumb / Title */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 0 }}>
        <h1
          title={crumb.label}
          style={{
            fontSize: 'var(--text-md)',
            fontWeight: 600,
            color: 'var(--color-text)',
            lineHeight: 1.2,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            minWidth: 0,
          }}
        >
          {crumb.label}
        </h1>
        {crumb.sub && (
          <>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"
              style={{ color: 'var(--color-text-muted)' }}>
              <path d="M5 3l4 4-4 4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span title={crumb.sub} style={{ fontSize: 'var(--text-base)', color: 'var(--color-text-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>
              {crumb.sub}
            </span>
          </>
        )}
      </div>

      {/* Search button */}
      <button
        onClick={() => dispatch({ type: 'TOGGLE_SEARCH' })}
        aria-label="Open search"
        aria-expanded={isSearchOpen}
        aria-keyshortcuts={isMac ? 'Meta+K' : 'Control+K'}
        className="app-header__search"
        title={`Search (${isMac ? '⌘K' : 'Ctrl+K'})`}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          height: 34,
          borderRadius: 'var(--radius-md)',
          border: '1px solid var(--color-border)',
          background: 'var(--color-bg)',
          color: 'var(--color-text-muted)',
          cursor: 'pointer',
          fontSize: 'var(--text-sm)',
          flexShrink: 0,
          transition: 'border-color 0.15s',
        }}
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.3" />
          <path d="M9.5 9.5L12.5 12.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
        <span className="app-header__search-text" style={{ flex: 1, textAlign: 'left' }}>Search...</span>
        <kbd
          className="app-header__search-text"
          style={{
            fontSize: 'var(--text-xs)',
            background: 'var(--color-surface)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-sm)',
            padding: '1px 5px',
            fontFamily: 'var(--font-mono)',
          }}
        >
          {isMac ? '⌘K' : 'Ctrl+K'}
        </kbd>
      </button>

      {/* Right actions */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        <GitIndicator />

        {/* Validation indicator */}
        {(validationCount.errors > 0 || validationCount.warnings > 0) && (
          <button
            aria-label={`${validationCount.errors} errors, ${validationCount.warnings} warnings`}
            onClick={() => (window.location.href = '/settings')}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              padding: '0 8px',
              height: 28,
              borderRadius: 'var(--radius-md)',
              border: '1px solid var(--color-border)',
              background: 'transparent',
              fontSize: 'var(--text-xs)',
              cursor: 'pointer',
              color: validationCount.errors > 0 ? 'var(--color-critical)' : 'var(--color-warning)',
            }}
          >
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true">
              <path d="M6.5 2L12 11H1L6.5 2Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
              <path d="M6.5 6v2.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
              <circle cx="6.5" cy="9.5" r="0.5" fill="currentColor" />
            </svg>
            {validationCount.errors > 0 && (
              <span>{validationCount.errors}E</span>
            )}
            {validationCount.warnings > 0 && (
              <span>{validationCount.warnings}W</span>
            )}
          </button>
        )}

        <Button variant="secondary" size="sm" onClick={handleOpenClaude} loading={openingClaude}
          aria-label="Open Claude Code" title="Open Claude Code">
          <span className="app-header__compact-icon" aria-hidden="true">
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
              <path d="M2 3.5l3 3-3 3M6.5 10h4.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
          <span className="app-header__label app-header__label--claude">Open Claude Code</span>
        </Button>

        <RecordButton />

        <Button variant="primary" size="sm" onClick={handleNewTask}
          icon={
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true">
              <path d="M6.5 2v9M2 6.5h9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          }
          aria-label="New task"
        >
          <span className="app-header__label app-header__label--new">New task</span>
        </Button>
      </div>
    </header>
  );
}
