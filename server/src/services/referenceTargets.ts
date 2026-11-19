import * as path from 'path';
import * as fsp from 'fs/promises';
import { parseMarkdown } from '../utils/markdown';
import { updateFromText } from './contextUpdateService';
import { heldMeetings } from './meetingLibrary';

/**
 * Where a reference to a workspace item opens in the app: a mention's href (`/stakeholders/people/stk-0001.md`) or a
 * bare id (`TASK-2026-0001`). `route` is an in-app address, never a file or outside link; `label` is the item's title
 * or name, for the chip's tooltip.
 *
 * Resolving only reads, and only exact workspace entries: every file and folder it opens is reached with no link in
 * any part of its path (a link, even one that stays in the workspace, counts as missing), and nothing is created,
 * migrated or cleaned up on the way. The list services are not used for that reason: they create their folders and
 * follow whatever the folders point at.
 */
export type ReferenceType = 'stakeholder' | 'template' | 'context' | 'task' | 'meeting';

export interface MentionTarget {
  exists: boolean;
  route: string | null;
  label?: string;
  type?: ReferenceType;
}

const NOTE_ID = 'CTX-[a-z0-9]+(?:-[a-z0-9]+)*';
/** The ids the dashboard can open by themselves (the formats in the workspace schemas). */
export const REFERENCE_ID = new RegExp(`^(?:TASK-\\d{4}-\\d{4}|STK-\\d{4}|GRP-\\d{4}|ORG-\\d{4}|CU-\\d{4}-\\d{4}(?:-M-\\d{2,3})?|MQ-\\d{4}-\\d{4}|RT-\\d{4}|${NOTE_ID})$`);
/** The workspace folders a reference may point into. Anything else (the app's own files, the OS) is never resolved. */
export const REFERENCE_ROOTS = ['tasks', 'context', 'stakeholders', 'outputs', 'meetings', 'context-updates', 'routines'] as const;
/** At most this many references are resolved in one request. */
export const MAX_RESOLVE_BATCH = 50;

const TASK_ID = /^TASK-\d{4}-\d{4}$/;
const UPDATE_ID = /^CU-\d{4}-\d{4}$/;
const MEETING_ID = /^(?:MQ-\d{4}-\d{4}|CU-\d{4}-\d{4}(?:-M-\d{2,3})?)$/;
const MISSING: MentionTarget = { exists: false, route: null };

/**
 * A reference as workspace-relative path segments, or null when it is not one the app may follow: `..` or `.`
 * segments, empty segments, backslashes, control characters, a drive or URL scheme, or a folder outside the roots.
 * The path is literal, as it is on disk: nothing is decoded here (a folder may be named `phase%2Done`). A link's URL
 * syntax is decoded once where the link is read (the page, or the GET endpoint's href).
 */
export function referenceSegments(ref: string): string[] | null {
  if (typeof ref !== 'string' || !ref || ref.length > 500) return null;
  const text = ref;
  // eslint-disable-next-line no-control-regex
  if (/[\\\u0000-\u001f\u007f]|:/.test(text)) return null;
  const parts = text.replace(/^\//, '').replace(/\/$/, '').split('/');
  if (parts.some((p) => !p || p === '.' || p === '..')) return null;
  if (!(REFERENCE_ROOTS as readonly string[]).includes(parts[0]!)) return null;
  return parts;
}

type Entry = { abs: string; file: boolean; dir: boolean };
type Front = Record<string, unknown>;

/** One batch's view of one workspace: its real root, fixed at the start, and exact-entry reads below it. */
class Workspace {
  private readonly cache = new Map<string, Promise<unknown>>();
  constructor(readonly root: string, readonly real: string) {}

  private once<T>(key: string, load: () => Promise<T>): Promise<T> {
    let p = this.cache.get(key) as Promise<T> | undefined;
    if (!p) { p = load(); this.cache.set(key, p); }
    return p;
  }

  /** The entry at these segments, only when it exists and no part of its path is a link. */
  entry(parts: string[]): Promise<Entry | null> {
    return this.once(`e:${parts.join('/')}`, async () => {
      const abs = path.join(this.real, ...parts);
      try {
        if ((await fsp.realpath(abs)) !== abs) return null;
        const st = await fsp.lstat(abs);
        return { abs, file: st.isFile(), dir: st.isDirectory() };
      } catch {
        return null;
      }
    });
  }

  /** The text of an exact file, or null. */
  text(parts: string[]): Promise<string | null> {
    return this.once(`t:${parts.join('/')}`, async () => {
      const e = await this.entry(parts);
      return e?.file ? fsp.readFile(e.abs, 'utf-8').catch(() => null) : null;
    });
  }

  /** The frontmatter of an exact Markdown file, or null. */
  front(parts: string[]): Promise<Front | null> {
    return this.once(`f:${parts.join('/')}`, async () => {
      const raw = await this.text(parts);
      if (raw === null) return null;
      try {
        return (parseMarkdown(raw).data as Front | undefined) ?? {};
      } catch {
        return null;
      }
    });
  }

  /** The names in an exact folder, or none. */
  list(parts: string[]): Promise<string[]> {
    return this.once(`l:${parts.join('/')}`, async () => {
      const e = await this.entry(parts);
      if (!e?.dir) return [];
      return (await fsp.readdir(e.abs).catch(() => [])).sort();
    });
  }
}

const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : undefined);
const idOf = (data: Front, file: string) => text(data['id']) ?? path.basename(file, '.md').toUpperCase();

async function task(ws: Workspace, id: string, route = `/board/task/${id}`): Promise<MentionTarget> {
  for (const dir of ['active', 'archive']) {
    const data = await ws.front(['tasks', dir, id, 'task.md']);
    if (data) return { exists: true, route, label: text(data['title']) ?? id, type: 'task' };
  }
  return MISSING;
}

const personTarget = (id: string, data: Front): MentionTarget =>
  ({ exists: true, route: `/stakeholders/${encodeURIComponent(id)}`, label: text(data['name']) ?? id, type: 'stakeholder' });
const chartTarget = (id: string, data: Front): MentionTarget =>
  ({ exists: true, route: `/stakeholders?tab=charts&chart=${encodeURIComponent(id)}`, label: text(data['name']) ?? id, type: 'stakeholder' });

/** A person or group by id: the file named after it first, then any file in its folder that carries it. */
async function stakeholder(ws: Workspace, id: string): Promise<MentionTarget> {
  const dirs = id.startsWith('GRP-') ? ['groups', 'people'] : ['people', 'groups'];
  for (const dir of dirs) {
    const named = await ws.front(['stakeholders', dir, `${id.toLowerCase()}.md`]);
    if (named && idOf(named, `${id}.md`) === id) return personTarget(id, named);
  }
  for (const dir of dirs) {
    for (const name of await ws.list(['stakeholders', dir])) {
      if (!name.endsWith('.md')) continue;
      const data = await ws.front(['stakeholders', dir, name]);
      if (data && idOf(data, name) === id) return personTarget(id, data);
    }
  }
  return MISSING;
}

async function chart(ws: Workspace, id: string): Promise<MentionTarget> {
  for (const name of await ws.list(['stakeholders', 'org-charts'])) {
    if (!name.endsWith('.md')) continue;
    const data = await ws.front(['stakeholders', 'org-charts', name]);
    if (data && idOf(data, name) === id) return chartTarget(id, data);
  }
  return MISSING;
}

const noteTarget = (data: Front | null): MentionTarget => {
  const id = data ? text(data['id']) : undefined;
  return { exists: true, route: id ? `/context?note=${encodeURIComponent(id)}` : '/context', label: data ? text(data['title']) : undefined, type: 'context' };
};

/** A context note by its id: every note folder (and older flat note) of every category. */
async function note(ws: Workspace, id: string): Promise<MentionTarget> {
  for (const category of await ws.list(['context'])) {
    for (const name of await ws.list(['context', category])) {
      const file = name.endsWith('.md') ? ['context', category, name] : ['context', category, name, 'note.md'];
      const data = await ws.front(file);
      if (data && text(data['id']) === id) return noteTarget(data);
    }
  }
  return MISSING;
}

async function update(ws: Workspace, id: string): Promise<MentionTarget> {
  const data = await ws.front(['context-updates', id, 'update.md']);
  return data ? { exists: true, route: `/context/updates/${id}`, label: text(data['title']) ?? id, type: 'context' } : MISSING;
}

async function routine(ws: Workspace, id: string): Promise<MentionTarget> {
  const data = await ws.front(['routines', `${id}.md`]);
  return data ? { exists: true, route: '/routines', label: text(data['title']) ?? id, type: 'task' } : MISSING;
}

type MeetingInfo = { id: string; title: string; linkable: boolean };

/**
 * The meetings the workspace holds, read here rather than through the meeting services (which read every update and
 * queued meeting through whatever links they find): each update's update.md and each queued meeting's manifest is read
 * only when it is an exact entry, and one that is not (a link) is skipped on its own. Held meetings are worked out by
 * the same rules as the Meetings page (heldMeetings); a queued meeting that is still in the queue comes first, as there.
 */
async function meetingList(ws: Workspace): Promise<MeetingInfo[]> {
  const out = new Map<string, MeetingInfo>();
  for (const name of await ws.list(['context-updates', 'meeting-queue'])) {
    if (!/^MQ-\d{4}-\d{4}$/.test(name)) continue;
    const data = await ws.front(['context-updates', 'meeting-queue', name, 'meeting.md']);
    if (data && data['status'] === 'queued') out.set(name, { id: name, title: text(data['title']) ?? name, linkable: true });
  }
  for (const name of await ws.list(['context-updates'])) {
    if (!UPDATE_ID.test(name)) continue;
    const raw = await ws.text(['context-updates', name, 'update.md']);
    if (raw === null) continue;
    let held: ReturnType<typeof heldMeetings>;
    try { held = heldMeetings(updateFromText(raw, name)); } catch { continue; }
    for (const m of held) if (!out.has(m.id)) out.set(m.id, { id: m.id, title: m.title, linkable: m.linkable });
  }
  return [...out.values()];
}

async function meeting(ws: Workspace, id: string, meetings: () => Promise<MeetingInfo[]>): Promise<MentionTarget> {
  const found = (await meetings()).find((m) => m.id === id);
  // A meeting whose review is still open has no page of its own yet (and a task cannot use it).
  if (!found || !found.linkable) return MISSING;
  return { exists: true, route: `/meetings/${id}`, label: found.title, type: 'meeting' };
}

async function byId(ws: Workspace, ref: string, meetings: () => Promise<MeetingInfo[]>): Promise<MentionTarget> {
  if (ref.startsWith('TASK-')) return task(ws, ref);
  if (ref.startsWith('STK-') || ref.startsWith('GRP-')) return stakeholder(ws, ref);
  if (ref.startsWith('ORG-')) return chart(ws, ref);
  if (ref.startsWith('CTX-')) return note(ws, ref);
  if (ref.startsWith('RT-')) return routine(ws, ref);
  if (MEETING_ID.test(ref) && !UPDATE_ID.test(ref)) return meeting(ws, ref, meetings);
  return update(ws, ref);
}

async function byPath(ws: Workspace, parts: string[], meetings: () => Promise<MeetingInfo[]>): Promise<MentionTarget> {
  const [root, ...rest] = parts;
  const exists = async () => Boolean(await ws.entry(parts));

  if (root === 'meetings') {
    // A meeting is linked by its page's path only; its files are private and never looked up from a link.
    return rest.length === 1 && MEETING_ID.test(rest[0]!) ? meeting(ws, rest[0]!, meetings) : MISSING;
  }
  if (root === 'tasks') {
    // Only the canonical layout: tasks/<active|archive>/<TASK-id>[/…].
    const [where, id, ...inside] = rest;
    if ((where !== 'active' && where !== 'archive') || !id || !TASK_ID.test(id)) return MISSING;
    // The task itself is found by id, so a path written before it moved to the archive still opens it.
    if (inside.length === 0 || (inside.length === 1 && inside[0] === 'task.md')) return task(ws, id);
    // A file of the task must be where the path says. A top-level attachment opens the Files tab; a deliverable
    // (anything in a sub-folder) is listed on the task's own page; an archived task has no Files tab.
    const target = await task(ws, id);
    const entry = await ws.entry(parts);
    if (!target.exists || !entry) return MISSING;
    return { ...target, route: inside.length === 1 && entry.file && where === 'active' ? `/board/task/${id}?tab=files` : target.route };
  }
  if (root === 'stakeholders') {
    if (!(await exists())) return MISSING;
    const [sub, name, ...more] = rest;
    if (!sub) return { exists: true, route: '/stakeholders', type: 'stakeholder' };
    if (more.length || !['people', 'groups', 'org-charts'].includes(sub)) return MISSING;
    if (!name) return { exists: true, route: sub === 'org-charts' ? '/stakeholders?tab=charts' : sub === 'groups' ? '/stakeholders?tab=groups' : '/stakeholders', type: 'stakeholder' };
    const data = await ws.front(parts);
    if (!data) return MISSING;
    const id = idOf(data, name);
    return sub === 'org-charts' ? chartTarget(id, data) : personTarget(id, data);
  }
  if (root === 'context') {
    if (!(await exists())) return MISSING;
    if (rest.length < 2) return { exists: true, route: '/context', type: 'context' };
    // The note a path belongs to: context/<category>/<slug>/note.md (or a file beside it), or an older flat
    // context/<category>/<name>.md.
    const flat = rest.length === 2 && rest[1]!.endsWith('.md');
    return noteTarget(await ws.front(flat ? parts : ['context', rest[0]!, rest[1]!, 'note.md']));
  }
  if (root === 'outputs') {
    if (!(await exists())) return MISSING;
    if (rest.length === 0 || (rest.length === 1 && rest[0] === 'templates')) return { exists: true, route: '/outputs', type: 'template' };
    if (rest[0] !== 'templates') return MISSING;
    const data = await ws.front(['outputs', 'templates', rest[1]!, 'output.md']);
    return { exists: true, route: '/outputs', label: data ? text(data['name']) : undefined, type: 'template' };
  }
  if (root === 'context-updates') {
    // The update itself only: whether its materials exist is never said.
    const [id, file, ...more] = rest;
    return id && UPDATE_ID.test(id) && !more.length && (!file || file === 'update.md') ? update(ws, id) : MISSING;
  }
  // routines/RT-NNNN.md
  const id = rest.length === 1 ? rest[0]!.replace(/\.md$/, '') : '';
  return /^RT-\d{4}$/.test(id) && rest[0] === `${id}.md` ? routine(ws, id) : MISSING;
}

/** Where each reference opens, in one workspace (fixed for the whole batch). Unknown, missing or unsafe: missing. */
export async function resolveReferences(workspacePath: string, refs: string[]): Promise<Record<string, MentionTarget>> {
  // No prototype: a reference named `constructor`, `toString` or `__proto__` is a key like any other.
  const out = Object.create(null) as Record<string, MentionTarget>;
  const wanted = refs.slice(0, MAX_RESOLVE_BATCH).filter((r): r is string => typeof r === 'string');
  const real = await fsp.realpath(path.resolve(workspacePath)).catch(() => null);
  if (!real) { for (const ref of wanted) out[ref] = MISSING; return out; }
  const ws = new Workspace(path.resolve(workspacePath), real);
  let meetings: Promise<MeetingInfo[]> | null = null;
  const loadMeetings = () => (meetings ??= meetingList(ws).catch(() => []));
  for (const ref of wanted) {
    if (ref in out) continue;
    let target = MISSING;
    try {
      if (REFERENCE_ID.test(ref)) target = await byId(ws, ref, loadMeetings);
      else {
        const parts = referenceSegments(ref);
        if (parts) target = await byPath(ws, parts, loadMeetings);
      }
    } catch {
      target = MISSING;
    }
    out[ref] = target;
  }
  return out;
}
