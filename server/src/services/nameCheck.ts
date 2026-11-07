/**
 * Advisory name and term check for deliverable sources (#85). Pure functions only: a registry of known person names
 * and glossary terms, text with markup and code blanked out, and the findings. Deterministic and local; no model.
 *
 * Two findings only:
 * - `person`: a word close to a known person's name but not equal to it ("Shimoto" for "Shiomoto");
 * - `abbreviation`: 2 to 6 capitals that are not in the glossary and not defined in the text.
 * An unknown full name is never a finding: names are not a dictionary.
 */

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
  'II III IV VI VII VIII IX XI XII AM PM GMT UTC JST TODO FYI ASAP CC BCC MD EN JA ES PT DE FR ZH KO').split(/\s+/));

const HONORIFIC_AFTER = /^(?:-?(?:san|sama|kun|chan|sensei|shi)\b|さん|様|さま|氏|君|くん|先生)/i;
const CJK = /[㐀-䶿一-鿿豈-﫿]/;
const CJK_RUN = /[㐀-䶿一-鿿豈-﫿々]+/g;

/** Splits a stakeholder `name` like "Family Given (漢字 漢字)" into its Latin and bracketed parts. */
export function personEntry(name: string): PersonEntry | null {
  const trimmed = name.trim();
  if (!trimmed) return null;
  const bracket = /[(（]([^)）]+)[)）]/.exec(trimmed);
  const outside = trimmed.replace(/[(（][^)）]*[)）]/g, ' ');
  const latin = (outside.match(/[\p{L}][\p{L}'’-]*/gu) ?? []).filter((p) => p.length >= 2 && !CJK.test(p));
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

/** Replaces a match with spaces of the same length, keeping line breaks, so line numbers and offsets stay right. */
function blank(text: string, re: RegExp, keep?: (m: RegExpExecArray) => string): string {
  return text.replace(re, (...args) => {
    const m = args.slice(0, -2) as unknown as RegExpExecArray;
    const whole = m[0];
    if (keep) {
      const kept = keep(m);
      const i = whole.indexOf(kept);
      if (kept && i >= 0) return whole.slice(0, i).replace(/[^\n]/g, ' ') + kept + whole.slice(i + kept.length).replace(/[^\n]/g, ' ');
    }
    return whole.replace(/[^\n]/g, ' ');
  });
}

/**
 * The prose of a Markdown, HTML or text file: code, links' targets, URLs, markup, entities, frontmatter, placeholders
 * and workspace ids replaced by spaces. Offsets and line numbers of what remains are those of the file.
 */
export function proseOf(text: string, kind: 'md' | 'html' | 'txt'): string {
  let s = text.replace(/\r\n?/g, (m) => ' '.repeat(m.length - 1) + '\n');
  if (kind === 'md') {
    s = blank(s, /^---\n[\s\S]*?\n---(?=\n|$)/);
    s = blank(s, /^(```|~~~)[^\n]*\n[\s\S]*?(?:\n\1[^\n]*|$)/gm);
    s = blank(s, /`[^`\n]+`/g);
    s = blank(s, /!\[[^\]\n]*\]\([^)\n]*\)/g);
    s = blank(s, /\[([^\]\n]*)\]\([^)\n]*\)/g, (m) => m[1] ?? '');
    s = blank(s, /^\s*\[[^\]\n]+\]:\s*\S+.*$/gm);
  }
  if (kind === 'md' || kind === 'html') {
    s = blank(s, /<!--[\s\S]*?-->/g);
    s = blank(s, /<(script|style|code|pre|kbd|samp|title)\b[\s\S]*?<\/\1\s*>/gi);
    // A block boundary (cell, item, heading, paragraph, line break) starts a new sentence: it ends in a line break here.
    s = s.replace(/<\/?(?:p|div|li|td|th|tr|h[1-6]|br|section|article|header|footer|table|ul|ol|dt|dd|blockquote|figcaption|caption)\b[^>]*>/gi,
      (tag) => tag.replace(/[^\n]/g, ' ').slice(0, -1) + '\n');
    s = blank(s, /<[^>]*>/g);
    s = blank(s, /&(?:#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);/gi);
  }
  s = blank(s, /\b(?:https?|ftp|file|mailto):[^\s<>"')\]]+/gi);
  s = blank(s, /\bwww\.[^\s<>"')\]]+/gi);
  s = blank(s, /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g);
  s = blank(s, /\[(?:PLACEHOLDER|INSERT|TBD|TODO)\b[^\]\n]*\]/gi);
  s = blank(s, /\bINSERT FROM [A-Z][A-Z\s]*/g);
  s = blank(s, /\b[A-Z]{1,7}-[A-Za-z0-9]*\d[A-Za-z0-9-]*\b/g);
  s = blank(s, /(?:^|[\s(])[\w.-]+\.(?:md|html?|txt|pdf|pptx?|docx?|xlsx?|csv|json|ya?ml|png|jpe?g|svg)\b/gi);
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

function lineAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

function snippetAt(original: string, index: number, length: number): string {
  const start = original.lastIndexOf('\n', index - 1) + 1;
  const endNl = original.indexOf('\n', index + length);
  const end = endNl < 0 ? original.length : endNl;
  const from = Math.max(start, index - 60);
  const to = Math.min(end, index + length + 60);
  return (from > start ? '…' : '') + original.slice(from, to).replace(/\s+/g, ' ').trim() + (to < end ? '…' : '');
}

/** True when the word at `index` starts a sentence (or a line, a heading, a list item, a table cell). */
function sentenceStart(prose: string, index: number): boolean {
  let i = index - 1;
  while (i >= 0 && (prose[i] === ' ' || prose[i] === '\t')) i--;
  if (i < 0 || prose[i] === '\n') return true;
  const c = prose[i]!;
  if (/[.!?:;|#>*•–—。！？]/.test(c)) return true;
  if (c === '-' || c === '+') {
    let j = i - 1;
    while (j >= 0 && (prose[j] === ' ' || prose[j] === '\t')) j--;
    return j < 0 || prose[j] === '\n';
  }
  return false;
}

/**
 * The findings for one file. `prose` is `proseOf(original, kind)`; `original` gives the snippets. Each finding is
 * listed once, at its first place, with how often it occurs.
 */
export function checkText(original: string, prose: string, registry: Registry): Finding[] {
  const found = new Map<string, Finding>();
  const add = (f: Omit<Finding, 'line' | 'snippet' | 'count'>, index: number, length: number) => {
    const prev = found.get(f.key);
    if (prev) { prev.count++; return; }
    found.set(f.key, { ...f, line: lineAt(original, index), snippet: snippetAt(original, index, length), count: 1 });
  };

  // Latin words: close to one part of a known name, with an anchor.
  const words = [...prose.matchAll(/[A-Za-z\u00c0-\u024f][A-Za-z\u00c0-\u024f'’-]*/g)];
  const parts = registry.people.flatMap((p) => p.latin.filter((x) => x.length >= 4).map((part) => ({ part, person: p })));
  for (let w = 0; w < words.length; w++) {
    const token = words[w]![0];
    const honorific = /-(?:san|sama|kun|chan|sensei|shi)$/i.exec(token);
    const word = (honorific ? token.slice(0, honorific.index) : token).replace(/['’-]+$/, '');
    const index = words[w]!.index!;
    if (word.length < 4 || word[0] !== word[0]!.toUpperCase() || word[0] === word[0]!.toLowerCase()) continue;
    if (word === word.toUpperCase()) continue; // capitals: an abbreviation, not a name
    if (registry.known.has(word.toLowerCase())) continue;
    const max = allowedDistance(word.length);
    let best: { part: string; person: PersonEntry; d: number } | null = null;
    for (const { part, person } of parts) {
      if (part[0]!.toLowerCase() !== word[0]!.toLowerCase()) continue;
      const d = editDistance(word.toLowerCase(), part.toLowerCase(), Math.min(max, allowedDistance(part.length)));
      if (d === 0 || d > Math.min(max, allowedDistance(part.length))) continue;
      if (!best || d < best.d) best = { part, person, d };
    }
    if (!best) continue;
    const neighbours = [words[w - 1], words[w + 1]].filter(Boolean).map((m) => m![0].toLowerCase());
    const after = prose.slice(index + word.length).replace(/^\s+/, '');
    const anchored = neighbours.some((n) => best!.person.latin.some((p) => p.toLowerCase() === n && p !== best!.part))
      || HONORIFIC_AFTER.test(after)
      || !sentenceStart(prose, index);
    if (!anchored) continue;
    add({ key: `person:${word}>${best.part}`, kind: 'person', found: word, suggestion: best.part }, index, word.length);
  }

  // Scripts without spaces: a run of characters one character away from a known name of 3+ characters, or a
  // 2-character family name one character away when an honorific follows.
  for (const run of prose.matchAll(CJK_RUN)) {
    const text = run[0];
    // Places already reported in this run (a full name first), so a part of the same name is not reported again.
    const covered: Array<[number, number]> = [];
    for (const person of registry.people) {
      if (!person.cjk) continue;
      const targets: Array<{ target: string; needsHonorific: boolean }> = [];
      if (person.cjk.full.length >= 3) targets.push({ target: person.cjk.full, needsHonorific: false });
      for (const part of person.cjk.parts) {
        if (part.length >= 3 && part !== person.cjk.full) targets.push({ target: part, needsHonorific: false });
        else if (part.length === 2) targets.push({ target: part, needsHonorific: true });
      }
      for (const { target, needsHonorific } of targets) {
        if (text.includes(target)) continue;
        for (let i = 0; i + target.length <= text.length; i++) {
          const window = text.slice(i, i + target.length);
          let diff = 0;
          for (let k = 0; k < target.length && diff <= 1; k++) if (window[k] !== target[k]) diff++;
          if (diff !== 1 || registry.known.has(window)) continue;
          const at = run.index! + i;
          if (needsHonorific && !HONORIFIC_AFTER.test(prose.slice(at + window.length))) continue;
          if (covered.some(([a, b]) => at < b && at + window.length > a)) continue;
          covered.push([at, at + window.length]);
          add({ key: `person:${window}>${target}`, kind: 'person', found: window, suggestion: target }, at, window.length);
        }
      }
    }
  }

  // Abbreviations: 2 to 6 capitals (digits, & or - inside), not known, not common, not defined in the text.
  const defined = new Set<string>();
  for (const m of prose.matchAll(/[(（]\s*([A-Z][A-Za-z0-9&-]{1,7})\s*[)）]/g)) defined.add(m[1]!);
  for (const m of prose.matchAll(/\b([A-Z][A-Z0-9&-]{1,7})\s*[(（]\s*[\p{L}][^)）]{3,}[)）]/gu)) defined.add(m[1]!);
  for (const m of prose.matchAll(/(?<![A-Za-z0-9&-])([A-Z][A-Za-z0-9&-]*[A-Z][A-Za-z0-9&-]*)(?![A-Za-z0-9&])/g)) {
    let abbr = m[1]!.replace(/-+$/, '');
    if (/^[A-Z]{2,}s$/.test(abbr)) abbr = abbr.slice(0, -1); // a plural: "POs" is "PO"
    if (/^[A-Z]{3,}\d+$/.test(abbr)) continue; // a label with a number ("NEW1"), not an abbreviation
    // Text set in capitals ("NEW GROUP LINE"): a neighbouring word in capitals too means styling, not abbreviations.
    const before = /([A-Za-z]+)[^A-Za-z\n]{1,3}$/.exec(prose.slice(Math.max(0, m.index! - 40), m.index!))?.[1];
    const next = /^[^A-Za-z\n]{1,3}([A-Za-z]+)/.exec(prose.slice(m.index! + m[1]!.length, m.index! + m[1]!.length + 40))?.[1];
    if ([before, next].some((w) => w && w.length >= 4 && w === w.toUpperCase()) && abbr.length >= 4) continue;
    // Part of a known name in capitals ("NORTHWIND GROUP" when NORTHWIND is known).
    if ([before, next].some((w) => w && w.length >= 2 && w === w.toUpperCase() && registry.terms.has(w))) continue;
    const letters = abbr.replace(/[^A-Z]/g, '');
    if (letters.length < 2 || abbr.length > 6 || /[a-z]{2}/.test(abbr)) continue;
    if (abbr !== abbr.toUpperCase() && !/^[A-Z][a-z]?[A-Z]/.test(abbr)) continue;
    if (COMMON.has(abbr) || COMMON.has(abbr.toUpperCase()) || defined.has(abbr)) continue;
    if (registry.terms.has(abbr) || registry.known.has(abbr.toLowerCase())) continue;
    add({ key: `abbreviation:${abbr}`, kind: 'abbreviation', found: abbr }, m.index!, abbr.length);
  }

  return [...found.values()].sort((a, b) => a.line - b.line || a.found.localeCompare(b.found));
}
