import * as fsp from 'fs/promises';
import * as path from 'path';
import { parseMarkdown } from '../utils/markdown';
import { SituationData, AttentionItem, Task, Priority, TaskStatus } from '../types';
import { TaskService } from './taskService';
import { calendarDaysUntil, endOfDay } from './insightsService';
import { WorkspaceService } from './workspace';

const taskService = new TaskService();
const workspaceService = new WorkspaceService();

const PRIORITY_ORDER: Record<Priority, number> = { critical: 0, high: 1, medium: 2, low: 3 };

const CLOSED_STATUSES = new Set<TaskStatus>(['done', 'approved', 'archived']);

const isOpen = (t: Task) => !CLOSED_STATUSES.has(t.status);

/**
 * The end of the due day, the same way Insights reads it (#1): a task due today is
 * not overdue until the day is over. `new Date('2026-11-10')` is UTC midnight, which
 * made it overdue from 09:00 in Tokyo and from the evening before in New York.
 */
const dueAt = (t: Task): Date | null => (typeof t.due_date === 'string' ? endOfDay(t.due_date) : null);

/** Due within `days` calendar days and not overdue; today counts as 0. */
const dueWithin = (t: Task, now: Date, days: number): boolean => {
  const due = dueAt(t);
  return due !== null && due >= now && calendarDaysUntil(due, now) <= days;
};

export class SituationService {
  async getSituationData(): Promise<SituationData> {
    const now = new Date();

    let tasks: Task[] = [];
    try {
      tasks = await taskService.listTasks();
    } catch {
      // Return empty data if workspace not configured
    }

    const activeTasks = tasks.filter((t) => t.status !== 'archived');
    const openTasks = tasks.filter(isOpen);

    // Compute metrics
    const overdueTasks = openTasks.filter((t) => {
      const due = dueAt(t);
      return due !== null && due < now;
    });

    const dueSoonTasks = openTasks.filter((t) => dueWithin(t, now, 7));

    const blockedTasks = activeTasks.filter((t) => t.status === 'blocked');
    const inProgressTasks = activeTasks.filter((t) => t.status === 'in_progress');

    // Build attention queue (max 7 items)
    const attentionCandidates: AttentionItem[] = [];

    for (const t of overdueTasks) {
      attentionCandidates.push({ id: t.id, title: t.title, status: t.status, priority: t.priority, due_date: t.due_date, flag_type: 'overdue' });
    }
    // A follow-up date that has come (#82): the user said they would chase it by then. Not the task's due date.
    const nowDay = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    for (const t of openTasks) {
      const w = (t as unknown as { waiting?: { for?: unknown; follow_up?: unknown; since?: unknown } }).waiting;
      if (!w || typeof w.for !== 'string' || typeof w.follow_up !== 'string' || w.follow_up > nowDay) continue;
      const waiting = { for: w.for, follow_up: w.follow_up, since: typeof w.since === 'string' ? w.since : '' };
      // Already listed (overdue): it keeps that badge and also says what needs chasing.
      const listed = attentionCandidates.find((a) => a.id === t.id);
      if (listed) { listed.waiting = waiting; continue; }
      attentionCandidates.push({ id: t.id, title: t.title, status: t.status, priority: t.priority, due_date: t.due_date, flag_type: 'follow_up', waiting: { for: w.for, follow_up: w.follow_up, since: typeof w.since === 'string' ? w.since : '' } });
    }
    for (const t of blockedTasks) {
      if (!attentionCandidates.find((a) => a.id === t.id)) {
        attentionCandidates.push({ id: t.id, title: t.title, status: t.status, priority: t.priority, due_date: t.due_date, flag_type: 'blocked' });
      }
    }
    for (const t of dueSoonTasks) {
      if (!attentionCandidates.find((a) => a.id === t.id)) {
        attentionCandidates.push({ id: t.id, title: t.title, status: t.status, priority: t.priority, due_date: t.due_date, flag_type: 'due_soon' });
      }
    }
    // High priority items (open tasks only)
    for (const t of openTasks.filter((t) => t.priority === 'critical' || t.priority === 'high')) {
      if (!attentionCandidates.find((a) => a.id === t.id)) {
        attentionCandidates.push({ id: t.id, title: t.title, status: t.status, priority: t.priority, due_date: t.due_date, flag_type: 'high_priority' });
      }
    }

    const attentionQueue = attentionCandidates
      .sort((a, b) => {
        const flagOrder: Record<string, number> = { overdue: 0, follow_up: 1, blocked: 2, due_soon: 3, high_priority: 4 };
        const flagDiff = (flagOrder[a.flag_type] ?? 4) - (flagOrder[b.flag_type] ?? 4);
        if (flagDiff !== 0) return flagDiff;
        return PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
      })
      .slice(0, 7)
      .map((item) => ({
        id: item.id,
        title: item.title,
        slug: item.id,
        reason: item.flag_type as 'overdue' | 'follow_up' | 'blocked' | 'due_soon',
        ...(item.waiting ? { waiting: item.waiting } : {}),
        due_date: item.due_date,
        stakeholders: tasks.find((t) => t.id === item.id)?.stakeholder_refs ?? [],
        priority: item.priority,
      }));

    // Current focus (in_progress, max 3)
    const currentFocus = inProgressTasks
      .sort((a, b) => {
        const aDue = dueAt(a);
        const bDue = dueAt(b);
        if (aDue && bDue) return aDue.getTime() - bDue.getTime();
        if (aDue) return -1;
        if (bDue) return 1;
        return 0;
      })
      .slice(0, 3)
      .map((t) => ({
        id: t.id,
        title: t.title,
        slug: t.id,
        priority: t.priority,
        due_date: t.due_date,
        stakeholders: t.stakeholder_refs ?? [],
        deliverables: (t.deliverables as unknown[]).map((d) => ({
          format: typeof d === 'object' && d !== null && 'format' in d ? (d as Record<string, unknown>)['format'] as string : String(d),
        })),
        progress: this.estimateProgress(t),
        created_at: t.created_at,
      }));

    // Upcoming commitments (next 14 days)
    const upcomingCommitments = openTasks
      .filter((t) => dueWithin(t, now, 14))
      .sort((a, b) => dueAt(a)!.getTime() - dueAt(b)!.getTime())
      .map((t) => ({
        id: t.id,
        title: t.title,
        slug: t.id,
        due_date: t.due_date!,
        stakeholders: t.stakeholder_refs ?? [],
        task_type: typeof t['task_type'] === 'string' ? t['task_type'] : 'ad_hoc',
      }));

    // Status counts
    const statusCounts: Record<TaskStatus, number> = { backlog: 0, ready: 0, in_progress: 0, blocked: 0, review: 0, done: 0, in_review: 0, approved: 0, archived: 0 };
    for (const t of tasks) {
      statusCounts[t.status] = (statusCounts[t.status] || 0) + 1;
    }

    // Cycle time (completed tasks with start + done dates)
    const cycleTimeData = tasks
      .filter((t) => t.status === 'done' && t.start_date && t.done_date)
      .map((t) => ({
        title: t.title,
        days: Math.round((new Date(t.done_date!).getTime() - new Date(t.start_date!).getTime()) / (24 * 60 * 60 * 1000)),
        priority: t.priority,
      }));

    // Recent activity
    const recentActivity = await this.getRecentActivity();

    return {
      overdue_count: overdueTasks.length,
      due_soon_count: dueSoonTasks.length,
      blocked_count: blockedTasks.length,
      in_progress_count: inProgressTasks.length,
      attention_queue: attentionQueue,
      current_focus: currentFocus,
      upcoming_commitments: upcomingCommitments,
      workflow_snapshot: {
        by_status: statusCounts,
        cycle_time_data: cycleTimeData,
      },
      recent_activity: recentActivity,
    };
  }

  private estimateProgress(task: Task): number {
    if (task.status === 'done') return 100;
    if (task.status === 'backlog' || task.status === 'ready') return 0;
    if (task.status === 'in_progress') {
      if (!task.start_date || !task.due_date) return 50;
      const start = new Date(task.start_date).getTime();
      const due = new Date(task.due_date).getTime();
      const now = Date.now();
      const progress = Math.round(((now - start) / (due - start)) * 100);
      return Math.max(5, Math.min(95, progress));
    }
    return 50;
  }

  private async getRecentActivity(): Promise<SituationData['recent_activity']> {
    try {
      const workspacePath = workspaceService.getWorkspacePath();
      const mdFiles: { path: string; mtime: Date }[] = [];

      const scanDir = async (dir: string): Promise<void> => {
        const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory() && !entry.name.startsWith('.')) {
            await scanDir(fullPath);
          } else if (entry.isFile() && entry.name.endsWith('.md')) {
            const stat = await fsp.stat(fullPath).catch(() => null);
            if (stat) mdFiles.push({ path: fullPath, mtime: stat.mtime });
          }
        }
      };

      await scanDir(workspacePath);

      const recent = mdFiles.sort((a, b) => b.mtime.getTime() - a.mtime.getTime()).slice(0, 10);
      return Promise.all(
        recent.map(async (f) => ({
          filename: path.basename(f.path),
          path: path.relative(workspacePath, f.path).split(path.sep).join('/'),
          title: await this.readTitle(f.path),
          event: 'modified',
          timestamp: f.mtime.toISOString(),
        }))
      );
    } catch {
      return [];
    }
  }

  // Most workspace files share a name (task.md, note.md, output.md), so the
  // dashboard needs the item's own title to tell them apart.
  private async readTitle(filePath: string): Promise<string | undefined> {
    try {
      const { data, content } = parseMarkdown(await fsp.readFile(filePath, 'utf-8'));
      const fromMeta = [data.title, data.name].find((v) => typeof v === 'string' && v.trim());
      if (fromMeta) return fromMeta.trim();
      return content.match(/^#\s+(.+)$/m)?.[1].trim() || undefined;
    } catch {
      return undefined;
    }
  }
}
