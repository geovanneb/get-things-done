import { AsyncLocalStorage } from 'node:async_hooks';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { WorkspaceConfig } from '../types';
import { ScaffoldOptions, WorkspaceProfile, scaffoldWorkspace } from './scaffold';
import { quoteYaml, unquoteYaml } from '../utils/yamlScalar';
import { workspaceIconVersion } from './workspaceIcon';

const ESB_CONFIG_DIR = path.join(os.homedir(), '.gtd');
const ESB_CONFIG_FILE = path.join(ESB_CONFIG_DIR, 'config.json');
/** Pre-rename location, still read so an un-migrated install keeps working. */
const LEGACY_CONFIG_FILE = path.join(os.homedir(), '.esb', 'config.json');

/** How many workspaces the switcher remembers. */
const MAX_RECENT = 8;

// Keep an operation on one workspace across awaits, even if another request switches folders.
const operationWorkspace = new AsyncLocalStorage<{ path: string }>();

export function withWorkspacePath<T>(workspacePath: string, fn: () => T): T {
  return operationWorkspace.run({ path: workspacePath }, fn);
}

interface RecentEntry {
  path: string;
  last_opened: string;
}

interface EsbConfig {
  workspace_path?: string;
  /** Newest first. Lets the dashboard switch between workspaces in one click. */
  recent_workspaces?: RecentEntry[];
}

export interface RecentWorkspace {
  path: string;
  name: string;
  current: boolean;
  /** False when the folder is gone or no longer holds a workspace. */
  available: boolean;
  last_opened: string | null;
  /** Set when the workspace has a picture; changes with it. */
  icon_version: string | null;
}

function readConfigFile(): EsbConfig {
  if (!fs.existsSync(ESB_CONFIG_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(ESB_CONFIG_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function writeConfigFile(config: EsbConfig): void {
  fs.mkdirSync(ESB_CONFIG_DIR, { recursive: true });
  fs.writeFileSync(ESB_CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
}

function samePath(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b);
}

/** The `name:` line of a workspace.yaml, or null when there is none. */
function readWorkspaceName(workspacePath: string): string | null {
  try {
    const raw = fs.readFileSync(path.join(workspacePath, 'workspace.yaml'), 'utf-8');
    const line = raw.split('\n').find((l) => l.startsWith('name:'));
    return line ? unquoteYaml(line.replace('name:', '')) : null;
  } catch {
    return null;
  }
}

export class WorkspaceService {
  getWorkspacePath(): string {
    const scoped = operationWorkspace.getStore();
    if (scoped) return scoped.path;
    const envPath = process.env['ESB_WORKSPACE_PATH'];
    if (envPath) return envPath;

    for (const configFile of [ESB_CONFIG_FILE, LEGACY_CONFIG_FILE]) {
      if (!fs.existsSync(configFile)) continue;
      try {
        const config: EsbConfig = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
        if (config.workspace_path) return config.workspace_path;
      } catch {
        // Try the next candidate.
      }
    }

    throw new Error('Workspace path not configured. Run `gtd init`, or set the ESB_WORKSPACE_PATH env var.');
  }

  setWorkspacePath(workspacePath: string): void {
    const existing = readConfigFile();
    writeConfigFile({ ...existing, workspace_path: workspacePath, recent_workspaces: withRecent(existing.recent_workspaces, workspacePath) });

    const scoped = operationWorkspace.getStore();
    if (scoped) scoped.path = workspacePath;

    // `gtd start` passes the path via env, which would otherwise keep winning over the config file.
    if (process.env['ESB_WORKSPACE_PATH']) {
      process.env['ESB_WORKSPACE_PATH'] = workspacePath;
    }
  }

  /** Puts a workspace at the top of the recent list, e.g. the one `gtd start` opened. */
  rememberWorkspace(workspacePath: string): void {
    const existing = readConfigFile();
    writeConfigFile({ ...existing, recent_workspaces: withRecent(existing.recent_workspaces, workspacePath) });
  }

  /** The current workspace first, then the others most recently opened first. */
  listRecentWorkspaces(): RecentWorkspace[] {
    let current: string | null = null;
    try { current = this.getWorkspacePath(); } catch { /* not configured yet */ }
    const entries = readConfigFile().recent_workspaces ?? [];
    const list: RecentWorkspace[] = [];
    const describe = (p: string, lastOpened: string | null): RecentWorkspace => ({
      path: p,
      name: readWorkspaceName(p) ?? path.basename(p),
      current: current !== null && samePath(p, current),
      available: this.isExistingWorkspace(p),
      last_opened: lastOpened,
      icon_version: workspaceIconVersion(p),
    });
    if (current) list.push(describe(current, entries.find((e) => samePath(e.path, current!))?.last_opened ?? null));
    for (const e of entries) {
      if (typeof e?.path !== 'string' || list.some((w) => samePath(w.path, e.path))) continue;
      list.push(describe(e.path, e.last_opened ?? null));
    }
    return list;
  }

  /** Drops a workspace from the recent list. The folder itself is not touched. */
  forgetWorkspace(workspacePath: string): void {
    const existing = readConfigFile();
    const recent = (existing.recent_workspaces ?? []).filter((e) => !samePath(e.path, workspacePath));
    writeConfigFile({ ...existing, recent_workspaces: recent });
  }

  /** Expands a leading `~` and returns an absolute path. */
  resolveUserPath(input: string): string {
    const trimmed = input.trim();
    const expanded = trimmed === '~' || trimmed.startsWith('~/') || trimmed.startsWith('~\\')
      ? path.join(os.homedir(), trimmed.slice(1))
      : trimmed;
    return path.resolve(expanded);
  }

  isExistingWorkspace(workspacePath: string): boolean {
    return fs.existsSync(path.join(workspacePath, 'workspace.yaml'));
  }

  async initWorkspace(workspacePath: string, opts: Partial<ScaffoldOptions> = {}): Promise<void> {
    const profile: WorkspaceProfile = opts.profile ?? { name: '', role: '', organization: '' };

    scaffoldWorkspace(workspacePath, {
      profile,
      workspaceName: opts.workspaceName ?? 'Executive Workspace',
      aiTools: opts.aiTools ?? ['claude-code'],
    });

    this.setWorkspacePath(workspacePath);
  }

  getWorkspaceConfig(): WorkspaceConfig {
    const workspacePath = this.getWorkspacePath();
    const workspaceYamlPath = path.join(workspacePath, 'workspace.yaml');

    let name = 'Get Things Done';
    let git_enabled = false;
    const schema_versions: Record<string, string> = {};

    if (fs.existsSync(workspaceYamlPath)) {
      const raw = fs.readFileSync(workspaceYamlPath, 'utf-8');
      // Simple YAML parsing for known keys
      const lines = raw.split('\n');
      let inSchemaVersions = false;
      let inSettings = false;
      let inSettingsGit = false;
      for (const line of lines) {
        if (line.startsWith('name:')) {
          name = unquoteYaml(line.replace('name:', ''));
        } else if (line.startsWith('git_enabled:')) {
          git_enabled = line.includes('true');
        } else if (line.startsWith('settings:')) {
          inSettings = true;
          inSettingsGit = false;
        } else if (inSettings && line.match(/^\s+git:/)) {
          inSettingsGit = true;
        } else if (inSettingsGit && line.match(/^\s+enabled:/)) {
          git_enabled = line.includes('true');
          inSettingsGit = false;
        } else if (inSettings && !line.startsWith(' ')) {
          inSettings = false;
          inSettingsGit = false;
        } else if (line.startsWith('schema_versions:')) {
          inSchemaVersions = true;
        } else if (inSchemaVersions && line.startsWith('  ')) {
          const match = line.match(/^\s+(\w+):\s*["']?([^"'\n]+)["']?/);
          if (match) {
            schema_versions[match[1]] = match[2].trim();
          }
        } else if (inSchemaVersions && !line.startsWith(' ')) {
          inSchemaVersions = false;
        }
      }
    }

    return { path: workspacePath, name, git_enabled, schema_versions, icon_version: workspaceIconVersion(workspacePath) };
  }

  updateWorkspaceName(newName: string): void {
    const workspacePath = this.getWorkspacePath();
    const workspaceYamlPath = path.join(workspacePath, 'workspace.yaml');

    if (!fs.existsSync(workspaceYamlPath)) {
      throw new Error('workspace.yaml not found in workspace directory.');
    }

    const raw = fs.readFileSync(workspaceYamlPath, 'utf-8');
    const updated = raw.replace(/^name:\s*.+$/m, () => `name: ${quoteYaml(newName)}`);
    fs.writeFileSync(workspaceYamlPath, updated, 'utf-8');
  }

  async validateWorkspacePath(workspacePath: string): Promise<boolean> {
    try {
      const stat = fs.statSync(workspacePath);
      if (!stat.isDirectory()) return false;
      // Check write permission by trying to access
      fs.accessSync(workspacePath, fs.constants.W_OK);
      return true;
    } catch {
      return false;
    }
  }
}

function withRecent(recent: RecentEntry[] | undefined, workspacePath: string): RecentEntry[] {
  const others = (Array.isArray(recent) ? recent : []).filter((e) => typeof e?.path === 'string' && !samePath(e.path, workspacePath));
  return [{ path: workspacePath, last_opened: new Date().toISOString() }, ...others].slice(0, MAX_RECENT);
}
