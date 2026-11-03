/**
 * Search in what was said: finding meetings by the words in their transcripts and notes. Pure functions: the Meetings
 * history service reads each meeting's own text and hands it here. Nothing is indexed or stored.
 */

/** One place in a meeting's text that holds a searched word: a transcript turn (with its time) or a line of notes. */
export interface SearchSnippet {
  /** The meeting file it is in, as the meeting lists it (a recording or transcript is named by its original). */
  file: string;
  /** `00:12:30` when it is a transcript turn, else null. */
  time: string | null;
  /** Who said it, as the transcript labels it, when known. */
  speaker: string | null;
  /** The text around the words, at most about 200 characters, with `…` where it was cut. */
  text: string;
}

export interface SearchHit {
  id: string;
  snippets: SearchSnippet[];
  /** How many places hold a searched word, also those not returned as snippets. */
  places: number;
}

export const MIN_QUERY = 2;
export const MAX_QUERY = 200;
const MAX_SNIPPETS = 3;
const AROUND = 90;

/** The same text however it was typed: full-width and half-width forms alike, any case. */
export function fold(text: string): string {
  return text.normalize('NFKC').toLowerCase();
}

/** The words of a query, folded; at most 10, so a pasted paragraph cannot make every search slow. */
export function queryWords(query: string): string[] {
  return [...new Set(fold(query).split(/\s+/).filter(Boolean))].slice(0, 10);
}

interface Unit { time: string | null; speaker: string | null; text: string }

/**
 * The parts of a meeting's readable text: the turns of a transcript copy (`[start → end] speaker` lines, each followed
 * by indented text, inside a text fence), or the non-empty lines of anything else.
 */
export function textUnits(markdown: string): Unit[] {
  const lines = markdown.split('\n');
  const open = lines.findIndex((line) => /^`{3,}text$/.test(line));
  const close = open < 0 ? -1 : lines.indexOf(lines[open]!.slice(0, -'text'.length), open + 1);
  if (close > open) {
    const turns: Unit[] = [];
    for (const line of lines.slice(open + 1, close)) {
      const turn = /^(?:#\d+ )?\[(\d\d:\d\d:\d\d) → \d\d:\d\d:\d\d\](?: (.+))?$/.exec(line);
      const last = turns[turns.length - 1];
      if (turn) {
        const who = turn[2]?.trim();
        turns.push({ time: turn[1]!, speaker: who && who !== '(no speaker label)' ? who : null, text: '' });
      } else if (line.startsWith('  ') && last) last.text += (last.text ? ' ' : '') + line.trim();
    }
    if (turns.length) return turns;
  }
  return lines.map((l) => l.trim()).filter(Boolean).map((text) => ({ time: null, speaker: null, text }));
}

/** The text around the first word found in it, cut at about AROUND characters on each side. */
function around(text: string, words: string[]): string {
  const folded = fold(text);
  // NFKC can change lengths (a ligature, a half-width katakana), so cut on the folded text when they differ.
  const source = folded.length === text.length ? text : folded;
  // A word found only in the speaker's name: the text from its start.
  const found = words.map((w) => folded.indexOf(w)).filter((i) => i >= 0);
  const at = found.length ? Math.min(...found) : 0;
  const start = Math.max(0, at - AROUND);
  const end = Math.min(source.length, at + AROUND);
  return `${start > 0 ? '…' : ''}${source.slice(start, end).trim()}${end < source.length ? '…' : ''}`;
}

/**
 * Whether a meeting's texts hold every word of the query (anywhere in them, not only in one turn), and where. The
 * places that hold the most words come first, then in the order they were said.
 */
export function searchMeeting(id: string, texts: { file: string; text: string }[], words: string[]): SearchHit | null {
  if (!words.length) return null;
  const all = fold(texts.map((t) => t.text).join('\n'));
  if (!words.every((w) => all.includes(w))) return null;
  const places: { file: string; unit: Unit; found: number; order: number }[] = [];
  for (const { file, text } of texts) {
    for (const unit of textUnits(text)) {
      const body = fold(`${unit.speaker ?? ''} ${unit.text}`);
      const found = words.filter((w) => body.includes(w)).length;
      if (found) places.push({ file, unit, found, order: places.length });
    }
  }
  const best = [...places].sort((a, b) => b.found - a.found || a.order - b.order).slice(0, MAX_SNIPPETS);
  return {
    id,
    places: places.length,
    snippets: best.map(({ file, unit }) => ({ file, time: unit.time, speaker: unit.speaker, text: around(unit.text, words) })),
  };
}
