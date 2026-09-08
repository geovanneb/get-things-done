import * as fs from 'fs';
import { ESB_DIR, ESB_CONFIG_FILE } from './paths';

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

export function writeConfig(config: EsbConfig): void {
  if (!fs.existsSync(ESB_DIR)) {
    fs.mkdirSync(ESB_DIR, { recursive: true });
  }
  const existing = readConfig();
  fs.writeFileSync(ESB_CONFIG_FILE, JSON.stringify({ ...existing, ...config }, null, 2), 'utf-8');
}

export function getWorkspacePath(): string | undefined {
  if (process.env['ESB_WORKSPACE_PATH']) return process.env['ESB_WORKSPACE_PATH'];
  return readConfig().workspace_path;
}

export function getPort(): number {
  return parseInt(process.env['PORT'] || String(readConfig().port || 3001), 10);
}
