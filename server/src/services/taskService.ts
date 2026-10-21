import * as path from 'path';
import * as fsp from 'fs/promises';
import { Task, TaskStatus, Priority } from '../types';
import { DONE_STATUSES } from './taskStatus';
import { FileService } from './fileService';
import { WorkspaceService } from './workspace';

const fileService = new FileService();
const workspaceService = new WorkspaceService();

interface TaskFilters {
  status?: TaskStatus;
  priority?: Priority;
  tags?: string[];
  stakeholder_ref?: string;
  search?: string;
}

/**
 * Record when a task actually started and finished.
 *
 * Without these, everything downstream has to guess: Insights can only fall
 * back to `updated_at`, which means "last edited", not "finished". This is the
 * one choke point every status change from the UI passes through, so it is
 * where the real timestamps get written.
 *
 * An agent editing `task.md` directly bypasses this, which is why the workspace
 * rules also ask it to write `start_date` itself.
 */
function stampStatusDates(previousStatus: TaskStatus, updated: Task, now: string): void {
  const wasDone = DONE_STATUSES.has(previousStatus);
  const isNowDone = DONE_STATUSES.has(updated.status);

  if (isNowDone && !updated.done_date) {
    updated.done_date = now;
  } else if (wasDone && !isNowDone && updated.status !== 'archived') {
    // Genuinely reopened — the old completion date is no longer true.
    // Archiving is filing, not undoing, so it keeps its completion date.
    delete updated.done_date;
  }

  if (!updated.start_date && (updated.status === 'in_progress' || isNowDone)) {
    updated.start_date = now;
  }
}

export class TaskService {
  private getActiveDir(): string {
    return path.join(workspaceService.getWorkspacePath(), 'tasks', 'active');
  }

  private getArchiveDir(): string {
    return path.join(workspaceService.getWorkspacePath(), 'tasks', 'archive');
  }

  async listTasks(filters?: TaskFilters): Promise<Task[]> {
    const activeDir = this.getActiveDir();
    await fileService.ensureDir(activeDir);

    const entries = await fsp.readdir(activeDir, { withFileTypes: true }).catch(() => []);
    const tasks: Task[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const taskFile = path.join(activeDir, entry.name, 'task.md');
      if (!(await fileService.exists(taskFile))) continue;

      try {
        const { data, content } = await fileService.readMarkdown<Task>(taskFile);
        const rawData = data as Record<string, unknown>;
        const stakeholderObjs = Array.isArray(rawData['stakeholders'])
          ? (rawData['stakeholders'] as { ref?: string; role?: string; key?: boolean }[])
          : [];
        const task: Task = {
          ...data,
          id: data.id || entry.name,
          body: content || undefined,
          tags: data.tags || [],
          stakeholders: stakeholderObjs,
          stakeholder_refs: stakeholderObjs.length > 0
            ? stakeholderObjs.map((s) => s.ref ?? '').filter(Boolean)
            : (data.stakeholder_refs || []),
          skills: data.skills || [],
          deliverables: data.deliverables || [],
          dependencies: data.dependencies || [],
          path: taskFile,
        };

        if (filters) {
          if (filters.status && task.status !== filters.status) continue;
          if (filters.priority && task.priority !== filters.priority) continue;
          if (filters.tags && filters.tags.length > 0) {
            const hasTag = filters.tags.some((t) => task.tags.includes(t));
            if (!hasTag) continue;
          }
          if (filters.stakeholder_ref && !task.stakeholder_refs.includes(filters.stakeholder_ref)) continue;
          if (filters.search) {
            const q = filters.search.toLowerCase();
            const matches =
              task.title?.toLowerCase().includes(q) ||
              task.description?.toLowerCase().includes(q) ||
              task.objective?.toLowerCase().includes(q);
            if (!matches) continue;
          }
        }

        tasks.push(task);
      } catch {
        // Skip malformed task files
      }
    }

    return tasks.sort((a, b) => {
      const priorityOrder: Record<Priority, number> = { critical: 0, high: 1, medium: 2, low: 3 };
      return (priorityOrder[a.priority] ?? 4) - (priorityOrder[b.priority] ?? 4);
    });
  }

  async getTask(id: string): Promise<Task> {
    const taskFile = path.join(this.getActiveDir(), id, 'task.md');

    const buildTask = (data: Task, content: string, filePath: string): Task => {
      const raw = data as Record<string, unknown>;
      const stakeholderObjs = Array.isArray(raw['stakeholders'])
        ? (raw['stakeholders'] as { ref?: string; role?: string; key?: boolean }[])
        : [];
      return {
        ...data,
        id,
        body: content || undefined,
        tags: data.tags || [],
        stakeholders: stakeholderObjs,
        stakeholder_refs: stakeholderObjs.length > 0
          ? stakeholderObjs.map((s) => s.ref ?? '').filter(Boolean)
          : (data.stakeholder_refs || []),
        skills: data.skills || [],
        deliverables: data.deliverables || [],
        dependencies: data.dependencies || [],
        path: filePath,
      };
    };

    if (!(await fileService.exists(taskFile))) {
      const archiveFile = path.join(this.getArchiveDir(), id, 'task.md');
      if (!(await fileService.exists(archiveFile))) {
        throw new Error(`Task not found: ${id}`);
      }
      const { data, content } = await fileService.readMarkdown<Task>(archiveFile);
      return buildTask(data, content, archiveFile);
    }

    const { data, content } = await fileService.readMarkdown<Task>(taskFile);
    return buildTask(data, content, taskFile);
  }

  private async generateSlashCommand(): Promise<void> {
    const commandsDir = path.join(workspaceService.getWorkspacePath(), '.claude', 'commands');
    await fileService.ensureDir(commandsDir);
    const commandFile = path.join(commandsDir, 'gtd-task.md');
    if (await fsp.access(commandFile).then(() => true).catch(() => false)) return;
    const content = `---
description: Execute a task by ID (e.g. /gtd-task TASK-2026-0001)
---

Read and execute the task defined in: tasks/active/$ARGUMENTS/task.md

Follow all instructions in CLAUDE.md. Load the task file first, then load all referenced stakeholder files, the output template, and context notes. Load any files attached directly to the task folder.

Produce the deliverable as specified by the task's output template. When you start working, update the task status to \`in_progress\` and set \`preferred_agent\` to the agent doing the work, so the board can show who is on it. When complete, save the deliverable to the task's deliverables folder and update the task status to \`in_review\`. Never set the task status to \`done\` — only the user does that manually.

If the executive comes back with feedback on a task that is already \`in_review\`, set the status back to \`in_progress\` as your very first action, before editing anything, then back to \`in_review\` once the fix is saved. This applies to every correction, however small.
`;
    await fsp.writeFile(commandFile, content, 'utf-8');
  }

  async createTask(data: Partial<Task>): Promise<Task> {
    const id = await this.generateTaskId();
    const now = new Date().toISOString();
    const taskDir = path.join(this.getActiveDir(), id);

    await fileService.ensureDir(taskDir);
    await fileService.ensureDir(path.join(taskDir, 'attachments'));
    await fileService.ensureDir(path.join(taskDir, 'deliverables'));
    await fileService.ensureDir(path.join(taskDir, 'executions'));
    await fileService.ensureDir(path.join(taskDir, 'notes'));

    const rawData = data as Record<string, unknown>;
    const incomingStakeholders = Array.isArray(rawData['stakeholders'])
      ? (rawData['stakeholders'] as { ref: string; role: string; key?: boolean }[])
      : [];

    const task: Task = {
      id,
      title: data.title || 'Untitled Task',
      status: data.status || 'backlog',
      priority: data.priority || 'medium',
      due_date: data.due_date,
      start_date: data.start_date,
      done_date: data.done_date,
      tags: data.tags || [],
      stakeholders: incomingStakeholders,
      stakeholder_refs: incomingStakeholders.map((s) => s.ref).filter(Boolean),
      template_ref: data.template_ref,
      agent_ref: data.agent_ref,
      skills: data.skills || [],
      description: data.description,
      objective: data.objective,
      deliverables: data.deliverables || [],
      dependencies: data.dependencies || [],
      created_at: now,
      updated_at: now,
    };

    const { path: _path, body: _body, ...fields } = task;
    // .schemas/task.schema.json requires schema_version and type; write them like every other
    // workspace file so tasks created from the board validate against the workspace schema.
    const frontmatter = { schema_version: '1.0', type: 'task', ...fields };
    const content = typeof data.body === 'string' ? data.body : (data.description || '');
    await fileService.writeMarkdown(path.join(taskDir, 'task.md'), frontmatter as Record<string, unknown>, content);
    const created = { ...task, path: path.join(taskDir, 'task.md') };
    await this.generateSlashCommand();
    return created;
  }

  async updateTask(id: string, data: Partial<Task>): Promise<Task> {
    const existing = await this.getTask(id);
    const taskFile = path.join(this.getActiveDir(), id, 'task.md');
    const { content: existingContent } = await fileService.readMarkdown<Task>(taskFile);

    const now = new Date().toISOString();
    const updated: Task = {
      ...existing,
      ...data,
      id,
      updated_at: now,
    };

    stampStatusDates(existing.status, updated, now);

    // body is the markdown content — keep it out of frontmatter
    const { path: _path, body: newBody, ...frontmatter } = updated;
    const content = typeof newBody === 'string' ? newBody : existingContent;
    await fileService.writeMarkdown(taskFile, frontmatter as Record<string, unknown>, content);
    const savedTask = { ...updated, path: taskFile };
    await this.generateSlashCommand();
    return savedTask;
  }

  async deleteTask(id: string): Promise<void> {
    const taskDir = path.join(this.getActiveDir(), id);
    if (!(await fileService.exists(taskDir))) {
      throw new Error(`Task not found: ${id}`);
    }
    await fsp.rm(taskDir, { recursive: true, force: true });
  }

  async archiveTask(id: string): Promise<void> {
    const activeDir = path.join(this.getActiveDir(), id);
    const archiveDir = path.join(this.getArchiveDir(), id);

    if (!(await fileService.exists(activeDir))) {
      throw new Error(`Task not found: ${id}`);
    }

    await fileService.ensureDir(this.getArchiveDir());
    await fsp.rename(activeDir, archiveDir);

    // Update status to archived
    const taskFile = path.join(archiveDir, 'task.md');
    const { data, content } = await fileService.readMarkdown<Task>(taskFile);
    data.status = 'archived';
    data.updated_at = new Date().toISOString();
    await fileService.writeMarkdown(taskFile, data as unknown as Record<string, unknown>, content);
  }

  async getTaskContent(id: string): Promise<string> {
    const taskFile = path.join(this.getActiveDir(), id, 'task.md');
    if (!(await fileService.exists(taskFile))) {
      throw new Error(`Task not found: ${id}`);
    }
    const { content } = await fileService.readMarkdown<Task>(taskFile);
    return content;
  }

  async updateTaskContent(id: string, content: string): Promise<void> {
    const taskFile = path.join(this.getActiveDir(), id, 'task.md');
    if (!(await fileService.exists(taskFile))) {
      throw new Error(`Task not found: ${id}`);
    }
    const { data } = await fileService.readMarkdown<Task>(taskFile);
    data.updated_at = new Date().toISOString();
    await fileService.writeMarkdown(taskFile, data as unknown as Record<string, unknown>, content);
  }

  private async generateTaskId(): Promise<string> {
    const year = new Date().getFullYear();
    const activeDir = this.getActiveDir();
    await fileService.ensureDir(activeDir);

    const entries = await fsp.readdir(activeDir).catch(() => []);
    const prefix = `TASK-${year}-`;

    let maxSeq = 0;
    for (const entry of entries) {
      if (entry.startsWith(prefix)) {
        const seq = parseInt(entry.substring(prefix.length), 10);
        if (!isNaN(seq) && seq > maxSeq) maxSeq = seq;
      }
    }

    // Also check archive
    const archiveDir = this.getArchiveDir();
    const archiveEntries = await fsp.readdir(archiveDir).catch(() => []);
    for (const entry of archiveEntries) {
      if (entry.startsWith(prefix)) {
        const seq = parseInt(entry.substring(prefix.length), 10);
        if (!isNaN(seq) && seq > maxSeq) maxSeq = seq;
      }
    }

    const nextSeq = String(maxSeq + 1).padStart(4, '0');
    return `${prefix}${nextSeq}`;
  }

  async listTaskFiles(id: string): Promise<Array<{ name: string; size: number; modified: string; type: string }>> {
    const taskDir = path.join(this.getActiveDir(), id);
    if (!(await fileService.exists(taskDir))) throw new Error(`Task not found: ${id}`);

    const entries = await fsp.readdir(taskDir, { withFileTypes: true });
    const results = [];
    for (const entry of entries) {
      if (!entry.isFile() || entry.name === 'task.md') continue;
      const filePath = path.join(taskDir, entry.name);
      const stat = await fsp.stat(filePath);
      results.push({
        name: entry.name,
        size: stat.size,
        modified: stat.mtime.toISOString(),
        type: path.extname(entry.name).slice(1).toLowerCase() || 'file',
      });
    }
    return results.sort((a, b) => b.modified.localeCompare(a.modified));
  }

  async saveTaskFile(id: string, originalName: string, buffer: Buffer): Promise<{ name: string; size: number; modified: string; type: string }> {
    const taskDir = path.join(this.getActiveDir(), id);
    if (!(await fileService.exists(taskDir))) throw new Error(`Task not found: ${id}`);

    const safe = path.basename(originalName).replace(/[^\w.\-]/g, '_');
    const filePath = path.join(taskDir, safe);
    await fsp.writeFile(filePath, buffer);
    const stat = await fsp.stat(filePath);
    return { name: safe, size: stat.size, modified: stat.mtime.toISOString(), type: path.extname(safe).slice(1).toLowerCase() || 'file' };
  }

  async deleteTaskFile(id: string, filename: string): Promise<void> {
    const safe = path.basename(filename);
    if (safe === 'task.md') throw new Error('Cannot delete task.md');
    const filePath = path.join(this.getActiveDir(), id, safe);
    await fsp.unlink(filePath);
  }
}
