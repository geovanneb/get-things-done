import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export const ESB_DIR = path.join(os.homedir(), '.gtd');
export const ESB_CONFIG_FILE = path.join(ESB_DIR, 'config.json');
export const ESB_PID_FILE = path.join(ESB_DIR, 'gtd.pid');

/** Config location used before the project was renamed to Get Things Done. */
const LEGACY_DIR = path.join(os.homedir(), '.esb');

/**
 * Moves an existing `~/.esb` config into `~/.gtd` once, so upgrading users keep
 * their configured workspace without re-running init.
 */
export function migrateLegacyConfig(): void {
  const legacyConfig = path.join(LEGACY_DIR, 'config.json');
  if (fs.existsSync(ESB_CONFIG_FILE) || !fs.existsSync(legacyConfig)) return;

  try {
    fs.mkdirSync(ESB_DIR, { recursive: true });
    fs.copyFileSync(legacyConfig, ESB_CONFIG_FILE);
  } catch {
    // Not fatal — the user can re-point with `gtd use <path>`.
  }
}

export function getPackageRoot(): string {
  return path.resolve(__dirname, '../../..');
}

export function getBundledServerPath(): string {
  return path.join(getPackageRoot(), 'dist', 'server', 'index.js');
}

export function getBundledUiPath(): string {
  return path.join(getPackageRoot(), 'dist', 'ui');
}

export function getTemplatesPath(): string {
  return path.join(getPackageRoot(), 'templates');
}

export function getBundledScaffoldPath(): string {
  return path.join(getPackageRoot(), 'dist', 'server', 'services', 'scaffold.js');
}
