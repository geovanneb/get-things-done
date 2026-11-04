import type { SpeakerTurn } from './parts';

/**
 * What the transcription worker and the dashboard share about voices (see docs/voiceprints.md): which stretches of a
 * recording are one voice alone, and the arithmetic on voice embeddings. Pure, so the worker and the tests use the
 * very same rules.
 */

/** A stretch of a recording in seconds. */
export interface Interval { start: number; end: number }

/** A clean sample is at least this long: shorter speech says too little about a voice. */
export const MIN_SAMPLE_SECONDS = 1.5;
/** Longer clean speech is cut into samples of at most this length, so one long turn is not one sample. */
export const MAX_SAMPLE_SECONDS = 10;
/** At most this much speech per voice and recording, in at most this many samples. */
export const MAX_VOICE_SECONDS = 60;
export const MAX_VOICE_SAMPLES = 20;
/** Taken off both ends of a turn: diarization is least sure where a voice starts and stops. */
const EDGE_SECONDS = 0.2;

/**
 * The stretches where `voice` speaks and no other sound of the diarization does, cut to sample size. Diarization keeps
 * overlapping turns of two voices; the transcript does not (it gives each part one speaker), which is why samples are
 * taken from these turns and never from the transcript's lines. The longest go first, up to the caps, returned in time order.
 */
export function cleanIntervals(turns: readonly SpeakerTurn[], voice: number): Interval[] {
  if (voice <= 0) return [];
  const others = turns.filter((t) => t.speaker !== voice);
  const pieces: Interval[] = [];
  for (const turn of turns.filter((t) => t.speaker === voice)) {
    let free: Interval[] = [{ start: turn.start + EDGE_SECONDS, end: turn.end - EDGE_SECONDS }];
    for (const o of others) {
      if (o.end <= turn.start || o.start >= turn.end) continue;
      // The other sound and its edge are taken out: what is left on either side is this voice alone.
      free = free.flatMap((f) => [
        { start: f.start, end: Math.min(f.end, o.start - EDGE_SECONDS) },
        { start: Math.max(f.start, o.end + EDGE_SECONDS), end: f.end },
      ]).filter((f) => f.end - f.start > 0);
    }
    for (const f of free) {
      if (f.end - f.start < MIN_SAMPLE_SECONDS) continue;
      // Even cuts, each between the minimum and the maximum length.
      const count = Math.ceil((f.end - f.start) / MAX_SAMPLE_SECONDS);
      const step = (f.end - f.start) / count;
      for (let i = 0; i < count; i++) pieces.push({ start: round(f.start + i * step), end: round(f.start + (i + 1) * step) });
    }
  }
  const chosen: Interval[] = [];
  let total = 0;
  for (const p of [...pieces].sort((a, b) => (b.end - b.start) - (a.end - a.start) || a.start - b.start)) {
    if (chosen.length >= MAX_VOICE_SAMPLES || total >= MAX_VOICE_SECONDS) break;
    chosen.push(p);
    total += p.end - p.start;
  }
  return chosen.sort((a, b) => a.start - b.start);
}

/** Seconds of speech in some stretches. */
export const secondsOf = (intervals: readonly Interval[]): number => round(intervals.reduce((s, i) => s + (i.end - i.start), 0));

const round = (n: number) => Math.round(n * 1000) / 1000;

/** An embedding as the model gives it: a few hundred finite numbers. Anything else is not one. */
export function isEmbedding(value: unknown, dim?: number): value is number[] {
  return Array.isArray(value) && value.length >= 64 && value.length <= 4096 && (dim === undefined || value.length === dim)
    && value.every((x) => typeof x === 'number' && Number.isFinite(x));
}

/** The vector scaled to length 1; null for a vector of length 0. */
export function normalize(v: readonly number[]): number[] | null {
  const length = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return length > 0 ? v.map((x) => x / length) : null;
}

/**
 * The direction several embeddings share: the mean of each scaled to length 1, scaled again. This is what sherpa-onnx's
 * own speaker manager compares with, so a print and a voice are compared the same way. Null when there is nothing to average.
 */
export function centroid(vectors: readonly (readonly number[])[]): number[] | null {
  const units = vectors.map(normalize).filter((v): v is number[] => v !== null);
  if (!units.length || units.some((u) => u.length !== units[0]!.length)) return null;
  const sum = new Array<number>(units[0]!.length).fill(0);
  for (const u of units) for (let i = 0; i < u.length; i++) sum[i]! += u[i]!;
  return normalize(sum);
}

/** Cosine similarity of two embeddings of the same size, from -1 to 1; 0 when either has no direction. */
export function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) return 0;
  const [x, y] = [normalize(a), normalize(b)];
  if (!x || !y) return 0;
  return x.reduce((s, v, i) => s + v * y[i]!, 0);
}

/** An embedding as it is stored and sent: five decimals are far finer than the model's own precision. */
export const compact = (v: readonly number[]): number[] => v.map((x) => Math.round(x * 1e5) / 1e5);
