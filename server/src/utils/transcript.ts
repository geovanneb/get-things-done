import { createHash } from 'crypto';

/**
 * Meeting transcripts exported as WebVTT (Teams, Zoom, Meet) are hard to read: a cue every few seconds,
 * timing on every line, markup around speaker names. This turns one into a readable transcript that keeps
 * every word and every speaker label as written, with the time of each turn. Nothing is translated,
 * summarized or matched to stakeholders: a speaker label is what the file says, not a person.
 *
 * What cannot be read is reported, never dropped silently: the copy then says it is incomplete, so the
 * reader goes back to the original.
 */

/** One stretch of speech: a cue, or the part of a cue spoken by one voice. */
export interface TranscriptCue { start: number; end: number; speaker: string | null; text: string }

export interface ParsedTranscript {
  cues: TranscriptCue[];
  /** Speaker labels in order of first appearance, exactly as written. */
  speakers: string[];
  /** End of the latest cue, in seconds. */
  duration: number;
  /** What could not be read, with line numbers. Empty when every cue was read. */
  problems: string[];
}

/** Larger files keep only the original: converting them would hold up the server. */
export const MAX_CONVERT_BYTES = 10 * 1024 * 1024;
/** Consecutive cues of one named speaker form one turn when the next starts within this many seconds. */
const MAX_TURN_GAP = 10;

const TIMING = /^((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})[ \t]+-->[ \t]+((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})(?:[ \t].*)?$/;

function seconds(stamp: string): number {
  return stamp.replace(',', '.').split(':').map(Number).reduce((total, part) => total * 60 + part, 0);
}

export function clock(total: number): string {
  const s = Math.floor(total);
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((n) => String(n).padStart(2, '0')).join(':');
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', lrm: '', rlm: '' };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === '#') {
      const n = code[1]?.toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : whole;
    }
    return ENTITIES[code.toLowerCase()] ?? whole;
  });
}

/**
 * Text of a file, from UTF-8 or UTF-16 with a byte order mark (some exports use UTF-16). Returns null for
 * bytes that cannot be text in that encoding, so nothing is dropped or replaced silently.
 */
export function decodeText(buffer: Buffer): string | null {
  try {
    if (buffer[0] === 0xff && buffer[1] === 0xfe) {
      if (buffer.length % 2) return null;
      return new TextDecoder('utf-16le', { fatal: true }).decode(buffer.subarray(2));
    }
    if (buffer[0] === 0xfe && buffer[1] === 0xff) {
      if (buffer.length % 2) return null;
      return new TextDecoder('utf-16be', { fatal: true }).decode(buffer.subarray(2));
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  } catch {
    return null;
  }
}

/** Whether a text is WebVTT: the format requires "WEBVTT" at the very start. */
export function isWebVtt(text: string): boolean {
  return /^\uFEFF?WEBVTT(?:[ \t][^\n]*)?(?:\r?\n|$)/.test(text);
}

/** The cue markup WebVTT defines, other than voices: removed, never read as words. */
const MARKUP = /^(?:\/?(?:c|i|b|u|ruby|rt|lang)(?:\.[^\s]*)?(?:\s[^<>]*)?|(?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})$/i;

/** A speaker label on one line, without control characters; null when nothing is left. */
function label(raw: string): string | null {
  const visible = [...decodeEntities(raw)].map((ch) => (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 ? ' ' : ch)).join('');
  const text = visible.replace(/\s+/g, ' ').trim();
  return text || null;
}

/**
 * Splits a cue's text by voice. `<v Name>` starts a voice and `</v>` (or the end of the cue) ends it; text
 * outside a voice has no speaker. Other markup is removed; the words stay, each part on its own.
 */
function splitVoices(payload: string, where: string, problems: string[]): { speaker: string | null; text: string }[] {
  const parts: { speaker: string | null; text: string }[] = [];
  let voice: string | null = null;
  let open = false;
  let buffer = '';
  const flush = () => {
    const text = decodeEntities(buffer).replace(/[ \t]+/g, ' ').split('\n').map((l) => l.trim()).filter(Boolean).join('\n');
    if (text) parts.push({ speaker: voice, text });
    buffer = '';
  };
  const tag = /<([^<>]*)>/g;
  let last = 0;
  for (let m = tag.exec(payload); m; m = tag.exec(payload)) {
    buffer += payload.slice(last, m.index);
    last = tag.lastIndex;
    const inner = m[1]!.trim();
    const v = /^v(?:\.[^\s]*)?\s+([\s\S]+)$/i.exec(inner);
    if (v) {
      if (open) problems.push(`${where}: a voice tag inside another voice tag; each is shown as its own speaker`);
      flush();
      voice = label(v[1]!);
      open = true;
    } else if (/^\/v$/i.test(inner)) {
      flush();
      voice = null;
      open = false;
    } else if (/^v(?:\.[^\s]*)?$/i.test(inner)) {
      problems.push(`${where}: a voice tag without a name`);
      flush();
      voice = null;
      open = true;
    } else if (!MARKUP.test(inner)) {
      // Not WebVTT markup, so it is text as written ("x < y > z"), kept with its brackets.
      buffer += m[0];
    }
    // WebVTT markup (<c>, <i>, <b>, <u>, <lang>, <ruby>, <rt>, a timestamp) is removed; the words stay.
  }
  buffer += payload.slice(last);
  flush();
  return parts;
}

/**
 * Reads a WebVTT file. Returns null when it is not WebVTT. NOTE, STYLE and REGION blocks are skipped as the
 * format defines them; any other block that is not a cue is listed under `problems`, never read as speech.
 */
export function parseWebVtt(text: string): ParsedTranscript | null {
  if (!isWebVtt(text)) return null;
  const lines = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
  const problems: string[] = [];
  const cues: TranscriptCue[] = [];
  let duration = 0;
  let i = 0;
  const block = (): { from: number; lines: string[] } | null => {
    while (i < lines.length && lines[i]!.trim() === '') i++;
    if (i >= lines.length) return null;
    const from = i;
    while (i < lines.length && lines[i]!.trim() !== '') i++;
    return { from: from + 1, lines: lines.slice(from, i) };
  };
  // The header: WEBVTT and optional header lines. A cue in it (a missing blank line) is reported, not read.
  const header = block();
  if (header && header.lines.slice(1).some((l) => l.includes('-->'))) {
    problems.push(`lines ${header.from}-${header.from + header.lines.length - 1}: a cue inside the header (a blank line is missing after WEBVTT), left out of the copy`);
  }
  for (let b = block(); b; b = block()) {
    const where = b.lines.length > 1 ? `lines ${b.from}-${b.from + b.lines.length - 1}` : `line ${b.from}`;
    const first = b.lines[0]!;
    if (/^(NOTE|STYLE|REGION)(?:[ \t]|$)/.test(first)) continue;
    const at = TIMING.test(first.trim()) ? 0 : !first.includes('-->') && b.lines.length > 1 && TIMING.test(b.lines[1]!.trim()) ? 1 : -1;
    if (at < 0) { problems.push(`${where}: not a cue, left out of the copy`); continue; }
    const m = TIMING.exec(b.lines[at]!.trim())!;
    const start = seconds(m[1]!);
    const end = seconds(m[2]!);
    if (end < start) problems.push(`${where}: the cue ends before it starts`);
    duration = Math.max(duration, end);
    for (const part of splitVoices(b.lines.slice(at + 1).join('\n'), where, problems)) cues.push({ start, end, ...part });
  }
  const seen = new Set<string>();
  for (const c of cues) if (c.speaker) seen.add(c.speaker);
  return { cues, speakers: [...seen], duration, problems };
}

export function sha256(buffer: Buffer | string): string {
  return createHash('sha256').update(buffer).digest('hex');
}

interface Turn { start: number; end: number; lastStart: number; speaker: string | null; lines: string[] }

/**
 * Consecutive cues become one turn only for the same named speaker, when the next starts after the last
 * one ended (no overlap, which would hide its time) and within MAX_TURN_GAP seconds.
 */
function turns(cues: TranscriptCue[]): Turn[] {
  const out: Turn[] = [];
  for (const c of cues) {
    const last = out[out.length - 1];
    const sameTurn = last && c.speaker !== null && last.speaker === c.speaker
      && c.start >= last.end && c.start - last.end <= MAX_TURN_GAP;
    if (sameTurn) {
      for (const line of c.text.split('\n')) last.lines.push(line);
      last.end = Math.max(last.end, c.end);
      last.lastStart = c.start;
    } else {
      out.push({ start: c.start, end: c.end, lastStart: c.start, speaker: c.speaker, lines: c.text.split('\n') });
    }
  }
  return out;
}

/**
 * The readable transcript. The speech sits in a fenced block, so nothing in it is read as Markdown, and every
 * spoken line is indented, so no line of speech can look like a turn line "[start → end] speaker".
 */
export function transcriptMarkdown(source: string, hash: string, parsed: ParsedTranscript): string {
  const list = turns(parsed.cues);
  const body = list.map((t) => [`[${clock(t.start)} → ${clock(t.end)}] ${t.speaker ?? '(no speaker label)'}`, ...t.lines.map((l) => `  ${l}`)].join('\n')).join('\n\n');
  // A loop, not Math.max(...runs): a transcript can hold more runs than a function takes arguments.
  let longest = 2;
  for (const m of body.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  const fence = '`'.repeat(longest + 1);
  const speakers = parsed.speakers.length ? parsed.speakers.map((s) => s.replace(/[`*_[\]<>#|\\]/g, (ch) => `\\${ch}`)).join(', ') : 'none labelled';
  const status = parsed.problems.length
    ? [
      `**Incomplete.** ${parsed.problems.length} part${parsed.problems.length > 1 ? 's' : ''} of the original could not be read and ${parsed.problems.length > 1 ? 'are' : 'is'} listed below. Read the original as well.`,
      '',
      ...parsed.problems.map((p) => `- ${p}`),
    ]
    : ['**Complete.** Every cue of the original is below, word for word; only timing lines and markup are removed.'];
  return [
    `# Transcript: ${source}`,
    '',
    `Readable copy of \`${source}\` (WebVTT), made by the dashboard. Source SHA-256: \`${hash}\`. The original stays next to this file.`,
    '',
    `- Length: ${clock(parsed.duration)}, ${parsed.cues.length} cues in ${list.length} turns`,
    `- Speakers as labelled in the file, not checked against stakeholders: ${speakers}`,
    '',
    ...status,
    '',
    'Each turn starts with a line `[start → end] speaker`; what was said follows, indented by two spaces.',
    '',
    `${fence}text`,
    body,
    fence,
    '',
  ].join('\n');
}
