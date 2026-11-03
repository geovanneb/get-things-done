import * as path from 'path';
import { copyTurns, parseWebVtt, sha256, transcriptMarkdown, turns, type ParsedTranscript } from '../utils/transcript';

/**
 * Corrections to the words of a meeting's transcript, as a reviewed correction carries them: in one numbered turn of a
 * readable copy, `before` becomes `after`. Pure: these functions read and return text, the version writer
 * (meetingVersions) writes it.
 *
 * The rules, agreed in #239:
 * - a change names its place exactly: the readable copy, the turn's number, and old text that stands exactly once in
 *   that turn (never across two lines, so never across two cues);
 * - the original and its readable copy change together: for a WebVTT original, the one cue holding the old text is
 *   changed in the `.vtt` (every other cue as written), the copy is made again from it, and the result is checked to
 *   differ only there. A recording has no text original: its copy is changed in place, and checked the same way;
 * - anything that cannot be placed for certain is refused with the reason, never guessed.
 */

export interface TranscriptChange { file: string; turn: number; before: string; after: string }

/** The files a set of changes produces: the new text of each changed file, by name. */
export type ChangedFiles = Map<string, string>;

const MAX_CHANGES = 100;
const MAX_TEXT = 500;

/** A change from a request or a record, or the reason it is not one. */
export function parseChange(raw: unknown): TranscriptChange | string {
  const o = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const { file, turn, before, after } = o;
  if (typeof file !== 'string' || !file || path.basename(file) !== file || file.startsWith('.')) return 'it does not name a file of the meeting';
  if (typeof turn !== 'number' || !Number.isInteger(turn) || turn < 1) return 'its turn is not a turn number';
  if (typeof before !== 'string' || !before || before.length > MAX_TEXT) return 'it has no old text';
  if (typeof after !== 'string' || after.length > MAX_TEXT) return 'it has no new text';
  if (/[\r\n]/.test(before) || /[\r\n]/.test(after)) return 'a change stays within one line';
  if (after.includes('`')) return 'the new text may not hold a backtick';
  if (before === after) return 'the new text is the same as the old';
  return { file, turn, before, after };
}

/** How many times `part` stands in `text`, overlaps included: "aa" stands twice in "aaa". */
function count(text: string, part: string): number {
  let n = 0;
  for (let i = text.indexOf(part); i >= 0; i = text.indexOf(part, i + 1)) n++;
  return n;
}

/** The line of a turn that holds `before` once, and nowhere else in the turn, or why not. */
function placeIn(lines: string[], change: TranscriptChange): number | string {
  const total = lines.reduce((n, l) => n + count(l, change.before), 0);
  if (total === 0) return `"${change.before}" is not in turn ${change.turn}`;
  if (total > 1) return `"${change.before}" stands more than once in turn ${change.turn}, so it is not clear which one is meant`;
  return lines.findIndex((l) => count(l, change.before) === 1);
}

/** What kind of readable copy a file is, from the lines the dashboard writes at its top. */
function copyKind(copy: string): { kind: 'webvtt'; source: string } | { kind: 'recording' } | null {
  const head = copy.slice(0, 2000);
  const vtt = /\nReadable copy of `([^`\n]+)` \(WebVTT\), made by the dashboard\./.exec(head);
  if (vtt) return { kind: 'webvtt', source: vtt[1]! };
  if (/\nMade on this computer from the recording `[^`\n]+`/.test(head)) return { kind: 'recording' };
  return null;
}

/** A recording's copy: the one line changed in place, and checked to be the only difference. */
function changeRecordingCopy(copy: string, change: TranscriptChange): string {
  const read = copyTurns(copy);
  if (!read) throw problem('this file is not a readable transcript with turns');
  const turn = read.turns[change.turn - 1];
  if (!turn) throw problem(`this transcript has no turn ${change.turn}`);
  const at = placeIn(turn.lines, change);
  if (typeof at === 'string') throw problem(at);
  // The turn's lines follow its heading, in order (see copyTurns): find the at-th spoken line after it.
  let index = turn.at;
  for (let seen = -1; seen < at;) { index++; if (read.lines[index]!.startsWith('  ')) seen++; }
  const lines = [...read.lines];
  lines[index] = `  ${turn.lines[at]!.replace(change.before, change.after)}`;
  const next = lines.join('\n');
  const again = copyTurns(next);
  const same = again && again.turns.length === read.turns.length && again.turns.every((t, i) => (
    t.heading === read.turns[i]!.heading && t.lines.join('\n') === (i === change.turn - 1 ? turn.lines.map((l, j) => (j === at ? l.replace(change.before, change.after) : l)) : read.turns[i]!.lines).join('\n')
  ));
  if (!same) throw problem('the change would alter more than that line');
  return next;
}

/**
 * The blocks of a WebVTT text as parseWebVtt reads them: runs of non-blank lines. `parts` alternates lines and the
 * line breaks between them (as written), so a block is changed in place and everything around it stays as it was.
 */
function vttBlocks(text: string): { parts: string[]; blocks: { from: number; to: number }[] } {
  const parts = text.split(/(\r\n|\n|\r)/);
  const blocks: { from: number; to: number }[] = [];
  let start = -1;
  let last = -1;
  for (let i = 0; i < parts.length; i += 2) {
    if (parts[i]!.trim() === '') {
      if (start >= 0) blocks.push({ from: start, to: last });
      start = -1;
    } else {
      if (start < 0) start = i;
      last = i;
    }
  }
  if (start >= 0) blocks.push({ from: start, to: last });
  return { parts, blocks };
}

/**
 * A WebVTT original and its copy: the one cue holding the old text changed in the `.vtt`, every other line kept as
 * written, and the copy made again from it. Checked: the original read again differs only in that cue's text.
 */
function changeWebVtt(vtt: string, copy: string, source: string, change: TranscriptChange): { vtt: string; copy: string } {
  const parsed = parseWebVtt(vtt);
  const read = copyTurns(copy);
  if (!parsed || !read) throw problem('the transcript or its original cannot be read');
  const list = turns(parsed.cues);
  // The copy must be the copy of this original: the same turns with the same words, whatever format it was made in.
  if (list.length !== read.turns.length || list.some((t, i) => t.lines.join('\n') !== read.turns[i]!.lines.join('\n'))) {
    throw problem(`this copy does not match its original ${source}`);
  }
  const turn = list[change.turn - 1];
  if (!turn) throw problem(`this transcript has no turn ${change.turn}`);
  const at = placeIn(turn.lines, change);
  if (typeof at === 'string') throw problem(at);
  // Which cue of the turn holds that line.
  let cue = -1;
  for (let line = 0, k = 0; k < turn.cues.length; k++) {
    const n = parsed.cues[turn.cues[k]!]!.text.split('\n').length;
    if (at < line + n) { cue = turn.cues[k]!; break; }
    line += n;
  }
  // Which block of the file holds that cue: count the cues each block gives, in order, after the header.
  const { parts, blocks } = vttBlocks(vtt);
  let seen = 0;
  let target: { from: number; to: number } | null = null;
  for (const b of blocks.slice(1)) {
    const given = parseWebVtt(`WEBVTT\n\n${parts.slice(b.from, b.to + 1).join('')}`)?.cues.length ?? 0;
    if (cue < seen + given) { target = b; break; }
    seen += given;
  }
  if (!target) throw problem(`the cue of turn ${change.turn} cannot be found in ${source}`);
  const raw = parts.slice(target.from, target.to + 1).join('');
  if (count(raw, change.before) !== 1) throw problem(`"${change.before}" cannot be placed once in the cue of ${source} (it is written differently there)`);
  const next = [...parts.slice(0, target.from), raw.replace(change.before, change.after), ...parts.slice(target.to + 1)].join('');
  const again = parseWebVtt(next);
  const expected = parsed.cues.map((c, i) => (i === cue ? { ...c, text: c.text.replace(change.before, change.after) } : c));
  if (!again || !sameCues(again, { ...parsed, cues: expected })) throw problem(`the change would alter more of ${source} than that cue`);
  return { vtt: next, copy: transcriptMarkdown(source, sha256(Buffer.from(next, 'utf-8')), again) };
}

function sameCues(a: ParsedTranscript, b: ParsedTranscript): boolean {
  return a.cues.length === b.cues.length && a.problems.join('\n') === b.problems.join('\n')
    && a.cues.every((c, i) => c.start === b.cues[i]!.start && c.end === b.cues[i]!.end && c.speaker === b.cues[i]!.speaker && c.text === b.cues[i]!.text);
}

class ChangeProblem extends Error {}
const problem = (message: string) => new ChangeProblem(message);

/**
 * Applies changes, in order, to a version's files (`read` gives a file's text, null when the version does not hold
 * it). Returns the changed files, and for each change null or why it does not fit. A change is checked against the
 * text as the changes before it left it.
 */
export async function applyChanges(raw: unknown, read: (name: string) => Promise<string | null>): Promise<{ files: ChangedFiles; problems: (string | null)[] }> {
  if (!Array.isArray(raw) || raw.length === 0) throw Object.assign(new Error('Give the changes as a list of { file, turn, before, after }'), { statusCode: 400 });
  if (raw.length > MAX_CHANGES) throw Object.assign(new Error(`At most ${MAX_CHANGES} changes at a time`), { statusCode: 400 });
  const files: ChangedFiles = new Map();
  const text = async (name: string) => files.get(name) ?? read(name);
  const problems: (string | null)[] = [];
  for (const entry of raw) {
    const change = parseChange(entry);
    if (typeof change === 'string') { problems.push(change); continue; }
    try {
      const copy = await text(change.file);
      if (copy === null) throw problem(`${change.file} is not a file of this version`);
      const kind = copyKind(copy);
      if (!kind) throw problem(`${change.file} is not a readable transcript the dashboard made, so its words cannot be corrected here`);
      if (kind.kind === 'recording') { files.set(change.file, changeRecordingCopy(copy, change)); problems.push(null); continue; }
      if (path.extname(kind.source).toLowerCase() !== '.vtt') throw problem(`${change.file} is not the copy of a WebVTT file`);
      const original = await text(kind.source);
      if (original === null) throw problem(`its original ${kind.source} is not in this version, so they cannot change together`);
      const done = changeWebVtt(original, copy, kind.source, change);
      files.set(kind.source, done.vtt);
      files.set(change.file, done.copy);
      problems.push(null);
    } catch (err) {
      if (!(err instanceof ChangeProblem)) throw err;
      problems.push(err.message);
    }
  }
  return { files, problems };
}
