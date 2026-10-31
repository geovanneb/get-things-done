const SAMPLE_RATE = 16000;
/** Audio given to the model around a part, for the sounds voice detection cuts off at the start and end of speech. */
const CONTEXT_BEFORE = 0.3 * SAMPLE_RATE | 0;
const CONTEXT_AFTER = 0.4 * SAMPLE_RATE | 0;
/** A part this long gets no context after it: voice detection can end a long stretch inside a very short pause. */
const LONG_PART = 10 * SAMPLE_RATE;
/** Longest stretch given to Whisper at once, which reads at most 30 seconds, and where to look for a pause before it. */
export const LONGEST_PART = 25 * SAMPLE_RATE;
const SEARCH = 5 * SAMPLE_RATE;
const WINDOW = SAMPLE_RATE / 10;

export interface Part { start: number; samples: Float32Array }

/** Splits speech too long for the model at its quietest moment shortly before the limit. Every sample stays in one part. */
export function splitLong(part: Part, longest = LONGEST_PART, search = SEARCH): Part[] {
  const parts: Part[] = [];
  let offset = 0;
  while (part.samples.length - offset > longest) {
    let cut = longest;
    let quietest = Infinity;
    for (let at = longest - search; at + WINDOW <= longest; at += WINDOW) {
      let energy = 0;
      for (let i = 0; i < WINDOW; i++) energy += part.samples[offset + at + i]! ** 2;
      if (energy < quietest) { quietest = energy; cut = at + WINDOW / 2; }
    }
    parts.push({ start: part.start + offset, samples: part.samples.subarray(offset, offset + cut) });
    offset += cut;
  }
  parts.push({ start: part.start + offset, samples: part.samples.subarray(offset) });
  return parts;
}

/** A piece this short around a change of language is not worth a part of its own. */
const SHORTEST_PIECE = SAMPLE_RATE / 4;
/** Where the voice changes a part ends even for a short remark: it must not end up under the other voice. */
export const SHORTEST_TURN = SAMPLE_RATE / 10;

/** Ends a part where the language changes, so the speech after the change is not read in the language before it. */
export function splitAtChanges(part: Part, seconds: readonly number[], shortest = SHORTEST_PIECE): Part[] {
  const parts: Part[] = [];
  let offset = 0;
  for (const at of seconds) {
    const cut = Math.round(at * SAMPLE_RATE) - part.start;
    if (cut - offset < shortest || part.samples.length - cut < shortest) continue;
    parts.push({ start: part.start + offset, samples: part.samples.subarray(offset, cut) });
    offset = cut;
  }
  parts.push({ start: part.start + offset, samples: part.samples.subarray(offset) });
  return parts;
}

/**
 * Who spoke when, in seconds. `speaker` is 1 for the first voice of the recording, 2 for the next; 0 for a voice heard
 * too little to name. Its turns still mark where the voice changes, so its words are never put under someone else.
 */
export interface SpeakerTurn { start: number; end: number; speaker: number }

/** A voice heard for less than this in the whole recording is a sound, a cough or a click: it gets no label. */
const LEAST_SPEECH = 2;

/** The engine's turns in order, with sound times only, numbered by who speaks first. */
export function speakerTurns(raw: readonly { start: number; end: number; speaker: number }[], seconds: number): SpeakerTurn[] {
  const labels = new Map<number, number>();
  const sound = raw.filter((t) => Number.isFinite(t.start) && Number.isFinite(t.end) && Number.isInteger(t.speaker) && t.start >= 0 && t.end > t.start && t.start < seconds);
  const talk = new Map<number, number>();
  for (const t of sound) talk.set(t.speaker, (talk.get(t.speaker) ?? 0) + Math.min(t.end, seconds) - t.start);
  return sound
    .sort((a, b) => a.start - b.start)
    .map((t) => {
      if (talk.get(t.speaker)! < LEAST_SPEECH) return { start: t.start, end: Math.min(t.end, seconds), speaker: 0 };
      if (!labels.has(t.speaker)) labels.set(t.speaker, labels.size + 1);
      return { start: t.start, end: Math.min(t.end, seconds), speaker: labels.get(t.speaker)! };
    });
}

/** Where one voice gives way to another. */
export function speakerCuts(turns: readonly SpeakerTurn[]): number[] {
  return turns.filter((t, i) => i > 0 && t.speaker !== turns[i - 1]!.speaker).map((t) => t.start);
}

/**
 * Who speaks in a stretch, when that is clear. A stretch holds pauses too, so this counts the speech the voices were
 * heard in: one voice has most of it and another hardly any, and enough of the stretch is known speech at all.
 * Otherwise it stays unassigned: a guess must not become a name.
 */
const CLEAR_SHARE = 0.6;
const OTHER_VOICE = 0.25;
const KNOWN_SPEECH = 0.3;

export function speakerOf(start: number, end: number, turns: readonly SpeakerTurn[]): number | undefined {
  const heard = new Map<number, number>();
  for (const t of turns) {
    const overlap = Math.min(end, t.end) - Math.max(start, t.start);
    if (overlap > 0) heard.set(t.speaker, (heard.get(t.speaker) ?? 0) + overlap);
  }
  const [first, second] = [...heard].sort((a, b) => b[1] - a[1]);
  const voiced = [...heard.values()].reduce((sum, s) => sum + s, 0);
  if (!first || first[0] === 0 || voiced < (end - start) * KNOWN_SPEECH) return undefined;
  return first[1] >= voiced * CLEAR_SHARE && (second?.[1] ?? 0) <= voiced * OTHER_VOICE ? first[0] : undefined;
}

/** The nearest cuts around a stretch, in seconds: its context stays inside them. */
export function cutsAround(cuts: readonly number[], start: number, end: number): { before: number; after: number | null } {
  let before = 0;
  let after: number | null = null;
  for (const cut of cuts) {
    if (cut <= start) before = cut;
    else if (cut >= end) { after = cut; break; }
  }
  return { before, after };
}

export interface Around {
  /** Where the part before this one ended. */
  previousEnd: number;
  /** Where the next part starts, when it is known. */
  next: number | null;
  /** Samples heard so far. */
  heard: number;
  /** The recording ended, so nothing follows what was heard. */
  ending: boolean;
}

/** The samples to give the model for a part. Context never reaches into the part's neighbours or past what was heard. */
export function contextRange(start: number, end: number, around: Around): { from: number; to: number } {
  const from = Math.min(start, Math.max(around.previousEnd, start - CONTEXT_BEFORE, 0));
  if (end - start >= LONG_PART && !around.ending) return { from, to: end };
  return { from, to: Math.max(end, Math.min(around.heard, end + CONTEXT_AFTER, around.next ?? Infinity)) };
}

/** The last stretch of audio, for the context around a part. Parts themselves come from voice detection. */
export class RecentAudio {
  private readonly samples: Float32Array;
  /** Samples heard so far. A sample's place in `samples` is its number modulo the buffer's length. */
  seen = 0;

  constructor(size: number) {
    this.samples = new Float32Array(size);
  }

  add(input: Float32Array): void {
    const size = this.samples.length;
    for (let i = Math.max(0, input.length - size); i < input.length; i++) this.samples[(this.seen + i) % size] = input[i]!;
    this.seen += input.length;
  }

  /** Samples `from` to `to`; null when they are gone or not heard yet. */
  slice(from: number, to: number): Float32Array | null {
    if (from < 0 || to < from || from < this.seen - this.samples.length || to > this.seen) return null;
    const out = new Float32Array(to - from);
    for (let i = 0; i < out.length; i++) out[i] = this.samples[(from + i) % this.samples.length]!;
    return out;
  }
}
