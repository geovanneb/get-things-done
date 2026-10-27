import React from 'react';
import ReactDOM from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useAppState } from '../../store';
import { apiGet, apiPost } from '../../utils/api';
import type { RecentWorkspace } from '../../types';

/** Same folder, same color, on every machine: recognisable at a glance in the rail. */
function workspaceHue(path: string): number {
  let h = 0;
  for (let i = 0; i < path.length; i++) h = (h * 31 + path.charCodeAt(i)) >>> 0;
  return h % 360;
}

/** The last two folders of a path, enough to tell two workspaces with the same name apart. */
function shortPath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : path;
}

function WorkspaceAvatar({ name, path, size = 24 }: { name: string; path: string; size?: number }) {
  return (
    <span
      aria-hidden="true"
      style={{
        width: size, height: size, flexShrink: 0, borderRadius: 'var(--radius-sm)',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        background: `oklch(0.62 0.13 ${workspaceHue(path)})`, color: 'white',
        fontSize: size >= 24 ? 'var(--text-sm)' : 'var(--text-xs)', fontWeight: 700, lineHeight: 1,
      }}
    >
      {(name.trim()[0] ?? '?').toUpperCase()}
    </span>
  );
}

function IconChevron() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true" style={{ flexShrink: 0 }}>
      <path d="M3.5 4.5 6 2l2.5 2.5M3.5 7.5 6 10l2.5-2.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * The workspace you are in, at the top of the rail, and a menu of the ones opened before for
 * one-click switching (the pattern of Slack, Notion and Linear's workspace switchers, and VS Code's
 * Open Recent). `healthColor` is the validation dot that used to sit next to the name.
 */
export default function WorkspaceSwitcher({ collapsed, healthColor, healthLabel }: { collapsed: boolean; healthColor: string; healthLabel: string }) {
  const { workspace } = useAppState();
  const navigate = useNavigate();
  const [open, setOpen] = React.useState(false);
  const [recent, setRecent] = React.useState<RecentWorkspace[] | null>(null);
  const [switching, setSwitching] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const menuRef = React.useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = React.useState<{ top: number; left: number } | null>(null);

  const name = workspace?.name ?? 'Workspace';
  const path = workspace?.path ?? '';

  // Browser tabs and the window switcher say which workspace each tab shows.
  React.useEffect(() => {
    if (workspace?.name) document.title = `${workspace.name} · Get Things Done`;
  }, [workspace?.name]);

  const load = React.useCallback(() => {
    apiGet<RecentWorkspace[]>('/api/workspace/recent').then(setRecent).catch(() => setRecent([]));
  }, []);

  const close = React.useCallback((returnFocus = true) => {
    setOpen(false);
    setError(null);
    if (returnFocus) triggerRef.current?.focus();
  }, []);

  const toggle = () => {
    if (open) { close(); return; }
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) setAnchor(collapsed ? { top: rect.top, left: rect.right + 8 } : { top: rect.bottom + 6, left: rect.left });
    load();
    setOpen(true);
  };

  // Click outside or Escape closes; arrow keys move between the menu entries.
  React.useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!menuRef.current?.contains(t) && !triggerRef.current?.contains(t)) close(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); close(); return; }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[data-ws-item]') ?? []);
      if (items.length === 0) return;
      e.preventDefault();
      const i = items.indexOf(document.activeElement as HTMLElement);
      const next = e.key === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
      items[next]?.focus();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open, close]);

  // Focus the first entry once the list is in.
  React.useEffect(() => {
    if (open && recent) menuRef.current?.querySelector<HTMLElement>('[data-ws-item]')?.focus();
  }, [open, recent]);

  const switchTo = async (target: RecentWorkspace) => {
    if (target.current) { close(); return; }
    setSwitching(target.path);
    setError(null);
    try {
      const res = await fetch('/api/workspace/switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ path: target.path }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(res.status === 409 ? `${target.name} is no longer a workspace. Open it from Settings to set it up again.` : body.error || `HTTP ${res.status}`);
        return;
      }
      // Reset cached data and leave entity URLs whose IDs belong to the previous workspace.
      window.location.assign('/situation');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not switch workspace.');
    } finally {
      setSwitching(null);
    }
  };

  const forget = async (target: RecentWorkspace) => {
    try {
      setRecent(await apiPost<RecentWorkspace[]>('/api/workspace/recent/forget', { path: target.path }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not remove it from the list.');
    }
  };

  const openAnother = () => {
    close(false);
    navigate('/settings?change=1');
  };

  const trigger = (
    <button
      ref={triggerRef}
      type="button"
      onClick={toggle}
      aria-haspopup="menu"
      aria-expanded={open}
      aria-label={`Workspace: ${name}. ${healthLabel}. Switch workspace`}
      title={collapsed ? `${name} (${path})` : path}
      style={{
        position: 'relative', display: 'flex', alignItems: 'center', gap: 8, minWidth: 0,
        flex: collapsed ? undefined : 1, padding: collapsed ? 2 : '4px 6px', margin: collapsed ? 0 : '0 0 0 -6px',
        border: 'none', borderRadius: 'var(--radius-md)', cursor: 'pointer', textAlign: 'left',
        background: open ? 'var(--nav-hover-bg)' : 'transparent', color: 'var(--nav-text-active)',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--nav-hover-bg)'; }}
      onMouseLeave={(e) => { if (!open) e.currentTarget.style.background = 'transparent'; }}
    >
      <span style={{ position: 'relative', display: 'inline-flex' }}>
        <WorkspaceAvatar name={name} path={path} size={collapsed ? 28 : 26} />
        <span
          aria-hidden="true"
          style={{ position: 'absolute', right: -2, bottom: -2, width: 8, height: 8, borderRadius: '50%', background: healthColor, boxShadow: '0 0 0 2px var(--nav-bg)' }}
        />
      </span>
      {!collapsed && (
        <>
          <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}>
            <span className="truncate" style={{ fontSize: 'var(--text-sm)', fontWeight: 600 }}>{name}</span>
            <span className="truncate" style={{ fontSize: 'var(--text-xs)', color: 'var(--nav-text)' }}>{shortPath(path) || 'Get Things Done'}</span>
          </span>
          <span style={{ color: 'var(--nav-text)', display: 'flex' }}><IconChevron /></span>
        </>
      )}
    </button>
  );

  const others = (recent ?? []).filter((w) => !w.current);

  return (
    <>
      {trigger}
      {open && anchor && ReactDOM.createPortal(
        <div
          ref={menuRef}
          role="menu"
          aria-label="Switch workspace"
          style={{
            position: 'fixed', top: anchor.top, left: anchor.left, zIndex: 1100, width: 300, maxWidth: 'calc(100vw - 24px)',
            maxHeight: 'min(70vh, 480px)', overflowY: 'auto', padding: 6,
            background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-lg)',
          }}
        >
          <div style={{ padding: '6px 8px 4px', fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Workspaces
          </div>
          {recent === null && <div style={{ padding: 8, fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)' }}>Loading...</div>}
          {(recent ?? []).map((w) => (
            <div key={w.path} style={{ display: 'flex', alignItems: 'center', borderRadius: 'var(--radius-md)' }}>
              <button
                type="button"
                role="menuitemradio"
                aria-checked={w.current}
                data-ws-item
                disabled={!!switching || (!w.available && !w.current)}
                onClick={() => void switchTo(w)}
                title={w.path}
                style={{
                  flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 10, padding: '7px 8px',
                  border: 'none', borderRadius: 'var(--radius-md)', background: w.current ? 'var(--color-accent-subtle)' : 'transparent',
                  cursor: w.available || w.current ? 'pointer' : 'not-allowed', textAlign: 'left', color: 'var(--color-text)',
                  opacity: w.available || w.current ? 1 : 0.55,
                }}
                onMouseEnter={(e) => { if (!w.current) e.currentTarget.style.background = 'var(--color-surface-hover)'; }}
                onMouseLeave={(e) => { if (!w.current) e.currentTarget.style.background = 'transparent'; }}
                onFocus={(e) => { if (!w.current) e.currentTarget.style.background = 'var(--color-surface-hover)'; }}
                onBlur={(e) => { if (!w.current) e.currentTarget.style.background = 'transparent'; }}
              >
                <WorkspaceAvatar name={w.name} path={w.path} size={26} />
                <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}>
                  <span className="truncate" style={{ fontSize: 'var(--text-sm)', fontWeight: w.current ? 600 : 500 }}>{w.name}</span>
                  <span className="truncate" style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', fontFamily: 'var(--font-mono)' }}>
                    {w.available || w.current ? shortPath(w.path) : 'Folder not found'}
                  </span>
                </span>
                {w.current && (
                  <span style={{ fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--color-accent)', flexShrink: 0 }}>Current</span>
                )}
                {switching === w.path && (
                  <span aria-live="polite" style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', flexShrink: 0 }}>Opening...</span>
                )}
              </button>
              {!w.current && (
                <button
                  type="button"
                  onClick={() => void forget(w)}
                  aria-label={`Remove ${w.name} from this list`}
                  title="Remove from this list (the folder stays on disk)"
                  style={{ width: 26, height: 26, flexShrink: 0, border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--color-text-muted)', borderRadius: 'var(--radius-sm)', fontSize: 'var(--text-base)' }}
                  onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--color-critical)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--color-text-muted)'; }}
                >
                  ×
                </button>
              )}
            </div>
          ))}
          {recent !== null && others.length === 0 && (
            <p style={{ margin: 0, padding: '6px 8px', fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', lineHeight: 1.45 }}>
              Workspaces you open show up here, so you can switch back in one click.
            </p>
          )}
          {error && (
            <p role="alert" style={{ margin: '4px 8px', fontSize: 'var(--text-xs)', color: 'var(--color-critical)', lineHeight: 1.45 }}>{error}</p>
          )}
          <div style={{ height: 1, background: 'var(--color-border)', margin: '6px 0' }} />
          <button
            type="button"
            role="menuitem"
            data-ws-item
            onClick={openAnother}
            style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '8px', border: 'none', borderRadius: 'var(--radius-md)', background: 'transparent', cursor: 'pointer', textAlign: 'left', fontSize: 'var(--text-sm)', color: 'var(--color-text)' }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-surface-hover)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
            onFocus={(e) => { e.currentTarget.style.background = 'var(--color-surface-hover)'; }}
            onBlur={(e) => { e.currentTarget.style.background = 'transparent'; }}
          >
            <span aria-hidden="true" style={{ width: 26, textAlign: 'center', color: 'var(--color-text-muted)', fontSize: 'var(--text-base)' }}>+</span>
            Open another folder...
          </button>
        </div>,
        document.body,
      )}
    </>
  );
}
