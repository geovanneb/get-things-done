import * as fs from 'fs';
import * as path from 'path';
import { simpleGit, SimpleGit } from 'simple-git';
import { GitStatus, GitDiff } from '../types';
import { WorkspaceService } from './workspace';

const workspaceService = new WorkspaceService();

export class GitService {
  private getGit(): SimpleGit {
    const workspacePath = workspaceService.getWorkspacePath();
    return simpleGit(workspacePath);
  }

  async isGitRepo(): Promise<boolean> {
    const workspacePath = workspaceService.getWorkspacePath();
    return fs.existsSync(path.join(workspacePath, '.git'));
  }

  async getStatus(): Promise<GitStatus> {
    try {
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
      };
    }
  }

  async getDiff(filePath?: string): Promise<GitDiff> {
    const git = this.getGit();

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
    const git = this.getGit();
    const log = await git.log({ maxCount: limit });

    return (log.all || []).map((entry) => ({
      hash: entry.hash,
      author: entry.author_name,
      date: entry.date,
      message: entry.message,
    }));
  }

  async stageFile(filePath: string): Promise<void> {
    const git = this.getGit();
    await git.add(filePath);
  }

  async commit(message: string): Promise<void> {
    if (!message || message.trim().length === 0) {
      throw new Error('Commit message is required');
    }
    const git = this.getGit();
    // NEVER auto-push
    await git.commit(message);
  }
}
