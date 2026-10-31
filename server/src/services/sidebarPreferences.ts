import * as fsp from 'fs/promises';
import * as path from 'path';
import { atomicWrite } from '../utils/atomicWrite';
import { workspaceEntry } from '../utils/files';

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
const PREFERENCES_FILE = path.join('.situation-board', 'ui-preferences.json');

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

async function preferencesPath(workspacePath: string): Promise<string> {
  // No symbolic links anywhere below the workspace: the file is written in place.
  return workspaceEntry(workspacePath, path.join(workspacePath, PREFERENCES_FILE), true);
}

async function readFileObject(file: string): Promise<Record<string, unknown>> {
  const raw = await fsp.readFile(file, 'utf-8').catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  if (raw === null) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    // A broken file (for example a bad merge) falls back to the defaults instead of breaking the sidebar.
    return {};
  }
}

export async function readSidebarPreferences(workspacePath: string): Promise<SidebarPreferences> {
  const stored = (await readFileObject(await preferencesPath(workspacePath)))['sidebar'];
  try {
    return stored === undefined ? EMPTY_SIDEBAR : parseSidebarPreferences(stored);
  } catch {
    return EMPTY_SIDEBAR;
  }
}

// Saves from this server run one at a time, so two quick changes cannot interleave their read and write.
// Another program editing the file at the same moment can still lose a change: the replace is atomic, not merged.
let queue: Promise<unknown> = Promise.resolve();

/** Replaces the sidebar part of the file and keeps every other key as it was. */
export function saveSidebarPreferences(workspacePath: string, value: unknown): Promise<SidebarPreferences> {
  const prefs = parseSidebarPreferences(value);
  const run = queue.then(async () => {
    const file = await preferencesPath(workspacePath);
    const current = await readFileObject(file);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await atomicWrite(file, JSON.stringify({ ...current, sidebar: prefs }, null, 2) + '\n');
    return prefs;
  });
  queue = run.catch(() => undefined);
  return run;
}
