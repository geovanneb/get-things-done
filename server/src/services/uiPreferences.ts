import * as fsp from 'fs/promises';
import * as path from 'path';
import { atomicWrite } from '../utils/atomicWrite';
import { workspaceEntry } from '../utils/files';

/**
 * `.situation-board/ui-preferences.json`: the dashboard's per-workspace preferences (the sidebar order, the board
 * columns). It is scaffolded and tracked by git, so the preferences follow the workspace between the browser, the
 * desktop app and other computers. Each feature owns one top-level key and keeps every other key as it was.
 */
const PREFERENCES_FILE = path.join('.situation-board', 'ui-preferences.json');

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
    // A broken file (for example a bad merge) falls back to the defaults instead of breaking the dashboard.
    return {};
  }
}

/** The stored value of one key, or undefined when the file or the key is missing or the file is broken. */
export async function readUiPreference(workspacePath: string, key: string): Promise<unknown> {
  return (await readFileObject(await preferencesPath(workspacePath)))[key];
}

// Saves from this server run one at a time, across every key, so two quick changes cannot interleave their read
// and write. Another program editing the file at the same moment can still lose a change: the replace is atomic,
// not merged.
let queue: Promise<unknown> = Promise.resolve();

/** Replaces one key of the file and keeps every other key as it was. */
export function saveUiPreference<T>(workspacePath: string, key: string, value: T): Promise<T> {
  const run = queue.then(async () => {
    const file = await preferencesPath(workspacePath);
    const current = await readFileObject(file);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await atomicWrite(file, JSON.stringify({ ...current, [key]: value }, null, 2) + '\n');
    return value;
  });
  queue = run.catch(() => undefined);
  return run;
}
