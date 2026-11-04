/**
 * Who speaks in a transcript, as data the queue and the meeting folders share: the names a user gave, the stretches
 * where each speaker speaks alone (times only), and "sounds like" suggestions from remembered voices. Pure parsing.
 */

const SHA256 = /^[0-9a-f]{64}$/;
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});

/** A speaker label of a transcript (`Speaker 2`) and the person the user says it is. */
export interface SpeakerName { label: string; name: string; ref?: string }
export interface SpeakerNames { transcript_sha256: string; names: SpeakerName[] }

export const SPEAKER_LABEL = /^Speaker \d{1,3}$/;
/** As many voices as speaker detection finds in a long meeting, with room to spare. */
export const MAX_SPEAKER_NAMES = 200;

/** The names a user gave, each label once: what a request sends and what a manifest holds. */
export function parseSpeakerNames(value: unknown): SpeakerName[] {
  const seen = new Set<string>();
  return (Array.isArray(value) ? value : []).flatMap((entry) => {
    const o = obj(entry);
    const label = typeof o['label'] === 'string' ? o['label'] : '';
    const name = typeof o['name'] === 'string' ? o['name'].trim().replace(/\s+/g, ' ').slice(0, 120) : '';
    const ref = typeof o['ref'] === 'string' && /^(STK-\d{4}|me)$/.test(o['ref']) ? o['ref'] : undefined;
    if (!SPEAKER_LABEL.test(label) || !name || seen.has(label)) return [];
    seen.add(label);
    return [{ label, name, ...(ref ? { ref } : {}) }];
  }).slice(0, MAX_SPEAKER_NAMES);
}

/** Each speaker label's clean stretches, as `[start, end]` seconds, for the transcript with this hash. */
export interface SpeakerVoices { transcript_sha256: string; voices: { label: string; intervals: [number, number][]; seconds: number }[] }
/**
 * "Sounds like" hints for the transcript with this hash, made with the speaker model of `model_sha256`: a hint made
 * with another model, or for another transcript, is never shown or used.
 */
export interface SpeakerSuggestions { transcript_sha256: string; model_sha256: string; items: SpeakerSuggestion[] }
export interface SpeakerSuggestion { label: string; ref: string; score: number }

/** A recording's speaker stretches, as stored: each label once, finite increasing times, at most the voice caps. */
export function parseSpeakerVoices(value: unknown): SpeakerVoices | undefined {
  const o = obj(value);
  if (typeof o['transcript_sha256'] !== 'string' || !SHA256.test(o['transcript_sha256']) || !Array.isArray(o['voices'])) return undefined;
  const seen = new Set<string>();
  const voices = o['voices'].slice(0, MAX_SPEAKER_NAMES).flatMap((entry) => {
    const v = obj(entry);
    const label = v['label'];
    if (typeof label !== 'string' || !SPEAKER_LABEL.test(label) || seen.has(label) || !Array.isArray(v['intervals']) || v['intervals'].length > 64) return [];
    const intervals = v['intervals'].filter((i): i is [number, number] => Array.isArray(i) && i.length === 2 && i.every((x) => typeof x === 'number' && Number.isFinite(x) && x >= 0) && i[1] > i[0]);
    if (intervals.length !== v['intervals'].length) return [];
    seen.add(label);
    return [{ label, intervals, seconds: typeof v['seconds'] === 'number' && Number.isFinite(v['seconds']) ? v['seconds'] : 0 }];
  });
  return { transcript_sha256: o['transcript_sha256'], voices };
}

export function parseSpeakerSuggestions(value: unknown): SpeakerSuggestions | undefined {
  const o = obj(value);
  if (typeof o['transcript_sha256'] !== 'string' || !SHA256.test(o['transcript_sha256']) || typeof o['model_sha256'] !== 'string' || !SHA256.test(o['model_sha256']) || !Array.isArray(o['items'])) return undefined;
  const seen = new Set<string>();
  const items = o['items'].slice(0, MAX_SPEAKER_NAMES).flatMap((entry) => {
    const i = obj(entry);
    if (typeof i['label'] !== 'string' || !SPEAKER_LABEL.test(i['label']) || seen.has(i['label']) || typeof i['ref'] !== 'string' || !/^(STK-\d{4}|me)$/.test(i['ref'])
      || typeof i['score'] !== 'number' || !(i['score'] >= -1 && i['score'] <= 1)) return [];
    seen.add(i['label']);
    return [{ label: i['label'], ref: i['ref'], score: i['score'] }];
  });
  return { transcript_sha256: o['transcript_sha256'], model_sha256: o['model_sha256'], items };
}

