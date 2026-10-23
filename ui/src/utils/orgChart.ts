import type { OrgChartMember } from '@/types';

export interface OrgTreeNode {
  ref: string;
  children: OrgTreeNode[];
}

/** Top-level nodes with their reports nested. A manager missing from the chart makes the member top-level. */
export function buildTree(members: OrgChartMember[]): OrgTreeNode[] {
  const refs = new Set(members.map((m) => m.ref));
  const nodes = new Map<string, OrgTreeNode>(members.map((m) => [m.ref, { ref: m.ref, children: [] }]));
  const roots: OrgTreeNode[] = [];
  for (const m of members) {
    const node = nodes.get(m.ref)!;
    if (m.reports_to && refs.has(m.reports_to) && m.reports_to !== m.ref) nodes.get(m.reports_to)!.children.push(node);
    else roots.push(node);
  }
  return roots;
}

/** Number of levels in the tree (1 = only top-level people). */
export function treeDepth(roots: OrgTreeNode[]): number {
  return roots.reduce((max, n) => Math.max(max, 1 + treeDepth(n.children)), 0);
}

/**
 * Cards to collapse so that only the first `level` levels show (level 1 = top-level people only).
 * Every card from that depth down is collapsed, so expanding one later reveals one level at a time.
 */
export function collapsedForLevel(roots: OrgTreeNode[], level: number): Set<string> {
  const out = new Set<string>();
  const walk = (nodes: OrgTreeNode[], depth: number) => {
    for (const n of nodes) {
      if (n.children.length > 0 && depth >= level - 1) out.add(n.ref);
      walk(n.children, depth + 1);
    }
  };
  walk(roots, 0);
  return out;
}

/** `ref` and everyone below it. */
export function descendantsOf(members: OrgChartMember[], ref: string): Set<string> {
  const out = new Set<string>([ref]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const m of members) {
      if (m.reports_to && out.has(m.reports_to) && !out.has(m.ref)) {
        out.add(m.ref);
        grew = true;
      }
    }
  }
  return out;
}

/** True when `ref` may report to `manager` (null = top level) without creating a loop. */
export function canReportTo(members: OrgChartMember[], ref: string, manager: string | null): boolean {
  if (manager === null) return true;
  if (!members.some((m) => m.ref === ref)) return true;
  return !descendantsOf(members, ref).has(manager);
}

function member(ref: string, manager: string | null): OrgChartMember {
  return manager ? { ref, reports_to: manager } : { ref };
}

/** Adds `ref` (or moves it, if already in the chart) under `manager`. */
export function placeMember(members: OrgChartMember[], ref: string, manager: string | null): OrgChartMember[] {
  if (!canReportTo(members, ref, manager)) return members;
  if (members.some((m) => m.ref === ref)) return members.map((m) => (m.ref === ref ? member(ref, manager) : m));
  return [...members, member(ref, manager)];
}

/** Removes `ref`; their direct reports move up to `ref`'s manager. */
export function removeMember(members: OrgChartMember[], ref: string): OrgChartMember[] {
  const removed = members.find((m) => m.ref === ref);
  if (!removed) return members;
  return members
    .filter((m) => m.ref !== ref)
    .map((m) => (m.reports_to === ref ? member(m.ref, removed.reports_to ?? null) : m));
}

export function managerOf(members: OrgChartMember[], ref: string): string | null {
  return members.find((m) => m.ref === ref)?.reports_to ?? null;
}
