/**
 * Search folding (full-width and half-width forms alike, any case) with a way back to the original text, so an excerpt
 * can show what was written around a word that was found in the folded text. Browser-safe: only
 * String.prototype.normalize, toLowerCase and, when present, Intl.Segmenter.
 */

/** The same text however it was typed: full-width and half-width forms alike, any case. */
export function fold(text: string): string {
  return text.normalize('NFKC').toLowerCase();
}

/**
 * `fold(text)` with, for every folded code unit, the `[start, end)` of the source text it came from. A source range
 * never splits a grapheme (or a surrogate pair without Intl.Segmenter). `coarse` means the pieces could not be lined
 * up with the whole fold; every unit then maps to the whole text, and callers must not treat that as a place.
 */
export interface FoldMap {
  folded: string;
  starts: Uint32Array;
  ends: Uint32Array;
  coarse: boolean;
}

const segmenter: Intl.Segmenter | null =
  typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function' ? new Intl.Segmenter('und', { granularity: 'grapheme' }) : null;

/** Only ASCII: folding is plain lower case there, and every offset stays where it was. */
function isAscii(s: string): boolean {
  return !/[\u0080-\uffff]/.test(s);
}

/** Where each grapheme (each code point without Intl.Segmenter) of `s` starts, plus `s.length`. */
function graphemeStarts(s: string): number[] {
  const out: number[] = [];
  if (segmenter) for (const g of segmenter.segment(s)) out.push(g.index);
  else for (let i = 0; i < s.length; i += s.codePointAt(i)! > 0xffff ? 2 : 1) out.push(i);
  out.push(s.length);
  return out;
}

/**
 * NFKC never joins a code point in these ranges onto what comes before it, so a cut just before one folds the same as
 * the whole: Latin and other text below U+0300, kana (but not the two combining sound marks), CJK ideographs.
 */
function safeBefore(cp: number): boolean {
  return cp < 0x300 || (cp >= 0x3040 && cp <= 0x30ff && cp !== 0x3099 && cp !== 0x309a) || (cp >= 0x4e00 && cp <= 0x9fff);
}

/** Final sigma is the one mapping of toLowerCase() that depends on its neighbours; a piece may differ only there. */
function sameIgnoringSigma(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a.charCodeAt(i);
    const y = b.charCodeAt(i);
    if (x !== y && !((x === 0x3c3 || x === 0x3c2) && (y === 0x3c3 || y === 0x3c2))) return false;
  }
  return true;
}

/** Maps a whole string: call it on a bounded piece of text (a window around a hit), never on a whole document. */
export function foldWithMap(s: string): FoldMap {
  const folded = fold(s);
  const starts = new Uint32Array(folded.length);
  const ends = new Uint32Array(folded.length);
  if (isAscii(s)) {
    for (let i = 0; i < s.length; i++) {
      starts[i] = i;
      ends[i] = i + 1;
    }
    return { folded, starts, ends, coarse: false };
  }
  // Graphemes, merged while NFKC does not split cleanly between them (ㄱ + ㅏ → 가 crosses graphemes).
  const b = graphemeStarts(s);
  const pieces: [number, number][] = [];
  let from = b[0]!;
  for (let k = 1; k < b.length - 1; k++) {
    const at = b[k]!;
    const left = s.slice(from, at);
    const right = s.slice(at, b[k + 1]!);
    if (safeBefore(s.codePointAt(at)!) || (left + right).normalize('NFKC') === left.normalize('NFKC') + right.normalize('NFKC')) {
      pieces.push([from, at]);
      from = at;
    }
  }
  if (s.length) pieces.push([from, s.length]);
  let pos = 0;
  for (const [a, z] of pieces) {
    const f = fold(s.slice(a, z));
    if (!sameIgnoringSigma(f, folded.slice(pos, pos + f.length))) return coarse(s, folded);
    starts.fill(a, pos, pos + f.length);
    ends.fill(z, pos, pos + f.length);
    pos += f.length;
  }
  return pos === folded.length ? { folded, starts, ends, coarse: false } : coarse(s, folded);
}

function coarse(s: string, folded: string): FoldMap {
  return { folded, starts: new Uint32Array(folded.length), ends: new Uint32Array(folded.length).fill(s.length), coarse: true };
}

// A long line or turn is walked in blocks cut where folding cannot change across the cut, so only the few blocks
// around a hit are mapped. A run with no such place is cut at MAX_BLOCK anyway; the hit is then checked on its window.
const BLOCK = 1024;
const MAX_BLOCK = 4096;

/** The end of the block that starts at `from`. */
function blockEnd(text: string, from: number): number {
  let i = from + BLOCK;
  for (; i < text.length && i < from + MAX_BLOCK; i++) if (safeBefore(text.charCodeAt(i))) return i;
  if (i >= text.length) return text.length;
  // No safe code point: a cut just before i where the text close by folds the same split or not (ｶ|ﾞ would not), so
  // the counts of a very long run do not drift. Only a run of combining marks longer than the neighbourhood can fool
  // it, and a run with no such cut at all is cut at i: the hit is then found on its window, near where it should be.
  for (let j = i; j > i - 32; j--) {
    const unit = text.charCodeAt(j);
    if (unit >= 0xdc00 && unit <= 0xdfff) continue;
    const left = text.slice(j - 16, j);
    const right = text.slice(j, j + 16);
    if ((left + right).normalize('NFKC') === left.normalize('NFKC') + right.normalize('NFKC')) return j;
  }
  const unit = text.charCodeAt(i);
  return unit >= 0xdc00 && unit <= 0xdfff ? i + 1 : i;
}

/**
 * The source range of `word` found at `at` in `fold(text)`, by mapping only a few blocks around it. When that window
 * cannot be lined up (a long run with no safe cut, or a coarse map), the start of the block that holds the hit: a plain
 * excerpt near it, not a precise place, and never the whole text.
 */
function sourceOf(text: string, at: number, word: string): [number, number] {
  let start = 0;
  let base = 0;
  let prevStart = 0;
  let prevBase = 0;
  for (;;) {
    const end = blockEnd(text, start);
    const length = fold(text.slice(start, end)).length;
    if (base + length > at || end >= text.length) {
      // The block before (context to the left), the block of the hit, and blocks on until the word and one more.
      let winEnd = end;
      let winFolded = base + length;
      for (let extra = 0; winEnd < text.length && (extra < 1 || winFolded < at + word.length); extra++) {
        const next = blockEnd(text, winEnd);
        winFolded += fold(text.slice(winEnd, next)).length;
        winEnd = next;
        if (extra > 8) break;
      }
      const map = foldWithMap(text.slice(prevStart, winEnd));
      if (map.coarse) return [start, start];
      // Nearest occurrence to where it should be: the same place unless a forced cut shifted the count.
      const want = at - prevBase;
      let best = -1;
      for (let i = map.folded.indexOf(word); i >= 0; i = map.folded.indexOf(word, i + 1)) {
        if (best < 0 || Math.abs(i - want) < Math.abs(best - want)) best = i;
        if (i > want) break;
      }
      if (best < 0) return [start, start];
      return [prevStart + map.starts[best]!, prevStart + map.ends[best + word.length - 1]!];
    }
    prevStart = start;
    prevBase = base;
    start = end;
    base += length;
  }
}

// How far from a cut the graphemes are read to find a boundary; a longer grapheme is cut between code points.
const SNAP = 64;
// How far back a run of flag halves is counted to know how they pair up.
const MAX_FLAG_RUN = 4096;

/** A regional indicator (half of a flag, U+1F1E6-U+1F1FF) starts at `i`. */
function isFlagHalf(text: string, i: number): boolean {
  const unit = text.charCodeAt(i + 1);
  return text.charCodeAt(i) === 0xd83c && unit >= 0xdde6 && unit <= 0xddff;
}

/**
 * `at` moved back (or forward) to the nearest place that does not split a grapheme. Only a little text around `at` is
 * read, which is enough except inside a run of flags, where the pairing depends on where the run starts: the text is
 * then read from the start of the run, and when the run is too long for that, `fallback` (a known boundary, an edge of
 * the hit) is used. A grapheme longer than the text read (a very long run of combining marks) is cut between code
 * points.
 */
function snap(text: string, at: number, forward: boolean, fallback: number): number {
  if (at <= 0 || at >= text.length) return at;
  const unit = text.charCodeAt(at);
  if (unit >= 0xdc00 && unit <= 0xdfff) at += forward ? 1 : -1;
  let lo = Math.max(0, at - SNAP);
  let runStart = false;
  if (at >= 2 && isFlagHalf(text, at - 2) && isFlagHalf(text, at)) {
    let before = 0;
    let i = at - 2;
    for (; i >= 0 && before < MAX_FLAG_RUN && isFlagHalf(text, i); i -= 2) before++;
    if (i >= 0 && isFlagHalf(text, i)) return fallback;
    // Without Intl.Segmenter, pairs counted from the start of the run; with it, read from there like any other cut,
    // so marks that follow a flag stay with it.
    if (!segmenter) return before % 2 === 0 ? at : at + (forward ? 2 : -2);
    lo = i + 2;
    runStart = true;
  }
  const hi = Math.min(text.length, at + SNAP);
  // Boundaries at the edges of the piece read are not real ones unless they are the text's own ends (or a run's start).
  const bounds = graphemeStarts(text.slice(lo, hi))
    .map((i) => lo + i)
    .filter((i) => (i > lo || lo === 0 || runStart) && (i < hi || hi === text.length));
  const found = forward ? bounds.find((i) => i >= at) : [...bounds].reverse().find((i) => i <= at);
  return found ?? at;
}

/**
 * The original text around the first of `words` (already folded) found in `fold(text)`, about `radius` characters on
 * each side, trimmed, with `…` where it was cut. No word found (it was in something else, such as a speaker name):
 * the text from its start. Only a bounded window around the hit is mapped, however long the text.
 */
export function excerptAround(text: string, words: string[], radius: number): string {
  const folded = fold(text);
  let at = -1;
  let word = '';
  for (const w of words) {
    const i = w ? folded.indexOf(w) : -1;
    if (i >= 0 && (at < 0 || i < at)) [at, word] = [i, w];
  }
  let hit: [number, number] = [0, 0];
  if (at >= 0) {
    hit = isAscii(text) ? [at, at + word.length] : sourceOf(text, at, word);
  }
  const start = snap(text, Math.max(0, hit[0] - radius), false, hit[0]);
  const end = snap(text, Math.min(text.length, Math.max(hit[0] + radius, hit[1])), true, hit[1]);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`;
}
