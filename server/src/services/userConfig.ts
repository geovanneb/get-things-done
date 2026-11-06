import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { atomicWrite } from '../utils/atomicWrite';
import { lock, unlock } from '../utils/fileLock';

export interface UserConfig {
  workspace_path?: string;
  port?: number;
  recent_workspaces?: { path: string; last_opened: string }[];
  interface_language?: string;
  [key: string]: unknown;
}

export const userConfigPath = () => path.join(os.homedir(), '.gtd', 'config.json');

/** Missing is a new installation; damaged config must never be silently overwritten. */
export function readUserConfig(file = userConfigPath()): UserConfig {
  let raw: string;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error; }
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid user configuration');
  return value as UserConfig;
}

/** Every config writer must read and change under the same cross-process lock. */
export async function updateUserConfig(change: (current: UserConfig) => UserConfig, file = userConfigPath()): Promise<UserConfig> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const held = await lock(`${file}.lock`, 5000, () => Object.assign(new Error('Settings are being saved elsewhere. Try again.'), { statusCode: 409 }));
  try {
    const next = change(readUserConfig(file));
    await atomicWrite(file, JSON.stringify(next, null, 2) + '\n');
    return next;
  } finally { await unlock(held); }
}
