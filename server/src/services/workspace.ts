import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { WorkspaceConfig } from '../types';
import { ScaffoldOptions, WorkspaceProfile, scaffoldWorkspace } from './scaffold';

const ESB_CONFIG_DIR = path.join(os.homedir(), '.gtd');
const ESB_CONFIG_FILE = path.join(ESB_CONFIG_DIR, 'config.json');
/** Pre-rename location, still read so an un-migrated install keeps working. */
const LEGACY_CONFIG_FILE = path.join(os.homedir(), '.esb', 'config.json');

interface EsbConfig {
  workspace_path?: string;
}

export class WorkspaceService {
  getWorkspacePath(): string {
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
    if (!fs.existsSync(ESB_CONFIG_DIR)) {
      fs.mkdirSync(ESB_CONFIG_DIR, { recursive: true });
    }

    let existing: EsbConfig = {};
    if (fs.existsSync(ESB_CONFIG_FILE)) {
      try {
        existing = JSON.parse(fs.readFileSync(ESB_CONFIG_FILE, 'utf-8'));
      } catch {
        // ignore
      }
    }

    const updated: EsbConfig = { ...existing, workspace_path: workspacePath };
    fs.writeFileSync(ESB_CONFIG_FILE, JSON.stringify(updated, null, 2), 'utf-8');

    // `gtd start` passes the path via env, which would otherwise keep winning over the config file.
    if (process.env['ESB_WORKSPACE_PATH']) {
      process.env['ESB_WORKSPACE_PATH'] = workspacePath;
    }
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
          name = line.replace('name:', '').trim().replace(/^["']|["']$/g, '');
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

    return { path: workspacePath, name, git_enabled, schema_versions };
  }

  updateWorkspaceName(newName: string): void {
    const workspacePath = this.getWorkspacePath();
    const workspaceYamlPath = path.join(workspacePath, 'workspace.yaml');

    if (!fs.existsSync(workspaceYamlPath)) {
      throw new Error('workspace.yaml not found in workspace directory.');
    }

    const raw = fs.readFileSync(workspaceYamlPath, 'utf-8');
    const updated = raw.replace(/^name:\s*.+$/m, `name: "${newName}"`);
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
