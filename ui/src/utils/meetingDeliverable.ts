import type { NewTaskDraft } from '@/types';
import type { MeetingRow } from './meetingHistory';

/**
 * Whether a task can be made from a meeting now: one waiting in the queue, or one an update holds whose id is final.
 * A record-only meeting whose update is still reviewed can be renumbered, so it cannot be linked to yet.
 */
export function canMakeDeliverable(row: Pick<MeetingRow, 'inTrash' | 'queued' | 'held'>): boolean {
  if (row.inTrash) return false;
  if (row.queued) return row.queued.status === 'queued' && !row.queued.in_digest;
  return Boolean(row.held?.linkable);
}

/** A meeting mention as the picker writes it: `[@Title · 2026-10-30](/meetings/MQ-2026-0012)`. */
export function meetingMention(row: Pick<MeetingRow, 'id' | 'title' | 'date'>): string {
  // Square brackets would end the link text early.
  const label = `${row.title.replace(/[[\]]/g, (c) => (c === '[' ? '(' : ')'))}${row.date ? ` · ${row.date}` : ''}`;
  return `[@${label}](/meetings/${row.id})`;
}

/**
 * The New task form for a deliverable made from meetings: their mentions in the Objective and one deliverable for the
 * output template. The audience is left to the user: who was in a meeting is not who the deliverable is for.
 */
export function deliverableDraft(rows: Pick<MeetingRow, 'id' | 'title' | 'date'>[]): NewTaskDraft {
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
