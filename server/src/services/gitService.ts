import * as fs from 'fs';
import * as path from 'path';
import { simpleGit, SimpleGit } from 'simple-git';
// simple-git's own list of guarded variables (GIT_*, EDITOR, PAGER, SSH_ASKPASS...). Same version simple-git pins.
import { isGitEnvKey, vulnerabilityCheck } from '@simple-git/argv-parser';
import { GitStatus, GitDiff } from '../types';
import { WorkspaceService } from './workspace';

const workspaceService = new WorkspaceService();

/** Thrown when the workspace uses git but no git program is installed. Routes answer it with 503. */
export class GitUnavailableError extends Error {
  readonly statusCode = 503;
  constructor() {
    super('Git is not installed on this computer. Install git to see changes and commit from the dashboard.');
    this.name = 'GitUnavailableError';
  }
}

// Installing git while the server runs is rare, so a found git is remembered, but a missing one is checked again
// after a minute instead of until restart.
const RECHECK_MISSING_MS = 60_000;
let installedCheck: { installed: boolean; checkedAt: number } | null = null;

/** A git program supplied by the host, for example the portable git bundled in the desktop app. */
export interface GitRuntime {
  /** Absolute path of the git executable. */
  binary: string;
  /** Variables that program needs (GIT_EXEC_PATH and similar). Added on top of the process environment. */
  env?: Record<string, string>;
}

let runtime: GitRuntime | null = null;

/** Use this git instead of the `git` on PATH; null goes back to PATH. Set by the host at startup, never per request. */
export function useGitRuntime(next: GitRuntime | null): void {
  runtime = next;
  installedCheck = null;
}

function createGit(baseDir?: string): SimpleGit {
  if (!runtime) return baseDir ? simpleGit(baseDir) : simpleGit();
  const env = runtime.env ?? {};
  // simple-git refuses variables such as GIT_EXEC_PATH unless their category is allowed. Allow exactly the
  // categories the host's own variables need (as simple-git classifies them), nothing more.
  const hostCategories = Object.fromEntries([...vulnerabilityCheck([], env)].map((issue) => [issue.category, true]));
  const git = simpleGit({
    ...(baseDir ? { baseDir } : {}),
    binary: runtime.binary,
    // Installed apps live in paths with spaces ("Get Things Done.app"), which simple-git refuses by default.
    // Safe here: the path and the variables come from the host, not from a request.
    unsafe: { ...hostCategories, allowUnsafeCustomBinary: true },
    // simple-git drops GIT_* variables unless they are named here; the bundled git needs its own.
    allowEnvironment: Object.keys(env),
  });
  if (!Object.keys(env).length) return git;
  // Passing an environment makes every variable in it explicit, and simple-git refuses explicit guarded ones.
  // Without an environment it silently drops the inherited ones (an editor's GIT_EDITOR, EDITOR...), so do the same.
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !isGitEnvKey(key.toLowerCase().trim())),
  );
  return git.env({ ...inherited, ...env });
}

export class GitService {
  private getGit(): SimpleGit {
    const workspacePath = workspaceService.getWorkspacePath();
    return createGit(workspacePath);
  }

  /** Whether a git program can be run. Git is optional: the dashboard works without it. */
  async isInstalled(): Promise<boolean> {
    if (installedCheck && (installedCheck.installed || Date.now() - installedCheck.checkedAt < RECHECK_MISSING_MS)) {
      return installedCheck.installed;
    }
    let installed: boolean;
    try {
      installed = (await createGit().version()).installed;
    } catch {
      installed = false;
    }
    installedCheck = { installed, checkedAt: Date.now() };
    return installed;
  }

  /** The workspace has a `.git` folder, whether or not git is installed. */
  hasRepository(): boolean {
    const workspacePath = workspaceService.getWorkspacePath();
    return fs.existsSync(path.join(workspacePath, '.git'));
  }

  /** Git features are usable: the workspace is a repository and git is installed. */
  async isGitRepo(): Promise<boolean> {
    return this.hasRepository() && (await this.isInstalled());
  }

  private async requireGit(): Promise<SimpleGit> {
    if (!(await this.isInstalled())) throw new GitUnavailableError();
    return this.getGit();
  }

  async getStatus(): Promise<GitStatus> {
    const installed = await this.isInstalled();
    try {
      if (!installed) throw new GitUnavailableError();
      const git = this.getGit();
      const status = await git.status();
      return {
        branch: status.current || 'unknown',
        modified: status.modified,
        staged: status.staged,
        untracked: status.not_added,
        ahead: status.ahead,
        behind: status.behind,
        is_clean: status.isClean(),
        is_repo: true,
        git_installed: true,
      };
    } catch {
      return {
        branch: '',
        modified: [],
        staged: [],
        untracked: [],
        ahead: 0,
        behind: 0,
        is_clean: true,
        is_repo: false,
        git_installed: installed,
      };
    }
  }

  async getDiff(filePath?: string): Promise<GitDiff> {
    const git = await this.requireGit();

    let diffOutput: string;
    if (filePath) {
      diffOutput = await git.diff(['--', filePath]);
    } else {
      diffOutput = await git.diff();
    }

    // Parse stats from diff
    const insertions = (diffOutput.match(/\+{1}(?!\+)/g) || []).length;
    const deletions = (diffOutput.match(/-{1}(?!-)/g) || []).length;
    const fileMatches = diffOutput.match(/^diff --git/gm) || [];

    return {
      files: fileMatches.map((_, i) => {
        const match = diffOutput.match(new RegExp(`diff --git a/(\\S+)`));
        return match ? match[1] : `file_${i}`;
      }),
      diff: diffOutput,
      stats: {
        insertions,
        deletions,
        files_changed: fileMatches.length,
      },
    };
  }

  async getLog(limit = 20): Promise<{ hash: string; author: string; date: string; message: string }[]> {
    const git = await this.requireGit();
    const log = await git.log({ maxCount: limit });

    return (log.all || []).map((entry) => ({
      hash: entry.hash,
      author: entry.author_name,
      date: entry.date,
      message: entry.message,
    }));
  }

  async stageFile(filePath: string): Promise<void> {
    const git = await this.requireGit();
    // `--` so a file name is never read as an option.
    await git.raw(['add', '--', filePath]);
  }

  async commit(message: string): Promise<void> {
    if (!message || message.trim().length === 0) {
      throw new Error('Commit message is required');
    }
    const git = await this.requireGit();
    // NEVER auto-push
    await git.commit(message);
  }
}
