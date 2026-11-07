import * as path from 'path';
import { promises as fsp } from 'fs';
import { ContextUpdateService, type ContextUpdate } from './contextUpdateService';
import { FileService } from './fileService';
import { actionNotice, type ActionNotice } from './meetingActionNotice';
import { heldMeetings, isMeetingId } from './meetingLibrary';
import { checkSelectionForMeeting, readTaskSelections, resolveMeeting, reviewChangeOf, type MeetingSelection, type PinnedMeeting, type ReviewChange } from './meetingSources';
import { MentionService } from './mentionService';
import { WorkspaceService } from './workspace';
import { workspaceEntry } from '../utils/files';

/**
 * The reverse of a task's meeting sources: from one meeting, the tasks that used it and how each stands now. On demand
 * and never changing a task: nothing is pinned, reopened, rewritten or run, and nothing says a deliverable is wrong. A
 * change is something to look at, never proof. Uses the comparisons the task page shows; no new ones. Reading the
 * meeting goes through the same path opening it does, which may finish that update's own pending tidy-up.
 */

/** Most important first. `not_compared`: something could not be compared, so nothing is claimed about it. */
export const RELATED_STATES = ['not_compared', 'changed', 'pin_failed', 'unpinned', 'older_version', 'no_change', 'related'] as const;
export type RelatedState = typeof RELATED_STATES[number];

/** One thing found about a task, as a code the dashboard words in its language. Never free text from a file. */
export type RelatedFinding =
  | { code: 'meeting_unreadable' | 'selection_damaged' | 'source_changed' | 'source_missing' | 'older_version' | 'pin_failed' | 'unavailable_when_pinned' | 'unpinned' | 'action_legacy' }
  | { code: 'record_changed'; change: ReviewChange }
  /** Which properties of the action item differ, never their values. */
  | { code: 'action_changed'; properties: string[] }
  | { code: 'action_not_compared'; reason: ActionNotice['state'] };

export interface RelatedTask {
  id: string;
  title: string;
  status: string;
  archived: boolean;
  /**
   * How the task is tied to the meeting. `latest`: pinned in its latest selection. `earlier`: pinned in an earlier one.
   * A pin that failed is a finding, not a tie.
   */
  via: { latest: boolean; earlier: boolean; mention: boolean; action: boolean };
  selection: string | null;
  state: RelatedState;
  findings: RelatedFinding[];
  /** The task's complete deliverables, by id and file name: what exists on the task, not what was made from the meeting. */
  deliverables: { id: string; name: string }[];
}

export type SkipReason = 'folder_unreadable' | 'task_unreadable' | 'selection_damaged' | 'update_unreadable' | 'check_failed';

export interface RelatedWork {
  meeting: string;
  meeting_readable: boolean;
  tasks: RelatedTask[];
  scanned: number;
  /** Tasks, folders or updates that could not be checked: never silently dropped. */
  skipped: { item: string; reason: SkipReason }[];
}

const workspace = new WorkspaceService();
const fileService = new FileService();
const mentions = new MentionService();
const contextUpdates = new ContextUpdateService();
const IDENTITY = /^(CU-\d{4}-\d{4})\/(M-\d{2,3})\//;
const TASK_ID = /^TASK-\d{4}-\d{4}$/;
const UPDATE_ID = /^CU-\d{4}-\d{4}$/;

const order = (s: RelatedState) => RELATED_STATES.indexOf(s);

/**
 * The original records (update/record) whose meeting is this one: how a task made from an action item is matched. An
 * update folder the list could not read is reported, since a task made from it would otherwise go unnoticed.
 */
async function recordsOfMeeting(meetingId: string, skipped: RelatedWork['skipped'], updates: ContextUpdate[] | null): Promise<Set<string>> {
  const keys = new Set<string>();
  if (!updates) { skipped.push({ item: 'context-updates', reason: 'folder_unreadable' }); return keys; }
  for (const u of updates) {
    for (const m of heldMeetings(u)) if (m.id === meetingId && m.record) keys.add(`${u.id}/${m.record.id}`);
  }
  const listed = new Set(updates.map((u) => u.id));
  // The list says nothing when the folder itself cannot be read, so read it here too and say so.
  let folders: import('fs').Dirent[] = [];
  try {
    folders = await fsp.readdir(path.join(workspace.getWorkspacePath(), 'context-updates'), { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') skipped.push({ item: 'context-updates', reason: 'folder_unreadable' });
  }
  for (const f of folders) if (f.isDirectory() && UPDATE_ID.test(f.name) && !listed.has(f.name)) skipped.push({ item: f.name, reason: 'update_unreadable' });
  return keys;
}

function stateOf(findings: RelatedFinding[], inLatest: boolean): RelatedState {
  const has = (...codes: RelatedFinding['code'][]) => findings.some((f) => codes.includes(f.code));
  if (has('meeting_unreadable', 'selection_damaged', 'action_not_compared')) return 'not_compared';
  if (has('source_changed', 'source_missing', 'record_changed', 'action_changed')) return 'changed';
  if (has('pin_failed')) return 'pin_failed';
  if (has('unpinned')) return 'unpinned';
  if (has('older_version')) return 'older_version';
  return inLatest ? 'no_change' : 'related';
}

function actionFindings(notice: ActionNotice): RelatedFinding[] {
  const out: RelatedFinding[] = [];
  if (notice.state === 'changed') out.push({ code: 'action_changed', properties: notice.changes.map((c) => c.property) });
  else if (notice.state !== 'current' && notice.state !== 'none') out.push({ code: 'action_not_compared', reason: notice.state });
  if (notice.legacy) out.push({ code: 'action_legacy' });
  return out;
}

async function relatedTask(
  meetingId: string, now: PinnedMeeting | null, records: Set<string>, updates: ContextUpdate[],
  taskFile: string, data: Record<string, unknown>, body: string, archived: boolean,
): Promise<RelatedTask | 'selection_damaged' | null> {
  const id = String(data['id'] ?? path.basename(path.dirname(taskFile)));
  let selections: MeetingSelection[] = [];
  let damaged = false;
  try {
    selections = await readTaskSelections(taskFile);
  } catch {
    damaged = true;
  }
  const latest = selections.at(-1) ?? null;
  const pinned = latest?.meetings.find((m) => m.id === meetingId) ?? null;
  const failedPin = Boolean(latest?.problems.some((p) => p.id === meetingId));
  const earlier = selections.slice(0, -1).some((s) => s.meetings.some((m) => m.id === meetingId));
  const mention = mentions.meetingIds(body).includes(meetingId);
  const identity = typeof data['meeting_action'] === 'string' ? IDENTITY.exec(data['meeting_action']) : null;
  const action = Boolean(identity && records.has(`${identity[1]}/${identity[2]}`));

  // Not tied in any way that can be seen. A damaged selection may hide a tie, so it is reported, not dropped.
  if (!pinned && !failedPin && !earlier && !mention && !action) return damaged ? 'selection_damaged' : null;

  const findings: RelatedFinding[] = [];
  if (damaged) {
    // Whether the meeting was pinned is unknown: never "not pinned yet", and the task's own refresh repairs it.
    findings.push({ code: 'selection_damaged' });
  } else if (pinned && latest) {
    if (!now) {
      findings.push({ code: 'meeting_unreadable' });
    } else {
      const check = await checkSelectionForMeeting(latest, meetingId, now);
      for (const s of check.sources) {
        if (s.state === 'changed') findings.push({ code: 'source_changed' });
        else if (s.state === 'missing') findings.push({ code: 'source_missing' });
        else if (s.older_version) findings.push({ code: 'older_version' });
      }
      const change = reviewChangeOf(pinned, now);
      if (change) findings.push({ code: 'record_changed', change });
    }
    if (pinned.unavailable.length > 0) findings.push({ code: 'unavailable_when_pinned' });
  }
  if (failedPin) findings.push({ code: 'pin_failed' });
  if (mention && !pinned && !failedPin && !damaged) findings.push({ code: 'unpinned' });
  if (action) findings.push(...actionFindings(await actionNotice({ ...data, id }, updates)));

  const deliverables = (Array.isArray(data['deliverables']) ? data['deliverables'] : []).flatMap((d: unknown) => {
    const o = d && typeof d === 'object' ? d as Record<string, unknown> : null;
    if (!o || o['status'] !== 'complete' || typeof o['id'] !== 'string') return [];
    const file = typeof o['file_path'] === 'string' ? path.posix.basename(o['file_path'].replace(/\\/g, '/')) : '';
    return [{ id: o['id'], name: file }];
  });

  return {
    id,
    title: String(data['title'] ?? ''),
    status: String(data['status'] ?? ''),
    archived,
    via: { latest: Boolean(pinned), earlier, mention, action },
    selection: latest?.id ?? null,
    state: stateOf(findings, Boolean(pinned)),
    findings,
    deliverables,
  };
}

/** Every task, active and archived, that used the meeting, with how it stands now. */
export async function relatedWork(meetingId: string): Promise<RelatedWork> {
  if (!isMeetingId(meetingId)) throw Object.assign(new Error('Invalid meeting id'), { statusCode: 400 });
  const ws = workspace.getWorkspacePath();
  // Resolved once for every task. A meeting that cannot be read is said, never taken for deleted sources.
  const now = await resolveMeeting(meetingId).catch(() => null);
  const result: RelatedWork = { meeting: meetingId, meeting_readable: now !== null, tasks: [], scanned: 0, skipped: [] };
  // Reuse this request's snapshot for every action comparison; never rescan all updates for each task.
  const updates = await contextUpdates.list().catch(() => null);
  const records = await recordsOfMeeting(meetingId, result.skipped, updates);

  for (const [folder, archived] of [['active', false], ['archive', true]] as const) {
    let dir: string;
    let entries: import('fs').Dirent[];
    try {
      // The folder itself, with no link anywhere below the workspace.
      dir = await workspaceEntry(ws, path.join(ws, 'tasks', folder));
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') result.skipped.push({ item: `tasks/${folder}`, reason: 'folder_unreadable' });
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !TASK_ID.test(entry.name)) continue;
      const taskFile = path.join(dir, entry.name, 'task.md');
      let data: Record<string, unknown>;
      let body: string;
      try {
        // A plain task.md inside the workspace, reached through no link: an outside file is never read.
        await workspaceEntry(ws, taskFile);
        const stat = await fsp.lstat(taskFile);
        if (!stat.isFile()) throw new Error('not a file');
        result.scanned++;
        const read = await fileService.readMarkdown<Record<string, unknown>>(taskFile);
        data = read.data;
        body = read.content;
      } catch (err) {
        // A folder without a task.md is not a task; anything else that stops the read is reported.
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') result.skipped.push({ item: entry.name, reason: 'task_unreadable' });
        continue;
      }
      try {
        const row = await relatedTask(meetingId, now, records, updates ?? [], taskFile, data, body, archived);
        if (row === 'selection_damaged') result.skipped.push({ item: entry.name, reason: 'selection_damaged' });
        else if (row) result.tasks.push(row);
      } catch {
        result.skipped.push({ item: entry.name, reason: 'check_failed' });
      }
    }
  }

  result.tasks.sort((a, b) => Number(a.archived) - Number(b.archived) || order(a.state) - order(b.state) || a.id.localeCompare(b.id));
  return result;
}
