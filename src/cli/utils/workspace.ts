import { getBundledScaffoldPath } from './paths';

/**
 * Bridge to the shared scaffolder.
 *
 * The real implementation lives in the server tree (`server/src/services/scaffold.ts`)
 * so that `gtd init` and `POST /api/workspace/init` cannot drift apart. The CLI and
 * the server are separate TypeScript projects, so it is loaded from its compiled
 * output at runtime rather than imported across project roots.
 */

export interface WorkspaceProfile {
  name: string;
  role: string;
  organization: string;
  [key: string]: string;
}

export type AiTool = 'claude-code' | 'copilot' | 'codex';

export interface ScaffoldOptions {
  profile: WorkspaceProfile;
  workspaceName?: string;
  aiTools?: AiTool[];
}

export interface ScaffoldResult {
  created: string[];
  skipped: string[];
}

export interface UpgradeResult {
  updated: string[];
  added: string[];
  conflicted: string[];
  unchanged: string[];
  removed?: string[];
  retired_kept?: string[];
  fromVersion: string | null;
  toVersion: string;
}

interface ScaffoldModule {
  isExistingWorkspace(dir: string): boolean;
  scaffoldWorkspace(workspacePath: string, opts: ScaffoldOptions): ScaffoldResult;
  upgradeWorkspace(workspacePath: string, opts: ScaffoldOptions): UpgradeResult;
  getAppVersion(): string;
}

let cached: ScaffoldModule | null = null;

function load(): ScaffoldModule {
  if (cached) return cached;

  const scaffoldPath = getBundledScaffoldPath();
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    cached = require(scaffoldPath) as ScaffoldModule;
  } catch (err) {
    throw new Error(
      `Could not load the workspace scaffolder from ${scaffoldPath}. ` +
        `The installation may be incomplete — try reinstalling the package.\n` +
        (err instanceof Error ? err.message : String(err)),
      { cause: err }
    );
  }
  return cached;
}

export function isExistingWorkspace(dir: string): boolean {
  return load().isExistingWorkspace(dir);
}

export function scaffoldWorkspace(workspacePath: string, opts: ScaffoldOptions): ScaffoldResult {
  return load().scaffoldWorkspace(workspacePath, opts);
}

export function upgradeWorkspace(workspacePath: string, opts: ScaffoldOptions): UpgradeResult {
  return load().upgradeWorkspace(workspacePath, opts);
}

export function getAppVersion(): string {
  return load().getAppVersion();
}
