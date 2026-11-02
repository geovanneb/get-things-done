import { fileInside } from '../utils/files';
import * as path from 'path';
import * as fsp from 'fs/promises';
import { TaskService } from './taskService';
import { StakeholderService } from './stakeholderService';
import { ContextService } from './contextService';
import { OutputService } from './outputService';
import { FileService } from './fileService';
import { WorkspaceService } from './workspace';
import { MeetingHistoryService } from './meetingHistoryService';
import { MeetingDigestService } from './meetingDigestService';
import { meetingIdOf, resolveMeeting } from './meetingSources';

const taskService = new TaskService();
const stakeholderService = new StakeholderService();
const contextService = new ContextService();
const outputService = new OutputService();
const fileService = new FileService();
const workspaceService = new WorkspaceService();
const meetingHistory = new MeetingHistoryService();
const meetingQueue = new MeetingDigestService();

export type MentionType = 'stakeholder' | 'template' | 'context' | 'task' | 'meeting';

export interface MentionCandidate {
  type: MentionType;
  id: string;
  label: string;
  /** Secondary line in the picker (role, category, format, status). */
  detail?: string;
  /** Workspace-root path with a leading slash, e.g. `/stakeholders/people/stk-0001.md`. */
  href: string;
  /** Set for tasks marked confidential or restricted, so the picker can warn. */
  confidentiality?: string;
}

export interface ParsedMention {
  label: string;
  href: string;
}

/**
 * A mention is a normal Markdown link whose text starts with `@`:
 * `[@Jane Doe](/stakeholders/people/stk-0001.md)`. The path is relative to the workspace root
 * (leading slash), so it means the same thing wherever the task file lives. Links without the
 * slash that start with a mention folder are accepted too.
 */
const MENTION_RE = /\[@([^\]\n]+)\]\((\/[^)\s]+|(?:stakeholders|context|outputs|tasks)\/[^)\s]+)\)/g;
const TASK_ID_RE = /TASK-\d{4}-\d{4}/;

function restrictedLevel(v: unknown): string | undefined {
  return v === 'confidential' || v === 'restricted' ? v : undefined;
}

function toHref(absPath: string): string {
  const rel = path.relative(workspaceService.getWorkspacePath(), absPath);
  return '/' + rel.split(path.sep).join('/');
}

export class MentionService {
  /** Every Markdown mention in a piece of text, in order, without duplicates. */
  extractMentions(markdown: string | undefined): ParsedMention[] {
    if (!markdown) return [];
    const seen = new Set<string>();
    const out: ParsedMention[] = [];
    for (const m of markdown.matchAll(MENTION_RE)) {
      // Early mentions were written without the leading slash; they mean the same workspace-root path.
      const href = m[2].startsWith('/') ? m[2] : `/${m[2]}`;
      if (seen.has(href)) continue;
      seen.add(href);
      out.push({ label: m[1], href });
    }
    return out;
  }

  /** The meetings a piece of text mentions (`/meetings/<id>`), in order, without duplicates. */
  meetingIds(markdown: string | undefined): string[] {
    return this.extractMentions(markdown).flatMap((m) => meetingIdOf(m.href) ?? []);
  }

  /**
   * Whether a mention still points at something: a file, or a meeting the task may use (one whose review is still
   * open cannot be linked to yet, so it counts as missing until its update is done).
   */
  async exists(href: string): Promise<boolean> {
    return (await this.problem(href)) === null;
  }

  /** Why a mention points at nothing usable: `in_review` (a meeting whose record id may still change), `missing`, or null. */
  async problem(href: string): Promise<'in_review' | 'missing' | null> {
    const meeting = meetingIdOf(href);
    if (meeting) {
      return resolveMeeting(meeting).then(() => null, (err: { statusCode?: number }) => (err.statusCode === 409 ? 'in_review' as const : 'missing' as const));
    }
    if (href.startsWith('/meetings/')) return 'missing';
    return (await this.resolve(href)) !== null ? null : 'missing';
  }

  /**
   * Absolute path of the file a mention points to, or null when it no longer exists. A meeting is not a file: its
   * mention resolves to null here, and to what may be read of it through `meetingSources`.
   * Task mentions are resolved by ID, so they keep working after a task moves to the archive.
   */
  async resolve(href: string): Promise<string | null> {
    // Never the file system for a meeting, even once a meetings/ folder exists: its sources are pinned per task.
    if (href.startsWith('/meetings/')) return null;
    const ws = path.resolve(workspaceService.getWorkspacePath());
    const direct = path.resolve(ws, '.' + href);
    if (!direct.startsWith(ws + path.sep)) return null; // never leave the workspace
    const resolveFile = (candidate: string) => fileInside(ws, path.relative(ws, candidate)).catch(() => null);
    const resolved = await resolveFile(direct);
    if (resolved) return resolved;
    const taskId = href.startsWith('/tasks/') ? href.match(TASK_ID_RE)?.[0] : undefined;
    if (taskId) {
      for (const dir of ['active', 'archive']) {
        const candidate = path.join(ws, 'tasks', dir, taskId, 'task.md');
        const resolvedTask = await resolveFile(candidate);
        if (resolvedTask) return resolvedTask;
      }
    }
    return null;
  }

  /** Picker search across stakeholders, output templates, context notes and tasks (incl. archived). */
  async search(query: string, limit = 8): Promise<MentionCandidate[]> {
    const q = query.trim().toLowerCase();
    const match = (...fields: (string | undefined)[]) => !q || fields.some((f) => f?.toLowerCase().includes(q));
    const groups: MentionCandidate[][] = [];

    const stakeholders = await stakeholderService.listStakeholders().catch(() => []);
    groups.push(
      stakeholders
        .filter((s) => match(s.name, s.id, s.role, s.organization))
        .filter((s) => s.path)
        .map((s) => ({
          type: 'stakeholder' as const,
          id: s.id,
          label: s.name,
          detail: [s.role, s.organization].filter(Boolean).join(' · ') || undefined,
          href: toHref(s.path!),
        })),
    );

    const templates = await outputService.listTemplates().catch(() => []);
    groups.push(
      templates
        .filter((t) => match(t.name, t.id, t.slug))
        .filter((t) => t.path)
        .map((t) => ({
          type: 'template' as const,
          id: t.slug || t.id,
          label: t.name,
          detail: t.format ? t.format.toUpperCase() : undefined,
          href: toHref(t.path!),
        })),
    );

    const notes = await contextService.listContextNotes().catch(() => []);
    groups.push(
      notes
        .filter((n) => match(n.title, n.id, n.slug))
        .filter((n) => n.path)
        .map((n) => ({
          type: 'context' as const,
          id: n.id,
          label: n.title,
          detail: n.category,
          href: toHref(n.path!),
        })),
    );

    const tasks = [...(await taskService.listTasks().catch(() => [])), ...(await this.listArchivedTasks())];
    groups.push(
      tasks
        .filter((t) => match(t.title, t.id))
        .filter((t) => t.path)
        .map((t) => ({
          type: 'task' as const,
          id: t.id,
          label: t.title,
          detail: t.status,
          href: toHref(t.path!),
          confidentiality: restrictedLevel((t as unknown as Record<string, unknown>)['confidentiality']),
        })),
    );

    groups.push(await this.searchMeetings(match));

    return groups.flatMap((g) => g.slice(0, limit));
  }

  /**
   * Meetings a task can be made from: ones still in the queue, and ones an update holds whose id is final. Newest
   * first, with the date and how far their review got.
   */
  private async searchMeetings(match: (...fields: (string | undefined)[]) => boolean): Promise<MentionCandidate[]> {
    const held = (await meetingHistory.list().catch(() => [])).filter((m) => m.linkable);
    const queued = ((await meetingQueue.readQueue().catch(() => null))?.meetings ?? []).filter((m) => m.status === 'queued' && !m.in_digest);
    // The same words as the task's meeting sources: not reviewed yet, in review, reviewed.
    const review = (m: (typeof held)[number]) => m.deleted && m.record ? 'record only'
      : m.review_state === 'final' ? 'reviewed' : m.review_state === 'provisional' ? 'in review' : 'not reviewed yet';
    const all: (MentionCandidate & { date: string })[] = [
      ...queued.map((m) => ({ type: 'meeting' as const, id: m.id, label: m.title, detail: [m.meeting_date, 'not reviewed yet'].filter(Boolean).join(' · '), href: `/meetings/${m.id}`, date: m.meeting_date })),
      ...held.filter((m) => !queued.some((q) => q.id === m.id)).map((m) => ({ type: 'meeting' as const, id: m.id, label: m.title, detail: [m.meeting_date, review(m)].filter(Boolean).join(' · '), href: `/meetings/${m.id}`, date: m.meeting_date })),
    ];
    return all
      .filter((m) => match(m.label, m.id, m.date))
      .sort((a, b) => b.date.localeCompare(a.date))
      .map(({ date: _date, ...m }) => m);
  }

  private async listArchivedTasks() {
    const dir = path.join(workspaceService.getWorkspacePath(), 'tasks', 'archive');
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    const out = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      try {
        out.push(await taskService.getTask(e.name));
      } catch {
        // Not a task folder
      }
    }
    return out;
  }
}
