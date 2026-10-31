import React from 'react';
import { NavLink } from 'react-router-dom';
import { TONE_COLOR, type PendingAction } from '../../hooks/usePendingActions';
import { isActivePath } from './navGroups';

export interface MoreItem {
  path: string;
  label: string;
  icon: React.ReactNode;
  pending?: PendingAction;
}

/**
 * Hidden items stay reachable here. Their dots show on More, so hiding Routines never hides a broken routine.
 */
export default function NavMore({ items, collapsed, currentPath }: { items: MoreItem[]; collapsed: boolean; currentPath: string }) {
  const [open, setOpen] = React.useState(false);
  const [position, setPosition] = React.useState({ left: 0, top: 0 });
  const buttonRef = React.useRef<HTMLButtonElement>(null);
  const menuRef = React.useRef<HTMLUListElement>(null);

  const active = items.some((item) => isActivePath(item.path, currentPath));
  const waiting = items.filter((item) => item.pending);
  const count = waiting.reduce((sum, item) => sum + item.pending!.count, 0);
  const tone = waiting.some((item) => item.pending!.tone === 'problem') ? 'problem' : 'attention';
  const summary = waiting.map((item) => item.pending!.label).join(', ');

  React.useEffect(() => setOpen(false), [currentPath]);

  React.useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLElement>('a')?.focus();
    const outside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!menuRef.current?.contains(target) && !buttonRef.current?.contains(target)) setOpen(false);
    };
    document.addEventListener('mousedown', outside);
    return () => document.removeEventListener('mousedown', outside);
  }, [open]);

  const toggle = () => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect) {
      // Beside the sidebar, kept inside the window.
      const height = items.length * 40 + 12;
      setPosition({ left: rect.right + 6, top: Math.max(8, Math.min(rect.top, window.innerHeight - height - 8)) });
    }
    setOpen((was) => !was);
  };

  const close = () => {
    setOpen(false);
    buttonRef.current?.focus();
  };

  return (
    <li role="listitem">
      <button
        ref={buttonRef}
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-controls="nav-more-menu"
        aria-label={summary ? `More, ${summary}` : 'More'}
        title={summary ? `More: ${summary}` : collapsed ? 'More' : undefined}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: collapsed ? 'center' : 'flex-start', gap: 10,
          width: '100%', height: 40, padding: collapsed ? 0 : '0 10px', marginBottom: 2, border: 'none',
          borderRadius: 'var(--radius-md)', position: 'relative', cursor: 'pointer', fontSize: 'var(--text-sm)',
          fontWeight: active ? 500 : 400, textAlign: 'left',
          color: active || open ? 'var(--nav-text-active)' : 'var(--nav-text)',
          background: active ? 'var(--nav-active-bg)' : open ? 'var(--nav-hover-bg)' : 'transparent',
        }}
        onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = 'var(--nav-hover-bg)'; }}
        onMouseLeave={(e) => { if (!active && !open) e.currentTarget.style.background = 'transparent'; }}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" style={{ flexShrink: 0 }}>
          <circle cx="3.5" cy="8" r="1.3" /><circle cx="8" cy="8" r="1.3" /><circle cx="12.5" cy="8" r="1.3" />
        </svg>
        {!collapsed && <span style={{ flex: 1 }}>More</span>}
        {!collapsed && count > 0 && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--nav-text-active)' }}>
            <span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: '50%', background: TONE_COLOR[tone] }} />
            {count}
          </span>
        )}
        {collapsed && count > 0 && (
          <span
            aria-hidden="true"
            style={{
              position: 'absolute', top: 6, right: 8, width: 7, height: 7, borderRadius: '50%',
              background: TONE_COLOR[tone], boxShadow: '0 0 0 2px var(--nav-bg)',
            }}
          />
        )}
      </button>

      {open && (
        <ul
          ref={menuRef}
          id="nav-more-menu"
          role="list"
          aria-label="Hidden sidebar items"
          onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } }}
          style={{
            position: 'fixed', left: position.left, top: position.top, zIndex: 1000, minWidth: 200, margin: 0,
            padding: 6, listStyle: 'none', background: 'var(--nav-bg)', border: '1px solid var(--nav-border)',
            borderRadius: 'var(--radius-md)', boxShadow: 'var(--shadow-md)',
          }}
        >
          {items.map((item) => {
            const here = isActivePath(item.path, currentPath);
            return (
              <li key={item.path}>
                <NavLink
                  to={item.path}
                  onClick={() => setOpen(false)}
                  aria-current={here ? 'page' : undefined}
                  aria-label={item.pending ? `${item.label}, ${item.pending.label}` : item.label}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10, height: 36, padding: '0 10px',
                    borderRadius: 'var(--radius-md)', textDecoration: 'none', fontSize: 'var(--text-sm)',
                    color: here ? 'var(--nav-text-active)' : 'var(--nav-text)',
                    background: here ? 'var(--nav-active-bg)' : 'transparent',
                  }}
                  onMouseEnter={(e) => { if (!here) e.currentTarget.style.background = 'var(--nav-hover-bg)'; }}
                  onMouseLeave={(e) => { if (!here) e.currentTarget.style.background = 'transparent'; }}
                >
                  <span style={{ display: 'flex', flexShrink: 0 }}>{item.icon}</span>
                  <span style={{ flex: 1 }}>{item.label}</span>
                  {item.pending && (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--nav-text-active)' }}>
                      <span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: '50%', background: TONE_COLOR[item.pending.tone] }} />
                      {item.pending.count}
                    </span>
                  )}
                </NavLink>
              </li>
            );
          })}
        </ul>
      )}
    </li>
  );
}
