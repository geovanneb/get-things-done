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

// ---- the speakers panel ----------------------------------------------------------------------------------------

/** What helps recognise a speaker: the first thing they said and when, and how many parts are theirs. */
export interface SpeakerEvidence { first: { time: string; text: string }; count: number }

export function speakerEvidence(parts: readonly { time: string; speaker?: string; text: string }[]): Map<string, SpeakerEvidence> {
  const out = new Map<string, SpeakerEvidence>();
  for (const p of parts) {
    if (!p.speaker) continue;
    const seen = out.get(p.speaker);
    if (seen) seen.count++;
    else out.set(p.speaker, { first: { time: p.time, text: p.text }, count: 1 });
  }
  return out;
}

/** Seconds of a transcript time (`00:01:05`, `01:05`); null when it is not one. */
export function secondsOfTime(time: string): number | null {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})$/.exec(time);
  return m ? Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
}

/** The value of a person in the picker: by stakeholder id, or by a typed name. */
export const NOT_NAMED = '';
export const SOMEONE_ELSE = '__other';
const valueOf = (person: { name: string; ref?: string } | undefined) => (!person ? NOT_NAMED : person.ref ? `ref:${person.ref}` : `name:${person.name}`);
export { valueOf as personValue };

/**
 * The picker for one speaker: who the meeting expected first (you among them), then every other stakeholder, then
 * "Someone else…". A person already given to another speaker says so, and can still be chosen (diarization can split
 * one person in two). A typed name in use stays listed, so the current value always shows.
 */
export function personOptions(input: {
  label: string;
  choices: { option: string; person: { name: string; ref?: string } }[];
  expected: ReadonlySet<string>;
  names: SpeakerName[];
}): { value: string; label: string; group?: string }[] {
  const takenBy = new Map<string, string>();
  for (const n of input.names) if (n.label !== input.label) takenBy.set(valueOf(n), n.label);
  const current = input.names.find((n) => n.label === input.label);
  const item = (person: { name: string; ref?: string }, shown: string, group: string) => {
    const value = valueOf(person);
    const other = takenBy.get(value);
    return { value, label: other ? `${shown} · also ${other}` : shown, group };
  };
  const seen = new Set<string>();
  const expected: { value: string; label: string; group?: string }[] = [];
  const others: { value: string; label: string; group?: string }[] = [];
  const meChoice = input.choices.find((c) => c.person.ref === 'me');
  const me = item(meChoice?.person ?? { name: 'Me', ref: 'me' }, meChoice ? `${meChoice.person.name} (you)` : 'You', 'Expected at this meeting');
  expected.push(me);
  seen.add(me.value);
  for (const c of input.choices) {
    const value = valueOf(c.person);
    if (seen.has(value)) continue;
    seen.add(value);
    const isExpected = input.expected.has(c.person.ref ?? `name:${c.person.name.toLowerCase()}`);
    (isExpected ? expected : others).push(item(c.person, c.option, isExpected ? 'Expected at this meeting' : 'Other stakeholders'));
  }
  const typed = current && !current.ref && !seen.has(valueOf(current)) ? [{ value: valueOf(current), label: current.name, group: 'Named by hand' }] : [];
  return [{ value: NOT_NAMED, label: 'Not named yet' }, ...expected, ...others, ...typed, { value: SOMEONE_ELSE, label: 'Someone else…' }];
}

/** The person a picker value stands for; null for "not named". */
export function personOf(value: string, choices: { person: { name: string; ref?: string } }[], names: SpeakerName[]): { name: string; ref?: string } | null {
  if (value === NOT_NAMED || value === SOMEONE_ELSE) return null;
  const found = choices.find((c) => valueOf(c.person) === value)?.person ?? names.find((n) => valueOf(n) === value);
  if (found) return { name: found.name, ...(found.ref ? { ref: found.ref } : {}) };
  if (value === 'ref:me') return { name: 'Me', ref: 'me' };
  return value.startsWith('name:') ? { name: value.slice(5) } : null;
}

/** One line on where naming stands: "4 speakers · 2 named · 1 suggestion to review". */
export function speakersSummary(rows: Pick<SpeakerRow, 'named' | 'suggestion'>[]): string {
  const named = rows.filter((r) => r.named).length;
  const suggested = rows.filter((r) => !r.named && r.suggestion).length;
  return [
    `${rows.length} ${rows.length === 1 ? 'speaker' : 'speakers'}`,
    named === rows.length ? 'all named' : `${named} named`,
    ...(suggested ? [`${suggested} ${suggested === 1 ? 'suggestion' : 'suggestions'} to review`] : []),
  ].join(' · ');
}
