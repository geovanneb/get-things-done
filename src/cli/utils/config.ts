import * as fs from 'fs';
import * as path from 'path';
import { ESB_CONFIG_FILE, getBundledScaffoldPath } from './paths';

interface EsbConfig {
  workspace_path?: string;
  port?: number;
}

export function readConfig(): EsbConfig {
  if (!fs.existsSync(ESB_CONFIG_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(ESB_CONFIG_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

/** Use the server's config boundary, like the shared scaffolder, including its cross-process lock. */
export async function writeConfig(config: EsbConfig): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { updateUserConfig } = require(path.join(path.dirname(getBundledScaffoldPath()), 'userConfig.js')) as {
    updateUserConfig(change: (current: Record<string, unknown>) => Record<string, unknown>): Promise<unknown>;
  };
  await updateUserConfig(current => ({ ...current, ...config }));
}

export function getWorkspacePath(): string | undefined {
  if (process.env['ESB_WORKSPACE_PATH']) return process.env['ESB_WORKSPACE_PATH'];
  return readConfig().workspace_path;
}

export function getPort(): number {
  return parseInt(process.env['PORT'] || String(readConfig().port || 3001), 10);
}
