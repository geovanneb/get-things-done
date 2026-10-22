import * as path from 'path';
import * as fsp from 'fs/promises';
import { ContextNote, ContextCategory } from '../types';
import { FileService } from './fileService';
import { WorkspaceService } from './workspace';
import { fileInside, listFolderFiles, topLevelName, FolderFile } from '../utils/files';

const fileService = new FileService();
const workspaceService = new WorkspaceService();

// Per-note folder structure: context/category/slug/note.md
// Old structure (backward compat): context/category/slug.md
// Migration: old files are moved to new structure automatically

export class ContextService {
  private getContextDir(category?: ContextCategory): string {
    const base = path.join(workspaceService.getWorkspacePath(), 'context');
    return category ? path.join(base, category) : base;
  }

  private getNoteDir(category: ContextCategory, slug: string): string {
    return path.join(this.getContextDir(category), slug);
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
    const categories: ContextCategory[] = category
      ? [category]
      : ['company', 'organization', 'strategy', 'programs', 'decisions', 'risks', 'glossary', 'situation'];

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
            category: cat,
            tags: data.tags || [],
            created_at: data.created_at || new Date().toISOString(),
            updated_at: data.updated_at || new Date().toISOString(),
            body: content,
            path: filePath,
          });
        } catch {
          // Skip malformed files
        }
      }
    }

    return results.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }

  async getContextNote(id: string): Promise<ContextNote> {
    const result = await this.findContextFile(id);
    if (!result) throw new Error(`Context note not found: ${id}`);

    const { filePath, category } = result;
    const { data, content } = await fileService.readMarkdown<ContextNote>(filePath);
    return {
      ...data,
      id,
      category,
      tags: data.tags || [],
      created_at: data.created_at || new Date().toISOString(),
      updated_at: data.updated_at || new Date().toISOString(),
      body: content,
      path: filePath,
    };
  }

  async createContextNote(data: Partial<ContextNote>): Promise<ContextNote> {
    const now = new Date().toISOString();
    const category: ContextCategory = ((data.category || 'situation').toLowerCase() as ContextCategory);
    const slug = data.slug || this.slugify(data.title || 'untitled');
    const id = `CTX-${slug}`;
    const noteDir = this.getNoteDir(category, slug);
    const filePath = this.getNoteFile(category, slug);

    await fileService.ensureDir(noteDir);

    const note: ContextNote = {
      id,
      category,
      title: data.title || 'Untitled',
      slug,
      tags: [],
      relevance: data.relevance,
      created_at: now,
      updated_at: now,
    };

    const { content: _c, body: _b, path: _path, ...frontmatter } = note;
    const bodyContent = data.body || data.content || '';
    await fileService.writeMarkdown(filePath, frontmatter as Record<string, unknown>, bodyContent);
    return { ...note, body: bodyContent, path: filePath };
  }

  async updateContextNote(id: string, data: Partial<ContextNote>): Promise<ContextNote> {
    const existing = await this.getContextNote(id);
    const incomingCategory = data.category
      ? (data.category.toLowerCase() as ContextCategory)
      : existing.category;

    const bodyContent = data.body !== undefined
      ? data.body
      : (data.content !== undefined ? data.content : (existing.body || existing.content || ''));

    let filePath = existing.path!;

    // If category changed, move the entire slug directory
    if (incomingCategory !== existing.category) {
      const slug = path.basename(path.dirname(existing.path!));
      const newNoteDir = this.getNoteDir(incomingCategory, slug);
      const newFilePath = this.getNoteFile(incomingCategory, slug);
      await fileService.ensureDir(newNoteDir);
      // Move all files in the old dir to the new dir
      const oldDir = path.dirname(existing.path!);
      const entries = await fsp.readdir(oldDir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (entry.isFile()) {
          await fsp.rename(path.join(oldDir, entry.name), path.join(newNoteDir, entry.name));
        }
      }
      await fsp.rm(oldDir, { recursive: true, force: true });
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

    const { content: _c, body: _b, path: _path, ...frontmatter } = updated;
    await fileService.writeMarkdown(filePath, frontmatter as Record<string, unknown>, bodyContent);
    return { ...updated, body: bodyContent, path: filePath };
  }

  async deleteContextNote(id: string): Promise<void> {
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
    const safe = path.basename(originalName).replace(/[^\w.\-]/g, '_');
    const fp = path.join(noteDir, safe);
    await fsp.writeFile(fp, buffer);
    const stat = await fsp.stat(fp);
    return { name: safe, size: stat.size, modified: stat.mtime.toISOString(), type: path.extname(safe).slice(1).toLowerCase() || 'file' };
  }

  async deleteContextFile(id: string, filename: string): Promise<void> {
    const result = await this.findContextFile(id);
    if (!result) throw new Error(`Context note not found: ${id}`);
    const safe = topLevelName(filename);
    if (safe === 'note.md') throw new Error('Cannot delete note.md');
    const noteDir = path.dirname(result.filePath);
    await fsp.unlink(path.join(noteDir, safe));
  }

  private async findContextFile(id: string): Promise<{ filePath: string; category: ContextCategory } | null> {
    const categories: ContextCategory[] = ['company', 'organization', 'strategy', 'programs', 'decisions', 'risks', 'glossary', 'situation'];

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

  private slugify(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 64);
  }
}
