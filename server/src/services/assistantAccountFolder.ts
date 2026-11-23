import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readUserConfig, type UserConfig } from './userConfig';

/**
 * Which sign-in each assistant uses when the dashboard starts it (#505): the chat and the background runner. Each
 * assistant keeps its sign-in in a config folder of its own, named by one environment variable. The chosen folder is
 * kept per computer in `~/.gtd/config.json` (`assistant_accounts`), never in a workspace. Nothing chosen: the
 * assistant inherits the dashboard's environment exactly as before.
 *
 * Only folder paths, a name the user gave and the sign-in method last used are stored: never anything inside the
 * folders.
 */

export type AssistantId = 'claude-code' | 'codex' | 'copilot';
export const ASSISTANTS: AssistantId[] = ['claude-code', 'codex', 'copilot'];

export interface FolderSpec {
  /** The variable that names the config folder. */
  envVar: string;
  /** The default folder, under home, used when the variable is unset. */
  defaultName: string;
  /** Other folders next to it with this prefix are offered when they hold one of `markers`. */
  prefix: string;
  /** Entries whose presence (never contents) marks a config folder of this assistant. */
  markers: string[];
  /** Whether the dashboard lets the user choose a folder: only where each folder's account can be checked. */
  choosable: boolean;
  /**
   * Files in a config folder that say who is signed in or which folders are trusted. In a chosen or added folder each
   * must be a plain file of that folder, never a link: a link could borrow another account's sign-in or trust.
   */
  identityFiles: string[];
  /**
   * Variables that sign in on their own and would win over the folder's sign-in. Removed from every process started
   * for a chosen (named) folder, so the choice really decides; the inherited default keeps them, as before.
   */
  authOverrides: string[];
}

export const FOLDERS: Record<AssistantId, FolderSpec> = {
  'claude-code': {
    envVar: 'CLAUDE_CONFIG_DIR', defaultName: '.claude', prefix: '.claude-', markers: ['.claude.json'], choosable: true,
    identityFiles: ['.claude.json', '.credentials.json'],
    authOverrides: ['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_REFRESH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
  },
  codex: {
    envVar: 'CODEX_HOME', defaultName: '.codex', prefix: '.codex-', markers: ['config.toml', 'auth.json', 'sessions'], choosable: true,
    identityFiles: ['auth.json', 'config.toml'],
    authOverrides: ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN'],
  },
  // Copilot reads COPILOT_HOME, but there is no way to read a folder's account without opening a session in it.
  copilot: {
    envVar: 'COPILOT_HOME', defaultName: '.copilot', prefix: '.copilot-', markers: ['config.json'], choosable: false,
    identityFiles: ['config.json'], authOverrides: ['GH_TOKEN', 'GITHUB_TOKEN', 'COPILOT_GITHUB_TOKEN'],
  },
};

const KEY = 'assistant_accounts';

/** What is saved for one assistant. */
export interface SavedChoice {
  /** The chosen folder; absent for the default. */
  folder?: string;
  /** Folders added by path or made from the app; only these may be outside the home folder. */
  added: string[];
  /** A name the user gave an account, by folder. */
  names: Record<string, string>;
  /** The sign-in method each account last used, by folder ('' for the default). Never credentials. */
  methods: Record<string, string>;
}

function refused(status: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode: status });
}

/** The home folder as the system resolves it (on macOS a temporary home may sit behind /var → /private/var). */
export function realHome(home = os.homedir()): string {
  try { return fs.realpathSync.native(home); } catch { return path.resolve(home); }
}

const same = (a: string, b: string) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

/** Whether `folder` is below `home`. */
export function insideHome(folder: string, home = realHome()): boolean {
  const rel = path.relative(home, folder);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const strings = (v: unknown): Record<string, string> => (isRecord(v) ? Object.fromEntries(Object.entries(v).filter((e): e is [string, string] => typeof e[1] === 'string')) : {});

/** One assistant's saved choice, with anything malformed left out. */
export function savedChoice(id: AssistantId, config: UserConfig = readUserConfig()): SavedChoice {
  const all = config[KEY];
  const raw = isRecord(all) && isRecord(all[id]) ? all[id] : {};
  const folder = typeof raw['folder'] === 'string' ? raw['folder'] : undefined;
  const added = Array.isArray(raw['added']) ? raw['added'].filter((f): f is string => typeof f === 'string' && path.isAbsolute(f)) : [];
  return { ...(folder ? { folder } : {}), added, names: strings(raw['names']), methods: strings(raw['methods']) };
}

/** The config with one assistant's choice changed; other assistants and other settings are kept. */
export function withChoice(config: UserConfig, id: AssistantId, change: (c: SavedChoice) => SavedChoice): UserConfig {
  const all = isRecord(config[KEY]) ? config[KEY] : {};
  return { ...config, [KEY]: { ...all, [id]: change(savedChoice(id, config)) } };
}

/**
 * Checks a folder before it is chosen, added or used: an absolute path to a real directory (not a link, and no link
 * on the way: the real path must be the path given), not the home folder, the root or the assistant's default folder
 * (that one is "Default"; for Claude Code, naming it in the variable would even read another settings file). Inside
 * the home folder, or one of the folders the user added. Returns the folder, normalized.
 */
export function checkFolder(id: AssistantId, folder: unknown, added: string[], home = realHome()): string {
  if (typeof folder !== 'string' || !folder.trim() || !path.isAbsolute(folder.trim())) throw refused(400, 'Give the full path of the folder.');
  const resolved = path.resolve(folder.trim());
  let stat: fs.Stats;
  try { stat = fs.lstatSync(resolved); } catch { throw refused(400, 'That folder does not exist.'); }
  if (stat.isSymbolicLink()) throw refused(400, 'That folder is a link. Give the path of the folder itself.');
  if (!stat.isDirectory()) throw refused(400, 'That path is not a folder.');
  let real: string;
  try { real = fs.realpathSync.native(resolved); } catch { throw refused(400, 'That folder cannot be read.'); }
  if (!same(real, resolved)) throw refused(400, `That path goes through a link. Use the folder's real path: ${real}`);
  if (path.dirname(resolved) === resolved || same(resolved, home)) throw refused(400, 'Choose a config folder, not the home folder or the root.');
  if (same(resolved, path.join(home, FOLDERS[id].defaultName))) throw refused(400, 'That is the default folder. Choose the default account instead.');
  if (!insideHome(resolved, home) && !added.some((a) => same(a, resolved))) throw refused(400, 'That folder is outside your home folder. Add it by its path first.');
  for (const name of FOLDERS[id].identityFiles) {
    let file: fs.Stats | null = null;
    try { file = fs.lstatSync(path.join(resolved, name)); } catch { /* not there yet: a new account */ }
    if (file && !file.isFile()) throw refused(400, 'This account\'s sign-in files point somewhere else, so the dashboard cannot use it.');
  }
  return resolved;
}

/** Said when the chosen folder can no longer be used: the assistant then starts nothing until another is chosen. */
export const CHOSEN_FOLDER_PROBLEM = 'The account chosen in Settings can no longer be found on this computer. Choose an account again in Settings → Assistant accounts.';

/** The chosen config folder, checked again now; null for the default. Throws (409) when it cannot be used. */
export function chosenFolder(id: AssistantId): string | null {
  if (!FOLDERS[id].choosable) return null;
  const choice = savedChoice(id);
  if (!choice.folder) return null;
  try { return checkFolder(id, choice.folder, choice.added); } catch { throw refused(409, CHOSEN_FOLDER_PROBLEM); }
}

/**
 * The environment for a process of this assistant: `env` (already cleaned by the assistant's own rules), with its
 * folder variable set to the chosen folder. Nothing chosen: `env` unchanged. A chosen folder that can no longer be
 * used throws (409) rather than falling back to another account.
 */
export function withChosenFolder(id: AssistantId, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const folder = chosenFolder(id);
  return folder ? forFolder(id, env, folder) : env;
}

/** `env` for a named folder: its variable set, and every variable that would sign in on its own removed. */
export function forFolder(id: AssistantId, env: NodeJS.ProcessEnv, folder: string): NodeJS.ProcessEnv {
  const next = { ...env, [FOLDERS[id].envVar]: folder };
  for (const name of FOLDERS[id].authOverrides) delete next[name];
  return next;
}

/**
 * Counts, per assistant, every change of sign-in this dashboard made (a choice, a sign-in, a sign-out): checks cached
 * before a change are not reused after it, and a launch approved by a check before it is refused. A change for one
 * assistant leaves the others' approvals alone.
 */
const generations = new Map<AssistantId, number>();
export function authGeneration(id: AssistantId): number {
  return generations.get(id) ?? 0;
}
export function authChanged(id: AssistantId): void {
  generations.set(id, authGeneration(id) + 1);
}

/** Which account an environment uses, as of now: its folder and the assistant's sign-in generation. Compared at each launch. */
export function accountKey(id: AssistantId, env: NodeJS.ProcessEnv): string {
  return `${env[FOLDERS[id].envVar] ?? ''}\u0000${authGeneration(id)}`;
}

/** Folders a run or a chat of this dashboard is using now, with how many use each: never signed out under them. */
const inUse = new Map<string, number>();
const useKey = (id: AssistantId, env: NodeJS.ProcessEnv) => `${id}\u0000${env[FOLDERS[id].envVar] ?? ''}`;

/** Marks the folder `env` uses as in use until the returned function is called (once). */
export function holdFolder(id: AssistantId, env: NodeJS.ProcessEnv): () => void {
  const key = useKey(id, env);
  inUse.set(key, (inUse.get(key) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (inUse.get(key) ?? 1) - 1;
    if (left > 0) inUse.set(key, left); else inUse.delete(key);
  };
}

export function folderInUse(id: AssistantId, env: NodeJS.ProcessEnv): boolean {
  return inUse.has(useKey(id, env));
}
