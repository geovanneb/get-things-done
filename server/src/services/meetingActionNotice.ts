import { actionItemKey, CORRECTION_KIND, ContextUpdateService, type ContextUpdate, type MeetingActionItem, type MeetingRecord } from './contextUpdateService';
import { correctionChain } from './meetingCorrections';
import { heldMeetings } from './meetingLibrary';
import type { MeetingActionSource } from './taskService';

/** One property of an action item that differs between the version a task was made from and the current one. */
export interface ActionChange { property: 'description' | 'owner' | 'due_date'; before: string; after: string }

/**
 * Whether the meeting record a task was made from has changed since, for the task's own action item:
 * - `none`: the task was not made from a meeting action;
 * - `current`: the current version says the same about the item as the version the task was made from;
 * - `changed`: it says something else (`changes`);
 * - `conflict` or `broken`: the versions of the record do not hold, so nothing is compared;
 * - `unknown`: the version the task was made from is not one of the record's versions now (gone or changed), or
 *   what the task recorded about it cannot be read;
 * - `ambiguous`: the task was made before tasks recorded their item, and the original has two items alike;
 * - `gone`: the original record or the item is no longer there.
 * `legacy` says the task did not record its version (it was made before tasks did), so the original record stands in
 * for it; the comparison then says so, since that task may have been made from a later version.
 */
export interface ActionNotice {
  state: 'none' | 'current' | 'changed' | 'conflict' | 'broken' | 'unknown' | 'ambiguous' | 'gone';
  meeting: string | null;
  changes: ActionChange[];
  /** The version the task was compared with, when there is one that holds. */
  current: { update_id: string; record_id: string; at: string | null } | null;
  legacy: boolean;
}

const IDENTITY = /^(CU-\d{4}-\d{4})\/(M-\d{2,3})\/([0-9a-f]{12})$/;
const contextUpdates = new ContextUpdateService();

const personText = (p: MeetingActionItem['owner']) => (p ? (p.ref ? `${p.name} (${p.ref})` : p.name) : '');

/** The item a version holds for the original item at `rootIndex`: through its slots for a correction, by place in the original. */
function itemIn(u: ContextUpdate, record: MeetingRecord, rootIndex: number): MeetingActionItem | null {
  if (u.kind === CORRECTION_KIND && u.correction) {
    const slot = u.correction.slots.find((s) => s.root_index === rootIndex);
    const at = slot ? record.action_items.findIndex((a) => a.slot === slot.slot) : -1;
    return at >= 0 ? record.action_items[at]! : null;
  }
  return record.action_items[rootIndex] ?? null;
}

function compare(before: MeetingActionItem, after: MeetingActionItem): ActionChange[] {
  const changes: ActionChange[] = [];
  if (before.description !== after.description) changes.push({ property: 'description', before: before.description, after: after.description });
  if (JSON.stringify([before.owner?.ref ?? null, before.owner?.name ?? null]) !== JSON.stringify([after.owner?.ref ?? null, after.owner?.name ?? null])) {
    changes.push({ property: 'owner', before: personText(before.owner), after: personText(after.owner) });
  }
  if ((before.due_date || '') !== (after.due_date || '')) changes.push({ property: 'due_date', before: before.due_date || '', after: after.due_date || '' });
  return changes;
}

/**
 * The notice for a task made from a meeting action item. Computed from the updates each time, never stored: the
 * task's fields are the user's and are never changed by it. Compares the item in the version the task was made from
 * with the item in the current version, only while the versions hold, and never guesses which item or version is meant.
 * In order: the original and its meeting, then the versions (a conflict or a broken chain is said first), then the
 * version the task was made from, then the item.
 */
export async function actionNotice(task: Record<string, unknown>): Promise<ActionNotice> {
  const result = (state: ActionNotice['state'], extra: Partial<ActionNotice> = {}): ActionNotice => ({ state, meeting: null, changes: [], current: null, legacy: false, ...extra });
  const identity = typeof task['meeting_action'] === 'string' ? IDENTITY.exec(task['meeting_action']) : null;
  if (!identity) return result('none');
  const [, rootUpdateId, rootRecordId, key] = identity as unknown as [string, string, string, string];
  // No version recorded: an older task, compared with the original. One recorded but unreadable: never compared.
  const legacy = !('meeting_action_source' in task);
  const raw = task['meeting_action_source'] as Partial<MeetingActionSource> | null | undefined;
  const source = raw && typeof raw === 'object' && typeof raw.update_id === 'string' && typeof raw.record_id === 'string' && typeof raw.revision === 'string'
    && typeof raw.root_index === 'number' && Number.isInteger(raw.root_index) && raw.root_index >= 0 ? raw as MeetingActionSource : null;

  // The meeting is the original's own, as its update holds it; a correction's claim never decides it.
  const all = await contextUpdates.list();
  const rootUpdate = all.find((u) => u.id === rootUpdateId);
  const meeting = rootUpdate ? heldMeetings(rootUpdate).find((m) => m.record?.id === rootRecordId)?.id ?? null : null;
  if (!rootUpdate || !meeting) return result('gone', { legacy });
  const shownMeeting = heldMeetings(rootUpdate).find((m) => m.id === meeting)?.linkable ? meeting : null;
  const chain = correctionChain(meeting, { update_id: rootUpdateId, record_id: rootRecordId }, all);
  if (chain.state === 'conflict' || chain.state === 'broken') return result(chain.state, { meeting: shownMeeting, legacy });
  const head = chain.links[chain.links.length - 1];
  const rootRecord = rootUpdate.meeting_records.find((r) => r.id === rootRecordId);
  if (!head || !rootRecord) return result('gone', { meeting: shownMeeting, legacy });
  if (!legacy && !source) return result('unknown', { meeting: shownMeeting });
  const baseline = source ?? { update_id: rootUpdateId, record_id: rootRecordId, revision: rootRecord.revision };
  if (!chain.links.some((l) => l.update_id === baseline.update_id && l.record_id === baseline.record_id && l.revision === baseline.revision)) {
    return result('unknown', { meeting: shownMeeting, legacy });
  }

  // Which original item: the one the task recorded; for an older task, the one item with its key, never one of two.
  let rootIndex: number;
  if (source) {
    rootIndex = source.root_index;
    const item = rootRecord.action_items[rootIndex];
    if (!item || actionItemKey(item) !== key) return result('gone', { meeting: shownMeeting });
  } else {
    const matches = rootRecord.action_items.flatMap((a, i) => (actionItemKey(a) === key ? [i] : []));
    if (matches.length === 0) return result('gone', { meeting: shownMeeting, legacy });
    if (matches.length > 1) return result('ambiguous', { meeting: shownMeeting, legacy });
    rootIndex = matches[0]!;
  }

  const versionItem = (v: { update_id: string; record_id: string }) => {
    const u = all.find((x) => x.id === v.update_id);
    const r = u?.meeting_records.find((x) => x.id === v.record_id);
    return u && r ? itemIn(u, r, rootIndex) : null;
  };
  const before = versionItem(baseline);
  const after = versionItem(head);
  if (!before || !after) return result('gone', { meeting: shownMeeting, legacy });
  const changes = compare(before, after);
  return result(changes.length ? 'changed' : 'current', { meeting: shownMeeting, legacy, changes, current: { update_id: head.update_id, record_id: head.record_id, at: head.at } });
}
