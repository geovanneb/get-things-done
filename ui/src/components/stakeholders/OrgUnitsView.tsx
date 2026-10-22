import { useEffect, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import Avatar from '@/components/common/Avatar';
import type { OrgChartMember, OrgUnit, Stakeholder } from '@/types';
import type { UnitTreeNode } from '@/utils/orgChart';
import { DRAG_MIME } from './OrgChartTree';

export type UnitAction = 'edit' | 'add-sub-unit' | 'delete';

interface UnitsViewProps {
  roots: UnitTreeNode[];
  members: OrgChartMember[];
  people: Map<string, Stakeholder>;
  titles: Map<string, string>;
  dragging: string | null;
  onDragStart: (ref: string) => void;
  onDragEnd: () => void;
  /** Puts a person in a unit (null = no unit). */
  onAssign: (ref: string, unit: string | null) => void;
  onUnitAction: (unit: OrgUnit, action: UnitAction) => void;
  /** Opens the unit picker for one person. */
  onPerson: (ref: string) => void;
  /** Placeholder refs (not stakeholders yet). */
  placeholders?: Set<string>;
}

/**
 * Units as boxes, nested the same way as the chart, with their people listed inside.
 * Drag a person onto a unit to move them; units never change who reports to whom.
 */
export default function OrgUnitsView(props: UnitsViewProps) {
  const { roots, members } = props;
  const unassigned = members.filter((m) => !m.unit || !hasUnit(roots, m.unit));
  return (
    <div className="org-tree-scroll">
      <div className="org-tree">
        <ul>
          {roots.map((n) => <UnitBranch key={n.unit.id} node={n} {...props} />)}
        </ul>
      </div>
      <Bucket title="Not in a unit" refs={unassigned.map((m) => m.ref)} unit={null} {...props} />
    </div>
  );
}

function hasUnit(nodes: UnitTreeNode[], id: string): boolean {
  return nodes.some((n) => n.unit.id === id || hasUnit(n.children, id));
}

function UnitBranch({ node, ...props }: { node: UnitTreeNode } & UnitsViewProps) {
  return (
    <li>
      <UnitCard node={node} {...props} />
      {node.children.length > 0 && (
        <ul>
          {node.children.map((c) => <UnitBranch key={c.unit.id} node={c} {...props} />)}
        </ul>
      )}
    </li>
  );
}

function useDropTarget(dragging: string | null, accept: (ref: string) => void) {
  const [over, setOver] = useState(false);
  return {
    over,
    handlers: {
      onDragOver: (e: DragEvent) => { if (dragging) { e.preventDefault(); e.stopPropagation(); setOver(true); } },
      onDragLeave: () => setOver(false),
      onDrop: (e: DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setOver(false);
        const ref = e.dataTransfer.getData(DRAG_MIME);
        if (ref) accept(ref);
      },
    },
  };
}

function UnitCard({ node, members, people, titles, dragging, onAssign, onUnitAction, ...rest }: { node: UnitTreeNode } & UnitsViewProps) {
  const { unit } = node;
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const drop = useDropTarget(dragging, (ref) => onAssign(ref, unit.id));
  // Head first, then everyone else by name.
  const refs = members.filter((m) => m.unit === unit.id).map((m) => m.ref)
    .sort((a, b) => Number(b === unit.head) - Number(a === unit.head) || (people.get(a)?.name ?? a).localeCompare(people.get(b)?.name ?? b));
  const headElsewhere = unit.head && !refs.includes(unit.head) ? people.get(unit.head)?.name ?? unit.head : null;

  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: MouseEvent) => { if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [menuOpen]);

  return (
    <div className={`org-unit${drop.over ? ' org-unit--drop' : ''}`} data-unit={unit.id} {...drop.handlers}>
      <div className="org-unit__head">
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="org-node__clamp" style={{ fontSize: 'var(--text-sm)', fontWeight: 700, color: 'var(--color-text)' }}>{unit.name}</div>
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
            {refs.length} {refs.length === 1 ? 'person' : 'people'}{headElsewhere ? ` · led by ${headElsewhere}` : ''}
          </div>
        </div>
        <div ref={menuRef} style={{ position: 'relative', flexShrink: 0 }}>
          <button type="button" className="org-node__menu-btn" aria-label={`Actions for ${unit.name}`} aria-haspopup="menu" aria-expanded={menuOpen}
            onClick={() => setMenuOpen((o) => !o)}>
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
              <circle cx="3" cy="7" r="1.2" fill="currentColor" /><circle cx="7" cy="7" r="1.2" fill="currentColor" /><circle cx="11" cy="7" r="1.2" fill="currentColor" />
            </svg>
          </button>
          {menuOpen && (
            <div role="menu" className="org-node__menu">
              {([['edit', 'Edit unit…'], ['add-sub-unit', 'Add a sub-unit…'], ['delete', 'Delete unit']] as Array<[UnitAction, string]>).map(([action, label]) => (
                <button key={action} type="button" role="menuitem"
                  className={action === 'delete' ? 'org-node__menu-item org-node__menu-item--danger' : 'org-node__menu-item'}
                  onClick={() => { setMenuOpen(false); onUnitAction(unit, action); }}>
                  {label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      <PersonList refs={refs} head={unit.head} people={people} titles={titles} {...rest} />
      {refs.length === 0 && <div className="org-unit__empty">Drag people here</div>}
    </div>
  );
}

function Bucket({ title, refs, unit, people, titles, dragging, onAssign, ...rest }: { title: string; refs: string[]; unit: null } & UnitsViewProps) {
  const drop = useDropTarget(dragging, (ref) => onAssign(ref, unit));
  if (refs.length === 0 && !dragging) return null;
  const sorted = [...refs].sort((a, b) => (people.get(a)?.name ?? a).localeCompare(people.get(b)?.name ?? b));
  // Up to four 204px columns (plus gaps and padding), so a long list wraps instead of widening the canvas.
  const columns = Math.min(4, Math.max(1, refs.length));
  return (
    <div className={`org-unit org-unit--bucket${drop.over ? ' org-unit--drop' : ''}`} style={{ width: columns * 206 + 16 }} {...drop.handlers}>
      <div className="org-unit__head">
        <div style={{ fontSize: 'var(--text-sm)', fontWeight: 700, color: 'var(--color-text-secondary)' }}>{title} · {refs.length}</div>
      </div>
      <PersonList refs={sorted} people={people} titles={titles} {...rest} wrap />
      {refs.length === 0 && <div className="org-unit__empty">Drop here to take someone out of their unit</div>}
    </div>
  );
}

function PersonList({ refs, head, people, titles, onDragStart, onDragEnd, onPerson, wrap, placeholders }: {
  refs: string[]; head?: string; people: Map<string, Stakeholder>; titles: Map<string, string>; wrap?: boolean; placeholders?: Set<string>;
  onDragStart: (ref: string) => void; onDragEnd: () => void; onPerson: (ref: string) => void;
}) {
  if (refs.length === 0) return null;
  return (
    <ul className={`org-unit__people${wrap ? ' org-unit__people--wrap' : ''}`}>
      {refs.map((ref) => {
        const p = people.get(ref);
        const name = p?.name ?? `${ref} (missing)`;
        const role = titles.get(ref) || p?.role;
        return (
          <li key={ref}>
            <button type="button" className="org-unit__person" draggable
              onDragStart={(e) => { e.dataTransfer.setData(DRAG_MIME, ref); e.dataTransfer.effectAllowed = 'move'; onDragStart(ref); }}
              onDragEnd={onDragEnd}
              onClick={() => onPerson(ref)}
              title={`Move ${name} to another unit`}>
              <Avatar name={name} size="sm" initials={p?.avatar_initials} />
              <span style={{ minWidth: 0, flex: 1, textAlign: 'left' }}>
                <span className="org-node__clamp" style={{ fontSize: 'var(--text-sm)', color: p ? 'var(--color-text)' : 'var(--color-critical)' }}>{name}</span>
                {role && <span className="org-node__clamp" style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>{role}</span>}
                {placeholders?.has(ref) && <span className="org-node__unit org-node__unit--ph">Placeholder</span>}
              </span>
              {ref === head && <span className="org-unit__badge">Head</span>}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
