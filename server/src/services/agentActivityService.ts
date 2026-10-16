import * as path from 'path';
import { WorkspaceService } from './workspace';
import { TaskService } from './taskService';
import { listExecutionFiles, summariseExecution, timestampFromFilename } from './executionLog';
import { Pile, pileFor } from './taskStatus';
import { Task } from '../types';

export type { Pile };

export interface ActivityDeliverable {
  id?: string;
  format?: string;
  status?: string;
  file_path?: string;
}

/** One task an agent is (or could be) working on. */
export interface ActivityTask {
  id: string;
  title: string;
  pile: Pile;
  status: string;
  priority: string;
  /** Agent handling the task, from `preferred_agent`. */
  agent?: string;
  task_type?: string;
  updated_at: string;
  created_at: string;
  due_date?: string;
  /** How many context notes the task pulls in — drives the bookshelf trips. */
  context_count: number;
  /** How many stakeholder files the agent has to read. */
  stakeholder_count: number;
  deliverables: ActivityDeliverable[];
  /** ISO timestamp of the newest execution log, when the task has one. */
  last_execution_at?: string;
  /** How many execution logs the task has accumulated (reruns and rework). */
  execution_count: number;
}

export interface AgentActivitySnapshot {
  generated_at: string;
  counts: Record<Pile, number>;
  tasks: ActivityTask[];
  /** Most recent execution logs across the whole workspace, newest first. */
  recent_executions: Array<{
    task_id: string;
    task_title: string;
    timestamp: string;
    summary: string;
  }>;
}

/** Count entries in a frontmatter field that may be a list of refs or strings. */
function countRefs(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  return 0;
}

export class AgentActivityService {
  private workspaceService = new WorkspaceService();
  private taskService = new TaskService();

  /**
   * Build the snapshot the Agent Floor animates. Everything here is read from
   * the workspace on disk — pile sizes, who is working on what, and the real
   * execution history. Nothing is invented.
   */
  async getSnapshot(): Promise<AgentActivitySnapshot> {
    const workspacePath = this.workspaceService.getWorkspacePath();
    const tasks = await this.taskService.listTasks();

    const counts: Record<Pile, number> = { backlog: 0, active: 0, review: 0, done: 0 };
    const activityTasks: ActivityTask[] = [];
    const recent: AgentActivitySnapshot['recent_executions'] = [];

    for (const task of tasks as Array<Task & Record<string, unknown>>) {
      const pile = pileFor(String(task.status));
      if (!pile) continue;
      counts[pile] += 1;

      const { files, dir } = await listExecutionFiles(workspacePath, task.id);
      const newest = files.length > 0 ? files[files.length - 1] : undefined;
      const lastExecutionAt = newest
        ? timestampFromFilename(newest, task.updated_at)
        : undefined;

      const deliverables = Array.isArray(task['deliverables'])
        ? (task['deliverables'] as unknown[]).filter(
            (d): d is ActivityDeliverable => typeof d === 'object' && d !== null,
          )
        : [];

      const entry: ActivityTask = {
        id: task.id,
        title: task.title,
        pile,
        status: String(task.status),
        priority: String(task.priority ?? 'medium'),
        task_type: typeof task['task_type'] === 'string' ? (task['task_type'] as string) : undefined,
        updated_at: task.updated_at,
        created_at: task.created_at,
        due_date: task.due_date,
        context_count: countRefs(task['contexts']),
        stakeholder_count:
          countRefs(task['stakeholders']) || countRefs(task['stakeholder_refs']),
        deliverables,
        execution_count: files.length,
      };
      if (typeof task['preferred_agent'] === 'string' && task['preferred_agent']) {
        entry.agent = task['preferred_agent'] as string;
      }
      if (lastExecutionAt) entry.last_execution_at = lastExecutionAt;
      activityTasks.push(entry);

      if (newest) {
        recent.push({
          task_id: task.id,
          task_title: task.title,
          timestamp: lastExecutionAt ?? task.updated_at,
          summary: await summariseExecution(path.join(dir, newest)),
        });
      }
    }

    recent.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

    return {
      generated_at: new Date().toISOString(),
      counts,
      tasks: activityTasks,
      recent_executions: recent.slice(0, 12),
    };
  }
}
