import { useEffect, useRef, useState } from 'react';
import Avatar from '@/components/common/Avatar';
import type { Stakeholder } from '@/types';
import type { OrgTreeNode } from '@/utils/orgChart';

export const DRAG_MIME = 'application/x-gtd-stakeholder';

export type NodeAction = 'add-report' | 'change-manager' | 'top-level' | 'open' | 'remove';

interface TreeProps {
  roots: OrgTreeNode[];
  people: Map<string, Stakeholder>;
  view: 'chart' | 'outline';
  selected: string | null;
  collapsed: Set<string>;
  /** Returns whether the stakeholder being dragged may be dropped on `target` (null = top level). */
  canDrop: (target: string | null) => boolean;
  dragging: string | null;
  hasManager: (ref: string) => boolean;
  onSelect: (ref: string | null) => void;
  onToggle: (ref: string) => void;
  onDragStart: (ref: string) => void;
  onDragEnd: () => void;
  onDrop: (ref: string, target: string | null) => void;
  onAction: (ref: string, action: NodeAction) => void;
  /** Search matches (highlighted) and the match being shown. */
  matches?: Set<string>;
  currentMatch?: string | null;
}

function countBelow(node: OrgTreeNode): number {
  return node.children.reduce((n, c) => n + 1 + countBelow(c), 0);
}

export default function OrgChartTree(props: TreeProps) {
  const { roots, view, dragging, canDrop, onDrop } = props;
  const [topHover, setTopHover] = useState(false);

  const topZone = (
    <div
      onDragOver={(e) => { if (dragging && canDrop(null)) { e.preventDefault(); setTopHover(true); } }}
      onDragLeave={() => setTopHover(false)}
      onDrop={(e) => {
        e.preventDefault();
        setTopHover(false);
        const ref = e.dataTransfer.getData(DRAG_MIME);
        if (ref) onDrop(ref, null);
      }}
      className="org-top-zone"
      style={{
        borderColor: topHover ? 'var(--color-accent)' : undefined,
        background: topHover ? 'var(--color-accent-subtle)' : undefined,
        color: topHover ? 'var(--color-accent)' : undefined,
        display: dragging ? 'block' : 'none',
      }}
    >
      Drop here to place at the top of the chart
    </div>
  );

  if (view === 'outline') {
    return (
      <div className="org-outline">
        {topZone}
        <OutlineList nodes={roots} depth={0} {...props} />
      </div>
    );
  }

  return (
    <div className="org-tree-scroll">
      {topZone}
      <div className="org-tree">
        <ul>
          {roots.map((n) => <ChartBranch key={n.ref} node={n} {...props} />)}
        </ul>
      </div>
    </div>
  );
}

function ChartBranch({ node, ...props }: { node: OrgTreeNode } & TreeProps) {
  const isCollapsed = props.collapsed.has(node.ref);
  return (
    <li>
      <NodeCard node={node} compact={false} {...props} />
      {node.children.length > 0 && !isCollapsed && (
        <ul>
          {node.children.map((c) => <ChartBranch key={c.ref} node={c} {...props} />)}
        </ul>
      )}
    </li>
  );
}

function OutlineList({ nodes, depth, ...props }: { nodes: OrgTreeNode[]; depth: number } & TreeProps) {
  return (
    <ul style={{ listStyle: 'none', margin: 0, padding: depth === 0 ? 0 : '0 0 0 22px', borderLeft: depth === 0 ? 'none' : '1px solid var(--color-border)' }}>
      {nodes.map((n) => (
        <li key={n.ref} style={{ padding: '3px 0' }}>
          <NodeCard node={n} compact {...props} />
          {n.children.length > 0 && !props.collapsed.has(n.ref) && (
            <div style={{ marginLeft: 14, marginTop: 3 }}>
              <OutlineList nodes={n.children} depth={depth + 1} {...props} />
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

function NodeCard({ node, compact, people, selected, collapsed, dragging, canDrop, hasManager, onSelect, onToggle, onDragStart, onDragEnd, onDrop, onAction, matches, currentMatch }: { node: OrgTreeNode; compact: boolean } & TreeProps) {
  const person = people.get(node.ref);
  const name = person?.name ?? node.ref;
  const isSelected = selected === node.ref;
  const isCollapsed = collapsed.has(node.ref);
  const [over, setOver] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const dropAllowed = dragging !== null && dragging !== node.ref && canDrop(node.ref);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: MouseEvent) => { if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [menuOpen]);

  const reports = node.children.length;
  const hidden = isCollapsed ? countBelow(node) : 0;

  return (
    <div
      className={`org-node${isSelected ? ' org-node--selected' : ''}${over && dropAllowed ? ' org-node--drop' : ''}${dragging === node.ref ? ' org-node--dragging' : ''}${matches?.has(node.ref) ? ' org-node--match' : ''}${currentMatch === node.ref ? ' org-node--current' : ''}`}
      data-ref={node.ref}
      style={{ width: compact ? 'auto' : 184, display: compact ? 'flex' : undefined, maxWidth: compact ? 520 : undefined }}
      draggable
      onDragStart={(e) => { e.dataTransfer.setData(DRAG_MIME, node.ref); e.dataTransfer.effectAllowed = 'move'; onDragStart(node.ref); }}
      onDragEnd={() => { setOver(false); onDragEnd(); }}
      onDragOver={(e) => { if (dropAllowed) { e.preventDefault(); e.stopPropagation(); setOver(true); } }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setOver(false);
        const ref = e.dataTransfer.getData(DRAG_MIME);
        if (ref && ref !== node.ref) onDrop(ref, node.ref);
      }}
      onClick={() => onSelect(isSelected ? null : node.ref)}
      role="treeitem"
      aria-selected={isSelected}
      aria-expanded={reports > 0 ? !isCollapsed : undefined}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(isSelected ? null : node.ref); }
        if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); onAction(node.ref, 'remove'); }
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, flex: 1 }}>
        <Avatar name={name} size={compact ? 'sm' : 'md'} initials={person?.avatar_initials} />
        <div style={{ minWidth: 0, flex: 1, textAlign: 'left' }}>
          <div className={compact ? 'org-node__line' : 'org-node__clamp'} style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: person ? 'var(--color-text)' : 'var(--color-critical)' }}>
            {person ? name : `${node.ref} (missing)`}
          </div>
          {(person?.role || (compact && person?.organization)) && (
            <div className={compact ? 'org-node__line' : 'org-node__clamp'} style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
              {compact ? [person?.role, person?.organization].filter(Boolean).join(' · ') : person?.role}
            </div>
          )}
        </div>
        {isSelected && (
          <button
            type="button"
            className={compact ? 'org-node__add' : 'org-node__add org-node__add--edge'}
            aria-label={`Add a direct report to ${name}`}
            title="Add a direct report"
            onClick={(e) => { e.stopPropagation(); onAction(node.ref, 'add-report'); }}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M6 2v8M2 6h8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
          </button>
        )}
        <div ref={menuRef} style={{ position: 'relative', flexShrink: 0 }}>
          <button
            type="button"
            className="org-node__menu-btn"
            aria-label={`Actions for ${name}`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={(e) => { e.stopPropagation(); setMenuOpen((o) => !o); }}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
              <circle cx="3" cy="7" r="1.2" fill="currentColor" /><circle cx="7" cy="7" r="1.2" fill="currentColor" /><circle cx="11" cy="7" r="1.2" fill="currentColor" />
            </svg>
          </button>
          {menuOpen && (
            <div role="menu" className="org-node__menu" onClick={(e) => e.stopPropagation()}>
              {([
                ['add-report', 'Add a direct report…'],
                ['change-manager', 'Change manager…'],
                ...(hasManager(node.ref) ? [['top-level', 'Move to top of chart'] as [NodeAction, string]] : []),
                ['open', 'Open profile'],
                ['remove', 'Remove from chart'],
              ] as Array<[NodeAction, string]>).map(([action, label]) => (
                <button key={action} type="button" role="menuitem"
                  className={action === 'remove' ? 'org-node__menu-item org-node__menu-item--danger' : 'org-node__menu-item'}
                  onClick={() => { setMenuOpen(false); onAction(node.ref, action); }}>
                  {label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      {reports > 0 && (
        <button
          type="button"
          className="org-node__toggle"
          onClick={(e) => { e.stopPropagation(); onToggle(node.ref); }}
          aria-label={isCollapsed ? `Show ${name}'s reports` : `Hide ${name}'s reports`}
        >
          {isCollapsed ? `+${hidden} below` : `${reports} ${reports === 1 ? 'report' : 'reports'}`}
        </button>
      )}
    </div>
  );
}
