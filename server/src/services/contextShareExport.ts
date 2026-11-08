/**
 * The pure part of sharing context notes (#107): one note body rebuilt from an explicit list of Markdown parts. No
 * relative imports, so it also runs alone in a worker thread (see contextShare.ts), where a pathological note is stopped
 * by a deadline and a memory limit instead of stalling the server.
 */
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown, gfmToMarkdown } from 'mdast-util-gfm';
import { toMarkdown } from 'mdast-util-to-markdown';
import { gfm } from 'micromark-extension-gfm';
import type { Nodes, Parents, Root, RootContent } from 'mdast';

/** Why a note cannot be exported; the dashboard words each code in the user's language. */
export type ExportProblem = 'too_complex' | 'unknown_part';

export class ExportRefused extends Error {
  constructor(readonly code: ExportProblem, message: string) { super(message); }
}

/** Block and inline parts kept, with their children rebuilt the same way. Anything else in a note refuses it. */
const KEEP = new Set(['root', 'heading', 'paragraph', 'list', 'listItem', 'table', 'tableRow', 'tableCell', 'code', 'inlineCode',
  'blockquote', 'thematicBreak', 'text', 'emphasis', 'strong', 'delete', 'break']);
/** Parts left out on purpose (nothing of them is in the file). */
const DROP = new Set(['html', 'image', 'imageReference', 'definition', 'footnoteDefinition', 'footnoteReference', 'yaml']);
/** Parts reduced to their words: a link keeps its text, never its target. */
const UNWRAP = new Set(['link', 'linkReference']);
/** Containers that say nothing once emptied by what was taken out. */
const DROP_WHEN_EMPTY = new Set(['paragraph', 'heading', 'listItem', 'list', 'blockquote', 'emphasis', 'strong', 'delete']);

/** Lines nested deeper than this (quotes, list items) are refused before parsing: the parser recurses on them. */
const MAX_NESTING = 40;

function textOf(node: Nodes): string {
  if ('value' in node && typeof node.value === 'string') return node.value;
  return 'children' in node ? (node as Parents).children.map((c) => textOf(c as Nodes)).join('') : '';
}

/** A link whose words are its own address (an autolink, a bare web or e-mail address): the address is the target. */
function addressLink(node: Nodes): boolean {
  if (node.type !== 'link') return false;
  const text = textOf(node).trim();
  const url = node.url.trim();
  return text === url || `mailto:${text}` === url || `http://${text}` === url || `https://${text}` === url
    || /^(?:[a-z][a-z0-9+.-]*:|www\.)\S+$/i.test(text) || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text);
}

/** Nesting depth of the most nested line: quote and list markers at its start, and list indentation. */
function nestingDepth(body: string): number {
  let deepest = 0;
  for (const line of body.split('\n')) {
    const lead = /^(?:[ \t]*(?:>|[-*+](?=[ \t])|\d{1,9}[.)](?=[ \t])))*/.exec(line)?.[0] ?? '';
    const depth = (lead.match(/>|[-*+](?=[ \t])|\d{1,9}[.)]/g) ?? []).length;
    const indent = /^[ \t]*/.exec(line)![0].replace(/\t/g, '    ').length;
    const byIndent = /^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]/.test(line) ? Math.floor(indent / 2) : 0;
    deepest = Math.max(deepest, depth, byIndent);
  }
  return deepest;
}

/** The note body rebuilt from allowed parts only, its headings placed right under the note's title. */
export function exportBody(body: string): string {
  if (nestingDepth(body) > MAX_NESTING) throw new ExportRefused('too_complex', 'The note nests too deeply to export safely.');
  const tree = fromMarkdown(body, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  const clean = (node: Nodes): RootContent[] => {
    if (DROP.has(node.type) || addressLink(node)) return [];
    if (UNWRAP.has(node.type)) return (node as Parents).children.flatMap((c) => clean(c as Nodes));
    if (!KEEP.has(node.type)) throw new ExportRefused('unknown_part', `It contains a part the export cannot handle safely (${node.type}).`);
    const copy = { ...node } as Nodes & { position?: unknown; data?: unknown };
    delete copy.position;
    delete copy.data;
    if (copy.type === 'listItem' && typeof copy.checked === 'boolean') copy.checked = null; // task boxes read as plain items
    if (copy.type === 'code') {
      // The info string after the language is not shown when a note is read: never carried out.
      copy.meta = null;
      if (copy.lang && !/^[\w+#.-]{1,30}$/.test(copy.lang)) copy.lang = null;
    }
    if ('children' in copy) (copy as Parents).children = (copy as Parents).children.flatMap((c) => clean(c as Nodes)) as never;
    // Space left at the edges by what was taken out ("text <!-- note -->") is trimmed, never written as an escape.
    if (copy.type === 'paragraph' || copy.type === 'heading' || copy.type === 'tableCell') {
      // Neighbouring text joined, and the double space a removed part leaves collapsed.
      const kids: RootContent[] = [];
      for (const k of copy.children as RootContent[]) {
        const prev = kids[kids.length - 1];
        if (k.type === 'text' && prev?.type === 'text') prev.value = (prev.value + k.value).replace(/[ \t]{2,}/g, ' ');
        else kids.push(k.type === 'text' ? { ...k } : k);
      }
      const first = kids[0];
      const last = kids[kids.length - 1];
      if (first?.type === 'text') first.value = first.value.replace(/^[ \t]+/, '');
      if (last?.type === 'text') last.value = last.value.replace(/[ \t]+$/, '');
      copy.children = kids.filter((k) => k.type !== 'text' || k.value !== '') as never;
    }
    // A container emptied by what was taken out (an image alone in a paragraph, a heading, an item) goes too.
    if (DROP_WHEN_EMPTY.has(copy.type) && (copy as Parents).children.length === 0) return [];
    return [copy as RootContent];
  };
  const root: Root = { type: 'root', children: tree.children.flatMap((c) => clean(c)) };
  // The note's top heading (of what is kept) becomes level 2, right under the title; deeper levels keep their steps.
  let top = 6;
  const visit = (n: Nodes) => { if (n.type === 'heading') top = Math.min(top, n.depth); if ('children' in n) (n as Parents).children.forEach((c) => visit(c as Nodes)); };
  visit(root);
  const shift = 2 - top;
  const place = (n: Nodes) => {
    if (n.type === 'heading') n.depth = Math.max(2, Math.min(6, n.depth + shift)) as 1 | 2 | 3 | 4 | 5 | 6;
    if ('children' in n) (n as Parents).children.forEach((c) => place(c as Nodes));
  };
  place(root);
  return toMarkdown(root, { extensions: [gfmToMarkdown()], bullet: '-', emphasis: '_', strong: '*', fences: true, rule: '-' }).trim();
}

/** A note's title as a level-1 heading, escaped as a heading (a closing "#" stays part of the title). */
export function titleLine(title: string): string {
  const one = title.replace(/\s+/g, ' ').trim() || 'Untitled';
  return toMarkdown({ type: 'heading', depth: 1, children: [{ type: 'text', value: one }] }).trim();
}

/** One note's section of the file, or why it cannot be exported. Used directly and from the worker. */
export function exportSection(title: string, body: string): { ok: true; text: string } | { ok: false; code: ExportProblem; message: string } {
  try {
    return { ok: true, text: `${titleLine(title)}\n\n${exportBody(body)}`.trimEnd() };
  } catch (err) {
    if (err instanceof ExportRefused) return { ok: false, code: err.code, message: err.message };
    if (err instanceof RangeError) return { ok: false, code: 'too_complex', message: 'The note nests too deeply to export safely.' };
    throw err;
  }
}
