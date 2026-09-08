import * as fsp from 'fs/promises';
import * as path from 'path';
import { InsightsData, Task, TaskStatus, Priority } from '../types';
import { TaskService } from './taskService';
import { GitService } from './gitService';
import { WorkspaceService } from './workspace';

const taskService = new TaskService();
const gitService = new GitService();
const workspaceService = new WorkspaceService();

function getWeekKey(date: Date): string {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - d.getDay()); // Sunday start
  return d.toISOString().slice(0, 10);
}

function subtractWeeks(date: Date, weeks: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() - weeks * 7);
  return d;
}

export class InsightsService {
  async getInsightsData(): Promise<InsightsData> {
    let tasks: Task[] = [];
    try {
      tasks = await taskService.listTasks();
      // Also include archived tasks
      const archived = await taskService.listTasks({ status: 'archived' }).catch(() => []);
      const ids = new Set(tasks.map((t) => t.id));
      for (const t of archived) {
        if (!ids.has(t.id)) tasks.push(t);
      }
    } catch {
      tasks = [];
    }

    const now = new Date();
    const weeks: string[] = [];
    for (let i = 7; i >= 0; i--) {
      weeks.push(getWeekKey(subtractWeeks(now, i)));
    }

    // Throughput: tasks completed per week
    const throughput = weeks.map((week) => {
      const weekEnd = new Date(week);
      weekEnd.setDate(weekEnd.getDate() + 7);

      const completed = tasks.filter((t) => {
        if (!t.done_date) return false;
        const doneWeek = getWeekKey(new Date(t.done_date));
        return doneWeek === week;
      }).length;

      return { week, completed };
    });

    // Cycle time: completed tasks with start and done dates
    const cycleTime = tasks
      .filter((t) => t.status === 'done' && t.start_date && t.done_date)
      .map((t) => ({
        title: t.title,
        days: Math.max(0, Math.round((new Date(t.done_date!).getTime() - new Date(t.start_date!).getTime()) / (24 * 60 * 60 * 1000))),
        priority: t.priority,
      }));

    // Due date risk distribution
    const activeTasks = tasks.filter((t) => t.status !== 'done' && t.status !== 'archived' && t.due_date);
    const dueDateRisk = { overdue: 0, within_3_days: 0, within_7_days: 0, within_14_days: 0, beyond_14_days: 0 };

    for (const t of activeTasks) {
      const dueMs = new Date(t.due_date!).getTime() - now.getTime();
      const dueDays = dueMs / (24 * 60 * 60 * 1000);

      if (dueDays < 0) dueDateRisk.overdue++;
      else if (dueDays < 3) dueDateRisk.within_3_days++;
      else if (dueDays < 7) dueDateRisk.within_7_days++;
      else if (dueDays < 14) dueDateRisk.within_14_days++;
      else dueDateRisk.beyond_14_days++;
    }

    // Cumulative flow: per-week status counts
    // We estimate historical state from file modification times when git is unavailable
    const cumulativeFlow = await this.buildCumulativeFlow(tasks, weeks);

    // Reshape to match frontend InsightsData types
    const cumulativeFlowShaped = cumulativeFlow.map((row) => ({
      date: row.week,
      backlog: row.counts.backlog,
      ready: row.counts.ready,
      in_progress: row.counts.in_progress,
      blocked: row.counts.blocked,
      review: row.counts.review,
      done: row.counts.done,
    }));

    const avgCycleTime = cycleTime.length > 0
      ? Math.round(cycleTime.reduce((sum, t) => sum + t.days, 0) / cycleTime.length)
      : 0;
    const thisWeek = weeks[weeks.length - 1];
    const throughputThisWeek = throughput.find((t) => t.week === thisWeek)?.completed ?? 0;
    const totalActive = tasks.filter((t) => t.status !== 'archived').length;
    const done = tasks.filter((t) => t.status === 'done').length;
    const completionRate = totalActive > 0 ? Math.round((done / totalActive) * 100) : 0;
    const tasksAtRisk = dueDateRisk.overdue + dueDateRisk.within_3_days;

    return {
      cumulative_flow: cumulativeFlowShaped,
      cycle_time: cycleTime,
      due_date_risk: {
        overdue: dueDateRisk.overdue,
        due_3d: dueDateRisk.within_3_days,
        due_7d: dueDateRisk.within_7_days,
        due_14d: dueDateRisk.within_14_days,
        safe: dueDateRisk.beyond_14_days,
      },
      throughput,
      avg_cycle_time: avgCycleTime,
      throughput_this_week: throughputThisWeek,
      completion_rate: completionRate,
      tasks_at_risk: tasksAtRisk,
    };
  }

  private async buildCumulativeFlow(tasks: Task[], weeks: string[]): Promise<{ week: string; counts: Record<TaskStatus, number> }[]> {
    const emptyStatusCounts = (): Record<TaskStatus, number> => ({
      backlog: 0, ready: 0, in_progress: 0, blocked: 0, review: 0, done: 0, in_review: 0, approved: 0, archived: 0,
    });

    // Try to use git log for historical data
    let useGit = false;
    try {
      useGit = await gitService.isGitRepo();
    } catch {
      useGit = false;
    }

    if (useGit) {
      try {
        const log = await gitService.getLog(200);
        // Build week -> status counts from git history (simplified)
        const weekData = new Map<string, Record<TaskStatus, number>>();
        for (const week of weeks) {
          weekData.set(week, emptyStatusCounts());
        }

        // For now, use current state and spread backwards based on task dates
        return this.estimateFlowFromDates(tasks, weeks);
      } catch {
        // Fall through to estimate
      }
    }

    return this.estimateFlowFromDates(tasks, weeks);
  }

  private estimateFlowFromDates(tasks: Task[], weeks: string[]): { week: string; counts: Record<TaskStatus, number> }[] {
    const emptyStatusCounts = (): Record<TaskStatus, number> => ({
      backlog: 0, ready: 0, in_progress: 0, blocked: 0, review: 0, done: 0, in_review: 0, approved: 0, archived: 0,
    });

    return weeks.map((week) => {
      const weekDate = new Date(week);
      const weekEnd = new Date(week);
      weekEnd.setDate(weekEnd.getDate() + 7);
      const counts = emptyStatusCounts();

      for (const task of tasks) {
        const createdAt = new Date(task.created_at || weekDate);
        const doneAt = task.done_date ? new Date(task.done_date) : null;

        // Task existed this week if created before week end
        if (createdAt > weekEnd) continue;

        if (doneAt && doneAt <= weekDate) {
          // Task was done before this week
          counts['done']++;
        } else if (task.status === 'archived') {
          counts['archived']++;
        } else if (doneAt && doneAt <= weekEnd) {
          // Task completed this week
          counts['done']++;
        } else {
          // Approximate based on current status
          counts[task.status]++;
        }
      }

      return { week, counts };
    });
  }
}
