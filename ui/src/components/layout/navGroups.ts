/**
 * The sidebar's default structure: grouped by the job each page does, ordered by how often
 * it is used (issue #191). Ids stay stable so a saved custom order can refer to them later.
 */

export type NavItemId =
  | 'situation'
  | 'board'
  | 'meetings'
  | 'insights'
  | 'context'
  | 'stakeholders'
  | 'outputs'
  | 'agents'
  | 'routines'
  | 'agent-floor'
  | 'profile'
  | 'settings';

export interface NavEntry {
  id: NavItemId;
  path: string;
  label: string;
}

export interface NavGroup {
  id: 'work' | 'memory' | 'automation' | 'account';
  /** Shown above the group. The work group has none: it is the top of the list. */
  heading?: string;
  items: NavEntry[];
}

export function navGroups({ agentFloor }: { agentFloor: boolean }): NavGroup[] {
  const automation: NavEntry[] = [
    { id: 'agents', path: '/agents', label: 'Agents & Skills' },
    { id: 'routines', path: '/routines', label: 'Routines' },
  ];
  // Experimental view, shown only while the Settings switch is on.
  if (agentFloor) automation.push({ id: 'agent-floor', path: '/agent-floor', label: 'Agent Floor' });

  return [
    {
      id: 'work',
      items: [
        { id: 'situation', path: '/situation', label: 'Situation' },
        { id: 'board', path: '/board', label: 'Board' },
        { id: 'meetings', path: '/meetings', label: 'Meetings' },
        { id: 'insights', path: '/insights', label: 'Insights' },
      ],
    },
    {
      id: 'memory',
      heading: 'Memory',
      items: [
        { id: 'context', path: '/context', label: 'Context' },
        { id: 'stakeholders', path: '/stakeholders', label: 'Stakeholders' },
        { id: 'outputs', path: '/outputs', label: 'Output templates' },
      ],
    },
    { id: 'automation', heading: 'Automation', items: automation },
    {
      id: 'account',
      items: [
        { id: 'profile', path: '/profile', label: 'Profile' },
        { id: 'settings', path: '/settings', label: 'Settings' },
      ],
    },
  ];
}

/** The user's own order and hidden items, saved per workspace. Ids only: merged with the defaults above. */
export interface SidebarPrefs {
  order: Partial<Record<NavGroup['id'], string[]>>;
  hidden: string[];
}

export const DEFAULT_SIDEBAR: SidebarPrefs = { order: {}, hidden: [] };

/** Situation is the home route, and Settings is where the customization is undone. */
export function canHide(id: NavItemId): boolean {
  return id !== 'situation' && id !== 'settings';
}

export interface ArrangedEntry extends NavEntry {
  hidden: boolean;
}
export interface ArrangedGroup extends Omit<NavGroup, 'items'> {
  items: ArrangedEntry[];
}

/**
 * The saved order first, then every item it does not mention (a new feature, or Agent Floor switched on)
 * right after the item that comes before it by default, so new items show up where they belong.
 */
export function orderGroup(defaults: NavEntry[], saved: string[] | undefined): NavEntry[] {
  if (!saved) return defaults;
  const byId = new Map(defaults.map((entry) => [entry.id as string, entry]));
  const result: NavEntry[] = [];
  for (const id of saved) {
    const entry = byId.get(id);
    if (entry && !result.includes(entry)) result.push(entry);
  }
  defaults.forEach((entry, i) => {
    if (result.includes(entry)) return;
    const before = defaults.slice(0, i).reverse().find((e) => result.includes(e));
    result.splice(before ? result.indexOf(before) + 1 : 0, 0, entry);
  });
  return result;
}

export function arrangeSidebar(groups: NavGroup[], prefs: SidebarPrefs): ArrangedGroup[] {
  return groups.map((group) => ({
    ...group,
    items: orderGroup(group.items, prefs.order[group.id]).map((entry) => ({
      ...entry,
      hidden: canHide(entry.id) && prefs.hidden.includes(entry.id),
    })),
  }));
}

/** Moves an item to `index` inside its own group. Items never move between groups. */
export function moveItem(groups: NavGroup[], prefs: SidebarPrefs, id: NavItemId, index: number): SidebarPrefs {
  const group = arrangeSidebar(groups, prefs).find((g) => g.items.some((item) => item.id === id));
  if (!group) return prefs;
  const ids = group.items.map((item) => item.id as string);
  const from = ids.indexOf(id);
  const to = Math.max(0, Math.min(ids.length - 1, index));
  if (from === to) return prefs;
  ids.splice(to, 0, ...ids.splice(from, 1));
  return { ...prefs, order: { ...prefs.order, [group.id]: ids } };
}

export function setHidden(prefs: SidebarPrefs, id: NavItemId, hidden: boolean): SidebarPrefs {
  if (!canHide(id)) return prefs;
  const rest = prefs.hidden.filter((h) => h !== id);
  return { ...prefs, hidden: hidden ? [...rest, id] : rest };
}

/** True when the sidebar looks exactly like the default one, whatever is stored. */
export function isDefaultSidebar(groups: NavGroup[], prefs: SidebarPrefs): boolean {
  return arrangeSidebar(groups, prefs).every((group, g) =>
    group.items.every((item, i) => !item.hidden && item.id === groups[g].items[i].id));
}

/** Whether the page at `current` belongs to the sidebar item at `path` (a task page belongs to Board). */
export function isActivePath(path: string, current: string): boolean {
  return current === path || current.startsWith(path + '/');
}
