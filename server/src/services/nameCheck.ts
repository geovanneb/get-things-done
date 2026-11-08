/**
 * Advisory name and term check for deliverable sources (#85). Pure functions only: a registry of known person names
 * and glossary terms, text with markup and code blanked out, and the findings. Deterministic and local; no model.
 *
 * Two findings only:
 * - `person`: a word close to a known person's name but not equal to it ("Shimoto" for "Shiomoto");
 * - `abbreviation`: 2 to 6 capitals that are not in the glossary and not defined in the text.
 * An unknown full name is never a finding: names are not a dictionary.
 */

import { COMMON_WORDS } from './nameCheckWords';

export interface PersonEntry {
  /** The stakeholder's full `name`, as written. */
  name: string;
  /** Latin-script parts of the name (outside brackets), each 2+ letters. */
  latin: string[];
  /** The name in a script without spaces (the part in brackets), joined without spaces, and its parts. */
  cjk: { full: string; parts: string[] } | null;
}

export interface Registry {
  people: PersonEntry[];
  /** Every known word or term, compared without case: name parts, glossary terms, organizations. */
  known: Set<string>;
  /** Known abbreviations and terms, exactly as written (for capitals). */
  terms: Set<string>;
}

export interface Finding {
  key: string;
  kind: 'person' | 'abbreviation';
  /** What the text says. */
  found: string;
  /** The known spelling it is close to (person only). */
  suggestion?: string;
  /** 1-based line of the first occurrence. */
  line: number;
  snippet: string;
  count: number;
}

/** Abbreviations so common in business writing that listing them would only be noise. */
const COMMON = new Set(('AI API APIS CEO CFO COO CTO CIO CEOS HR IT PR PDF PPT PPTX DOCX XLSX CSV HTML CSS JSON XML URL URLS ' +
  'UI UX QA KPI KPIS OKR OKRS ROI FY Q1 Q2 Q3 Q4 H1 H2 YOY MOM YTD EOD EOW EOM ETA FAQ TBD TBC NA N-A OK USA US UK EU ' +
  'JP JPY USD EUR GBP BRL VAT ID IDS IP SLA SLAS SaaS SAAS B2B B2C R&D PM AM MVP POC PoC NDA RFP RFQ SOW MOU CRM ERP ' +
  'II III IV VI VII VIII IX XI XII AM PM GMT UTC JST TODO FYI ASAP CC BCC MD EN JA ES PT DE FR ZH KO ' +
  'DRAFT NOTE NOTES WIP NB PS RACI PHD PhD FAQS').split(/\s+/));

/** A word in a cased script (Latin, Greek, Cyrillic, with accents and combining marks); never Chinese or Japanese. */
const LATIN_WORD = /[\p{Lu}\p{Ll}][\p{Lu}\p{Ll}\p{M}'’-]*/gu;
/** Most findings listed for one file: enough to act on, never a flood. */
export const MAX_FINDINGS = 200;
const HONORIFIC_AFTER = /^(?:-?(?:san|sama|kun|chan|sensei|shi)\b|さん|様|さま|氏|君|くん|先生)/i;
const CJK = /[㐀-䶿一-鿿豈-﫿]/;
const CJK_RUN = /[㐀-䶿一-鿿豈-﫿々]+/g;

/** Splits a stakeholder `name` like "Family Given (漢字 漢字)" into its Latin and bracketed parts. */
export function personEntry(name: string): PersonEntry | null {
  const trimmed = name.normalize('NFC').trim();
  if (!trimmed) return null;
  const bracket = /[(（]([^)）]+)[)）]/.exec(trimmed);
  const outside = trimmed.replace(/[(（][^)）]*[)）]/g, ' ');
  const latin = (outside.match(LATIN_WORD) ?? []).filter((p) => p.length >= 2);
  let cjk: PersonEntry['cjk'] = null;
  const cjkSource = bracket?.[1] ?? (CJK.test(outside) ? outside : '');
  if (cjkSource && CJK.test(cjkSource)) {
    const parts = cjkSource.split(/[\s\u3000\u30fb\uff65]+/).map((p) => p.trim()).filter((p) => CJK.test(p));
    cjk = { full: parts.join(''), parts };
  }
  if (latin.length === 0 && !cjk) return null;
  return { name: trimmed, latin, cjk };
}

/** Terms named by one glossary heading or lead: "OTS / OTSV" gives both; "Long form (LF)" gives both. */
export function splitTerm(raw: string): string[] {
  const out: string[] = [];
  for (const piece of raw.replace(/[*_`#]/g, '').split(/\s*[/／,、]\s*/)) {
    const term = piece.trim();
    if (!term) continue;
    const paren = /^(.*?)\s*[(（]([^)）]+)[)）]\s*$/.exec(term);
    if (paren) { if (paren[1]!.trim()) out.push(paren[1]!.trim()); out.push(paren[2]!.trim()); }
    else out.push(term);
  }
  return out;
}

/** Glossary terms in a note: its title, `#`-headings and bold lead terms (`**Term**:` at the start of a line). */
export function glossaryTerms(title: string | undefined, body: string): string[] {
  const raw: string[] = [];
  if (title) raw.push(title);
  for (const line of body.split('\n')) {
    const heading = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) raw.push(heading[1]!);
    const lead = /^\s*(?:[-*+]\s+)?\*\*([^*]+)\*\*\s*[:：]/.exec(line);
    if (lead) raw.push(lead[1]!);
    const tableLead = /^\s*\|\s*\**([^|*]+?)\**\s*\|/.exec(line);
    if (tableLead && !/^[-:\s]+$/.test(tableLead[1]!)) raw.push(tableLead[1]!);
  }
  return raw.flatMap(splitTerm);
}

export function buildRegistry(input: { names: string[]; organizations?: string[]; terms: string[] }): Registry {
  const people = input.names.map(personEntry).filter((p): p is PersonEntry => !!p);
  const known = new Set<string>();
  const terms = new Set<string>();
  const addWords = (text: string) => {
    known.add(text.toLowerCase());
    for (const w of text.match(/[\p{L}\p{N}][\p{L}\p{N}&'’-]*/gu) ?? []) { known.add(w.toLowerCase()); terms.add(w); }
  };
  for (const p of people) {
    for (const part of p.latin) known.add(part.toLowerCase());
    if (p.cjk) { known.add(p.cjk.full); for (const part of p.cjk.parts) known.add(part); }
  }
  for (const t of [...input.terms, ...(input.organizations ?? [])]) { if (t.trim()) { terms.add(t.trim()); addWords(t.trim()); } }
  return { people, known, terms };
}

/** Spaces of the same length as `text`, keeping its line breaks. */
function spaces(text: string): string {
  return text.replace(/[^\n]/g, ' ');
}

/** Replaces each match with spaces (keeping line breaks), or keeps one part of it. Every pattern here must be linear. */
function blank(text: string, re: RegExp, keep?: (m: RegExpExecArray) => string): string {
  return text.replace(re, (...args) => {
    const m = args.slice(0, -2) as unknown as RegExpExecArray;
    const whole = m[0];
    if (keep) {
      const kept = keep(m);
      const i = whole.indexOf(kept);
      if (kept && i >= 0) return spaces(whole.slice(0, i)) + kept + spaces(whole.slice(i + kept.length));
    }
    return spaces(whole);
  });
}

/** Blanks everything from each `open` to the next `close` (or to the end), searching forward only: linear in the text. */
function blankBetween(text: string, open: RegExp, close: (opened: RegExpExecArray) => string, toEnd: boolean): string {
  let out = '';
  let from = 0;
  const missing = new Set<string>();
  const opener = new RegExp(open.source, open.flags.includes('g') ? open.flags : open.flags + 'g');
  for (;;) {
    opener.lastIndex = from;
    const m = opener.exec(text);
    if (!m) break;
    const closeText = close(m).toLowerCase();
    let found: RegExpExecArray | null = null;
    // Once a closer is known to be missing from some point on, it is missing from every later point: never search again.
    if (!missing.has(closeText)) {
      const closer = new RegExp(closeText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      closer.lastIndex = m.index + m[0].length;
      found = closer.exec(text);
      if (!found) missing.add(closeText);
    }
    // Unclosed: to the end in HTML (as a browser reads it); in Markdown it is usually literal text, so only the opener.
    const stop = found ? found.index + found[0].length : toEnd ? text.length : m.index + m[0].length;
    out += text.slice(from, m.index) + spaces(text.slice(m.index, stop));
    from = stop;
    if (!found && toEnd) break;
  }
  return out + text.slice(from);
}

const BLOCK_TAGS = new Set(['p', 'div', 'li', 'td', 'th', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'br', 'section', 'article',
  'header', 'footer', 'table', 'ul', 'ol', 'dt', 'dd', 'blockquote', 'figcaption', 'caption']);

/**
 * Blanks every tag, however long (an embedded image can make one megabytes long), in one forward pass. A block
 * boundary (cell, item, heading, paragraph, line break) ends in a line break, so the next word starts a sentence.
 */
function blankTags(text: string): string {
  let out = '';
  let from = 0;
  const open = /<\/?([A-Za-z][A-Za-z0-9-]*)/g;
  for (;;) {
    open.lastIndex = from;
    const m = open.exec(text);
    if (!m) break;
    const close = text.indexOf('>', m.index + m[0].length);
    if (close < 0) break; // no '>' anywhere after: no later tag can close either
    const tag = text.slice(m.index, close + 1);
    const blanked = spaces(tag);
    out += text.slice(from, m.index) + (BLOCK_TAGS.has(m[1]!.toLowerCase()) ? blanked.slice(0, -1) + '\n' : blanked);
    from = close + 1;
  }
  return out + text.slice(from);
}

/** Fenced code blocks (``` or ~~~, indented up to 3 spaces), line by line. */
function blankFences(text: string): string {
  const lines = text.split('\n');
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(lines[i]!);
    if (fence === null) {
      // A backtick fence's info string has no backtick ("```js```" on one line is inline code, not a fence).
      if (open && !(open[1]![0] === '`' && open[2]!.includes('`'))) { fence = open[1]!; lines[i] = spaces(lines[i]!); }
    } else {
      const closes = open && open[1]![0] === fence[0] && open[1]!.length >= fence.length && lines[i]!.trim() === open[1];
      lines[i] = spaces(lines[i]!);
      if (closes) fence = null;
    }
  }
  return lines.join('\n');
}

/**
 * The prose of a Markdown, HTML or text file: code, links' targets, URLs, markup, emphasis, entities, frontmatter,
 * placeholders and workspace ids replaced by spaces. It has exactly the length of `text`, so offsets are the file's.
 * Every step is linear in the text: a deliverable can be large and must never stall the server.
 */
export function proseOf(text: string, kind: 'md' | 'html' | 'txt'): string {
  let s = text.replace(/\r\n?/g, (m) => ' '.repeat(m.length - 1) + '\n').replace(/^\ufeff/, ' ');
  if (kind === 'md') {
    if (/^ ?---\n/.test(s)) {
      const close = s.indexOf('\n---', 3);
      const stop = close < 0 ? 0 : close + 4;
      if (stop > 0) s = spaces(s.slice(0, stop)) + s.slice(stop);
    }
    s = blankFences(s);
    s = blank(s, /`[^`\n]{1,500}`/g);
    s = blank(s, /!\[[^[\]\n]{0,200}\]\([^()\n]{0,500}\)/g);
    s = blank(s, /\[([^[\]\n]{0,200})\]\([^()\n]{0,500}\)/g, (m) => m[1] ?? '');
    s = blank(s, /^ {0,3}\[[^\]\n]{1,200}\]:[^\n]*$/gm);
    // Emphasis markers next to a word: "**Name**" reads as "Name" in the middle of its sentence.
    s = s.replace(/(\*{1,3}|_{1,3})(?=[\p{L}\p{N}])|(?<=[\p{L}\p{N}.!?])(\*{1,3}|_{1,3})/gu, (m) => ' '.repeat(m.length));
  }
  if (kind === 'md' || kind === 'html') {
    s = blankBetween(s, /<!--/g, () => '-->', kind === 'html');
    s = blankBetween(s, /<(script|style|code|pre|kbd|samp|title)(?=[\s>/])/gi, (m) => `</${m[1]!.toLowerCase()}`, kind === 'html');
    s = blankTags(s);
    s = blank(s, /&(?:#\d{1,7}|#x[0-9a-f]{1,6}|[a-z][a-z0-9]{0,30});/gi);
  }
  s = blank(s, /\bdata:[\w/+.-]{1,100}(?:;[\w=.-]{1,100}){0,5},[A-Za-z0-9+/=%_-]+/g);
  s = blank(s, /\b(?:https?|ftp|file|mailto):[^\s<>"')\]]{1,4000}/gi);
  s = blank(s, /\bwww\.[^\s<>"')\]]{1,4000}/gi);
  s = blank(s, /(?<![\w.+-])[\w.+-]{1,64}@[\w-]{1,63}(?:\.[\w-]{1,63}){1,8}/g);
  s = blank(s, /\[(?:PLACEHOLDER|INSERT|TBD|TODO)\b[^\]\n]{0,1000}\]/gi);
  s = blank(s, /\bINSERT FROM [A-Z][A-Z ]{0,80}/g);
  s = blank(s, /(?<![A-Za-z0-9-])[A-Z]{1,7}-[A-Za-z0-9]{0,20}\d[A-Za-z0-9-]{0,40}/g);
  s = blank(s, /(?<![\w.-])[\w.-]{1,200}\.(?:md|html?|txt|pdf|pptx?|docx?|xlsx?|csv|json|ya?ml|png|jpe?g|svg)\b/gi);
  return s;
}

/** Optimal string alignment distance (a swap of two neighbours counts once), stopping early above `max`. */
export function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev2: number[] = [];
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2]! + 1);
      cur.push(v);
      rowMin = Math.min(rowMin, v);
    }
    if (rowMin > max) return max + 1;
    prev2 = prev;
    prev = cur;
  }
  return prev[b.length]!;
}

/** How far a word of this length may be from a name: none at 3 letters or fewer, 1 up to 7, 2 from 8. */
export function allowedDistance(length: number): number {
  return length <= 3 ? 0 : length <= 7 ? 1 : 2;
}

/** Start offsets of every line, for line numbers by binary search. */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  return starts;
}

function lineOf(starts: number[], index: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= index) lo = mid; else hi = mid - 1;
  }
  return lo + 1;
}

function snippetAt(original: string, index: number, length: number): string {
  const start = original.lastIndexOf('\n', index - 1) + 1;
  const endNl = original.indexOf('\n', index + length);
  const end = endNl < 0 ? original.length : endNl;
  const from = Math.max(start, index - 60);
  const to = Math.min(end, index + length + 60);
  return (from > start ? '…' : '') + original.slice(from, to).replace(/\s+/g, ' ').trim() + (to < end ? '…' : '');
}

/** True when the word at `index` starts a sentence, a line, a heading or a list item. A table cell does not. */
function sentenceStart(prose: string, index: number): boolean {
  let i = index - 1;
  while (i >= 0 && (prose[i] === ' ' || prose[i] === '\t')) i--;
  if (i < 0 || prose[i] === '\n') return true;
  const c = prose[i]!;
  if (/[.!?:;#>•–—。！？]/.test(c)) return true;
  if (c === '-' || c === '+' || c === '*' || /\d/.test(c)) {
    let j = i - 1;
    while (j >= 0 && /[\d \t]/.test(prose[j]!)) j--;
    return j < 0 || prose[j] === '\n';
  }
  return false;
}

/** Fiscal and period labels such as FY26, FY2026, Q3FY26, H1, CY2025: never unknown abbreviations. */
const PERIOD = /^(?:(?:FY|CY|Q[1-4]|H[12])\d{0,4})+$/;

export interface CheckResult {
  findings: Finding[];
  /** All findings found, when more than MAX_FINDINGS were (only the first ones are listed). */
  total: number;
}

/**
 * The findings for one file. `prose` is `proseOf(original, kind)`; `original` gives the snippets. Each finding is
 * listed once, at its first place, with how often it occurs; at most MAX_FINDINGS of them. Linear in the text.
 */
export function checkText(original: string, prose: string, registry: Registry): Finding[] {
  return checkTextFull(original, prose, registry).findings;
}

export function checkTextFull(original: string, prose: string, registry: Registry): CheckResult {
  const starts = lineStarts(original);
  const found = new Map<string, Omit<Finding, 'line' | 'snippet'> & { at: number; length: number }>();
  const add = (f: Omit<Finding, 'line' | 'snippet' | 'count'>, index: number, length: number) => {
    const prev = found.get(f.key);
    if (prev) { prev.count++; return; }
    found.set(f.key, { ...f, at: index, length, count: 1 });
  };

  // Latin words: close to one part of a known name, with an anchor.
  const words = [...prose.matchAll(LATIN_WORD)];
  const parts = registry.people.flatMap((p) => p.latin.filter((x) => x.length >= 4).map((part) => ({ part, lower: part.toLowerCase(), person: p })));
  const byInitial = new Map<string, typeof parts>();
  for (const entry of parts) {
    const k = entry.lower[0]!;
    byInitial.set(k, [...(byInitial.get(k) ?? []), entry]);
  }
  const capitalised = (w: string | undefined) => !!w && w[0] !== w[0]!.toLowerCase();
  const closest = new Map<string, { part: string; person: PersonEntry; d: number } | null>();
  for (let w = 0; w < words.length; w++) {
    const token = words[w]![0];
    const index = words[w]!.index!;
    // "Okabe-san" is "Okabe" with an honorific; "Natarajan's" is "Natarajan".
    const honorific = /-(?:san|sama|kun|chan|sensei|shi)$/i.exec(token);
    const word = (honorific ? token.slice(0, honorific.index) : token).replace(/['’]s?$/i, '').replace(/[-'’]+$/, '');
    if (word.length < 4 || word.length > 40 || !capitalised(word)) continue;
    if (word === word.toUpperCase()) continue; // capitals: an abbreviation, not a name
    const lower = word.toLowerCase();
    if (registry.known.has(lower)) continue;
    // The closest known name part, worked out once per distinct word (documents repeat their words).
    let best = closest.get(lower);
    if (best === undefined) {
      best = null;
      const max = allowedDistance(word.length);
      for (const { part, lower: target, person } of byInitial.get(lower[0]!) ?? []) {
        const limit = Math.min(max, allowedDistance(part.length));
        const d = editDistance(lower, target, limit);
        if (d === 0 || d > limit) continue;
        if (!best || d < best.d) best = { part, person, d };
      }
      closest.set(lower, best);
    }
    if (!best) continue;
    // Neighbours are words next to this one on the same line, with only spaces between.
    const near = (m: RegExpMatchArray | undefined, before: boolean) => {
      if (!m) return undefined;
      const gap = before ? prose.slice(m.index! + m[0].length, index) : prose.slice(index + token.length, m.index!);
      return /^[ \t]{1,3}$/.test(gap) ? m[0] : undefined;
    };
    const prev = near(words[w - 1], true);
    const next = near(words[w + 1], false);
    // Another part of the same person next to it, spelt right or nearly ("Dnaa Lindqvst" for "Dana Lindqvist").
    const sameName = [prev, next].some((n) => {
      if (!n) return false;
      const other = n.replace(/['’]s?$/i, '').toLowerCase();
      return best!.person.latin.some((p) => p !== best!.part && editDistance(other, p.toLowerCase(), allowedDistance(p.length)) <= allowedDistance(p.length));
    });
    const title = /(?:^|[^\p{L}])(?:Mr|Ms|Mrs|Mx|Dr|Prof|Sir|Dame)\.?[ \t]{1,3}$/u.test(prose.slice(Math.max(0, index - 12), index));
    const after = prose.slice(index + word.length, index + word.length + 12).replace(/^\s+/, '');
    const strong = sameName || title || !!honorific || HONORIFIC_AFTER.test(after);
    // A capital in mid-sentence also counts, unless the word is common English or sits next to a capitalised common
    // word (title case in a heading or a product or team name: "the Advisory Panel", "Meeting With ...").
    const titleCase = (n: string | undefined) => capitalised(n) && COMMON_WORDS.has(n!.toLowerCase());
    const weak = !sentenceStart(prose, index) && !COMMON_WORDS.has(lower) && !titleCase(prev) && !titleCase(next);
    if (!strong && !weak) continue;
    add({ key: `person:${word}>${best.part}`, kind: 'person', found: word, suggestion: best.part }, index, word.length);
  }

  // Scripts without spaces: a window one character off a known name of 3+ characters, or a 2-character family name
  // one character off when an honorific follows. Each target is indexed under its one-wildcard variants, so the cost is
  // the text times the name length, whatever the number of people.
  const WILD = '\u0000';
  const variants = new Map<number, Map<string, Array<{ target: string; needsHonorific: boolean }>>>();
  for (const person of registry.people) {
    if (!person.cjk) continue;
    const targets: Array<{ target: string; needsHonorific: boolean }> = [];
    if (person.cjk.full.length >= 3) targets.push({ target: person.cjk.full, needsHonorific: false });
    for (const part of person.cjk.parts) {
      if (part.length >= 3 && part !== person.cjk.full) targets.push({ target: part, needsHonorific: false });
      else if (part.length === 2) targets.push({ target: part, needsHonorific: true });
    }
    for (const t of targets) {
      if (t.target.length > 8) continue; // longer names in this script are rare; a misspelling is caught in their parts
      const byLength = variants.get(t.target.length) ?? new Map();
      variants.set(t.target.length, byLength);
      for (let k = 0; k < t.target.length; k++) {
        const v = t.target.slice(0, k) + WILD + t.target.slice(k + 1);
        byLength.set(v, [...(byLength.get(v) ?? []), t]);
      }
    }
  }
  const lengths = [...variants.keys()].sort((a, b) => b - a); // full names before their parts
  // Characters used in any target: a window with two or more others cannot be one character off a name.
  const nameChars = new Set<string>();
  for (const byLength of variants.values()) for (const v of byLength.keys()) for (const ch of v) nameChars.add(ch);
  for (const run of prose.matchAll(CJK_RUN)) {
    const text = run[0];
    const covered = new Uint8Array(text.length);
    const foreign = new Uint32Array(text.length + 1); // prefix counts of characters not in any name
    for (let i = 0; i < text.length; i++) foreign[i + 1] = foreign[i]! + (nameChars.has(text[i]!) ? 0 : 1);
    for (const L of lengths) {
      const byLength = variants.get(L)!;
      for (let i = 0; i + L <= text.length; i++) {
        if (foreign[i + L]! - foreign[i]! >= 2) continue;
        const window = text.slice(i, i + L);
        if (registry.known.has(window)) continue;
        let hit: { target: string; needsHonorific: boolean } | null = null;
        for (let k = 0; k < L && !hit; k++) {
          for (const t of byLength.get(window.slice(0, k) + WILD + window.slice(k + 1)) ?? []) {
            if (t.target !== window) { hit = t; break; }
          }
        }
        if (!hit) continue;
        const at = run.index! + i;
        if (hit.needsHonorific && !HONORIFIC_AFTER.test(prose.slice(at + L, at + L + 4))) continue;
        if (covered.subarray(i, i + L).some((x) => x === 1)) continue;
        covered.fill(1, i, i + L);
        add({ key: `person:${window}>${hit.target}`, kind: 'person', found: window, suggestion: hit.target }, at, L);
      }
    }
  }

  // Abbreviations: 2 to 6 capitals (digits, & or - inside), not known, not common, not defined in the text.
  const defined = new Set<string>();
  for (const m of prose.matchAll(/[(（][ \t]{0,3}([A-Z][A-Za-z0-9&-]{1,7})[ \t]{0,3}[)）]/g)) defined.add(m[1]!);
  for (const m of prose.matchAll(/(?<![A-Za-z0-9&-])([A-Z][A-Z0-9&-]{1,7})[ \t]{0,3}[(（][ \t]{0,3}\p{L}[^)）\n]{2,120}[)）]/gu)) defined.add(m[1]!);
  for (const m of prose.matchAll(/(?<![A-Za-z0-9&-])[A-Z][A-Za-z0-9&-]{1,7}(?![A-Za-z0-9&])/g)) {
    let abbr = m[0].replace(/-+$/, '');
    if (/^[A-Z]{2,}s$/.test(abbr)) abbr = abbr.slice(0, -1); // a plural: "POs" is "PO"
    const letters = abbr.replace(/[^A-Z]/g, '');
    if (letters.length < 2 || abbr.length > 6 || /[a-z]{2}/.test(abbr)) continue;
    if (abbr !== abbr.toUpperCase() && !/^[A-Z][a-z]?[A-Z]/.test(abbr)) continue;
    if (/^[A-Z]{3,}\d+$/.test(abbr) || PERIOD.test(abbr)) continue; // a label with a number ("NEW1"), a period ("FY26")
    if (COMMON.has(abbr) || COMMON.has(abbr.toUpperCase()) || defined.has(abbr)) continue;
    if (registry.terms.has(abbr) || registry.known.has(abbr.toLowerCase())) continue;
    // Text set in capitals ("NEW GROUP LINE"), or part of a known name in capitals ("NORTHWIND GROUP").
    const before = /([A-Za-z]+)[^A-Za-z\n]{1,3}$/.exec(prose.slice(Math.max(0, m.index! - 40), m.index!))?.[1];
    const next = /^[^A-Za-z\n]{1,3}([A-Za-z]+)/.exec(prose.slice(m.index! + m[0].length, m.index! + m[0].length + 40))?.[1];
    if ([before, next].some((w) => w && w.length >= 4 && w === w.toUpperCase()) && abbr.length >= 4) continue;
    if ([before, next].some((w) => w && w.length >= 2 && w === w.toUpperCase() && registry.terms.has(w))) continue;
    add({ key: `abbreviation:${abbr}`, kind: 'abbreviation', found: abbr }, m.index!, abbr.length);
  }

  const all = [...found.values()].sort((a, b) => a.at - b.at || a.found.localeCompare(b.found));
  // Only the displayed findings need snippets. Scanning a long line for every distinct finding was quadratic.
  return { findings: all.slice(0, MAX_FINDINGS).map(({ at, length, ...f }) => ({
    ...f, line: lineOf(starts, at), snippet: snippetAt(original, at, length),
  })), total: all.length };
}
