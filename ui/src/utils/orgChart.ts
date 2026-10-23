import type { OrgChartMember, OrgUnit } from '@/types';

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

/** Every ref in top-down, left-to-right order (ignores collapsing). */
export function treeOrder(roots: OrgTreeNode[]): string[] {
  const out: string[] = [];
  const walk = (nodes: OrgTreeNode[]) => nodes.forEach((n) => { out.push(n.ref); walk(n.children); });
  walk(roots);
  return out;
}

/** The managers above `ref`, nearest first. */
export function ancestorsOf(members: OrgChartMember[], ref: string): string[] {
  const managerOf = new Map(members.map((m) => [m.ref, m.reports_to]));
  const out: string[] = [];
  let current = managerOf.get(ref);
  while (current && !out.includes(current)) {
    out.push(current);
    current = managerOf.get(current);
  }
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

/** A member with a new manager; every other field (title…) is kept. */
function withManager(m: OrgChartMember, manager: string | null): OrgChartMember {
  const { reports_to: _old, ...rest } = m;
  return manager ? { ...rest, reports_to: manager } : rest;
}

/** Adds `ref` (or moves it, if already in the chart) under `manager`. */
export function placeMember(members: OrgChartMember[], ref: string, manager: string | null): OrgChartMember[] {
  if (!canReportTo(members, ref, manager)) return members;
  if (members.some((m) => m.ref === ref)) return members.map((m) => (m.ref === ref ? withManager(m, manager) : m));
  return [...members, withManager({ ref }, manager)];
}

/** Removes `ref`; their direct reports move up to `ref`'s manager. */
export function removeMember(members: OrgChartMember[], ref: string): OrgChartMember[] {
  const removed = members.find((m) => m.ref === ref);
  if (!removed) return members;
  return members
    .filter((m) => m.ref !== ref)
    .map((m) => (m.reports_to === ref ? withManager(m, removed.reports_to ?? null) : m));
}

/** Sets (or, when blank, clears) `ref`'s title in this chart. */
export function setTitle(members: OrgChartMember[], ref: string, title: string): OrgChartMember[] {
  const clean = title.trim();
  return members.map((m) => {
    if (m.ref !== ref) return m;
    const { title: _old, ...rest } = m;
    return clean ? { ...rest, title: clean } : rest;
  });
}

export function managerOf(members: OrgChartMember[], ref: string): string | null {
  return members.find((m) => m.ref === ref)?.reports_to ?? null;
}

// --- Units ------------------------------------------------------------------
// Units are membership containers (departments, teams). They never change who reports to whom.

export interface UnitTreeNode {
  unit: OrgUnit;
  children: UnitTreeNode[];
}

/** Top-level units with their sub-units nested; a unit whose parent is missing is top-level. */
export function buildUnitTree(units: OrgUnit[]): UnitTreeNode[] {
  const nodes = new Map(units.map((u) => [u.id, { unit: u, children: [] as UnitTreeNode[] }]));
  const roots: UnitTreeNode[] = [];
  for (const u of units) {
    const node = nodes.get(u.id)!;
    if (u.parent && u.parent !== u.id && nodes.has(u.parent)) nodes.get(u.parent)!.children.push(node);
    else roots.push(node);
  }
  return roots;
}

/** `id` and every unit nested inside it. */
export function unitDescendants(units: OrgUnit[], id: string): Set<string> {
  return descendantsOf(units.map((u) => ({ ref: u.id, reports_to: u.parent })), id);
}

/** True when unit `id` may sit inside `parent` (null = top level) without a loop. */
export function canNestUnit(units: OrgUnit[], id: string, parent: string | null): boolean {
  return parent === null || !unitDescendants(units, id).has(parent);
}

/** The next free chart-local unit id. */
export function nextUnitId(units: OrgUnit[]): string {
  const max = units.reduce((n, u) => Math.max(n, Number(u.id.match(/^U-(\d+)$/)?.[1] ?? 0)), 0);
  return `U-${max + 1}`;
}

/** Unit names from the top down to `id`. */
export function unitPath(units: OrgUnit[], id: string): string[] {
  const byId = new Map(units.map((u) => [u.id, u]));
  const names: string[] = [];
  const seen = new Set<string>();
  for (let u = byId.get(id); u && !seen.has(u.id); u = u.parent ? byId.get(u.parent) : undefined) {
    seen.add(u.id);
    names.unshift(u.name);
  }
  return names;
}

/** Adds a unit, or updates it when the id exists. Empty parent/head clear the field. */
export function saveUnit(units: OrgUnit[], unit: OrgUnit): OrgUnit[] {
  const clean: OrgUnit = { id: unit.id, name: unit.name.trim() };
  if (unit.parent && unit.parent !== unit.id) clean.parent = unit.parent;
  if (unit.head) clean.head = unit.head;
  return units.some((u) => u.id === unit.id) ? units.map((u) => (u.id === unit.id ? clean : u)) : [...units, clean];
}

/**
 * Deletes a unit. Its sub-units and its people move up to the unit it sat in (or out of any unit
 * when it was top-level); nobody is removed from the chart.
 */
export function deleteUnit(units: OrgUnit[], members: OrgChartMember[], id: string): { units: OrgUnit[]; members: OrgChartMember[] } {
  const gone = units.find((u) => u.id === id);
  if (!gone) return { units, members };
  return {
    units: units.filter((u) => u.id !== id).map((u) => {
      if (u.parent !== id) return u;
      const { parent: _old, ...rest } = u;
      return gone.parent ? { ...rest, parent: gone.parent } : rest;
    }),
    members: members.map((m) => (m.unit === id ? setUnitOf(m, gone.parent ?? null) : m)),
  };
}

function setUnitOf(m: OrgChartMember, unit: string | null): OrgChartMember {
  const { unit: _old, ...rest } = m;
  return unit ? { ...rest, unit } : rest;
}

/** Puts `ref` in `unit` (null = no unit); every other field is kept. */
export function setMemberUnit(members: OrgChartMember[], ref: string, unit: string | null): OrgChartMember[] {
  return members.map((m) => (m.ref === ref ? setUnitOf(m, unit) : m));
}

/** Units no longer led by `ref` (used when `ref` leaves the chart). */
export function withoutHead(units: OrgUnit[], ref: string): OrgUnit[] {
  return units.map((u) => {
    if (u.head !== ref) return u;
    const { head: _old, ...rest } = u;
    return rest;
  });
}
