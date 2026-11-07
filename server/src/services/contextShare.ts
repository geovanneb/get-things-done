import * as path from 'path';
import * as fsp from 'fs/promises';
import { createHash } from 'crypto';
import { constants as fsConstants } from 'fs';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown, gfmToMarkdown } from 'mdast-util-gfm';
import { toMarkdown } from 'mdast-util-to-markdown';
import { gfm } from 'micromark-extension-gfm';
import type { Nodes, Parents, Root, RootContent } from 'mdast';
import { WorkspaceService } from './workspace';
import { effectiveSensitivity } from './contextService';
import { parseMarkdown } from '../utils/markdown';
import { workspaceEntry } from '../utils/files';

/**
 * Share context notes as one Markdown file (#107). Only notes labelled `shareable` can be shared, checked here on
 * every call. The file holds each note's title and body, rebuilt from an explicit list of Markdown parts; everything
 * else (frontmatter, HTML and comments, images, link targets, footnotes, attachments, related notes, sources) is left
 * out, and a part this exporter does not know refuses the note rather than passing through as raw text.
 *
 * Preview, then download: the preview returns the exact text and a token (a hash of that text and of every note file
 * it came from). The download rebuilds the text and refuses it (409) unless the token is the same, so the bytes saved
 * are exactly the bytes previewed, and a note changed, moved or relabelled in between needs a new preview.
 */

const workspace = new WorkspaceService();

const CATEGORIES = ['company', 'organization', 'strategy', 'programs', 'decisions', 'risks', 'glossary', 'situation'];
const MAX_NOTES = 50;
const MAX_NOTE_BYTES = 512 * 1024;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024;
const NOTE_ID = /^CTX-[a-z0-9][a-z0-9-]{0,120}$/;

function httpError(status: number, message: string, details?: unknown): Error {
  return Object.assign(new Error(message), { statusCode: status, ...(details === undefined ? {} : { details }) });
}

class NoteProblem extends Error {}

/** Block and inline parts kept, with their children rebuilt the same way. Anything else in a note refuses it. */
const KEEP = new Set(['root', 'heading', 'paragraph', 'list', 'listItem', 'table', 'tableRow', 'tableCell', 'code', 'inlineCode',
  'blockquote', 'thematicBreak', 'text', 'emphasis', 'strong', 'delete', 'break']);
/** Parts left out on purpose (nothing of them is in the file). */
const DROP = new Set(['html', 'image', 'imageReference', 'definition', 'footnoteDefinition', 'footnoteReference', 'yaml']);
/** Parts reduced to their text: a link keeps its words, never its target. */
const UNWRAP = new Set(['link', 'linkReference']);

/** The note body rebuilt from allowed parts only, its headings placed under the note's title. */
export function exportBody(body: string): string {
  const tree = fromMarkdown(body, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  // The note's top heading level becomes 2, right under the note's title; levels below keep their steps.
  let top = 6;
  const visit = (n: Nodes) => { if (n.type === 'heading') top = Math.min(top, n.depth); if ('children' in n) (n as Parents).children.forEach((c) => visit(c as Nodes)); };
  visit(tree);
  const shift = 2 - top;
  const clean = (node: Nodes): RootContent[] => {
    if (DROP.has(node.type)) return [];
    if (UNWRAP.has(node.type)) return (node as Parents).children.flatMap((c) => clean(c as Nodes));
    if (!KEEP.has(node.type)) throw new NoteProblem(`It contains a part the export cannot handle safely (${node.type}).`);
    const copy = { ...node } as Nodes & { position?: unknown; data?: unknown };
    delete copy.position;
    delete copy.data;
    if (copy.type === 'heading') copy.depth = Math.max(2, Math.min(6, copy.depth + shift)) as 1 | 2 | 3 | 4 | 5 | 6;
    if (copy.type === 'listItem' && typeof copy.checked === 'boolean') copy.checked = null; // task boxes read as plain items
    if ('children' in copy) (copy as Parents).children = (copy as Parents).children.flatMap((c) => clean(c as Nodes)) as never;
    // Space left at the edges by what was taken out ("text <!-- note -->") is trimmed, never written as an escape.
    if (copy.type === 'paragraph' || copy.type === 'heading' || copy.type === 'tableCell') {
      const kids = copy.children as RootContent[];
      const first = kids[0];
      const last = kids[kids.length - 1];
      if (first?.type === 'text') first.value = first.value.replace(/^[ \t]+/, '');
      if (last?.type === 'text') last.value = last.value.replace(/[ \t]+$/, '');
      copy.children = kids.filter((k) => k.type !== 'text' || k.value !== '') as never;
    }
    // A paragraph left empty by what was taken out (an image on its own line) is dropped too.
    if (copy.type === 'paragraph' && copy.children.length === 0) return [];
    return [copy as RootContent];
  };
  const root: Root = { type: 'root', children: tree.children.flatMap((c) => clean(c)) };
  return toMarkdown(root, { extensions: [gfmToMarkdown()], bullet: '-', emphasis: '_', strong: '*', fences: true, rule: '-' }).trim();
}

/** A note's title as a heading line: one line, Markdown characters that would change it escaped. */
function titleLine(title: string): string {
  const one = title.replace(/\s+/g, ' ').trim() || 'Untitled';
  return '# ' + toMarkdown({ type: 'paragraph', children: [{ type: 'text', value: one }] }).trim();
}

interface FoundNote { id: string; file: string; title: string; body: string; label: unknown; sha256: string }

/** Reads a plain file reached through no link, without blocking on a pipe, at most `cap` bytes. */
async function readPlain(ws: string, file: string, cap: number): Promise<Buffer> {
  await workspaceEntry(ws, file);
  if (!(await fsp.lstat(file)).isFile()) throw new NoteProblem('Its file is not a plain file.');
  const handle = await fsp.open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
  try {
    if (!(await handle.stat()).isFile()) throw new NoteProblem('Its file is not a plain file.');
    const buffer = Buffer.alloc(cap + 1);
    let size = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
      if (bytesRead === 0) break;
      size += bytesRead;
      if (size > cap) throw new NoteProblem('The note is too large to share as text.');
    }
    return buffer.subarray(0, size);
  } finally {
    await handle.close();
  }
}

/** Every context note by id, read only (no folder is created or moved), through no link. */
async function findNotes(ws: string, wanted: Set<string>): Promise<Map<string, FoundNote[]>> {
  const found = new Map<string, FoundNote[]>();
  const base = path.join(ws, 'context');
  for (const cat of CATEGORIES) {
    const dir = path.join(base, cat);
    let entries: import('fs').Dirent[];
    try {
      await workspaceEntry(ws, dir);
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const file = entry.isDirectory() ? path.join(dir, entry.name, 'note.md') : entry.isFile() && entry.name.endsWith('.md') ? path.join(dir, entry.name) : null;
      if (!file) continue;
      let bytes: Buffer;
      try {
        bytes = await readPlain(ws, file, MAX_NOTE_BYTES);
      } catch {
        continue;
      }
      let parsed: { data: Record<string, unknown>; content: string };
      try {
        parsed = parseMarkdown(bytes.toString('utf-8')) as unknown as { data: Record<string, unknown>; content: string };
      } catch {
        continue;
      }
      const id = parsed.data['id'];
      if (typeof id !== 'string' || !wanted.has(id)) continue;
      const note: FoundNote = {
        id, file, title: typeof parsed.data['title'] === 'string' ? parsed.data['title'] : 'Untitled', body: parsed.content,
        label: parsed.data['sensitivity'], sha256: createHash('sha256').update(bytes).digest('hex'),
      };
      found.set(id, [...(found.get(id) ?? []), note]);
    }
  }
  return found;
}

export interface ShareRow { id: string; title: string; problem: string | null }
export interface SharePreview { rows: ShareRow[]; text: string | null; token: string | null; file_name: string }

function noteIds(body: unknown): string[] {
  const notes = (body as { notes?: unknown } | null)?.notes;
  if (!Array.isArray(notes) || notes.length === 0) throw httpError(400, 'Choose at least one note.');
  if (notes.length > MAX_NOTES) throw httpError(400, `Choose at most ${MAX_NOTES} notes.`);
  const ids = notes.map((n) => (typeof n === 'string' && NOTE_ID.test(n) ? n : null));
  if (ids.some((n) => n === null)) throw httpError(400, 'Not a context note id.');
  if (new Set(ids).size !== ids.length) throw httpError(400, 'A note is chosen twice.');
  return ids as string[];
}

/** The text of the file, the rows (with a reason for each note that cannot be shared) and the token. */
async function build(body: unknown): Promise<SharePreview & { hashes: string[] }> {
  const ids = noteIds(body);
  const ws = workspace.getWorkspacePath();
  const found = await findNotes(ws, new Set(ids));
  const rows: ShareRow[] = [];
  const parts: string[] = [];
  const hashes: string[] = [];
  let total = 0;
  for (const id of ids) {
    const matches = found.get(id) ?? [];
    const row: ShareRow = { id, title: matches[0]?.title ?? id, problem: null };
    try {
      if (matches.length === 0) throw new NoteProblem('This note is no longer there.');
      if (matches.length > 1) throw new NoteProblem('Two notes have this id; fix that before sharing.');
      const note = matches[0]!;
      const label = effectiveSensitivity(note.label);
      if (label !== 'shareable') {
        throw new NoteProblem(label === 'invalid' ? 'Its sharing label is not one the app knows, so it is never shared.' : 'Only notes labelled shareable can be shared.');
      }
      const section = `${titleLine(note.title)}\n\n${exportBody(note.body)}`.trimEnd();
      total += Buffer.byteLength(section, 'utf-8');
      if (total > MAX_TOTAL_BYTES) throw new NoteProblem('The file would be too large; choose fewer notes.');
      parts.push(section);
      hashes.push(`${note.id}\u0000${path.relative(ws, note.file)}\u0000${note.sha256}`);
    } catch (err) {
      if (!(err instanceof NoteProblem)) throw err;
      row.problem = err.message;
    }
    rows.push(row);
  }
  const day = new Date().toISOString().slice(0, 10);
  const fileName = `context-notes-${day}.md`;
  if (rows.some((r) => r.problem)) return { rows, text: null, token: null, file_name: fileName, hashes };
  const text = parts.join('\n\n---\n\n') + '\n';
  const token = createHash('sha256').update(text).update('\u0001').update(hashes.join('\u0002')).digest('hex');
  return { rows, text, token, file_name: fileName, hashes };
}

/** What the file would hold, exactly; no token while any chosen note cannot be shared. */
export async function previewContextShare(body: unknown): Promise<SharePreview> {
  const { hashes: _hashes, ...preview } = await build(body);
  return preview;
}

/** The file itself, only when it is exactly what was previewed. */
export async function downloadContextShare(body: unknown): Promise<{ name: string; text: string }> {
  const token = (body as { token?: unknown } | null)?.token;
  if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) throw httpError(400, 'Preview the file first.');
  const built = await build(body);
  if (!built.text || built.token !== token) {
    throw httpError(409, 'A note changed, moved or was relabelled since the preview. Preview again before downloading.');
  }
  return { name: built.file_name, text: built.text };
}
