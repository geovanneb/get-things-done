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
import { MentionService } from './mentionService';
import { orgChartService } from './orgChartService';
import { listFolderFiles } from '../utils/files';
import { checkOfficeFile } from '../utils/officeEncryption';

const taskService = new TaskService();
const stakeholderService = new StakeholderService();
const contextService = new ContextService();
const profileService = new ProfileService();
const outputService = new OutputService();
const fileService = new FileService();
const workspaceService = new WorkspaceService();
const mentionService = new MentionService();

/** Package file type for a mentioned path, matching the types used for the normal selection. */
function mentionType(href: string): string {
  if (href.startsWith('/stakeholders/')) return 'stakeholder';
  if (href.startsWith('/context/')) return 'context';
  if (href.startsWith('/outputs/')) return 'template';
  if (href.startsWith('/tasks/')) return 'task';
  return 'mention';
}

interface BuildOptions {
  includeStakeholders: boolean;
  includeContext: boolean;
  includeProfile: boolean;
  includeTemplate: boolean;
  selectedContextIds?: string[];
  selectedStakeholderRefs?: string[];
}

/** Folders whose other files the agent is told to load: the task's own folder, and a note's or template's folder. */
const OWN_FOLDER_FILES = new Set(['task.md', 'note.md', 'output.md']);

/**
 * Encrypted or broken Office files the agent would meet: the packaged files themselves and every file in the
 * folders of the task, context notes and template. Listed by path, so the agent can report them up front
 * instead of failing on them mid-task.
 */
async function unreadableFiles(files: ExecutionPackage['files']): Promise<NonNullable<ExecutionPackage['unreadable_files']>> {
  const found = new Map<string, NonNullable<ExecutionPackage['unreadable_files']>[number]>();
  for (const f of files) {
    const check = await checkOfficeFile(f.path);
    if (check) found.set(f.path, { path: f.path, check });
    if (!OWN_FOLDER_FILES.has(path.basename(f.path))) continue;
    const dir = path.dirname(f.path);
    for (const file of await listFolderFiles(dir)) {
      if (file.officeCheck) found.set(path.join(dir, file.name), { path: path.join(dir, file.name), check: file.officeCheck });
    }
  }
  return [...found.values()];
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

    // Files @-mentioned in the task's Objective: always included, on top of the normal selection.
    // A mention adds files; it never narrows what the options below would include.
    for (const m of mentionService.extractMentions(task.body)) {
      const abs = await mentionService.resolve(m.href);
      if (!abs) continue;
      const stats = await fileService.getFileStats(abs);
      files.push({ path: abs, type: mentionType(m.href), size: stats.size, hash: stats.hash, mentioned: true });
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

    // A file can be both mentioned and selected (or listed twice): keep the first occurrence.
    const seen = new Set<string>();
    const unique = files.filter((f) => (seen.has(f.path) ? false : (seen.add(f.path), true)));
    files.length = 0;
    files.push(...unique);

    const totalSize = files.reduce((sum, f) => sum + f.size, 0);
    const unreadable = await unreadableFiles(files);
    const pkg: ExecutionPackage = {
      id: uuidv4(),
      task_id: taskId,
      created_at: new Date().toISOString(),
      files,
      agent_ref: task.agent_ref,
      skills: task.skills || [],
      permissions: ['read', 'write'],
      command: '',
      total_size_bytes: totalSize,
      ...(unreadable.length > 0 && { unreadable_files: unreadable }),
    };

    pkg.command = this.generateCommand(pkg);
    return pkg;
  }

  async getPackagePreview(taskId: string): Promise<{ estimatedTokens: number; files: ExecutionPackage['files']; command: string; unreadable_files?: ExecutionPackage['unreadable_files'] }> {
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
      ...(pkg.unreadable_files && { unreadable_files: pkg.unreadable_files }),
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
