import { apiGet } from './api';

export type MentionType = 'stakeholder' | 'context' | 'template' | 'task';

export interface MentionCandidate {
  type: MentionType;
  id: string;
  label: string;
  detail?: string;
  /** Workspace-relative path, the link target written into the Markdown. */
  path: string;
}

export const MENTION_TYPE_LABELS: Record<MentionType, string> = {
  stakeholder: 'Stakeholders',
  context: 'Contexts',
  template: 'Output templates',
  task: 'Tasks',
};

export const MENTION_TYPE_ORDER: MentionType[] = ['stakeholder', 'context', 'template', 'task'];

export function mentionTypeForPath(relPath: string): MentionType | null {
  if (relPath.startsWith('stakeholders/')) return 'stakeholder';
  if (relPath.startsWith('context/')) return 'context';
  if (relPath.startsWith('outputs/templates/')) return 'template';
  if (relPath.startsWith('tasks/')) return 'task';
  return null;
}

const CACHE_MS = 30_000;
let cache: { at: number; items: MentionCandidate[] } | null = null;

export async function loadMentionCandidates(): Promise<MentionCandidate[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.items;
  const items = await apiGet<MentionCandidate[]>('/api/mentions');
  cache = { at: Date.now(), items };
  return items;
}

/**
 * In-app route for a mention, matching where the search overlay sends each type. Stakeholder and
 * task pages are keyed by the `id` inside the file, which can differ from the file name, so the id
 * comes from the candidate list.
 */
export async function resolveMentionRoute(relPath: string): Promise<string | null> {
  const type = mentionTypeForPath(relPath);
  if (type === 'context') return '/context';
  if (type === 'template') return '/outputs';
  if (type !== 'stakeholder' && type !== 'task') return null;
  const match = (await loadMentionCandidates()).find((c) => c.path === relPath);
  if (!match) return null;
  return type === 'stakeholder' ? `/stakeholders/${encodeURIComponent(match.id)}` : `/board/task/${encodeURIComponent(match.id)}`;
}

/** `[@Label](path)`. Brackets in the label would break the link, so they are dropped. */
export function mentionMarkdown(c: MentionCandidate): string {
  const label = c.label.replace(/[[\]]/g, '');
  return `[@${label}](${encodeURI(c.path)})`;
}

export function filterMentions(all: MentionCandidate[], query: string, type: MentionType | 'all'): MentionCandidate[] {
  const q = query.trim().toLowerCase();
  const scored: Array<{ c: MentionCandidate; score: number }> = [];
  for (const c of all) {
    if (type !== 'all' && c.type !== type) continue;
    if (!q) { scored.push({ c, score: 0 }); continue; }
    const label = c.label.toLowerCase();
    const hay = `${label} ${c.id.toLowerCase()} ${(c.detail ?? '').toLowerCase()}`;
    if (label.startsWith(q)) scored.push({ c, score: 0 });
    else if (label.split(/\s+/).some((w) => w.startsWith(q))) scored.push({ c, score: 1 });
    else if (hay.includes(q)) scored.push({ c, score: 2 });
  }
  scored.sort((a, b) =>
    MENTION_TYPE_ORDER.indexOf(a.c.type) - MENTION_TYPE_ORDER.indexOf(b.c.type) ||
    a.score - b.score ||
    a.c.label.localeCompare(b.c.label));
  return scored.map((s) => s.c);
}
