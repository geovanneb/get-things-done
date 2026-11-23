import type { HistoryMeeting, MeetingDetail, MeetingPerson, MeetingRecord, NewTaskDraft, OutputTemplate, Stakeholder } from '@/types';
import type { MeetingRow } from './meetingHistory';
import { actionTitle, namesMatch } from './meetingAction';

/**
 * Whether a task can be made from a meeting now: one waiting in the queue, or one an update holds whose id is final.
 * A record-only meeting whose update is still reviewed can be renumbered, so it cannot be linked to yet.
 */
export function canMakeDeliverable(row: Pick<MeetingRow, 'inTrash' | 'queued' | 'held'>): boolean {
  if (row.inTrash) return false;
  if (row.queued) return row.queued.status === 'queued' && !row.queued.in_digest;
  return Boolean(row.held?.linkable);
}

/** Whether the meeting has a confirmed record to build the draft from. Queued meetings and others keep the plain draft. */
export function hasConfirmedRecord(row: Pick<MeetingRow, 'held'>): boolean {
  return row.held?.record?.confirmation === 'confirmed';
}

/**
 * Whether an action item of this meeting's record can become a task now: the same rule as on the meeting's Tasks tab
 * (record confirmed, review done, and its versions agree).
 */
export function canTaskFromAction(meeting: Pick<HistoryMeeting, 'update' | 'correction'>, record: Pick<MeetingRecord, 'confirmation'>): boolean {
  const versions = meeting.correction;
  const holds = !versions || versions.state === 'original' || versions.state === 'corrected';
  return record.confirmation === 'confirmed' && meeting.update.status === 'done' && holds;
}

/** A meeting mention as the picker writes it: `[@Title · 2026-10-30](/meetings/MQ-2026-0012)`. */
export function meetingMention(row: Pick<MeetingRow, 'id' | 'title' | 'date'>): string {
  // Square brackets would end the link text early.
  const label = `${row.title.replace(/[[\]]/g, (c) => (c === '[' ? '(' : ')'))}${row.date ? ` · ${row.date}` : ''}`;
  return `[@${label}](/meetings/${row.id})`;
}

/**
 * The stakeholders the record's attendees and named speakers are, offered as the deliverable's audience for the user
 * to tick. A person counts only when the record links that stakeholder with the same stored name, or, when the record
 * gives no stakeholder id at all, when exactly one stakeholder has that name (whitespace aside, either form of
 * "Family Given (漢字)"). Near misses, a link whose name differs, an id that no longer resolves (it names someone
 * else, never a namesake) and the user ("me") are never suggested.
 */
export function audienceSuggestions(record: Pick<MeetingRecord, 'attendees' | 'speakers'>, stakeholders: Stakeholder[]): Stakeholder[] {
  const people: MeetingPerson[] = [...record.attendees, ...record.speakers.flatMap((s) => (s.person ? [s.person] : []))];
  const found: Stakeholder[] = [];
  for (const p of people) {
    if (p.ref === 'me') continue;
    let match: Stakeholder | undefined;
    if (p.ref?.trim()) {
      const linked = stakeholders.find((s) => s.id === p.ref);
      match = linked && namesMatch(p.name, linked.name) ? linked : undefined;
    } else if (p.name.trim()) {
      const same = stakeholders.filter((s) => namesMatch(p.name, s.name));
      match = same.length === 1 ? same[0] : undefined;
    }
    if (match && !found.some((s) => s.id === match.id)) found.push(match);
  }
  return found;
}

const norm = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[\s\u3000]+/g, ' ').trim();

/** Whether `text` holds `phrase` as whole words (Latin letters and digits at its ends need a boundary). */
function holdsPhrase(text: string, phrase: string): boolean {
  const p = norm(phrase);
  if (!p) return false;
  const body = p.split(' ').map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
  const start = /^[a-z0-9]/.test(p) ? '(?<![\\p{L}\\p{N}])' : '';
  const end = /[a-z0-9]$/.test(p) ? '(?![\\p{L}\\p{N}])' : '';
  return new RegExp(`${start}${body}${end}`, 'u').test(norm(text));
}

type TemplateInfo = Pick<OutputTemplate, 'id' | 'name' | 'format'>;

/**
 * The output template an action item names in full ("the Executive deck"), or null. When several names are found, only
 * a name that holds the others counts ("Executive deck v2" over "Executive deck"); two distinct names leave it empty.
 * Kinds of deliverable or file formats ("a deck", "a PDF") are never guessed from: the user picks the template.
 */
export function templateFor(action: string, templates: TemplateInfo[]): TemplateInfo | null {
  if (!action.trim() || !templates.length) return null;
  const named = templates.filter((t) => holdsPhrase(action, t.name));
  // Drop a name another named one holds (a name and its extension); what is left must be one template.
  const best = named.filter((t) => !named.some((o) => o !== t && norm(o.name) !== norm(t.name) && holdsPhrase(o.name, t.name)));
  return best.length === 1 ? best[0]! : null;
}

/** Why a meeting's record cannot be drafted from now, or null when it can. */
export type RecordProblem = 'not_confirmed' | 'versions' | 'changed';

/**
 * Whether the facts of a meeting's record may go into a draft: it is confirmed, its versions agree (no conflicting or
 * broken correction, whose facts could not be pinned), and, when `revision` is given, it is still the version the user
 * chose from.
 */
export function recordProblem(detail: Pick<MeetingDetail, 'meeting' | 'record'>, revision?: string): RecordProblem | null {
  const versions = detail.meeting.correction;
  if (versions && versions.state !== 'original' && versions.state !== 'corrected') return 'versions';
  if (!detail.record || detail.record.confirmation !== 'confirmed') return 'not_confirmed';
  if (revision !== undefined && detail.record.revision !== revision) return 'changed';
  return null;
}

/**
 * Whether `text` holds an @-mention of this meeting the server counts (`[@label](/meetings/<id>)`, the meeting form of
 * the server's MENTION_RE in mentionService). A plain link (`[label](/meetings/<id>)`) is not a mention: it pins nothing.
 */
export function mentionsMeeting(text: string, id: string): boolean {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\[@[^\\]\\n]+\\]\\(\\/meetings\\/${escaped}\\)`).test(text);
}

/**
 * The action-to-task draft with the meeting mentioned in its objective, so the new task pins the meeting's sources like
 * any task that mentions one.
 */
export function withMeetingMention(draft: NewTaskDraft, row: Pick<MeetingRow, 'id' | 'title' | 'date'>): NewTaskDraft {
  const mention = meetingMention(row);
  if (mentionsMeeting(draft.objective ?? '', row.id)) return draft;
  return { ...draft, objective: `${draft.objective ?? ''}\n\nFrom this meeting:\n\n- ${mention}`.trimStart() };
}

/** What the draft for one meeting with a confirmed record is built from. */
export interface DeliverableSource {
  record: MeetingRecord;
  /** The action item the deliverable is for, or null for the meeting as a whole. */
  item: number | null;
  stakeholders: Stakeholder[];
  templates: TemplateInfo[];
}

/**
 * The New task form for a deliverable made from meetings: their mentions in the Objective and one deliverable for the
 * output template. With one meeting and its confirmed record, the objective also holds the record's decisions and the
 * chosen action item, its people are offered as the audience to tick (never added), and a template is picked only
 * when the action item names one. Several meetings, or one without a confirmed record, keep the plain draft.
 */
export function deliverableDraft(rows: Pick<MeetingRow, 'id' | 'title' | 'date'>[], source?: DeliverableSource): NewTaskDraft {
  if (rows.length === 1 && source?.record.confirmation === 'confirmed') return recordDraft(rows[0]!, source);
  const title = rows.length === 1 ? `Deliverable from ${rows[0]!.title}` : `Deliverable from ${rows.length} meetings`;
  const objective = [
    `Make a deliverable from ${rows.length === 1 ? 'this meeting' : 'these meetings'}:`,
    '',
    ...rows.map((r) => `- ${meetingMention(r)}`),
    '',
    'Choose the output template under Deliverables, and say who it is for under Stakeholders.',
  ].join('\n');
  return { title, objective, deliverables: [{}] };
}

function recordDraft(row: Pick<MeetingRow, 'id' | 'title' | 'date'>, { record, item, stakeholders, templates }: DeliverableSource): NewTaskDraft {
  const action = item === null ? undefined : record.action_items[item];
  // One line each, so a list item never breaks apart.
  const line = (text: string) => text.replace(/\s*\n\s*/g, ' ').trim();
  const decisions = record.decisions.map(line).filter(Boolean);
  const suggested = audienceSuggestions(record, stakeholders);
  const template = action ? templateFor(action.description, templates) : null;
  const who = action?.owner ? (action.owner.ref === 'me' ? 'me' : action.owner.name || action.owner.ref || '') : '';
  // Only what is still left to the user.
  const left = [
    ...(template ? [] : ['choose the output template under Deliverables']),
    suggested.length ? 'tick who it is for under Stakeholders (people from the meeting are suggested)' : 'say who it is for under Stakeholders',
  ].join(', and ');
  const lines = [
    ...(action ? [
      `Prepare as agreed: ${line(action.description)}`,
      // A list, so each stays on its own line in the task view.
      ...(who ? [`- Owner: ${who}`] : []),
      ...(action.due_date ? [`- Due: ${action.due_date}`] : []),
      '',
      'From this meeting:',
    ] : ['Make a deliverable from this meeting:']),
    '',
    `- ${meetingMention(row)}`,
    ...(decisions.length ? ['', 'Decisions:', ...decisions.map((d) => `- ${d}`)] : []),
    '',
    `${left.charAt(0).toUpperCase()}${left.slice(1)}.`,
  ];
  const title = action ? actionTitle(action.description) : `Deliverable from ${record.title || row.title}`;
  return {
    title,
    objective: lines.join('\n'),
    deliverables: [template ? { template_ref: template.id, format: template.format.toLowerCase() } : {}],
    ...(suggested.length ? { suggested_stakeholders: suggested } : {}),
    ...(action?.due_date ? { due_date: action.due_date } : {}),
  };
}
