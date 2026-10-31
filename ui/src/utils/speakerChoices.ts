import type { MeetingParticipant, SpeakerName, Stakeholder } from '@/types';

/** One line of the list a speaker is named from: what the box shows, and who it means. */
export interface SpeakerChoice { option: string; person: Omit<SpeakerName, 'label'> }

/** What the box shows for a stakeholder: the id tells two people of the same name apart. */
const option = (name: string, ref?: string) => (ref ? `${name} (${ref})` : name);

/**
 * The meeting's expected people first, then every other stakeholder, each person once: a stakeholder by id, with the
 * name the stakeholder has now; someone who is no stakeholder by name.
 */
export function speakerChoices(participants: MeetingParticipant[], people: Stakeholder[]): SpeakerChoice[] {
  const current = new Map(people.map((p) => [p.id, p.name] as const));
  const choices: SpeakerChoice[] = [];
  const seen = new Set<string>();
  const add = (name: string, ref?: string) => {
    const shown = ref ? current.get(ref) ?? name : name;
    const key = ref ?? `name:${shown.toLowerCase()}`;
    if (!shown || seen.has(key)) return;
    seen.add(key);
    choices.push({ option: option(shown, ref), person: { name: shown, ...(ref ? { ref } : {}) } });
  };
  for (const p of participants) add(p.name, p.ref);
  for (const p of people) add(p.name, p.id);
  return choices;
}
