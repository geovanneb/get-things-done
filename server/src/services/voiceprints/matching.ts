import { cosine } from '../transcription/voices';

/**
 * The rule that turns voice scores into suggestions. A suggestion is only ever a hint ("Sounds like Daniel"): nothing
 * is named without the user's click. The real risk is the open set, someone never remembered who sounds like someone
 * who was, so the rule would rather suggest nothing than guess:
 *
 * - a score high enough, and a clear lead over the second best of all remembered voices (judged before anything is
 *   assigned, so one voice split into two labels can still get the same suggestion twice, which is then right);
 * - someone the meeting did not expect needs a much higher score: the people who come are mostly the ones invited;
 * - a print needs enough clean speech before it suggests anything, and so does the voice it is compared with;
 * - most of the voice's clean speech, sample by sample, must sound like that person too: diarization can merge two
 *   people into one voice, whose mean then half-resembles one of them. Such a voice gets no suggestion.
 *
 * Starting values, conservative; scripts/voiceprint-calibration.mjs measures real meetings before they change.
 */
export const MATCH_RULES = {
  score: 0.7,
  margin: 0.15,
  unexpected: 0.85,
  /** Clean speech a print needs before it suggests anything: one short "yes" makes no print. */
  printSeconds: 10,
  /** Clean speech a voice in the recording needs before it is compared at all. */
  voiceSeconds: 3,
  /** A single clean sample "sounds like" the suggested person from this score (short samples score lower than means). */
  sampleScore: 0.5,
  /** At least this share of the voice's clean speech must, sample by sample, sound like the suggested person. */
  consistency: 0.75,
} as const;

export type MatchRules = { [K in keyof typeof MATCH_RULES]: number };

/**
 * A diarized voice of a recording: its transcript label, the mean of its clean samples, how much clean speech that
 * was, and (when known) each sample's own embedding and length, for the consistency rule.
 */
export interface HeardVoice { label: string; centroid: readonly number[]; seconds: number; samples?: readonly { seconds: number; embedding: readonly number[] }[] }
/** A remembered voice that may be suggested. */
export interface KnownVoice { ref: string; centroid: readonly number[]; seconds: number }
export interface Suggestion { label: string; ref: string; score: number }

/** For each voice, the one remembered person it clearly sounds like, if any. */
export function suggestSpeakers(voices: readonly HeardVoice[], known: readonly KnownVoice[], expected: ReadonlySet<string>, rules: MatchRules = MATCH_RULES): Suggestion[] {
  const usable = known.filter((k) => k.seconds >= rules.printSeconds);
  const out: Suggestion[] = [];
  for (const voice of voices) {
    if (voice.seconds < rules.voiceSeconds) continue;
    const scored = usable.map((k) => ({ ref: k.ref, score: cosine(voice.centroid, k.centroid) })).sort((a, b) => b.score - a.score);
    const [best, second] = scored;
    if (!best || best.score < rules.score) continue;
    if (best.score - (second?.score ?? 0) < rules.margin) continue;
    if (!expected.has(best.ref) && best.score < rules.unexpected) continue;
    if (voice.samples?.length) {
      const print = usable.find((k) => k.ref === best.ref)!.centroid;
      const total = voice.samples.reduce((s, x) => s + x.seconds, 0);
      const agreeing = voice.samples.filter((x) => cosine(x.embedding, print) >= rules.sampleScore).reduce((s, x) => s + x.seconds, 0);
      if (total > 0 && agreeing / total < rules.consistency) continue;
    }
    out.push({ label: voice.label, ref: best.ref, score: Math.round(best.score * 100) / 100 });
  }
  return out;
}
