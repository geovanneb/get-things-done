import React from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useAppState } from '../../store';

interface NavItem {
  path: string;
  label: string;
  icon: React.ReactNode;
  badge?: number;
  dot?: boolean;
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

function IconKaizen() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M8 2.5C5 2.5 2.5 5 2.5 8S5 13.5 8 13.5 13.5 11 13.5 8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M11 2l2 2-5 5-2-2 5-5Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M13 4l1-2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
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

const NAV_COLLAPSE_KEY = 'gtd:nav-collapsed';
const NAV_WIDTH_EXPANDED = '242px';
const NAV_WIDTH_COLLAPSED = '60px';

export default function NavRail() {
  const { workspace, validationCount, agenticVisualMode } = useAppState();
  const location = useLocation();
  const [collapsed, setCollapsed] = React.useState<boolean>(() => {
    try {
      return localStorage.getItem(NAV_COLLAPSE_KEY) === '1';
    } catch {
      return false;
    }
  });

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

  const navItems: NavItem[] = [
    { path: '/situation', label: 'Situation', icon: <IconSituation /> },
    { path: '/board', label: 'Board', icon: <IconBoard /> },
    { path: '/stakeholders', label: 'Stakeholders', icon: <IconPeople /> },
    { path: '/outputs', label: 'Outputs', icon: <IconFile /> },
    { path: '/context', label: 'Context', icon: <IconBook /> },
    { path: '/agents', label: 'Agents & Skills', icon: <IconAgent /> },
    { path: '/insights', label: 'Insights', icon: <IconChart /> },
    { path: '/kaizen', label: 'Kaizen', icon: <IconKaizen /> },
  ];

  // Experimental view, shown only while the Settings switch is on.
  if (agenticVisualMode) {
    navItems.push({ path: '/agent-floor', label: 'Agent Floor', icon: <IconArcade /> });
  }

  const bottomItems: NavItem[] = [
    { path: '/profile', label: 'Profile', icon: <IconPerson /> },
    { path: '/settings', label: 'Settings', icon: <IconGear /> },
  ];

  return (
    <nav
      aria-label="Main navigation"
      style={{
        width: collapsed ? NAV_WIDTH_COLLAPSED : NAV_WIDTH_EXPANDED,
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
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: collapsed ? 'center' : 'flex-start' }}>
          {!collapsed && (
            <>
              <span
                aria-label={`Workspace health: ${validationCount.errors > 0 ? 'errors' : validationCount.warnings > 0 ? 'warnings' : 'good'}`}
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  background: healthColor,
                  flexShrink: 0,
                }}
              />
              <span
                className="truncate"
                style={{
                  fontSize: 'var(--text-sm)',
                  fontWeight: 600,
                  color: 'var(--nav-text-active)',
                  flex: 1,
                }}
                title={workspace?.name}
              >
                {workspace?.name ?? 'Workspace'}
              </span>
            </>
          )}

          <button
            onClick={toggleCollapsed}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            style={{
              position: 'relative',
              display: 'flex',
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
            {collapsed && (
              <span
                aria-label={`Workspace health: ${validationCount.errors > 0 ? 'errors' : validationCount.warnings > 0 ? 'warnings' : 'good'}`}
                style={{
                  position: 'absolute',
                  top: 1,
                  right: 1,
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  background: healthColor,
                }}
              />
            )}
          </button>
        </div>
        {!collapsed && (
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--nav-text)', marginTop: 2, paddingLeft: 16 }}>
            Get Things Done
          </div>
        )}
      </div>

      {/* Main nav items */}
      <ul
        role="list"
        style={{ flex: 1, padding: '8px 8px', listStyle: 'none', overflowY: 'auto' }}
      >
        {navItems.map((item) => (
          <NavRailItem key={item.path} item={item} currentPath={location.pathname} collapsed={collapsed} />
        ))}
      </ul>

      {/* Bottom items */}
      <div style={{ borderTop: '1px solid var(--nav-border)', padding: '8px 8px' }}>
        <ul role="list" style={{ listStyle: 'none' }}>
          {bottomItems.map((item) => (
            <NavRailItem key={item.path} item={item} currentPath={location.pathname} collapsed={collapsed} />
          ))}
        </ul>
      </div>
    </nav>
  );
}

function NavRailItem({ item, currentPath, collapsed }: { item: NavItem; currentPath: string; collapsed: boolean }) {
  const isActive =
    item.path === '/board'
      ? currentPath.startsWith('/board')
      : item.path === '/stakeholders'
      ? currentPath.startsWith('/stakeholders')
      : currentPath === item.path || currentPath.startsWith(item.path + '/');

  return (
    <li role="listitem">
      <NavLink
        to={item.path}
        aria-current={isActive ? 'page' : undefined}
        title={collapsed ? item.label : undefined}
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
        {!collapsed && item.badge !== undefined && item.badge > 0 && (
          <span
            style={{
              background: 'var(--color-critical)',
              color: 'white',
              borderRadius: 10,
              padding: '1px 6px',
              fontSize: 'var(--text-xs)',
              fontWeight: 600,
              lineHeight: '16px',
            }}
          >
            {item.badge}
          </span>
        )}
        {!collapsed && item.dot && (
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: 'var(--color-warning)',
            }}
          />
        )}
        {collapsed && item.badge !== undefined && item.badge > 0 && (
          <span
            style={{
              position: 'absolute',
              top: 4,
              right: 4,
              width: 7,
              height: 7,
              borderRadius: '50%',
              background: 'var(--color-critical)',
            }}
          />
        )}
      </NavLink>
    </li>
  );
}
