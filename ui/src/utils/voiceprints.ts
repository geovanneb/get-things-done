import type { RememberedVoice, SpeakerName, SpeakerSuggestion, Stakeholder } from '@/types';

/**
 * What the page says about remembered voices (Recognize known voices, docs/voiceprints.md). Pure, so the rules are
 * tested once: which speakers can be remembered, which suggestions to show, and how a remembered voice stands.
 */

/** One speaker of a transcript as the naming row shows it. */
export interface SpeakerRow {
  label: string;
  named: SpeakerName | undefined;
  /** "Sounds like": only for a speaker not named yet, and only for a person who is still a stakeholder. */
  suggestion: (SpeakerSuggestion & { name: string }) | null;
  /** The voice can be remembered: named with a stakeholder (or you), with speech of their own, and not remembered from this yet. */
  canRemember: boolean;
  /** The person's voice is already remembered on this computer. */
  remembered: boolean;
}

export function speakerRows(input: {
  labels: string[]; names: SpeakerName[]; suggestions: SpeakerSuggestion[]; rememberable: string[];
  people: Pick<Stakeholder, 'id' | 'name'>[]; prints: Pick<RememberedVoice, 'ref' | 'damaged'>[]; enabled: boolean;
}): SpeakerRow[] {
  const people = new Map(input.people.map((p) => [p.id, p.name] as const));
  const remembered = new Set(input.prints.filter((p) => !p.damaged).map((p) => p.ref));
  return input.labels.map((label) => {
    const named = input.names.find((n) => n.label === label);
    const s = named ? undefined : input.suggestions.find((x) => x.label === label);
    const name = s ? (s.ref === 'me' ? 'you' : people.get(s.ref)) : undefined;
    const ref = named?.ref;
    return {
      label, named,
      suggestion: s && name ? { ...s, name } : null,
      canRemember: input.enabled && Boolean(ref && (ref === 'me' || people.has(ref))) && input.rememberable.includes(label) && !remembered.has(ref!),
      remembered: Boolean(ref && remembered.has(ref)),
    };
  });
}

/** The tag a remembered voice gets, and whether it is a warning. */
export function voiceTag(v: Pick<RememberedVoice, 'damaged' | 'stakeholder' | 'stale_model' | 'ready'>): { text: string; warning: boolean } {
  if (v.damaged) return { text: 'Cannot be read', warning: true };
  if (!v.stakeholder) return { text: 'No longer a stakeholder', warning: true };
  if (v.stale_model) return { text: 'Made with an older speaker model', warning: true };
  if (!v.ready) return { text: 'Voice remembered, needs more speech', warning: false };
  return { text: 'Voice remembered', warning: false };
}

/** The consent wording for one person (the server sends it with `{person}` for the name). */
export const consentFor = (text: string, person: string): string => text.split('{person}').join(person);

/** How much speech, for people: "45 s", "2 min 5 s". */
export function speechLength(seconds: number): string {
  const s = Math.round(seconds);
  if (s < 60) return `${s} s`;
  return `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ''}`;
}
