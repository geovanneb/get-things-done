import * as path from 'path';
import * as fsp from 'fs/promises';
import { WorkspaceService } from './workspace';
import { FileService } from './fileService';
import { TaskService } from './taskService';
import { StakeholderService } from './stakeholderService';
import { ContextService } from './contextService';
import { OutputService } from './outputService';

const workspaceService = new WorkspaceService();
const fileService = new FileService();
const taskService = new TaskService();
const stakeholderService = new StakeholderService();
const contextService = new ContextService();
const outputService = new OutputService();

export type MentionType = 'stakeholder' | 'context' | 'template' | 'task';

export interface MentionCandidate {
  type: MentionType;
  id: string;
  label: string;
  detail?: string;
  /** Workspace-relative, forward slashes. This is what goes into the Markdown link. */
  path: string;
}

/** Matches `[@Label](relative/path.md)`, the format the UI inserts. */
const MENTION_RE = /\[@[^\]\n]+\]\(([^)\s]+\.md)\)/g;

export function mentionTypeForPath(relPath: string): MentionType | null {
  if (relPath.startsWith('stakeholders/')) return 'stakeholder';
  if (relPath.startsWith('context/')) return 'context';
  if (relPath.startsWith('outputs/templates/')) return 'template';
  if (relPath.startsWith('tasks/')) return 'task';
  return null;
}

/** Workspace-relative paths mentioned in a Markdown body, in order, without duplicates. */
export function extractMentionPaths(body: string | undefined): string[] {
  if (!body) return [];
  const seen = new Set<string>();
  for (const match of body.matchAll(MENTION_RE)) {
    let rel: string;
    try {
      rel = decodeURI(match[1]).replace(/^\.\//, '');
    } catch {
      continue;
    }
    if (mentionTypeForPath(rel)) seen.add(rel);
  }
  return [...seen];
}

export class MentionService {
  private toRelative(workspacePath: string, absPath: string): string {
    return path.relative(workspacePath, absPath).split(path.sep).join('/');
  }

  /** Resolves a mention to an absolute path, or null if it points outside the workspace. */
  resolveMentionPath(relPath: string): string | null {
    const root = path.resolve(workspaceService.getWorkspacePath());
    const abs = path.resolve(root, relPath);
    return abs.startsWith(root + path.sep) ? abs : null;
  }

  async listCandidates(): Promise<MentionCandidate[]> {
    const ws = workspaceService.getWorkspacePath();
    const rel = (p: string) => this.toRelative(ws, p);
    const out: MentionCandidate[] = [];

    const [stakeholders, notes, templates, activeTasks, archivedTasks] = await Promise.all([
      stakeholderService.listStakeholders().catch(() => []),
      contextService.listContextNotes().catch(() => []),
      outputService.listTemplates().catch(() => []),
      taskService.listTasks().catch(() => []),
      this.listArchivedTasks(ws),
    ]);

    for (const s of stakeholders) {
      if (!s.path) continue;
      const isGroup = rel(s.path).startsWith('stakeholders/groups/');
      const detail = isGroup ? 'Group' : [s.role, s.organization].filter(Boolean).join(' · ');
      out.push({ type: 'stakeholder', id: s.id, label: s.name || s.id, detail: detail || undefined, path: rel(s.path) });
    }
    for (const n of notes) {
      if (!n.path) continue;
      out.push({ type: 'context', id: n.id, label: n.title || n.id, detail: n.category, path: rel(n.path) });
    }
    for (const t of templates) {
      if (!t.path) continue;
      out.push({ type: 'template', id: t.id, label: t.name || t.id, detail: t.format, path: rel(t.path) });
    }
    for (const t of [...activeTasks, ...archivedTasks]) {
      if (!t.path) continue;
      out.push({ type: 'task', id: t.id, label: t.title || t.id, detail: `${t.id} · ${t.status ?? 'unknown'}`, path: rel(t.path) });
    }

    return out;
  }

  /** Archived tasks are not part of listTasks(), but they can still be mentioned. */
  private async listArchivedTasks(ws: string): Promise<Array<{ id: string; title?: string; status?: string; path: string }>> {
    const archiveDir = path.join(ws, 'tasks', 'archive');
    const entries = await fsp.readdir(archiveDir, { withFileTypes: true }).catch(() => []);
    const tasks: Array<{ id: string; title?: string; status?: string; path: string }> = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const taskFile = path.join(archiveDir, entry.name, 'task.md');
      try {
        const { data } = await fileService.readMarkdown<{ id?: string; title?: string; status?: string }>(taskFile);
        tasks.push({ id: data.id || entry.name, title: data.title, status: data.status || 'archived', path: taskFile });
      } catch {
        // missing or malformed task file
      }
    }
    return tasks;
  }
}

export const mentionService = new MentionService();
