import * as path from 'path';
import * as fsp from 'fs/promises';
import { constants as fsConstants } from 'fs';
import { parseMarkdown, stringifyFrontmatter } from '../utils/markdown';
import { atomicWrite } from '../utils/atomicWrite';
import { lock, unlock } from '../utils/fileLock';
import { titleSlug } from '../utils/slug';
import { workspaceEntry } from '../utils/files';
import type { BuiltinContextCategory } from '../types';

/**
 * The categories of context notes. The eight built-in ones always exist. A workspace may add its own in
 * `context/categories.md`, a Markdown file whose frontmatter lists them:
 *
 *   categories:
 *     - id: vendors            the folder, context/vendors/; never changes once made
 *       label: Vendors         what the dashboard shows; may be renamed
 *       description: …         what belongs here, for people and agents choosing a category
 *
 * The id is the folder name, so renaming a category moves no file. A category is removed only while it holds no
 * note. The file is Markdown so the watcher reports a change to it (the dashboard reloads the list) and agents can
 * read it. It is hand-editable: for display, an entry that is not valid is skipped and a file that cannot be read
 * lists none, never fatal. A change rewrites the file only from a complete read, keeping its other entries, fields and
 * body text; otherwise it is refused and the file left as it is.
 */

export const BUILTIN_CATEGORIES: readonly BuiltinContextCategory[] = ['company', 'organization', 'strategy', 'programs', 'decisions', 'risks', 'glossary', 'situation'];

/** English names of the built-in categories; the dashboard translates them by id. */
const BUILTIN_LABELS: Record<BuiltinContextCategory, string> = {
  company: 'Company', organization: 'Organization', strategy: 'Strategy', programs: 'Programs',
  decisions: 'Decisions', risks: 'Risks', glossary: 'Glossary', situation: 'Situation',
};

/** A folder name: lowercase ASCII, as note ids and the schemas require. */
export const CATEGORY_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
/**
 * Never a custom id: the built-in ones, `all` (the dashboard's "All notes"), `categories` (would sit next to
 * categories.md and read as it), and names Windows cannot use for a folder.
 */
const RESERVED = new Set<string>([
  ...BUILTIN_CATEGORIES, 'all', 'categories',
  'con', 'prn', 'aux', 'nul', ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`), ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);
export const MAX_CUSTOM_CATEGORIES = 30;
export const MAX_LABEL = 40;
export const MAX_DESCRIPTION = 300;
/** Far above any real list (30 entries); the room is for notes people write in the file's body. */
const MAX_REGISTRY_BYTES = 1024 * 1024;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
// eslint-disable-next-line no-control-regex
const CONTROL_EXCEPT_NEWLINE = /[\u0000-\u0009\u000b-\u001f\u007f]/;

export interface ContextCategoryInfo {
  id: string;
  label: string;
  description?: string;
  builtin: boolean;
}

function httpError(status: number, message: string, code?: string): Error {
  return Object.assign(new Error(message), { statusCode: status, ...(code ? { details: { code } } : {}) });
}

export const registryPath = (ws: string): string => path.join(ws, 'context', 'categories.md');

const BODY = [
  '# Context categories',
  '',
  'The categories this workspace adds to the built-in ones (company, organization, strategy, programs,',
  'decisions, risks, glossary, situation). Each one is a folder, `context/<id>/`, holding notes like any other.',
  '',
  'Manage them in the dashboard (Context, then "Add category"). Agents: file a note only in a category that is',
  'built in or listed above, and use its description to decide; never create a folder under `context/` yourself.',
  '',
].join('\n');

/** Text from the file or a request: trimmed, or null when it is not a usable label. */
function cleanLabel(value: unknown): string | null {
  const text = typeof value === 'string' ? value.trim() : '';
  return text && text.length <= MAX_LABEL && !CONTROL.test(text) ? text : null;
}

function cleanDescription(value: unknown): string | undefined | null {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return undefined;
  return text.length <= MAX_DESCRIPTION && !CONTROL_EXCEPT_NEWLINE.test(text) ? text : null;
}

/** The custom categories as written, without links, without blocking on a pipe and without reading a huge file. */
async function readRegistryFile(ws: string): Promise<string | null> {
  const file = registryPath(ws);
  try {
    await workspaceEntry(ws, file);
    const handle = await fsp.open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_REGISTRY_BYTES) return null;
      return (await handle.readFile()).toString('utf-8');
    } finally {
      await handle.close();
    }
  } catch {
    // Missing (the usual case), a link, or unreadable: no custom categories.
    return null;
  }
}

/** Labels a custom category can never take: the built-in ones, by English name or id, without case. */
const BUILTIN_NAMES = new Set<string>(BUILTIN_CATEGORIES.flatMap((id) => [id, BUILTIN_LABELS[id].toLowerCase()]));

/**
 * The valid custom entries of a `categories` list, in its order, with their position in the list. Entries with an
 * invalid, reserved or repeated id are skipped; every other distinct id is listed (up to the cap), so the notes in its
 * folder are always found. Labels stay unique without case:
 *
 * 1. The entries earlier versions listed come first, with their labels: the first 30 with a valid, new id whose label
 *    no earlier listed entry has. So no category listed before is pushed out by the cap or renamed, except below.
 * 2. Then, while there is room, the entries earlier versions skipped for a repeated label.
 * 3. An entry whose label is taken (by a built-in category, or one listed before it) is shown as its id, or when that is
 *    taken too, as "label (id)".
 */
function validEntries(list: unknown[]): Array<{ info: ContextCategoryInfo; index: number }> {
  const candidates: Array<{ index: number; id: string; label: string; description?: string }> = [];
  for (let index = 0; index < list.length; index++) {
    const entry = list[index];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const e = entry as Record<string, unknown>;
    const id = typeof e['id'] === 'string' ? e['id'] : '';
    if (!CATEGORY_ID.test(id) || RESERVED.has(id)) continue;
    const description = cleanDescription(e['description']);
    candidates.push({ index, id, label: cleanLabel(e['label']) ?? id, ...(description ? { description } : {}) });
  }

  // 1. As earlier versions chose: a repeated id or a label already listed is skipped.
  const chosen = new Set<(typeof candidates)[number]>();
  const ids = new Set<string>();
  const earlierLabels = new Set<string>();
  for (const c of candidates) {
    if (chosen.size >= MAX_CUSTOM_CATEGORIES) break;
    if (ids.has(c.id) || earlierLabels.has(c.label.toLowerCase())) continue;
    chosen.add(c);
    ids.add(c.id);
    earlierLabels.add(c.label.toLowerCase());
  }
  const listedBefore = [...chosen];
  // 2. Then the other distinct ids, while there is room.
  for (const c of candidates) {
    if (chosen.size >= MAX_CUSTOM_CATEGORIES) break;
    if (chosen.has(c) || ids.has(c.id)) continue;
    chosen.add(c);
    ids.add(c.id);
  }

  // 3. Labels: the ones from step 1 first, as they were, unless a built-in has it; then the rest in file order.
  const taken = new Set<string>(BUILTIN_NAMES);
  const labelOf = new Map<(typeof candidates)[number], string>();
  for (const c of listedBefore) {
    // Unique among themselves already (step 1).
    if (taken.has(c.label.toLowerCase())) continue;
    taken.add(c.label.toLowerCase());
    labelOf.set(c, c.label);
  }
  const ordered = [...chosen].sort((a, b) => a.index - b.index);
  for (const c of ordered) {
    if (labelOf.has(c)) continue;
    const options = [c.label, c.id, `${c.label} (${c.id})`];
    let label = options.find((o) => !taken.has(o.toLowerCase()));
    for (let n = 2; !label; n++) if (!taken.has(`${c.label} (${c.id} ${n})`.toLowerCase())) label = `${c.label} (${c.id} ${n})`;
    taken.add(label.toLowerCase());
    labelOf.set(c, label);
  }
  return ordered.map((c) => ({ info: { id: c.id, label: labelOf.get(c)!, ...(c.description ? { description: c.description } : {}), builtin: false }, index: c.index }));
}

/** The valid custom entries of the file, in its order. Invalid, reserved or repeated ones are skipped. */
export function parseRegistry(raw: string | null): ContextCategoryInfo[] {
  if (!raw) return [];
  let data: Record<string, unknown>;
  try {
    data = parseMarkdown(raw).data as Record<string, unknown>;
  } catch {
    return [];
  }
  return validEntries(Array.isArray(data['categories']) ? data['categories'] : []).map((e) => e.info);
}

export async function customCategories(ws: string): Promise<ContextCategoryInfo[]> {
  return parseRegistry(await readRegistryFile(ws));
}

const builtinInfos = (): ContextCategoryInfo[] => BUILTIN_CATEGORIES.map((id) => ({ id, label: BUILTIN_LABELS[id], builtin: true }));

/** Every category, built-in first, then the workspace's own in the order they were added. */
export async function listCategories(ws: string): Promise<ContextCategoryInfo[]> {
  return [...builtinInfos(), ...(await customCategories(ws))];
}

/** The folder names under context/ that hold notes: anything else there is never listed, read, moved or deleted. */
export async function categoryIds(ws: string): Promise<string[]> {
  return (await listCategories(ws)).map((c) => c.id);
}

async function lockRegistry(ws: string) {
  const locks = await workspaceEntry(ws, path.join(ws, '.situation-board', 'context-locks'), true);
  await fsp.mkdir(locks, { recursive: true });
  // Note locks are named after CTX- ids, so this name never meets one.
  const file = await workspaceEntry(ws, path.join(locks, '_categories.lock'), true);
  return lock(file, 5000, () => httpError(409, 'The categories are being changed elsewhere. Try again.'));
}

/** The registry as a change must see it: every entry and the rest of the file, so a rewrite keeps all of it. */
interface RegistryDocument {
  /** The frontmatter, `categories` included, as written. */
  data: Record<string, unknown>;
  /** The `categories` list as written, entries the dashboard skips included. */
  entries: unknown[];
  /** The Markdown after the frontmatter, as written. */
  body: string;
}

function unreadableRegistry(reason: string): Error {
  return httpError(
    409,
    `context/categories.md ${reason}, so the categories were not changed. Fix or remove that file, then try again.`,
    'category_registry_unreadable',
  );
}

/**
 * Reads the registry for a change. Only a missing file is an empty list: a file that is a link, too large,
 * unreadable, not UTF-8 or not valid frontmatter is refused, so a change never rewrites it from a partial read.
 */
async function readRegistryForChange(ws: string): Promise<RegistryDocument> {
  const file = registryPath(ws);
  let bytes: Buffer;
  try {
    await workspaceEntry(ws, file);
    const handle = await fsp.open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw unreadableRegistry('is not a regular file');
      if (stat.size > MAX_REGISTRY_BYTES) throw unreadableRegistry(`is larger than ${MAX_REGISTRY_BYTES / 1024 / 1024} MB`);
      bytes = await handle.readFile();
    } finally {
      await handle.close();
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { data: {}, entries: [], body: BODY };
    if ((err as { details?: { code?: string } }).details?.code === 'category_registry_unreadable') throw err;
    const code = (err as NodeJS.ErrnoException).code;
    throw unreadableRegistry(`could not be read${code ? ` (${code})` : ''}`);
  }
  if (bytes.length > MAX_REGISTRY_BYTES) throw unreadableRegistry(`is larger than ${MAX_REGISTRY_BYTES / 1024 / 1024} MB`);
  let raw: string;
  try {
    raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw unreadableRegistry('is not UTF-8 text');
  }
  // The body is everything after the complete closing line (padding on it included), so it goes back byte for byte.
  // The Markdown parser reads a frontmatter that is never closed as if it were, and closes at any line starting with
  // "---"; a change accepts only a closing line that is "---" (with optional spaces), and that is the first such line.
  let body = raw;
  if (/^---(?!-)/.test(raw)) {
    const close = /\r?\n---[ \t]*(?:\r?\n|$)/g;
    close.lastIndex = 3;
    const found = close.exec(raw);
    if (!found) throw unreadableRegistry('has frontmatter without its closing "---" line');
    if (raw.indexOf('\n---', 3) !== found.index + (found[0].startsWith('\r') ? 1 : 0)) {
      throw unreadableRegistry('has a line starting with "---" inside its frontmatter');
    }
    body = raw.slice(found.index + found[0].length);
  }
  let parsed: { data: unknown; content: string };
  try {
    parsed = parseMarkdown(raw);
  } catch {
    throw unreadableRegistry('has frontmatter that cannot be read');
  }
  const data = parsed.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw unreadableRegistry('has frontmatter that is not a list of fields');
  const record = data as Record<string, unknown>;
  const entries = 'categories' in record ? record['categories'] : [];
  if (!Array.isArray(entries)) throw unreadableRegistry('has a "categories" field that is not a list');
  // The body as written, also when blank: the explanation is written only into a new file.
  return { data: record, entries, body };
}

/** The new file's text, refused when it would be too large to read back: nothing is changed then. */
function serializeRegistry(doc: RegistryDocument, entries: unknown[]): string {
  // The body goes back exactly as read, line breaks (or their absence) included.
  const text = stringifyFrontmatter({ ...doc.data, categories: entries }) + doc.body;
  if (Buffer.byteLength(text) > MAX_REGISTRY_BYTES) {
    throw httpError(
      409,
      `context/categories.md would be larger than ${MAX_REGISTRY_BYTES / 1024 / 1024} MB, so the categories were not changed. Shorten the text in that file, then try again.`,
      'category_registry_unreadable',
    );
  }
  return text;
}

async function writeRegistry(ws: string, text: string): Promise<void> {
  const file = registryPath(ws);
  await workspaceEntry(ws, file, true);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await atomicWrite(file, text);
}

/** A category as it is written in the file: what the dashboard reads, nothing it adds. */
const entryOf = ({ id, label, description }: ContextCategoryInfo) => ({ id, label, ...(description ? { description } : {}) });

/**
 * Under the registry's lock, read again inside it, so two changes never overwrite each other through this app. The
 * change gets the valid categories and the list as written; it returns the new list, in which every entry it did not
 * touch (also one the dashboard skips) and the rest of the file stay as they were, and any folder work (`apply`), done
 * only once the new file is known to be valid.
 */
async function change<T>(
  ws: string,
  fn: (current: Array<{ info: ContextCategoryInfo; index: number }>, entries: unknown[]) => Promise<{ next: unknown[]; result: T; apply?: () => Promise<void>; removes?: string }>,
): Promise<T> {
  const held = await lockRegistry(ws);
  try {
    const doc = await readRegistryForChange(ws);
    const current = validEntries(doc.entries);
    const { next, result, apply, removes } = await fn(current, doc.entries);
    // A change never hides another listed category (and so its notes): at the cap, a rename can let an entry skipped
    // for a repeated label take another's place.
    const after = new Set(validEntries(next).map((e) => e.info.id));
    const hidden = current.find((e) => e.info.id !== removes && !after.has(e.info.id));
    if (hidden) {
      throw httpError(
        409,
        `This change would hide the category "${hidden.info.label}" (a workspace lists up to ${MAX_CUSTOM_CATEGORIES} categories of its own, and context/categories.md has more). Remove a category you no longer use first.`,
        'category_would_hide',
      );
    }
    // Every check, the new file's size included, comes before the first change on disk.
    const text = serializeRegistry(doc, next);
    await apply?.();
    await writeRegistry(ws, text);
    return result;
  } finally {
    await unlock(held);
  }
}

/**
 * Runs `fn` (a note being saved into a category) while that category is sure to stay: built-in ones always do; for
 * a custom one, under the registry's lock, after checking again that it is still listed. Category removal takes the
 * same lock, so it either sees the saved note or the save sees the category gone. Lock order: a note's lock first,
 * then this one; nothing that holds this lock waits for a note's.
 */
export async function withCategoryKept<T>(ws: string, id: string, fn: () => Promise<T>): Promise<T> {
  if ((BUILTIN_CATEGORIES as readonly string[]).includes(id)) return fn();
  const held = await lockRegistry(ws);
  try {
    if (!(await customCategories(ws)).some((c) => c.id === id)) {
      throw httpError(400, `The category "${id}" no longer exists. Choose another category.`, 'category_gone');
    }
    return await fn();
  } finally {
    await unlock(held);
  }
}

function requireLabel(value: unknown): string {
  const label = cleanLabel(value);
  if (!label) throw httpError(400, `Give the category a name of 1 to ${MAX_LABEL} characters.`);
  return label;
}

function requireDescription(value: unknown): string | undefined {
  const description = cleanDescription(value);
  if (description === null) throw httpError(400, `Keep the description to ${MAX_DESCRIPTION} characters of plain text.`);
  return description;
}

function sameLabel(label: string, others: ContextCategoryInfo[]): ContextCategoryInfo | undefined {
  const lower = label.toLowerCase();
  return others.find((c) => c.label.toLowerCase() === lower || c.id === lower);
}

/** A category id from a request: only a known shape reaches the file system. */
export function requestedCategoryId(value: unknown): string {
  if (typeof value !== 'string' || !CATEGORY_ID.test(value)) throw httpError(400, 'Invalid category id.');
  return value;
}

export async function createCategory(ws: string, body: unknown): Promise<ContextCategoryInfo> {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const label = requireLabel(b['label']);
  const description = requireDescription(b['description']);
  const id = titleSlug(label, 'category').slice(0, 40).replace(/-+$/, '');
  if (!CATEGORY_ID.test(id)) throw httpError(400, 'Give the category a name with at least one letter or digit.');
  return change(ws, async (valid, entries) => {
    const current = valid.map((e) => e.info);
    const all = [...builtinInfos(), ...current];
    const clash = sameLabel(label, all) ?? all.find((c) => c.id === id);
    if (clash || RESERVED.has(id)) {
      throw httpError(409, `There is already a category called "${clash?.label ?? label}". Choose another name.`);
    }
    if (current.length >= MAX_CUSTOM_CATEGORIES) throw httpError(409, `A workspace can have up to ${MAX_CUSTOM_CATEGORIES} categories of its own. Remove one you no longer use first.`);
    const created: ContextCategoryInfo = { id, label, ...(description ? { description } : {}), builtin: false };
    // The folder is made now, so the category shows in a file manager and an agent can file a note in it.
    const apply = async () => { await fsp.mkdir(await workspaceEntry(ws, path.join(ws, 'context', id), true), { recursive: true }); };
    return { next: [...entries, entryOf(created)], result: created, apply };
  });
}

/** Renames a category or changes its description. The id, and so the folder and every note in it, stays. */
export async function updateCategory(ws: string, rawId: unknown, body: unknown): Promise<ContextCategoryInfo> {
  const id = requestedCategoryId(rawId);
  if ((BUILTIN_CATEGORIES as readonly string[]).includes(id)) throw httpError(400, 'Built-in categories cannot be changed.');
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  return change(ws, async (valid, entries) => {
    const found = valid.find((e) => e.info.id === id);
    if (!found) throw httpError(404, 'This category no longer exists.');
    const existing = found.info;
    const label = b['label'] === undefined ? existing.label : requireLabel(b['label']);
    const description = b['description'] === undefined ? existing.description : requireDescription(b['description']);
    const others = [...builtinInfos(), ...valid.map((e) => e.info)].filter((c) => c.id !== id);
    const clash = sameLabel(label, others);
    if (clash) throw httpError(409, `There is already a category called "${clash.label}". Choose another name.`);
    const updated: ContextCategoryInfo = { id, label, ...(description ? { description } : {}), builtin: false };
    // Fields the dashboard does not know stay on the entry.
    const { description: _old, ...kept } = entries[found.index] as Record<string, unknown>;
    const next = [...entries];
    next[found.index] = { ...kept, ...entryOf(updated) };
    return { next, result: updated };
  });
}

/** How many notes a category folder holds, the way the context service finds them. */
async function noteCount(dir: string): Promise<number> {
  const missing = (err: NodeJS.ErrnoException) => err.code === 'ENOENT' || err.code === 'ENOTDIR';
  const scanError = (err: NodeJS.ErrnoException) => httpError(
    409,
    `The folder of this category could not be checked for notes (${err.code ?? 'error'}), so it was not removed. Check the folder's permissions, then try again.`,
    'category_scan_failed',
  );
  let entries: import('fs').Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (err) {
    // Only a folder that is not there holds no note; one that cannot be read may hold some.
    if (missing(err as NodeJS.ErrnoException)) return 0;
    throw scanError(err as NodeJS.ErrnoException);
  }
  let count = 0;
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.md')) count++;
    else if (entry.isDirectory()) {
      try {
        await fsp.lstat(path.join(dir, entry.name, 'note.md'));
        count++;
      } catch (err) {
        if (!missing(err as NodeJS.ErrnoException)) throw scanError(err as NodeJS.ErrnoException);
      }
    }
  }
  return count;
}

/**
 * Removes a category that holds no note. Its folder goes too when it is empty; anything else left in it (an
 * attachment without its note) stays on disk, and adding the category again shows the folder again.
 */
export async function deleteCategory(ws: string, rawId: unknown): Promise<void> {
  const id = requestedCategoryId(rawId);
  if ((BUILTIN_CATEGORIES as readonly string[]).includes(id)) throw httpError(400, 'Built-in categories cannot be removed.');
  await change(ws, async (valid, entries) => {
    if (!valid.some((e) => e.info.id === id)) throw httpError(404, 'This category no longer exists.');
    const dir = await workspaceEntry(ws, path.join(ws, 'context', id), true);
    const notes = await noteCount(dir);
    if (notes > 0) {
      throw httpError(409, `This category still holds ${notes} note${notes === 1 ? '' : 's'}. Move ${notes === 1 ? 'it' : 'them'} to another category or delete ${notes === 1 ? 'it' : 'them'} first.`);
    }
    const apply = () => fsp.rmdir(dir).catch(() => { /* not empty, or already gone: left as it is */ });
    // Every entry with this id goes, so a skipped repeat of it cannot take its place.
    return { next: entries.filter((e) => (e as { id?: unknown } | null)?.id !== id), result: undefined, apply, removes: id };
  });
}
