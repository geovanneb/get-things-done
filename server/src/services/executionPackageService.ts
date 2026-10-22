import * as path from 'path';
import * as fsp from 'fs/promises';
import { v4 as uuidv4 } from 'uuid';
import { ExecutionPackage } from '../types';
import { TaskService } from './taskService';
import { StakeholderService } from './stakeholderService';
import { ContextService } from './contextService';
import { ProfileService } from './profileService';
import { OutputService } from './outputService';
import { FileService } from './fileService';
import { WorkspaceService } from './workspace';
import { orgChartService } from './orgChartService';
import { extractMentionPaths, mentionService, mentionTypeForPath } from './mentionService';

const taskService = new TaskService();
const stakeholderService = new StakeholderService();
const contextService = new ContextService();
const profileService = new ProfileService();
const outputService = new OutputService();
const fileService = new FileService();
const workspaceService = new WorkspaceService();

interface BuildOptions {
  includeStakeholders: boolean;
  includeContext: boolean;
  includeProfile: boolean;
  includeTemplate: boolean;
  selectedContextIds?: string[];
  selectedStakeholderRefs?: string[];
}

export class ExecutionPackageService {
  async buildPackage(taskId: string, options: BuildOptions): Promise<ExecutionPackage> {
    const task = await taskService.getTask(taskId);
    const files: ExecutionPackage['files'] = [];

    // Add task file
    if (task.path) {
      const stats = await fileService.getFileStats(task.path);
      files.push({ path: task.path, type: 'task', size: stats.size, hash: stats.hash });
    }

    // Explicit @mentions are always included, on top of (never instead of) the options below.
    for (const relPath of extractMentionPaths(task.body)) {
      const absPath = mentionService.resolveMentionPath(relPath);
      if (!absPath || absPath === task.path || !(await fileService.exists(absPath))) continue;
      const stats = await fileService.getFileStats(absPath);
      files.push({ path: absPath, type: mentionTypeForPath(relPath) ?? 'file', size: stats.size, hash: stats.hash, mentioned: true });
    }

    // Add stakeholders
    if (options.includeStakeholders) {
      const refs = options.selectedStakeholderRefs || task.stakeholder_refs || [];
      for (const ref of refs) {
        try {
          const stk = await stakeholderService.getStakeholder(ref);
          if (stk.path) {
            const stats = await fileService.getFileStats(stk.path);
            files.push({ path: stk.path, type: 'stakeholder', size: stats.size, hash: stats.hash });
          }
        } catch {
          // Stakeholder not found, skip
        }
      }

      // Org charts give the reporting lines around the audience.
      const refSet = new Set(refs);
      for (const chart of await orgChartService.listCharts()) {
        if (!chart.path || !chart.members.some((m) => refSet.has(m.ref))) continue;
        const stats = await fileService.getFileStats(chart.path);
        files.push({ path: chart.path, type: 'org_chart', size: stats.size, hash: stats.hash });
      }
    }

    // Add context notes
    if (options.includeContext) {
      const ctxIds = options.selectedContextIds;
      if (ctxIds && ctxIds.length > 0) {
        for (const id of ctxIds) {
          try {
            const note = await contextService.getContextNote(id);
            if (note.path) {
              const stats = await fileService.getFileStats(note.path);
              files.push({ path: note.path, type: 'context', size: stats.size, hash: stats.hash });
            }
          } catch {
            // Context note not found, skip
          }
        }
      } else {
        // Include all context notes
        const notes = await contextService.listContextNotes();
        for (const note of notes) {
          if (note.path) {
            try {
              const stats = await fileService.getFileStats(note.path);
              files.push({ path: note.path, type: 'context', size: stats.size, hash: stats.hash });
            } catch {
              // Skip
            }
          }
        }
      }
    }

    // Add profile
    if (options.includeProfile) {
      const workspacePath = workspaceService.getWorkspacePath();
      const profilePath = path.join(workspacePath, 'profile', 'executive-profile.md');
      if (await fileService.exists(profilePath)) {
        const stats = await fileService.getFileStats(profilePath);
        files.push({ path: profilePath, type: 'profile', size: stats.size, hash: stats.hash });
      }
    }

    // Add output template
    if (options.includeTemplate && task.template_ref) {
      try {
        const template = await outputService.getTemplate(task.template_ref);
        if (template.path) {
          const stats = await fileService.getFileStats(template.path);
          files.push({ path: template.path, type: 'template', size: stats.size, hash: stats.hash });
        }
      } catch {
        // Template not found, skip
      }
    }

    // A mentioned file can also be picked up by the options above; keep the first (mentioned) entry.
    const seen = new Set<string>();
    const uniqueFiles = files.filter((f) => (seen.has(f.path) ? false : (seen.add(f.path), true)));

    const totalSize = uniqueFiles.reduce((sum, f) => sum + f.size, 0);
    const pkg: ExecutionPackage = {
      id: uuidv4(),
      task_id: taskId,
      created_at: new Date().toISOString(),
      files: uniqueFiles,
      agent_ref: task.agent_ref,
      skills: task.skills || [],
      permissions: ['read', 'write'],
      command: '',
      total_size_bytes: totalSize,
    };

    pkg.command = this.generateCommand(pkg);
    return pkg;
  }

  async getPackagePreview(taskId: string): Promise<{ estimatedTokens: number; files: { path: string; type: string; size: number; hash: string }[]; command: string }> {
    const pkg = await this.buildPackage(taskId, {
      includeStakeholders: true,
      includeContext: true,
      includeProfile: true,
      includeTemplate: true,
    });

    // Rough token estimate: ~4 chars per token
    const estimatedTokens = Math.round(pkg.total_size_bytes / 4);

    return {
      estimatedTokens,
      files: pkg.files,
      command: pkg.command,
    };
  }

  generateCommand(pkg: ExecutionPackage): string {
    const contextFlags = pkg.files.map((f) => `--context "${f.path}"`).join(' \\\n  ');
    const agentFlag = pkg.agent_ref ? `--agent "${pkg.agent_ref}"` : '';
    const skillsFlag = pkg.skills.length > 0 ? pkg.skills.map((s) => `--skill "${s}"`).join(' ') : '';

    const parts = ['claude', agentFlag, skillsFlag, contextFlags].filter(Boolean);
    return parts.join(' \\\n  ');
  }

  async savePackage(pkg: ExecutionPackage): Promise<string> {
    const workspacePath = workspaceService.getWorkspacePath();
    const executionsDir = path.join(workspacePath, 'tasks', 'active', pkg.task_id, 'executions');
    await fileService.ensureDir(executionsDir);

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filePath = path.join(executionsDir, `${timestamp}.json`);
    await fsp.writeFile(filePath, JSON.stringify(pkg, null, 2), 'utf-8');
    return filePath;
  }
}
