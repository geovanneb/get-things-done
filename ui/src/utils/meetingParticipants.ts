import type { MeetingParticipant, Stakeholder, Task } from '@/types';
import { MEETING_PREP_AGENT } from './meetingPrep';

/** Adds someone once: the same stakeholder, or the same name written either way. */
export function addParticipant(list: MeetingParticipant[], next: MeetingParticipant): MeetingParticipant[] {
  const name = next.name.trim().replace(/\s+/g, ' ');
  if (!name) return list;
  const same = (p: MeetingParticipant) => (next.ref && p.ref === next.ref) || p.name.toLowerCase() === name.toLowerCase();
  return list.some(same) ? list : [...list, { ...next, name }];
}

/** "A", "A and B", "A, B and C". */
export function joinNames(list: MeetingParticipant[]): string {
  const names = list.map((p) => p.name);
  return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** The reminder before recording: "everyone" stays, because the list is who was expected, not who is in the room. */
export function consentSentence(list: MeetingParticipant[]): string {
  return list.length
    ? `I have told everyone in the meeting, including ${joinNames(list)}, that it is being recorded.`
    : 'I have told everyone in the meeting that it is being recorded.';
}

/** What the record dialog starts from. */
export interface RecordPrefill { title: string; participants: MeetingParticipant[] }

/** A task that prepares a meeting: made with the meeting-prep agent, or by Prepare meeting in a workspace without it. */
export function isMeetingPrepTask(task: Pick<Task, 'title' | 'preferred_agent'>): boolean {
  return task.preferred_agent === MEETING_PREP_AGENT || /^Prepare:\s+meeting with\s/i.test(task.title);
}

/** The meeting a prep task is about: its title without "Prepare:", and its stakeholders as the people expected. */
export function recordPrefillFromTask(task: Pick<Task, 'title' | 'stakeholders'>, stakeholders: Pick<Stakeholder, 'id' | 'name'>[]): RecordPrefill {
  const title = task.title.replace(/^Prepare:\s*/, '').trim();
  const participants = (task.stakeholders ?? []).reduce<MeetingParticipant[]>((list, s) => {
    const name = stakeholders.find((p) => p.id === s.ref)?.name;
    return name ? addParticipant(list, { name, ref: s.ref }) : list;
  }, []);
  return { title: title ? title[0]!.toUpperCase() + title.slice(1) : '', participants };
}
