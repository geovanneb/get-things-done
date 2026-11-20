import * as path from 'path';
import * as fsp from 'fs/promises';
import { createHash } from 'crypto';
import { ContextNote, ContextCategory } from '../types';
import { FileService } from './fileService';
import { WorkspaceService } from './workspace';
import { lock, unlock } from '../utils/fileLock';
import { titleSlug } from '../utils/slug';
import { requireText, textList, textOf } from '../utils/loose';
import { categoryIds, withCategoryKept } from './contextCategories';

const TEXT_FIELDS = ['title', 'slug', 'body', 'content', 'relevance'] as const;
/** A timestamp as text: YAML reads an unquoted `updated_at: 2026-11-08` as a date, which cannot be sorted as text. */
const stamp = (value: unknown): string => value instanceof Date && !Number.isNaN(value.getTime()) ? value.toISOString() : typeof value === 'string' && value ? value : new Date().toISOString();
import { deleteAttachment, saveAttachment, fileInside, listFolderFiles, topLevelName, zipFolder, FolderFile, workspaceEntry } from '../utils/files';

const fileService = new FileService();

/** Whole-note sensitivity labels (#107). A note without one counts as `internal`. */
export const SENSITIVITIES = ['shareable', 'internal', 'personal'] as const;
export type Sensitivity = (typeof SENSITIVITIES)[number];

function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode: status });
}

/** How a note's label counts: none is `internal`; anything that is not a known label is `invalid` (never shareable). */
export function effectiveSensitivity(value: unknown): Sensitivity | 'invalid' {
  if (value === undefined || value === null || value === '') return 'internal';
  return (SENSITIVITIES as readonly unknown[]).includes(value) ? (value as Sensitivity) : 'invalid';
}

/** A label sent by the user: undefined keeps the current one, null or '' removes it, anything else must be a known label. */
function requestedSensitivity(value: unknown): Sensitivity | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if ((SENSITIVITIES as readonly unknown[]).includes(value)) return value as Sensitivity;
  throw httpError(400, `sensitivity must be one of ${SENSITIVITIES.join(', ')}, or empty for none.`);
}
const workspaceService = new WorkspaceService();

/**
 * Test seam for races with category removal: awaited after a request's category was checked (`checked`) and again
 * once the category is held for the save (`held`). Never set outside tests.
 */
export const contextSaveHooks: { pause?: (phase: 'checked' | 'held', category: string) => Promise<void> } = {};

/** The built-in categories and the workspace's own (context/categories.md); a note anywhere else is never listed, read or deleted. */
const categories = (): Promise<string[]> => categoryIds(workspaceService.getWorkspacePath());

/** A category sent by the user, matched without case: anything that is not a category is refused before a folder is made. */
async function requestedCategory(value: unknown): Promise<ContextCategory> {
  const category = typeof value === 'string' ? value.toLowerCase() : value;
  const known = await categories();
  if (known.includes(category as string)) return category as ContextCategory;
  throw httpError(400, `category must be one of ${known.join(', ')}.`);
}

/**
 * The lock file's name for a note id: the id itself, as create has always used. A hand-written id that is not a valid
 * file name (a colon, a trailing dot, too long) can never come from create, so it gets a hashed name instead of a 400.
 */
function lockName(id: string): string {
  try {
    // A leading underscore is kept for the workspace's own locks (`_categories.lock`): such an id is hashed, so a
    // note's lock never is the registry's and a move into a custom category never waits on itself.
    if (Buffer.byteLength(id) <= 200 && !id.startsWith('_')) return topLevelName(id);
  } catch { /* not a file name */ }
  return `id-${createHash('sha256').update(id).digest('hex').slice(0, 32)}`;
}

// Per-note folder structure: context/category/slug/note.md
// Old structure (backward compat): context/category/slug.md
// Migration: old files are moved to new structure automatically

/**
 * When a note was last edited, for sorting newest first. YAML reads an unquoted `updated_at: 2026-11-08T09:30:00Z` as a
 * Date, and people write other offsets than the server's UTC: compare the moments, not the text. Unreadable goes last.
 */
function editedAt(value: unknown): number {
  const time = value instanceof Date ? value.getTime() : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isNaN(time) ? -Infinity : time;
}

export class ContextService {
  private getContextDir(category?: ContextCategory): string {
    const base = path.join(workspaceService.getWorkspacePath(), 'context');
    return category ? path.join(base, topLevelName(category)) : base;
  }

  private getNoteDir(category: ContextCategory, slug: string): string {
    return path.join(this.getContextDir(category), topLevelName(slug));
  }

  private getNoteFile(category: ContextCategory, slug: string): string {
    return path.join(this.getNoteDir(category, slug), 'note.md');
  }

  /**
   * `dir` (a category's or a note's folder), checked to stay inside the workspace: no part of it below the workspace
   * may be a link, so a linked folder is refused before anything is read, migrated or written through it. A missing
   * tail is allowed (it is about to be made). Run again right before a change, since a folder can be swapped later.
   */
  private async contained(dir: string): Promise<string> {
    return workspaceEntry(workspaceService.getWorkspacePath(), dir, true);
  }

  /**
   * The note files in a category, one at a time and in the folder's order, each old single file migrated when it is
   * reached (a lookup by id stops at its note, as it always has). The category folder is checked before it is
   * created, listed or migrated into. Links inside it (a linked note folder or note.md) are skipped, never followed.
   */
  private async *noteFiles(cat: ContextCategory): AsyncGenerator<{ filePath: string; name: string }> {
    const dir = await this.contained(this.getContextDir(cat));
    await fileService.ensureDir(dir);
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isDirectory()) {
        // New structure: category/slug/note.md
        const noteFile = path.join(dir, entry.name, 'note.md');
        if (!(await fsp.lstat(noteFile).catch(() => null))?.isFile()) continue;
        yield { filePath: noteFile, name: entry.name };
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        // Old structure: migrate to new
        yield { filePath: await this.migrateOldFile(path.join(dir, entry.name), cat), name: entry.name };
      }
    }
  }

  /** The folder of a note found by id, checked again (see contained): 404 when there is no such note. */
  private async noteFolder(id: string): Promise<string> {
    const result = await this.findContextFile(id);
    if (!result) throw new Error(`Context note not found: ${id}`);
    return workspaceEntry(workspaceService.getWorkspacePath(), path.dirname(result.filePath)).catch((err: NodeJS.ErrnoException) => {
      // Removed by something that does not take the lock (an agent or the file manager) since it was found.
      if (err.code === 'ENOENT') throw new Error(`Context note not found: ${id}`);
      throw err;
    });
  }

  // Migrate old-style file to new folder structure
  private async migrateOldFile(oldPath: string, category: ContextCategory): Promise<string> {
    const slug = path.basename(oldPath, '.md');
    const noteDir = await this.contained(this.getNoteDir(category, slug));
    const noteFile = this.getNoteFile(category, slug);
    await fileService.ensureDir(noteDir);
    await fsp.rename(oldPath, noteFile);
    return noteFile;
  }

  async listContextNotes(category?: ContextCategory): Promise<ContextNote[]> {
    // Checked before any folder is touched: a read never creates a folder for a category that does not exist.
    const wanted: readonly ContextCategory[] = category ? [await requestedCategory(category)] : await categories();

    const results: ContextNote[] = [];

    for (const cat of wanted) {
      for await (const { filePath, name } of this.noteFiles(cat)) {
        try {
          const { data, content } = await fileService.readMarkdown<ContextNote>(filePath);
          results.push({
            ...data,
            title: textOf(data.title).trim() || name.replace(/\.md$/, ''),
            category: cat,
            tags: textList(data.tags),
            created_at: stamp(data.created_at),
            updated_at: stamp(data.updated_at),
            body: content,
            path: filePath,
          });
        } catch {
          // Skip malformed files
        }
      }
    }

    return results.sort((a, b) => editedAt(b.updated_at) - editedAt(a.updated_at) || 0);
  }

  async getContextNote(id: string): Promise<ContextNote> {
    const result = await this.findContextFile(id);
    if (!result) throw new Error(`Context note not found: ${id}`);

    const { filePath, category } = result;
    const { data, content } = await fileService.readMarkdown<ContextNote>(filePath);
    return {
      ...data,
      id,
      title: textOf(data.title).trim() || id,
      category,
      tags: textList(data.tags),
      created_at: stamp(data.created_at),
      updated_at: stamp(data.updated_at),
      body: content,
      path: filePath,
    };
  }

  /**
   * The note's cross-process lock, `.situation-board/context-locks/<id>.lock`. Create, update (and so a move to another
   * category) and delete all take it, so one waits for the other instead of finding the folder gone halfway. The path
   * stays the same as older versions used for create, so an older dashboard on the same workspace meets the same lock.
   */
  private async lockNote(id: string, busyMessage: string) {
    const ws = workspaceService.getWorkspacePath();
    const locks = await workspaceEntry(ws, path.join(ws, '.situation-board', 'context-locks'), true);
    await fileService.ensureDir(locks);
    const lockFile = await workspaceEntry(ws, path.join(locks, `${lockName(id)}.lock`), true);
    return lock(lockFile, 5000, () => httpError(409, busyMessage));
  }

  async createContextNote(data: Partial<ContextNote>): Promise<ContextNote> {
    requireText(data, TEXT_FIELDS);
    const now = new Date().toISOString();
    const category = await requestedCategory(data.category || 'situation');
    await contextSaveHooks.pause?.('checked', category);
    const slug = data.slug || titleSlug(data.title || 'untitled', 'note');
    const sensitivity = requestedSensitivity(data.sensitivity);
    const id = `CTX-${slug}`;
    await this.contained(this.getNoteDir(category, slug));

    // The id is shared across categories: check and create under one cross-process lock.
    const held = await this.lockNote(id, 'This context note is being created elsewhere. Try again.');
    try {
      // A custom category could be removed between the check above and the save: hold it until the note is on disk.
      return await withCategoryKept(workspaceService.getWorkspacePath(), category, () => this.createLocked(id, category, slug, data, sensitivity, now));
    } finally {
      await unlock(held);
    }
  }

  private async createLocked(id: string, category: ContextCategory, slug: string, data: Partial<ContextNote>, sensitivity: Sensitivity | null | undefined, now: string): Promise<ContextNote> {
    await contextSaveHooks.pause?.('held', category);
    const noteDir = this.getNoteDir(category, slug);
    const filePath = this.getNoteFile(category, slug);
    // Never replace another note (and its sharing label) by creating one with the same title.
    if (await fileService.exists(filePath)) throw httpError(409, `A context note named "${slug}" already exists in ${category}. Edit it, or choose another title.`);
    // Ids are CTX-<slug> in every category: a second note with the same id would be edited, relabelled or deleted
    // through the first one's id.
    const sameId = await this.findContextFile(id);
    if (sameId) throw httpError(409, `A context note named "${slug}" already exists in ${sameId.category}. Edit it, or choose another title.`);
    await fileService.ensureDir(await this.contained(noteDir));

    const note: ContextNote = {
      id,
      category,
      title: data.title || 'Untitled',
      slug,
      tags: [],
      relevance: data.relevance,
      ...(sensitivity ? { sensitivity } : {}),
      created_at: now,
      updated_at: now,
    };

    const { content: _c, body: _b, path: _path, ...frontmatter } = note;
    const bodyContent = data.body || data.content || '';
    // Written only if the name is still free: the id check above can migrate an old <slug>.md into this very folder.
    await fileService.createMarkdown(filePath, frontmatter as Record<string, unknown>, bodyContent).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'EEXIST') throw httpError(409, `A context note named "${slug}" already exists in ${category}. Edit it, or choose another title.`);
      throw err;
    });
    return { ...note, body: bodyContent, path: filePath };
  }

  async updateContextNote(id: string, data: Partial<ContextNote>): Promise<ContextNote> {
    requireText(data, TEXT_FIELDS);
    const sensitivity = requestedSensitivity(data.sensitivity);
    const requested = data.category ? await requestedCategory(data.category) : undefined;
    if (requested) await contextSaveHooks.pause?.('checked', requested);
    const held = await this.lockNote(id, 'This context note is being changed elsewhere. Try again.');
    try {
      if (!requested) return await this.updateLocked(id, data, sensitivity, requested);
      // A move (or a save naming the note's own category) holds that category until the note is in it, so removing
      // the category waits and then finds the note, or happens first and the save is refused.
      return await withCategoryKept(workspaceService.getWorkspacePath(), requested, async () => {
        await contextSaveHooks.pause?.('held', requested);
        return this.updateLocked(id, data, sensitivity, requested);
      });
    } finally {
      await unlock(held);
    }
  }

  /** The update itself, under the note's lock: the note is read here, so a move or edit that finished first is seen. */
  private async updateLocked(id: string, data: Partial<ContextNote>, sensitivity: Sensitivity | null | undefined, requested: ContextCategory | undefined): Promise<ContextNote> {
    const existing = await this.getContextNote(id);
    const incomingCategory = requested ?? existing.category;

    // null is not text to write: it keeps the note's text, like a field left out.
    const bodyContent = data.body ?? data.content ?? existing.body ?? existing.content ?? '';

    let filePath = existing.path!;
    let backedUp = false;

    // If category changed, move the entire slug directory
    if (incomingCategory !== existing.category) {
      const slug = path.basename(path.dirname(existing.path!));
      const newNoteDir = await this.contained(this.getNoteDir(incomingCategory, slug));
      // Never onto another note: its folder would be overwritten.
      if (await fileService.exists(newNoteDir)) throw httpError(409, `A context note named "${slug}" already exists in ${incomingCategory}. Rename one of them first.`);
      const newFilePath = this.getNoteFile(incomingCategory, slug);
      // Rename the folder itself so subfolders move too (moving files one by one and then
      // removing the old folder deleted them). Only the parent is created: Windows will not
      // rename onto an existing folder, even an empty one.
      await fileService.ensureDir(await this.contained(this.getContextDir(incomingCategory)));
      // The previous version goes to the trash before the folder moves, not in the write after it: a backup that fails
      // (a linked or full trash) leaves the note and its files where they were. The write below then skips it.
      await fileService.backup(existing.path!);
      backedUp = true;
      await this.contained(path.dirname(existing.path!));
      await fsp.rename(path.dirname(existing.path!), newNoteDir).catch((err: NodeJS.ErrnoException) => {
        // Removed by something that does not take the lock (an agent or the file manager): the note is gone, not broken.
        if (err.code === 'ENOENT') throw new Error(`Context note not found: ${id}`);
        throw err;
      });
      filePath = newFilePath;
    }

    const updated: ContextNote = {
      ...existing,
      ...data,
      id,
      category: incomingCategory,
      tags: [],
      updated_at: new Date().toISOString(),
    };
    if (sensitivity === null) delete updated.sensitivity;
    else if (sensitivity) updated.sensitivity = sensitivity;
    // A label left empty in the file (`sensitivity:`) means none: never write it back as `null`.
    else if (existing.sensitivity == null || existing.sensitivity === '') delete updated.sensitivity;

    const { content: _c, body: _b, path: _path, ...frontmatter } = updated;
    await fileService.writeMarkdown(filePath, frontmatter as Record<string, unknown>, bodyContent, { backup: !backedUp });
    return { ...updated, body: bodyContent, path: filePath };
  }

  async deleteContextNote(id: string): Promise<void> {
    const held = await this.lockNote(id, 'This context note is being changed elsewhere. Try again.');
    try {
      await this.deleteLocked(id);
    } finally {
      await unlock(held);
    }
  }

  private async deleteLocked(id: string): Promise<void> {
    const result = await this.findContextFile(id);
    if (!result) throw new Error(`Context note not found: ${id}`);
    // Delete the entire note directory (new structure) if possible, else just the file
    const noteDir = path.dirname(result.filePath);
    const noteDirName = path.basename(noteDir);
    const catDir = this.getContextDir(result.category);
    if (noteDir !== catDir && noteDirName !== result.category) {
      // New structure - delete whole dir (checked again just before: fs.rm never follows links inside it)
      await fsp.rm(await this.contained(noteDir), { recursive: true, force: true });
    } else {
      await fileService.deleteFile(result.filePath);
    }
  }

  async listContextFiles(id: string): Promise<FolderFile[]> {
    return listFolderFiles(await this.noteFolder(id), ['note.md']);
  }

  /** The note's whole folder (note.md and every attached file) as one ZIP. */
  async contextArchive(id: string): Promise<{ name: string; data: Buffer }> {
    return zipFolder(await this.noteFolder(id), 'note.md');
  }

  /** Absolute path of one file attached to the note (404 if missing, 400 if outside the note's folder). */
  async contextFilePath(id: string, name: string): Promise<string> {
    return fileInside(await this.noteFolder(id), name);
  }

  async saveContextFile(id: string, originalName: string, buffer: Buffer): Promise<{ name: string; size: number; modified: string; type: string }> {
    return saveAttachment(await this.noteFolder(id), originalName, buffer, 'note.md', workspaceService.getWorkspacePath());
  }

  async deleteContextFile(id: string, filename: string): Promise<void> {
    const noteDir = await this.noteFolder(id);
    const safe = topLevelName(filename);
    if (safe.toLowerCase() === 'note.md') throw new Error('Invalid file name: cannot delete note.md');
    await deleteAttachment(noteDir, safe, workspaceService.getWorkspacePath());
  }

  private async findContextFile(id: string): Promise<{ filePath: string; category: ContextCategory } | null> {
    for (const cat of await categories()) {
      for await (const { filePath } of this.noteFiles(cat)) {
        try {
          const { data } = await fileService.readMarkdown<{ id?: string }>(filePath);
          if (data.id === id) return { filePath, category: cat };
        } catch {
          // continue
        }
      }
    }
    return null;
  }
}
