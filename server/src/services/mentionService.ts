import { fileInside } from '../utils/files';
import * as path from 'path';
import * as fsp from 'fs/promises';
import { TaskService } from './taskService';
import { StakeholderService } from './stakeholderService';
import { ContextService } from './contextService';
import { OutputService } from './outputService';
import { FileService } from './fileService';
import { WorkspaceService } from './workspace';

const taskService = new TaskService();
const stakeholderService = new StakeholderService();
const contextService = new ContextService();
const outputService = new OutputService();
const fileService = new FileService();
const workspaceService = new WorkspaceService();

export type MentionType = 'stakeholder' | 'template' | 'context' | 'task';

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

  /**
   * Absolute path of the file a mention points to, or null when it no longer exists.
   * Task mentions are resolved by ID, so they keep working after a task moves to the archive.
   */
  async resolve(href: string): Promise<string | null> {
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

    return groups.flatMap((g) => g.slice(0, limit));
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
