import * as path from 'path';
import * as fsp from 'fs/promises';
import { createHash } from 'crypto';
import { ContextNote, ContextCategory } from '../types';
import { FileService } from './fileService';
import { WorkspaceService } from './workspace';
import { lock, unlock } from '../utils/fileLock';
import { titleSlug } from '../utils/slug';
import { requireText, textList, textOf } from '../utils/loose';

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

/** The categories in .schemas/context.schema.json; a note anywhere else is never listed, read or deleted. */
const CATEGORIES: readonly ContextCategory[] = ['company', 'organization', 'strategy', 'programs', 'decisions', 'risks', 'glossary', 'situation'];

/** A category sent by the user, matched without case: anything outside the eight is refused before a folder is made. */
function requestedCategory(value: unknown): ContextCategory {
  const category = typeof value === 'string' ? value.toLowerCase() : value;
  if ((CATEGORIES as readonly unknown[]).includes(category)) return category as ContextCategory;
  throw httpError(400, `category must be one of ${CATEGORIES.join(', ')}.`);
}

/**
 * The lock file's name for a note id: the id itself, as create has always used. A hand-written id that is not a valid
 * file name (a colon, a trailing dot, too long) can never come from create, so it gets a hashed name instead of a 400.
 */
function lockName(id: string): string {
  try {
    if (Buffer.byteLength(id) <= 200) return topLevelName(id);
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

  // Migrate old-style file to new folder structure
  private async migrateOldFile(oldPath: string, category: ContextCategory): Promise<string> {
    const slug = path.basename(oldPath, '.md');
    const noteDir = this.getNoteDir(category, slug);
    const noteFile = this.getNoteFile(category, slug);
    await fileService.ensureDir(noteDir);
    await fsp.rename(oldPath, noteFile);
    return noteFile;
  }

  async listContextNotes(category?: ContextCategory): Promise<ContextNote[]> {
    // Checked before any folder is touched: a read never creates a folder for a category that does not exist.
    const categories: readonly ContextCategory[] = category ? [requestedCategory(category)] : CATEGORIES;

    const results: ContextNote[] = [];

    for (const cat of categories) {
      const dir = this.getContextDir(cat);
      await fileService.ensureDir(dir);

      const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        let filePath: string;

        if (entry.isDirectory()) {
          // New structure: category/slug/note.md
          const noteFile = path.join(dir, entry.name, 'note.md');
          if (!(await fileService.exists(noteFile))) continue;
          filePath = noteFile;
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          // Old structure: migrate to new
          const oldPath = path.join(dir, entry.name);
          filePath = await this.migrateOldFile(oldPath, cat);
        } else {
          continue;
        }

        try {
          const { data, content } = await fileService.readMarkdown<ContextNote>(filePath);
          results.push({
            ...data,
            title: textOf(data.title).trim() || entry.name.replace(/\.md$/, ''),
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
    const category = requestedCategory(data.category || 'situation');
    const slug = data.slug || titleSlug(data.title || 'untitled', 'note');
    const sensitivity = requestedSensitivity(data.sensitivity);
    const id = `CTX-${slug}`;
    const noteDir = this.getNoteDir(category, slug);
    const filePath = this.getNoteFile(category, slug);

    // The id is shared across categories: check and create under one cross-process lock.
    const held = await this.lockNote(id, 'This context note is being created elsewhere. Try again.');
    try {
      // Never replace another note (and its sharing label) by creating one with the same title.
      if (await fileService.exists(filePath)) throw httpError(409, `A context note named "${slug}" already exists in ${category}. Edit it, or choose another title.`);
      // Ids are CTX-<slug> in every category: a second note with the same id would be edited, relabelled or deleted
      // through the first one's id.
      const sameId = await this.findContextFile(id);
      if (sameId) throw httpError(409, `A context note named "${slug}" already exists in ${sameId.category}. Edit it, or choose another title.`);
      await fileService.ensureDir(noteDir);

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
      await fileService.writeMarkdown(filePath, frontmatter as Record<string, unknown>, bodyContent);
      return { ...note, body: bodyContent, path: filePath };
    } finally {
      await unlock(held);
    }
  }

  async updateContextNote(id: string, data: Partial<ContextNote>): Promise<ContextNote> {
    requireText(data, TEXT_FIELDS);
    const sensitivity = requestedSensitivity(data.sensitivity);
    const requested = data.category ? requestedCategory(data.category) : undefined;
    const held = await this.lockNote(id, 'This context note is being changed elsewhere. Try again.');
    try {
      return await this.updateLocked(id, data, sensitivity, requested);
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

    // If category changed, move the entire slug directory
    if (incomingCategory !== existing.category) {
      const slug = path.basename(path.dirname(existing.path!));
      const newNoteDir = this.getNoteDir(incomingCategory, slug);
      // Never onto another note: its folder would be overwritten.
      if (await fileService.exists(newNoteDir)) throw httpError(409, `A context note named "${slug}" already exists in ${incomingCategory}. Rename one of them first.`);
      const newFilePath = this.getNoteFile(incomingCategory, slug);
      // Rename the folder itself so subfolders move too (moving files one by one and then
      // removing the old folder deleted them). Only the parent is created: Windows will not
      // rename onto an existing folder, even an empty one.
      await fileService.ensureDir(this.getContextDir(incomingCategory));
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
    await fileService.writeMarkdown(filePath, frontmatter as Record<string, unknown>, bodyContent);
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
      // New structure - delete whole dir
      await fsp.rm(noteDir, { recursive: true, force: true });
    } else {
      await fileService.deleteFile(result.filePath);
    }
  }

  async listContextFiles(id: string): Promise<FolderFile[]> {
    const result = await this.findContextFile(id);
    if (!result) throw new Error(`Context note not found: ${id}`);
    return listFolderFiles(path.dirname(result.filePath), ['note.md']);
  }

  /** The note's whole folder (note.md and every attached file) as one ZIP. */
  async contextArchive(id: string): Promise<{ name: string; data: Buffer }> {
    const result = await this.findContextFile(id);
    if (!result) throw new Error(`Context note not found: ${id}`);
    return zipFolder(path.dirname(result.filePath), 'note.md');
  }

  /** Absolute path of one file attached to the note (404 if missing, 400 if outside the note's folder). */
  async contextFilePath(id: string, name: string): Promise<string> {
    const result = await this.findContextFile(id);
    if (!result) throw new Error(`Context note not found: ${id}`);
    return fileInside(path.dirname(result.filePath), name);
  }

  async saveContextFile(id: string, originalName: string, buffer: Buffer): Promise<{ name: string; size: number; modified: string; type: string }> {
    const result = await this.findContextFile(id);
    if (!result) throw new Error(`Context note not found: ${id}`);
    const noteDir = path.dirname(result.filePath);
    return saveAttachment(noteDir, originalName, buffer, 'note.md');
  }

  async deleteContextFile(id: string, filename: string): Promise<void> {
    const result = await this.findContextFile(id);
    if (!result) throw new Error(`Context note not found: ${id}`);
    const safe = topLevelName(filename);
    if (safe.toLowerCase() === 'note.md') throw new Error('Invalid file name: cannot delete note.md');
    await deleteAttachment(path.dirname(result.filePath), safe);
  }

  private async findContextFile(id: string): Promise<{ filePath: string; category: ContextCategory } | null> {
    const categories = CATEGORIES;

    for (const cat of categories) {
      const dir = this.getContextDir(cat);
      await fileService.ensureDir(dir);

      const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        let filePath: string;
        if (entry.isDirectory()) {
          const noteFile = path.join(dir, entry.name, 'note.md');
          if (!(await fileService.exists(noteFile))) continue;
          filePath = noteFile;
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          // Old file - migrate before checking
          const oldPath = path.join(dir, entry.name);
          filePath = await this.migrateOldFile(oldPath, cat);
        } else {
          continue;
        }

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
