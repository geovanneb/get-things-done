import * as path from 'path';
import * as fsp from 'fs/promises';
import { constants as fsConstants } from 'fs';
import { parseMarkdown, stringifyMarkdown } from '../utils/markdown';
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
 * read it. It is hand-editable: an entry that is not valid is skipped, never fatal.
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
const MAX_REGISTRY_BYTES = 64 * 1024;
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

function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode: status });
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

/** The valid custom entries of the file, in its order. Invalid, reserved or repeated ones are skipped. */
export function parseRegistry(raw: string | null): ContextCategoryInfo[] {
  if (!raw) return [];
  let data: Record<string, unknown>;
  try {
    data = parseMarkdown(raw).data as Record<string, unknown>;
  } catch {
    return [];
  }
  const list = Array.isArray(data['categories']) ? data['categories'] : [];
  const seen = new Set<string>();
  const labels = new Set<string>();
  const result: ContextCategoryInfo[] = [];
  for (const entry of list) {
    if (result.length >= MAX_CUSTOM_CATEGORIES) break;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const e = entry as Record<string, unknown>;
    const id = typeof e['id'] === 'string' ? e['id'] : '';
    if (!CATEGORY_ID.test(id) || RESERVED.has(id) || seen.has(id)) continue;
    const label = cleanLabel(e['label']) ?? id;
    if (labels.has(label.toLowerCase())) continue;
    const description = cleanDescription(e['description']);
    seen.add(id);
    labels.add(label.toLowerCase());
    result.push({ id, label, ...(description ? { description } : {}), builtin: false });
  }
  return result;
}

export async function customCategories(ws: string): Promise<ContextCategoryInfo[]> {
  return parseRegistry(await readRegistryFile(ws));
}

/** Every category, built-in first, then the workspace's own in the order they were added. */
export async function listCategories(ws: string): Promise<ContextCategoryInfo[]> {
  const builtin = BUILTIN_CATEGORIES.map((id) => ({ id, label: BUILTIN_LABELS[id], builtin: true }));
  return [...builtin, ...(await customCategories(ws))];
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

async function writeRegistry(ws: string, categories: ContextCategoryInfo[]): Promise<void> {
  const file = registryPath(ws);
  await workspaceEntry(ws, file, true);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const entries = categories.map(({ id, label, description }) => ({ id, label, ...(description ? { description } : {}) }));
  await atomicWrite(file, stringifyMarkdown(BODY, { categories: entries }));
}

/** Under the registry's lock, read again inside it, so two changes never overwrite each other through this app. */
async function change<T>(ws: string, fn: (current: ContextCategoryInfo[]) => Promise<{ next: ContextCategoryInfo[]; result: T }>): Promise<T> {
  const held = await lockRegistry(ws);
  try {
    const { next, result } = await fn(await customCategories(ws));
    await writeRegistry(ws, next);
    return result;
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
  return change(ws, async (current) => {
    const all = await listCategories(ws);
    const clash = sameLabel(label, all) ?? all.find((c) => c.id === id);
    if (clash || RESERVED.has(id)) {
      throw httpError(409, `There is already a category called "${clash?.label ?? label}". Choose another name.`);
    }
    if (current.length >= MAX_CUSTOM_CATEGORIES) throw httpError(409, `A workspace can have up to ${MAX_CUSTOM_CATEGORIES} categories of its own. Remove one you no longer use first.`);
    const created: ContextCategoryInfo = { id, label, ...(description ? { description } : {}), builtin: false };
    // The folder is made now, so the category shows in a file manager and an agent can file a note in it.
    await fsp.mkdir(await workspaceEntry(ws, path.join(ws, 'context', id), true), { recursive: true });
    return { next: [...current, created], result: created };
  });
}

/** Renames a category or changes its description. The id, and so the folder and every note in it, stays. */
export async function updateCategory(ws: string, rawId: unknown, body: unknown): Promise<ContextCategoryInfo> {
  const id = requestedCategoryId(rawId);
  if ((BUILTIN_CATEGORIES as readonly string[]).includes(id)) throw httpError(400, 'Built-in categories cannot be changed.');
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  return change(ws, async (current) => {
    const index = current.findIndex((c) => c.id === id);
    if (index < 0) throw httpError(404, 'This category no longer exists.');
    const existing = current[index]!;
    const label = b['label'] === undefined ? existing.label : requireLabel(b['label']);
    const description = b['description'] === undefined ? existing.description : requireDescription(b['description']);
    const others = (await listCategories(ws)).filter((c) => c.id !== id);
    const clash = sameLabel(label, others);
    if (clash) throw httpError(409, `There is already a category called "${clash.label}". Choose another name.`);
    const updated: ContextCategoryInfo = { id, label, ...(description ? { description } : {}), builtin: false };
    const next = [...current];
    next[index] = updated;
    return { next, result: updated };
  });
}

/** How many notes a category folder holds, the way the context service finds them. */
async function noteCount(dir: string): Promise<number> {
  let count = 0;
  for (const entry of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (entry.isFile() && entry.name.endsWith('.md')) count++;
    else if (entry.isDirectory() && (await fsp.lstat(path.join(dir, entry.name, 'note.md')).catch(() => null))) count++;
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
  await change(ws, async (current) => {
    if (!current.some((c) => c.id === id)) throw httpError(404, 'This category no longer exists.');
    const dir = await workspaceEntry(ws, path.join(ws, 'context', id), true);
    const notes = await noteCount(dir);
    if (notes > 0) {
      throw httpError(409, `This category still holds ${notes} note${notes === 1 ? '' : 's'}. Move ${notes === 1 ? 'it' : 'them'} to another category or delete ${notes === 1 ? 'it' : 'them'} first.`);
    }
    await fsp.rmdir(dir).catch(() => { /* not empty, or already gone: left as it is */ });
    return { next: current.filter((c) => c.id !== id), result: undefined };
  });
}
