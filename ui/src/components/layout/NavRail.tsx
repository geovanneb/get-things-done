import React from 'react';
import WorkspaceSwitcher from './WorkspaceSwitcher';
import { NavLink, useLocation } from 'react-router-dom';
import { useAppDispatch, useAppState } from '../../store';
import { usePendingActions, TONE_COLOR, type PendingAction } from '../../hooks/usePendingActions';
import { arrangeSidebar, isActivePath, navGroups, type NavItemId } from './navGroups';
import SidebarEditor from './SidebarEditor';
import NavMore from './NavMore';

interface NavItem {
  path: string;
  label: string;
  icon: React.ReactNode;
  /** Something here waits on the user: shown as a dot with its count. */
  pending?: PendingAction;
}

function IconSituation() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1.5" y="1.5" width="5.5" height="5.5" rx="1" stroke="currentColor" strokeWidth="1.3" />
      <rect x="9" y="1.5" width="5.5" height="5.5" rx="1" stroke="currentColor" strokeWidth="1.3" />
      <rect x="1.5" y="9" width="5.5" height="5.5" rx="1" stroke="currentColor" strokeWidth="1.3" />
      <rect x="9" y="9" width="5.5" height="5.5" rx="1" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

function IconBoard() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1.5" y="3" width="3" height="10" rx="1" stroke="currentColor" strokeWidth="1.3" />
      <rect x="6.5" y="3" width="3" height="7" rx="1" stroke="currentColor" strokeWidth="1.3" />
      <rect x="11.5" y="3" width="3" height="5" rx="1" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

function IconPeople() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="6" cy="5" r="2.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M1.5 13.5c0-2.485 2.015-4.5 4.5-4.5s4.5 2.015 4.5 4.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <circle cx="11.5" cy="5" r="2" stroke="currentColor" strokeWidth="1.2" />
      <path d="M13.5 13.5c0-1.657-1.343-3-3-3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

function IconFile() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M9.5 1.5H3.5a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V5.5L9.5 1.5Z" stroke="currentColor" strokeWidth="1.3" />
      <path d="M9.5 1.5V5.5h4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M5 8.5h6M5 11h4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function IconBook() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M3 2.5h4c1.1 0 2 .9 2 2v8.5c0-1.1-.9-2-2-2H3V2.5Z" stroke="currentColor" strokeWidth="1.3" />
      <path d="M13 2.5H9c-1.1 0-2 .9-2 2v8.5c0-1.1.9-2 2-2h4V2.5Z" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

function IconAgent() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2" y="5" width="12" height="9" rx="2" stroke="currentColor" strokeWidth="1.3" />
      <path d="M5.5 5V3.5a2.5 2.5 0 0 1 5 0V5" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="5.5" cy="9.5" r="1" fill="currentColor" />
      <circle cx="10.5" cy="9.5" r="1" fill="currentColor" />
      <path d="M6.5 12h3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function IconChart() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M2 13L5.5 9l3 2.5L12 5l2 2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconPerson() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="5" r="3" stroke="currentColor" strokeWidth="1.3" />
      <path d="M2 14c0-3.314 2.686-6 6-6s6 2.686 6 6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function IconMic() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <rect x="6.25" y="2" width="5.5" height="9" rx="2.75" stroke="currentColor" strokeWidth="1.5" />
      <path d="M3.5 8.5a5.5 5.5 0 0 0 11 0M9 14v2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function IconRepeat() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M2.5 7V6a2.5 2.5 0 0 1 2.5-2.5h7.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M10.5 1.5l2 2-2 2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M13.5 9v1a2.5 2.5 0 0 1-2.5 2.5H3.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M5.5 14.5l-2-2 2-2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconArcade() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1.5" y="4.5" width="13" height="8" rx="2.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M4.5 7.2v2.6M3.2 8.5h2.6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <circle cx="10.6" cy="7.8" r="0.95" fill="currentColor" />
      <circle cx="12.2" cy="9.6" r="0.95" fill="currentColor" />
    </svg>
  );
}

function IconGear() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="2.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M8 1.5v1.3M8 13.2v1.3M1.5 8h1.3M13.2 8h1.3M3.4 3.4l.9.9M11.7 11.7l.9.9M3.4 12.6l.9-.9M11.7 4.3l.9-.9"
        stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function IconCollapse({ collapsed }: { collapsed: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      style={{ transform: collapsed ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}
    >
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M6.5 2.5v11" stroke="currentColor" strokeWidth="1.3" />
      <path d="M4.3 6.3L2.6 8l1.7 1.7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const NAV_ICONS: Record<NavItemId, React.ReactNode> = {
  situation: <IconSituation />,
  board: <IconBoard />,
  meetings: <IconMic />,
  insights: <IconChart />,
  context: <IconBook />,
  stakeholders: <IconPeople />,
  outputs: <IconFile />,
  agents: <IconAgent />,
  routines: <IconRepeat />,
  'agent-floor': <IconArcade />,
  profile: <IconPerson />,
  settings: <IconGear />,
};

const NAV_COLLAPSE_KEY = 'gtd:nav-collapsed';
const NAV_WIDTH_EXPANDED = '242px';
const NAV_WIDTH_COLLAPSED = '60px';
// Wider while customizing, so the full names fit next to the arrow and eye buttons.
const NAV_WIDTH_EDITING = '288px';

export default function NavRail() {
  const { validationCount, agenticVisualMode, sidebar, sidebarEditing } = useAppState();
  const dispatch = useAppDispatch();
  const location = useLocation();
  const pending = usePendingActions();
  const [preferredCollapsed, setCollapsed] = React.useState<boolean>(() => {
    try {
      return localStorage.getItem(NAV_COLLAPSE_KEY) === '1';
    } catch {
      return false;
    }
  });

  const [narrow, setNarrow] = React.useState(() => window.matchMedia('(max-width: 900px)').matches);
  React.useEffect(() => {
    const query = window.matchMedia('(max-width: 900px)');
    const changed = () => setNarrow(query.matches);
    query.addEventListener('change', changed);
    return () => query.removeEventListener('change', changed);
  }, []);
  // Customizing needs the labels, so the sidebar opens up while it lasts.
  const collapsed = !sidebarEditing && (narrow || preferredCollapsed);

  // Hover or keyboard focus shows the "Customize" link; a right click on the list offers the same.
  const [hovered, setHovered] = React.useState(false);
  const [customizeFocused, setCustomizeFocused] = React.useState(false);
  const [menu, setMenu] = React.useState<{ x: number; y: number } | null>(null);
  const startEditing = () => {
    setMenu(null);
    dispatch({ type: 'SET_SIDEBAR_EDITING', payload: true });
  };
  const closeMenu = React.useCallback(() => setMenu(null), []);
  const openMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY });
  };

  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(NAV_COLLAPSE_KEY, next ? '1' : '0');
      } catch {
        // ignore
      }
      return next;
    });
  };

  const healthColor =
    validationCount.errors > 0
      ? 'var(--color-critical)'
      : validationCount.warnings > 0
      ? 'var(--color-warning)'
      : 'var(--color-success)';
  const healthLabel = `Workspace health: ${validationCount.errors > 0 ? 'errors' : validationCount.warnings > 0 ? 'warnings' : 'good'}`;

  const toItem = (entry: { path: string; label: string; id: NavItemId }): NavItem => ({
    path: entry.path,
    label: entry.label,
    icon: NAV_ICONS[entry.id],
    pending: pending.find((p) => p.navPath === entry.path),
  });
  const arranged = arrangeSidebar(navGroups({ agentFloor: agenticVisualMode }), sidebar);
  const groups = arranged
    .map((group) => ({ ...group, items: group.items.filter((entry) => !entry.hidden).map(toItem) }))
    .filter((group) => group.items.length > 0);
  const hiddenItems = arranged.flatMap((group) => group.items.filter((entry) => entry.hidden).map(toItem));
  const mainGroups = groups.filter((g) => g.id !== 'account');
  const bottomItems = groups.find((g) => g.id === 'account')?.items ?? [];

  return (
    <nav
      aria-label="Main navigation"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        width: sidebarEditing ? NAV_WIDTH_EDITING : collapsed ? NAV_WIDTH_COLLAPSED : NAV_WIDTH_EXPANDED,
        flexShrink: 0,
        height: '100vh',
        background: 'var(--nav-bg)',
        borderRight: '1px solid var(--nav-border)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        transition: 'width 0.15s ease',
      }}
    >
      {/* Workspace header */}
      <div
        style={{
          padding: collapsed ? '12px 8px' : '12px 8px 12px 14px',
          borderBottom: '1px solid var(--nav-border)',
          flexShrink: 0,
        }}
      >
        <div style={{ display: 'flex', flexDirection: collapsed ? 'column' : 'row', alignItems: 'center', gap: collapsed ? 6 : 4 }}>
          <WorkspaceSwitcher collapsed={collapsed} healthColor={healthColor} healthLabel={healthLabel} />

          <button
            hidden={narrow}
            onClick={toggleCollapsed}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            style={{
              display: narrow ? 'none' : 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 28,
              height: 28,
              flexShrink: 0,
              borderRadius: 'var(--radius-md)',
              border: 'none',
              background: 'transparent',
              color: 'var(--nav-text)',
              cursor: 'pointer',
              padding: 0,
            }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--nav-hover-bg)'; (e.currentTarget as HTMLElement).style.color = 'var(--nav-text-active)'; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; (e.currentTarget as HTMLElement).style.color = 'var(--nav-text)'; }}
          >
            <IconCollapse collapsed={collapsed} />
          </button>
        </div>
      </div>

      {sidebarEditing ? (
        <SidebarEditor icons={NAV_ICONS} />
      ) : (
        <>
          {/* Main nav items, in groups */}
          <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }} onContextMenu={openMenu}>
            <div style={{ flex: 1, padding: '8px 8px', overflowY: 'auto' }}>
              {mainGroups.map((group) => (
                <div key={group.id} role={group.heading ? 'group' : undefined} aria-label={group.heading}>
                  {group.heading && <NavGroupHeading heading={group.heading} collapsed={collapsed} />}
                  <ul role="list" style={{ listStyle: 'none' }}>
                    {group.items.map((item) => (
                      <NavRailItem key={item.path} item={item} currentPath={location.pathname} collapsed={collapsed} />
                    ))}
                  </ul>
                </div>
              ))}
              {hiddenItems.length > 0 && (
                <>
                  {!collapsed && <div aria-hidden="true" style={{ height: 8 }} />}
                  {collapsed && <NavGroupHeading heading="" collapsed />}
                  <ul role="list" style={{ listStyle: 'none' }}>
                    <NavMore items={hiddenItems} collapsed={collapsed} currentPath={location.pathname} />
                  </ul>
                </>
              )}
            </div>
            {/* A control of the sidebar itself, not a destination: pinned to the panel's edge, right-aligned and
                quieter than the items. Collapsed, it is left out; right click and Settings still offer it. */}
            {!collapsed && (
              <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '2px 10px 8px' }}>
                <CustomizeLink visible={hovered || customizeFocused} onClick={startEditing} onFocusChange={setCustomizeFocused} />
              </div>
            )}
          </div>

          {/* Bottom items */}
          <div style={{ borderTop: '1px solid var(--nav-border)', padding: '8px 8px' }} onContextMenu={openMenu}>
            <ul role="list" style={{ listStyle: 'none' }}>
              {bottomItems.map((item) => (
                <NavRailItem key={item.path} item={item} currentPath={location.pathname} collapsed={collapsed} />
              ))}
            </ul>
          </div>
        </>
      )}
      {menu && <CustomizeMenu at={menu} onCustomize={startEditing} onClose={closeMenu} />}
    </nav>
  );
}

function CustomizeLink({ visible, onClick, onFocusChange }: {
  visible: boolean; onClick: () => void; onFocusChange: (focused: boolean) => void;
}) {
  const idle = { color: 'var(--nav-text)', borderColor: 'transparent', background: 'transparent' };
  const hover = { color: 'var(--nav-text-active)', borderColor: 'var(--nav-border)', background: 'var(--nav-hover-bg)' };
  return (
    <button
      type="button"
      onClick={onClick}
      onFocus={(e) => { onFocusChange(true); Object.assign(e.currentTarget.style, hover); }}
      onBlur={(e) => { onFocusChange(false); Object.assign(e.currentTarget.style, idle); }}
      onMouseEnter={(e) => Object.assign(e.currentTarget.style, hover)}
      onMouseLeave={(e) => Object.assign(e.currentTarget.style, idle)}
      style={{
        ...idle,
        display: 'inline-flex', alignItems: 'center', gap: 6, height: 24, padding: '0 9px',
        border: '1px solid transparent', borderRadius: 999, cursor: 'pointer',
        fontSize: 'var(--text-xs)', whiteSpace: 'nowrap',
        opacity: visible ? 1 : 0, transition: 'opacity 0.15s, color 0.1s, background 0.1s, border-color 0.1s',
      }}
    >
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M10.5 2.5l3 3L6 13H3v-3l7.5-7.5Z" />
      </svg>
      Customize sidebar
    </button>
  );
}

function CustomizeMenu({ at, onCustomize, onClose }: { at: { x: number; y: number }; onCustomize: () => void; onClose: () => void }) {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    ref.current?.querySelector('button')?.focus();
    const outside = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    document.addEventListener('mousedown', outside);
    return () => document.removeEventListener('mousedown', outside);
  }, [onClose]);
  return (
    <div
      ref={ref}
      role="menu"
      aria-label="Sidebar"
      onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
      style={{
        position: 'fixed', left: Math.min(at.x, window.innerWidth - 200), top: Math.min(at.y, window.innerHeight - 50),
        zIndex: 1000, padding: 4, minWidth: 180, background: 'var(--nav-bg)', border: '1px solid var(--nav-border)',
        borderRadius: 'var(--radius-md)', boxShadow: 'var(--shadow-md)',
      }}
    >
      <button
        type="button"
        role="menuitem"
        onClick={onCustomize}
        onBlur={(e) => { if (!ref.current?.contains(e.relatedTarget as Node)) onClose(); }}
        style={{
          display: 'block', width: '100%', height: 32, padding: '0 10px', border: 'none', textAlign: 'left',
          borderRadius: 'var(--radius-sm)', background: 'var(--nav-hover-bg)', color: 'var(--nav-text-active)',
          fontSize: 'var(--text-sm)', cursor: 'pointer',
        }}
      >
        Customize sidebar…
      </button>
    </div>
  );
}

// Collapsed, the heading becomes a thin divider so the grouping survives without text.
function NavGroupHeading({ heading, collapsed }: { heading: string; collapsed: boolean }) {
  if (collapsed) {
    return <div aria-hidden="true" style={{ height: 1, margin: '10px 12px', background: 'var(--nav-border)' }} />;
  }
  return (
    <div
      aria-hidden="true"
      style={{
        padding: '14px 10px 6px',
        fontSize: 'var(--text-xs)',
        fontWeight: 600,
        letterSpacing: '0.06em',
        textTransform: 'uppercase',
        color: 'var(--nav-text)',
        opacity: 0.7,
        whiteSpace: 'nowrap',
      }}
    >
      {heading}
    </div>
  );
}

function NavRailItem({ item, currentPath, collapsed }: { item: NavItem; currentPath: string; collapsed: boolean }) {
  const isActive = isActivePath(item.path, currentPath);

  return (
    <li role="listitem">
      <NavLink
        to={item.path}
        aria-current={isActive ? 'page' : undefined}
        aria-label={item.pending ? `${item.label}, ${item.pending.label}` : item.label}
        title={item.pending ? `${item.label}: ${item.pending.label}` : collapsed ? item.label : undefined}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: collapsed ? 'center' : 'flex-start',
          gap: 10,
          padding: collapsed ? '0' : '0 10px',
          height: 40,
          borderRadius: 'var(--radius-md)',
          color: isActive ? 'var(--nav-text-active)' : 'var(--nav-text)',
          background: isActive ? 'var(--nav-active-bg)' : 'transparent',
          textDecoration: 'none',
          fontSize: 'var(--text-sm)',
          fontWeight: isActive ? 500 : 400,
          transition: 'background 0.1s, color 0.1s',
          position: 'relative',
          marginBottom: 2,
        }}
        onMouseEnter={(e) => {
          if (!isActive) {
            (e.currentTarget as HTMLElement).style.background = 'var(--nav-hover-bg)';
            (e.currentTarget as HTMLElement).style.color = 'var(--nav-text-active)';
          }
        }}
        onMouseLeave={(e) => {
          if (!isActive) {
            (e.currentTarget as HTMLElement).style.background = 'transparent';
            (e.currentTarget as HTMLElement).style.color = 'var(--nav-text)';
          }
        }}
      >
        <span style={{ display: 'flex', flexShrink: 0 }}>{item.icon}</span>
        {!collapsed && (
          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {item.label}
          </span>
        )}
        {!collapsed && item.pending && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--nav-text-active)' }}>
            <span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: '50%', background: TONE_COLOR[item.pending.tone] }} />
            {item.pending.count}
          </span>
        )}
        {collapsed && item.pending && (
          <span
            aria-hidden="true"
            style={{
              position: 'absolute',
              top: 6,
              right: 8,
              width: 7,
              height: 7,
              borderRadius: '50%',
              background: TONE_COLOR[item.pending.tone],
              boxShadow: '0 0 0 2px var(--nav-bg)',
            }}
          />
        )}
      </NavLink>
    </li>
  );
}
