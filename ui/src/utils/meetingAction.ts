import type { ContextUpdate, MeetingRecord, NewTaskDraft, Stakeholder } from '@/types';

/**
 * The New task form's starting values for an action item of a confirmed meeting record. The objective says
 * where it comes from, so the task stands on its own; the owner becomes the stakeholder when that stakeholder
 * exists and has the name the record gives. Everything stays editable; saving creates the task and links the
 * item to it in one step.
 */
/** Whitespace only: no case, alias, order or transliteration guessing. */
function sameText(a: string, b: string): boolean {
  const norm = (s: string) => s.replace(/[\s\u3000]+/g, ' ').trim();
  return norm(a) === norm(b);
}

/**
 * Whether the name written in the record is this stakeholder's stored name. A stakeholder name may hold two
 * forms, "Family Given (漢字)": either form alone counts too. Anything else is a mismatch, never a guess.
 */
export function namesMatch(written: string, stakeholderName: string): boolean {
  if (!written.trim()) return true;
  const forms = [stakeholderName];
  const m = /^(.*?)\s*\((.+)\)\s*$/.exec(stakeholderName);
  if (m) forms.push(m[1]!, m[2]!);
  return forms.some((f) => sameText(written, f));
}

export function meetingActionDraft(
  update: Pick<ContextUpdate, 'id'>,
  record: MeetingRecord,
  item: number,
  owner?: Stakeholder,
): NewTaskDraft {
  const action = record.action_items[item]!;
  const meeting = `${record.title || 'a meeting'}${record.meeting_date ? ` on ${record.meeting_date}` : ''}`;
  const who = action.owner ? (action.owner.ref === 'me' ? 'me' : action.owner.name || action.owner.ref) : '';
  // The stakeholder is filled in only when the record's name is that stakeholder's name: a wrong link from
  // the agent must not silently put someone else on the task.
  const mismatch = owner && action.owner && !namesMatch(action.owner.name, owner.name);
  const lines = [
    `Action item from ${meeting} (context update ${update.id}, meeting record ${record.id}):`,
    '',
    action.description,
    ...(who ? ['', `Owner: ${who}`] : []),
    ...(action.due_date ? [`Due: ${action.due_date}`] : []),
    ...(mismatch ? ['', `Stakeholder not set: the record names "${action.owner!.name}" but links ${owner!.id}, which is ${owner!.name}. Choose the stakeholder yourself.`] : []),
  ];
  return {
    title: action.description.length > 200 ? `${action.description.slice(0, 197)}...` : action.description,
    objective: lines.join('\n'),
    stakeholders: owner && !mismatch ? [owner] : [],
    due_date: action.due_date || undefined,
    meeting_action: { update_id: update.id, record_id: record.id, item, revision: record.revision },
  };
}
