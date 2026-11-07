import { saveAttachment, topLevelName, workspaceEntry, withOfficeCheck, FolderFile } from '../utils/files';
import * as path from 'path';
import * as fsp from 'fs/promises';
import { Task, TaskStatus, Priority } from '../types';
import { DONE_STATUSES } from './taskStatus';
import { BOARD_COLUMN_ID } from './boardColumns';
import { FileService } from './fileService';
import { WorkspaceService } from './workspace';
import { reservedSequence } from './idReservations';
import { lock, unlock } from '../utils/fileLock';
import { StakeholderService } from './stakeholderService';

const fileService = new FileService();

/**
 * A task's deliverables with any `file_path` inside its own active folder pointed at the same file in its archive
 * folder. Paths anywhere else (shared files elsewhere in the workspace) are left as they are.
 */
function inArchive<T>(deliverables: T, id: string): T {
  if (!Array.isArray(deliverables)) return deliverables;
  const from = `tasks/active/${id}/`;
  return deliverables.map((d: unknown) => {
    if (!d || typeof d !== 'object') return d;
    const filePath = (d as { file_path?: unknown }).file_path;
    if (typeof filePath !== 'string') return d;
    const normal = filePath.replace(/\\/g, '/');
    return normal.startsWith(from) ? { ...d, file_path: `tasks/archive/${id}/${normal.slice(from.length)}` } : d;
  }) as T;
}

/**
 * Optional fields from `.schemas/task.schema.json` that `createTask` used to omit: it builds the task
 * field by field, so a field not handled there or listed here is dropped on create (update keeps it).
 */
const OPTIONAL_CREATE_FIELDS = ['slug', 'task_type', 'contexts', 'preferred_agent', 'confidentiality', 'review_date', 'estimated_hours'] as const;
/** Written by the server when a task is made from a meeting action item; never taken from a request. */
const SERVER_FIELDS = ['meeting_action', 'meeting_action_source', 'change_requests', 'waiting'] as const;

/**
 * What a task waits for (#82): one record, set and resolved with its own actions, never by an ordinary save. Independent
 * of the status: a task can wait on someone's input while other work on it continues. The follow-up date is the user's
 * reminder to chase, separate from the task's due date.
 */
export interface Waiting {
  for: string;
  /** A stakeholder or group, or a free-text party (someone who is not a stakeholder); null when not said. */
  party: { ref: string } | { name: string } | null;
  /** The day the waiting started (YYYY-MM-DD). */
  since: string;
  follow_up?: string;
  set_at: string;
}

const MAX_WAITING_TEXT = 500;
const MAX_PARTY_NAME = 200;
const STAKEHOLDER_REF = /^(STK|GRP)-\d{4}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const isDay = (v: unknown): v is string => typeof v === 'string' && DAY.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v);
const localToday = (): string => { const n = new Date(); return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`; };

/**
 * Feedback the executive gave on a task in review, with Request changes (#79): dated, kept in task.md, never in the
 * body. `open` until the agent that reworks the task marks it `addressed`. Written by the dashboard and agents only;
 * an ordinary task save never changes it.
 */
export interface ChangeRequest {
  id: string;
  requested_at: string;
  feedback: string;
  status: 'open' | 'addressed';
  addressed_at?: string;
  /** The dashboard's id for the submission, so sending it twice records it once. */
  request_id: string;
}

const MAX_FEEDBACK = 4000;
const REQUEST_ID = /^[A-Za-z0-9-]{8,64}$/;
const IN_REVIEW: TaskStatus[] = ['in_review', 'review'];
const TASK_LOCK_WAIT_MS = 5000;

function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode: status });
}

/** A timestamp is also the optimistic version: rapid writes and a backwards clock must advance it. */
function nextUpdatedAt(previous: unknown): string {
  const before = typeof previous === 'string' ? Date.parse(previous) : NaN;
  return new Date(Math.max(Date.now(), Number.isFinite(before) ? before + 1 : 0)).toISOString();
}

/** The change requests a task holds, as written; anything that is not one is left out of the count but never dropped. */
function changeRequestsOf(task: Record<string, unknown>): unknown[] {
  if (task['change_requests'] === undefined) return [];
  if (!Array.isArray(task['change_requests'])) throw httpError(409, "The task's change_requests must be a list. Repair task.md before requesting more changes.");
  return task['change_requests'] as unknown[];
}

/** Which version of a meeting record a task was made from, and which original action item it stands for. */
export interface MeetingActionSource { update_id: string; record_id: string; revision: string; root_index: number }
const workspaceService = new WorkspaceService();

/**
 * `board_column` (optional) is the board column a task was dropped in, for columns that share a status (see
 * boardColumns.ts). Request bodies are not typed at runtime: only a well-formed column id is written, and `null`
 * on update removes the field. The status stays the source of truth; the board ignores a column that no longer fits.
 */
function checkBoardColumn(value: unknown, allowNull: boolean): void {
  if (value === undefined || (allowNull && value === null)) return;
  if (typeof value !== 'string' || !BOARD_COLUMN_ID.test(value)) {
    throw Object.assign(new Error('Invalid board_column: use a board column id such as in_progress'), { statusCode: 400 });
  }
}

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

  if (isNowDone && (!wasDone || !updated.done_date)) {
    // Completing a task always records now. A done_date left over from an
    // earlier completion (e.g. the task was reopened by editing task.md, which
    // bypasses this function) is not when the task finished this time.
    updated.done_date = now;
  } else if (!isNowDone && updated.status !== 'archived' && updated.done_date) {
    // Reopened, here or earlier on disk — the old completion date is no longer
    // true. Archiving is filing, not undoing, so it keeps its completion date.
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
    return this.readTaskFolders(activeDir, filters);
  }

  /** Tasks filed away under `tasks/archive/`. The board never shows these; Insights counts them. */
  /** The task, active or archived, that was made from this meeting action item, if any. */
  async findByMeetingAction(meetingAction: string): Promise<Task | null> {
    const all = [...await this.listTasks().catch(() => []), ...await this.listArchivedTasks().catch(() => [])];
    return all.find((t) => (t as Record<string, unknown>)['meeting_action'] === meetingAction) ?? null;
  }

  async listArchivedTasks(): Promise<Task[]> {
    return (await this.readTaskFolders(this.getArchiveDir())).map((t) => ({ ...t, deliverables: inArchive(t.deliverables, t.id) }));
  }

  /**
   * Active task files that cannot be parsed (e.g. a duplicated YAML key). The board skips them,
   * so validation reports them instead of letting the task disappear without a trace.
   */
  async listUnreadableTaskFiles(): Promise<{ path: string; error: string }[]> {
    const dir = this.getActiveDir();
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    const unreadable: { path: string; error: string }[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const taskFile = path.join(dir, entry.name, 'task.md');
      if (!(await fileService.exists(taskFile))) continue;
      try {
        await fileService.readMarkdown<Task>(taskFile);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        unreadable.push({ path: taskFile, error: (message.split('\n')[0] ?? message).replace(/:\s*$/, '') });
      }
    }
    return unreadable;
  }

  private async readTaskFolders(dir: string, filters?: TaskFilters): Promise<Task[]> {
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    const tasks: Task[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const taskFile = path.join(dir, entry.name, 'task.md');
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
              task.objective?.toLowerCase().includes(q) ||
              task.body?.toLowerCase().includes(q);
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
    const taskFile = path.join(this.getActiveDir(), topLevelName(id), 'task.md');

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
      const archiveFile = path.join(this.getArchiveDir(), topLevelName(id), 'task.md');
      if (!(await fileService.exists(archiveFile))) {
        throw new Error(`Task not found: ${id}`);
      }
      const { data, content } = await fileService.readMarkdown<Task>(archiveFile);
      // Archived before archiving moved the paths too: shown where the files are now. Read-only, nothing is written.
      return buildTask({ ...data, deliverables: inArchive(data.deliverables, id) } as Task, content, archiveFile);
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

  /**
   * `origin` is for the server only, never a request body. `meeting_action` names the meeting action item the task
   * was made from, so a retry finds this task instead of creating a second one; `source` is the version of the record
   * it was made from and the original item's place, so a later correction can be compared with what the task saw.
   */
  async createTask(data: Partial<Task>, origin?: { meeting_action: string; source?: MeetingActionSource }): Promise<Task> {
    const rawData = data as Record<string, unknown>;
    // Set by routines, so a scheduled occurrence never produces a second task. Request bodies are not
    // typed at runtime: only well-formed pairs are kept, as the task schema requires.
    const routineRef = rawData['routine_ref'];
    const occurrence = rawData['routine_occurrence'];
    if (routineRef !== undefined || occurrence !== undefined) {
      if (typeof routineRef !== 'string' || !/^RT-\d{4}$/.test(routineRef)
        || typeof occurrence !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(occurrence)) {
        throw Object.assign(new Error('Invalid routine_ref/routine_occurrence: set both, as RT-NNNN and YYYY-MM-DDTHH:MM'), { statusCode: 400 });
      }
    }
    checkBoardColumn(rawData['board_column'], false);
    const id = await this.generateTaskId();
    const now = new Date().toISOString();
    const taskDir = path.join(this.getActiveDir(), topLevelName(id));

    await fileService.ensureDir(taskDir);
    await fileService.ensureDir(path.join(taskDir, 'attachments'));
    await fileService.ensureDir(path.join(taskDir, 'deliverables'));
    await fileService.ensureDir(path.join(taskDir, 'executions'));
    await fileService.ensureDir(path.join(taskDir, 'notes'));

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
    for (const key of OPTIONAL_CREATE_FIELDS) {
      if (rawData[key] !== undefined && rawData[key] !== null) task[key] = rawData[key];
    }
    if (typeof rawData['board_column'] === 'string') task.board_column = rawData['board_column'];
    if (routineRef !== undefined) {
      task['routine_ref'] = routineRef;
      task['routine_occurrence'] = occurrence;
    }
    if (origin) task['meeting_action'] = origin.meeting_action;
    if (origin?.source) task['meeting_action_source'] = origin.source;

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

  /** One writer at a time per task, across dashboards: a save and a change request never lose each other's write. */
  private async withTaskLock<T>(id: string, operation: () => Promise<T>, requireTask = true): Promise<T> {
    // Outside the task's own folder, which archiving moves: a write and an archive or delete wait for each other.
    const ws = workspaceService.getWorkspacePath();
    const name = topLevelName(id);
    const locks = await workspaceEntry(ws, path.join(ws, '.situation-board', 'task-locks'), true);
    await fileService.ensureDir(locks);
    const lockFile = await workspaceEntry(ws, path.join(locks, `${name}.lock`), true);
    const held = await lock(lockFile, TASK_LOCK_WAIT_MS, () => httpError(409, 'The task is being saved elsewhere; try again in a moment.'));
    try {
      // Checked under the lock: a task archived or deleted a moment ago is never written back into tasks/active.
      await workspaceEntry(ws, path.join(this.getActiveDir(), name, 'task.md'), true);
      if (requireTask && !(await fileService.exists(path.join(this.getActiveDir(), name, 'task.md')))) throw httpError(404, `Task not found: ${id}`);
      return await operation();
    } finally {
      await unlock(held);
    }
  }

  /**
   * Request changes on a task in review (#79): records the dated feedback and moves the task back to rework, in one
   * write under the task's lock. Never starts an agent, never touches the body, keeps the start date. Refused (409) when
   * the task is not in review or changed since the user saw it (`seen_updated_at`). The same `request_id` twice records
   * it once and answers with the first.
   */
  async requestChanges(id: string, input: unknown): Promise<{ task: Task; request: ChangeRequest; created: boolean }> {
    const b = input && typeof input === 'object' ? input as Record<string, unknown> : {};
    const feedback = typeof b['feedback'] === 'string' ? b['feedback'].trim() : '';
    if (!feedback) throw httpError(400, 'Write what should change.');
    if (feedback.length > MAX_FEEDBACK) throw httpError(400, `Keep the feedback under ${MAX_FEEDBACK} characters.`);
    const requestId = b['request_id'];
    if (typeof requestId !== 'string' || !REQUEST_ID.test(requestId)) throw httpError(400, 'Invalid request id.');
    const seen = b['seen_updated_at'];
    if (typeof seen !== 'string') throw httpError(400, 'Say which version of the task you reviewed.');

    return this.withTaskLock(id, async () => {
      const taskFile = path.join(this.getActiveDir(), topLevelName(id), 'task.md');
      const { data, content } = await fileService.readMarkdown<Task>(taskFile);
      const existing = data as Task & Record<string, unknown>;
      const requests = changeRequestsOf(existing);
      const again = requests.find((r) => r && typeof r === 'object' && (r as ChangeRequest).request_id === requestId) as ChangeRequest | undefined;
      if (again) return { task: { ...(await this.getTask(id)) }, request: again, created: false };
      if (!IN_REVIEW.includes(existing.status)) throw httpError(409, 'Changes can be requested only on a task in review.');
      if (existing.updated_at !== seen) throw httpError(409, 'The task changed since you opened it. Read it again, then request the changes.');

      const now = nextUpdatedAt(existing.updated_at);
      const numbers = requests.map((r) => Number(/^CR-(\d+)$/.exec(String((r as ChangeRequest | null)?.id ?? ''))?.[1] ?? 0));
      const request: ChangeRequest = {
        id: `CR-${String(Math.max(0, ...numbers) + 1).padStart(2, '0')}`,
        requested_at: now,
        feedback,
        status: 'open',
        request_id: requestId,
      };
      const updated = { ...existing, status: 'in_progress' as TaskStatus, change_requests: [...requests, request], updated_at: now } as Task;
      stampStatusDates(existing.status, updated, now);
      const { path: _path, body: _body, ...frontmatter } = updated;
      await fileService.writeMarkdown(taskFile, frontmatter as Record<string, unknown>, content);
      await this.generateSlashCommand();
      return { task: { ...updated, body: content || undefined, path: taskFile }, request, created: true };
    });
  }

  /**
   * Sets what the task waits for (#82), replacing an earlier record. Under the task's lock; refused (409) when the task
   * changed since the user saw it. The status is left as it is.
   */
  async setWaiting(id: string, input: unknown): Promise<Task> {
    const b = input && typeof input === 'object' ? input as Record<string, unknown> : {};
    const w = b['waiting'] && typeof b['waiting'] === 'object' ? b['waiting'] as Record<string, unknown> : {};
    const what = typeof w['for'] === 'string' ? w['for'].trim() : '';
    if (!what) throw httpError(400, 'Say what the task is waiting for.');
    if (what.length > MAX_WAITING_TEXT) throw httpError(400, `Keep it under ${MAX_WAITING_TEXT} characters.`);
    const rawParty = w['party'] && typeof w['party'] === 'object' ? w['party'] as Record<string, unknown> : null;
    let party: Waiting['party'] = null;
    if (rawParty && typeof rawParty['ref'] === 'string' && rawParty['ref']) {
      if (!STAKEHOLDER_REF.test(rawParty['ref'])) throw httpError(400, 'Invalid stakeholder.');
      // A party that is not on file would show as a bare id: refused, so the user picks one or types a name.
      const onFile = await new StakeholderService().getStakeholder(rawParty['ref']).then(() => true, () => false);
      if (!onFile) throw httpError(400, 'That stakeholder does not exist. Pick one from the list, or type a name.');
      party = { ref: rawParty['ref'] };
    } else if (rawParty && typeof rawParty['name'] === 'string' && rawParty['name'].trim()) {
      const name = rawParty['name'].trim();
      if (name.length > MAX_PARTY_NAME) throw httpError(400, `Keep the name under ${MAX_PARTY_NAME} characters.`);
      party = { name };
    }
    const since = w['since'] === undefined || w['since'] === '' ? localToday() : w['since'];
    if (!isDay(since)) throw httpError(400, 'The since date must be a date.');
    if (since > localToday()) throw httpError(400, 'The since date cannot be in the future.');
    const followUp = w['follow_up'] === undefined || w['follow_up'] === '' || w['follow_up'] === null ? undefined : w['follow_up'];
    if (followUp !== undefined && !isDay(followUp)) throw httpError(400, 'The follow-up date must be a date.');
    if (followUp !== undefined && followUp < since) throw httpError(400, 'The follow-up date cannot be before the since date.');
    const waiting: Waiting = { for: what, party, since, ...(followUp ? { follow_up: followUp } : {}), set_at: new Date().toISOString() };
    return this.writeServerField(id, b['seen_updated_at'], { waiting });
  }

  /** Resolves the waiting (#82): the record goes, the task stays as it is. */
  async resolveWaiting(id: string, input: unknown): Promise<Task> {
    const b = input && typeof input === 'object' ? input as Record<string, unknown> : {};
    return this.writeServerField(id, b['seen_updated_at'], { waiting: undefined });
  }

  /** One server-owned field changed under the task's lock, after a stale-view check; nothing else is touched. */
  private async writeServerField(id: string, seen: unknown, change: Record<string, unknown>): Promise<Task> {
    if (typeof seen !== 'string') throw httpError(400, 'Say which version of the task you saw.');
    return this.withTaskLock(id, async () => {
      const taskFile = path.join(this.getActiveDir(), topLevelName(id), 'task.md');
      const { data, content } = await fileService.readMarkdown<Task>(taskFile);
      if (data.updated_at !== seen) throw httpError(409, 'The task changed since you opened it. Read it again, then try again.');
      const updated: Record<string, unknown> = { ...data, ...change, updated_at: nextUpdatedAt(data.updated_at) };
      for (const [key, value] of Object.entries(change)) if (value === undefined) delete updated[key];
      await fileService.writeMarkdown(taskFile, updated, content);
      await this.generateSlashCommand();
      return { ...(updated as unknown as Task), body: content || undefined, path: taskFile };
    });
  }

  async updateTask(id: string, data: Partial<Task>): Promise<Task> {
    checkBoardColumn((data as Record<string, unknown>)['board_column'], true);
    return this.withTaskLock(id, () => this.updateTaskUnlocked(id, data));
  }

  private async updateTaskUnlocked(id: string, data: Partial<Task>): Promise<Task> {
    const existing = await this.getTask(id);
    const taskFile = path.join(this.getActiveDir(), topLevelName(id), 'task.md');
    const { content: existingContent } = await fileService.readMarkdown<Task>(taskFile);

    const now = nextUpdatedAt(existing.updated_at);
    const updated: Task = {
      ...existing,
      ...data,
      id,
      updated_at: now,
    };

    stampStatusDates(existing.status, updated, now);
    if (updated['board_column'] === null) delete updated['board_column'];
    // What the server recorded about the task's origin stays as it was, whatever the request says.
    for (const key of SERVER_FIELDS) {
      if (key in existing) (updated as Record<string, unknown>)[key] = (existing as Record<string, unknown>)[key];
      else delete (updated as Record<string, unknown>)[key];
    }

    // body is the markdown content — keep it out of frontmatter
    const { path: _path, body: newBody, ...frontmatter } = updated;
    const content = typeof newBody === 'string' ? newBody : existingContent;
    await fileService.writeMarkdown(taskFile, frontmatter as Record<string, unknown>, content);
    const savedTask = { ...updated, path: taskFile };
    await this.generateSlashCommand();
    return savedTask;
  }

  async deleteTask(id: string): Promise<void> {
    await this.withTaskLock(id, async () => {
      const taskDir = path.join(this.getActiveDir(), topLevelName(id));
      if (!(await fileService.exists(taskDir))) {
        throw new Error(`Task not found: ${id}`);
      }
      await fsp.rm(taskDir, { recursive: true, force: true });
    }, false);
  }

  /**
   * For a caller that must decide and act on a task in one step (System cleanup): runs `fn` under the task's lock, with
   * an archive that does not take the lock again. Whatever `fn` reads there is what it acts on.
   */
  async underTaskLock<T>(id: string, fn: (ops: { archive: () => Promise<void> }) => Promise<T>): Promise<T> {
    return this.withTaskLock(id, () => fn({ archive: () => this.archiveTaskUnlocked(id) }), false);
  }

  async archiveTask(id: string): Promise<void> {
    await this.withTaskLock(id, () => this.archiveTaskUnlocked(id), false);
  }

  private async archiveTaskUnlocked(id: string): Promise<void> {
    const activeDir = path.join(this.getActiveDir(), topLevelName(id));
    const archiveDir = path.join(this.getArchiveDir(), topLevelName(id));

    if (!(await fileService.exists(activeDir))) {
      throw new Error(`Task not found: ${id}`);
    }

    await fileService.ensureDir(this.getArchiveDir());
    await fsp.rename(activeDir, archiveDir);

    // Update status to archived; a deliverable's path inside the task's own folder moves with it, so its file still opens.
    const taskFile = path.join(archiveDir, 'task.md');
    const { data, content } = await fileService.readMarkdown<Task>(taskFile);
    data.status = 'archived';
    if (Array.isArray(data.deliverables)) data.deliverables = inArchive(data.deliverables, id);
    data.updated_at = nextUpdatedAt(data.updated_at);
    await fileService.writeMarkdown(taskFile, data as unknown as Record<string, unknown>, content);
  }

  async getTaskContent(id: string): Promise<string> {
    const taskFile = path.join(this.getActiveDir(), topLevelName(id), 'task.md');
    if (!(await fileService.exists(taskFile))) {
      throw new Error(`Task not found: ${id}`);
    }
    const { content } = await fileService.readMarkdown<Task>(taskFile);
    return content;
  }

  async updateTaskContent(id: string, content: string): Promise<void> {
    await this.withTaskLock(id, async () => {
      const taskFile = path.join(this.getActiveDir(), topLevelName(id), 'task.md');
      const { data } = await fileService.readMarkdown<Task>(taskFile);
      data.updated_at = nextUpdatedAt(data.updated_at);
      await fileService.writeMarkdown(taskFile, data as unknown as Record<string, unknown>, content);
    });
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

    // Ids of tasks the cleanup job removed stay taken, so old links never point at a new task.
    maxSeq = Math.max(maxSeq, await reservedSequence(prefix));

    // mkdir without recursive is an exclusive reservation shared by CLI and server writers.
    // A scan alone lets simultaneous manual and scheduled tasks overwrite the same task.md.
    for (;;) {
      const id = `${prefix}${String(++maxSeq).padStart(4, '0')}`;
      try {
        await fsp.mkdir(path.join(activeDir, id));
        return id;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
    }
  }

  async listTaskFiles(id: string): Promise<FolderFile[]> {
    const taskDir = path.join(this.getActiveDir(), topLevelName(id));
    if (!(await fileService.exists(taskDir))) throw new Error(`Task not found: ${id}`);

    const entries = await fsp.readdir(taskDir, { withFileTypes: true });
    const results: FolderFile[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || entry.name === 'task.md') continue;
      const filePath = path.join(taskDir, entry.name);
      const stat = await fsp.stat(filePath);
      results.push(await withOfficeCheck({
        name: entry.name,
        size: stat.size,
        modified: stat.mtime.toISOString(),
        type: path.extname(entry.name).slice(1).toLowerCase() || 'file',
      }, filePath));
    }
    return results.sort((a, b) => b.modified.localeCompare(a.modified));
  }

  async saveTaskFile(id: string, originalName: string, buffer: Buffer): Promise<FolderFile> {
    const taskDir = path.join(this.getActiveDir(), topLevelName(id));
    if (!(await fileService.exists(taskDir))) throw new Error(`Task not found: ${id}`);

    return saveAttachment(taskDir, originalName, buffer, 'task.md');
  }

  async deleteTaskFile(id: string, filename: string): Promise<void> {
    const safe = topLevelName(filename);
    if (safe.toLowerCase() === 'task.md') throw new Error('Invalid file name: cannot delete task.md');
    const filePath = path.join(this.getActiveDir(), topLevelName(id), safe);
    await fsp.unlink(filePath);
  }
}
