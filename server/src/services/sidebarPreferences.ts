import { readUiPreference, saveUiPreference } from './uiPreferences';

/**
 * The user's own sidebar order, kept per workspace (issue #191) so it follows the workspace between the
 * browser, the desktop app and other computers through git. Only ids are stored: the dashboard merges them
 * with its defaults, so items added by a later release still show up.
 */
export interface SidebarPreferences {
  /** Item ids per group, in the user's order. A group that is not listed keeps the default order. */
  order: Record<string, string[]>;
  /** Item ids moved to "More". */
  hidden: string[];
}

export class InvalidSidebarPreferencesError extends Error {}

const ID = /^[a-z][a-z0-9-]{0,39}$/;
const MAX_GROUPS = 8;
const MAX_IDS = 40;

export const EMPTY_SIDEBAR: SidebarPreferences = { order: {}, hidden: [] };

function idList(value: unknown, what: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_IDS) throw new InvalidSidebarPreferencesError(`${what} must be a list of at most ${MAX_IDS} ids.`);
  if (!value.every((id) => typeof id === 'string' && ID.test(id))) throw new InvalidSidebarPreferencesError(`${what} has an invalid id.`);
  if (new Set(value).size !== value.length) throw new InvalidSidebarPreferencesError(`${what} lists an id twice.`);
  return [...value] as string[];
}

/** Checks a request body. TypeScript types do not validate JSON at runtime. */
export function parseSidebarPreferences(value: unknown): SidebarPreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InvalidSidebarPreferencesError('Expected an object with order and hidden.');
  const { order = {}, hidden = [] } = value as { order?: unknown; hidden?: unknown };
  if (!order || typeof order !== 'object' || Array.isArray(order)) throw new InvalidSidebarPreferencesError('order must be an object.');
  const groups = Object.entries(order as Record<string, unknown>);
  if (groups.length > MAX_GROUPS) throw new InvalidSidebarPreferencesError(`order has more than ${MAX_GROUPS} groups.`);
  const parsed: [string, string[]][] = groups.map(([group, ids]) => {
    if (!ID.test(group)) throw new InvalidSidebarPreferencesError('order has an invalid group id.');
    return [group, idList(ids, `order.${group}`)];
  });
  return { order: Object.fromEntries(parsed), hidden: idList(hidden, 'hidden') };
}

export async function readSidebarPreferences(workspacePath: string): Promise<SidebarPreferences> {
  const stored = await readUiPreference(workspacePath, 'sidebar');
  try {
    return stored === undefined ? EMPTY_SIDEBAR : parseSidebarPreferences(stored);
  } catch {
    return EMPTY_SIDEBAR;
  }
}

/** Replaces the sidebar part of the file and keeps every other key as it was. */
export function saveSidebarPreferences(workspacePath: string, value: unknown): Promise<SidebarPreferences> {
  return saveUiPreference(workspacePath, 'sidebar', parseSidebarPreferences(value));
}
