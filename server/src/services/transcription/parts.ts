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
