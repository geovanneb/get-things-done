import React from 'react';
import { useAppDispatch, useAppState } from '../../store';
import { useSaveSidebar } from '../../hooks/useSidebar';
import {
  DEFAULT_SIDEBAR, arrangeSidebar, canHide, isDefaultSidebar, moveItem, navGroups, setHidden,
  type ArrangedEntry, type ArrangedGroup, type NavItemId,
} from './navGroups';

// The groups without a heading in the normal sidebar still get one here, so it is clear where items can move.
const EDIT_HEADINGS: Record<ArrangedGroup['id'], string> = {
  work: 'Work', memory: 'Memory', automation: 'Automation', account: 'Account',
};

/**
 * "Customize sidebar" mode, in place of the normal list. Drag and drop alone fails WCAG 2.2 SC 2.5.7, so every
 * row also has Move up and Move down buttons, and each change is announced to screen readers.
 */
export default function SidebarEditor({ icons }: { icons: Record<NavItemId, React.ReactNode> }) {
  const { sidebar, agenticVisualMode } = useAppState();
  const dispatch = useAppDispatch();
  const save = useSaveSidebar();
  const defaults = navGroups({ agentFloor: agenticVisualMode });
  const groups = arrangeSidebar(defaults, sidebar);
  const [announcement, setAnnouncement] = React.useState('');
  const [confirmReset, setConfirmReset] = React.useState(false);
  const [dragging, setDragging] = React.useState<NavItemId | null>(null);
  const titleRef = React.useRef<HTMLHeadingElement>(null);

  React.useEffect(() => titleRef.current?.focus(), []);

  const done = () => dispatch({ type: 'SET_SIDEBAR_EDITING', payload: false });

  const move = (group: ArrangedGroup, item: ArrangedEntry, to: number, keepFocus?: 'up' | 'down') => {
    save(moveItem(defaults, sidebar, item.id, to));
    setAnnouncement(`${item.label} moved to position ${to + 1} of ${group.items.length} in ${EDIT_HEADINGS[group.id]}.`);
    if (!keepFocus) return;
    // The row moves in the page: keep the focus on its button, or on the other arrow once it reaches the end.
    requestAnimationFrame(() => {
      const same = document.getElementById(`sidebar-${keepFocus}-${item.id}`) as HTMLButtonElement | null;
      const other = document.getElementById(`sidebar-${keepFocus === 'up' ? 'down' : 'up'}-${item.id}`);
      (same && !same.disabled ? same : other)?.focus();
    });
  };

  const toggle = (item: ArrangedEntry) => {
    save(setHidden(sidebar, item.id, !item.hidden));
    setAnnouncement(item.hidden ? `${item.label} is shown again.` : `${item.label} is hidden. It is under More.`);
  };

  const reset = () => {
    save(DEFAULT_SIDEBAR);
    setConfirmReset(false);
    setAnnouncement('The sidebar is back to the default order.');
  };

  return (
    <div
      style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        e.stopPropagation();
        if (confirmReset) setConfirmReset(false);
        else done();
      }}
    >
      <div style={{ padding: '12px 14px 4px' }}>
        <h2
          ref={titleRef}
          tabIndex={-1}
          style={{ margin: 0, fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--nav-text-active)', outline: 'none' }}
        >
          Customize sidebar
        </h2>
        <p style={{ margin: '4px 0 0', fontSize: 'var(--text-xs)', lineHeight: 1.45, color: 'var(--nav-text)' }}>
          Drag items or use the arrows to change their order inside a group. Hidden items move to More.
        </p>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '0 8px 8px' }}>
        {groups.map((group) => (
          <div key={group.id} role="group" aria-label={EDIT_HEADINGS[group.id]}>
            <div
              aria-hidden="true"
              style={{
                padding: '12px 10px 6px', fontSize: 'var(--text-xs)', fontWeight: 600, letterSpacing: '0.06em',
                textTransform: 'uppercase', color: 'var(--nav-text)', opacity: 0.7,
              }}
            >
              {EDIT_HEADINGS[group.id]}
            </div>
            <ul role="list" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {group.items.map((item, index) => (
                <EditRow
                  key={item.id}
                  item={item}
                  icon={icons[item.id]}
                  first={index === 0}
                  last={index === group.items.length - 1}
                  dragging={dragging === item.id}
                  onUp={() => move(group, item, index - 1, 'up')}
                  onDown={() => move(group, item, index + 1, 'down')}
                  onToggle={() => toggle(item)}
                  onDragStart={() => setDragging(item.id)}
                  onDragEnd={() => setDragging(null)}
                  // Items only move inside their own group.
                  acceptsDrop={dragging !== null && group.items.some((i) => i.id === dragging)}
                  onDrop={() => {
                    const moving = group.items.find((i) => i.id === dragging);
                    if (moving && moving.id !== item.id) move(group, moving, index);
                    setDragging(null);
                  }}
                />
              ))}
            </ul>
          </div>
        ))}
      </div>

      <div style={{ borderTop: '1px solid var(--nav-border)', padding: 8, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
        {confirmReset ? (
          <>
            <span style={{ flexBasis: '100%', padding: '0 4px 4px', fontSize: 'var(--text-xs)', color: 'var(--nav-text-active)' }}>
              Reset the sidebar to the default order and show every item?
            </span>
            <EditorButton onClick={reset} strong>Reset</EditorButton>
            <EditorButton onClick={() => setConfirmReset(false)}>Cancel</EditorButton>
          </>
        ) : (
          <>
            <EditorButton onClick={() => setConfirmReset(true)} disabled={isDefaultSidebar(defaults, sidebar)}>
              Reset to default
            </EditorButton>
            <span style={{ flex: 1 }} />
            <EditorButton onClick={done} strong>Done</EditorButton>
          </>
        )}
      </div>

      <div className="sr-only" aria-live="polite">{announcement}</div>
    </div>
  );
}

interface EditRowProps {
  item: ArrangedEntry;
  icon: React.ReactNode;
  first: boolean;
  last: boolean;
  dragging: boolean;
  acceptsDrop: boolean;
  onUp: () => void;
  onDown: () => void;
  onToggle: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDrop: () => void;
}

function EditRow({ item, icon, first, last, dragging, acceptsDrop, onUp, onDown, onToggle, onDragStart, onDragEnd, onDrop }: EditRowProps) {
  const hideable = canHide(item.id);
  const hideLabel = !hideable ? `${item.label} is always shown` : item.hidden ? `Show ${item.label}` : `Hide ${item.label}`;
  return (
    <li
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', item.id);
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      onDragOver={(e) => {
        if (!acceptsDrop) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
      }}
      onDrop={(e) => {
        e.preventDefault();
        onDrop();
      }}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        height: 38,
        padding: '0 4px 0 6px',
        marginBottom: 2,
        borderRadius: 'var(--radius-md)',
        background: dragging ? 'var(--nav-active-bg)' : 'var(--nav-hover-bg)',
        color: 'var(--nav-text-active)',
        fontSize: 'var(--text-sm)',
        cursor: 'grab',
      }}
    >
      <IconGrip />
      <span style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0, opacity: item.hidden ? 0.45 : 1 }}>
        <span style={{ display: 'flex', flexShrink: 0 }}>{icon}</span>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.label}</span>
        {item.hidden && <span className="sr-only">, hidden</span>}
      </span>
      <RowButton id={`sidebar-up-${item.id}`} label={`Move ${item.label} up`} disabled={first} onClick={onUp}>
        <path d="M8 12.5v-9M4.5 7 8 3.5 11.5 7" />
      </RowButton>
      <RowButton id={`sidebar-down-${item.id}`} label={`Move ${item.label} down`} disabled={last} onClick={onDown}>
        <path d="M8 3.5v9M4.5 9 8 12.5 11.5 9" />
      </RowButton>
      <RowButton label={hideLabel} disabled={!hideable} onClick={onToggle}>
        <path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8Z" />
        <circle cx="8" cy="8" r="2" />
        {item.hidden && <path d="M2.5 13.5l11-11" />}
      </RowButton>
    </li>
  );
}

function RowButton({ id, label, disabled, onClick, children }: {
  id?: string; label: string; disabled: boolean; onClick: () => void; children: React.ReactNode;
}) {
  return (
    <button
      id={id}
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center', width: 26, height: 26, flexShrink: 0, padding: 0,
        border: 'none', borderRadius: 'var(--radius-sm)', background: 'transparent', color: 'var(--nav-text)',
        cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.3 : 1,
      }}
      onMouseEnter={(e) => { if (!disabled) e.currentTarget.style.color = 'var(--nav-text-active)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--nav-text)'; }}
    >
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {children}
      </svg>
    </button>
  );
}

function EditorButton({ onClick, disabled, strong, children }: {
  onClick: () => void; disabled?: boolean; strong?: boolean; children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        height: 30, padding: '0 12px', borderRadius: 'var(--radius-md)', fontSize: 'var(--text-xs)', fontWeight: 600,
        border: strong ? 'none' : '1px solid var(--nav-border)',
        background: strong ? 'var(--color-accent)' : 'transparent',
        color: strong ? 'var(--color-text-on-accent)' : 'var(--nav-text-active)',
        cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.4 : 1,
      }}
    >
      {children}
    </button>
  );
}

function IconGrip() {
  return (
    <svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor" aria-hidden="true" style={{ flexShrink: 0, color: 'var(--nav-text)', opacity: 0.7 }}>
      <circle cx="3" cy="4" r="1.1" /><circle cx="7" cy="4" r="1.1" />
      <circle cx="3" cy="8" r="1.1" /><circle cx="7" cy="8" r="1.1" />
      <circle cx="3" cy="12" r="1.1" /><circle cx="7" cy="12" r="1.1" />
    </svg>
  );
}
