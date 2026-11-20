import * as path from 'path';
import * as fsp from 'fs/promises';
import { OutputTemplate, OutputFormat } from '../types';
import { FileService } from './fileService';
import { WorkspaceService } from './workspace';
import { lock, unlock } from '../utils/fileLock';
import { titleSlug } from '../utils/slug';
import { requireText, requireList, textList, textOf } from '../utils/loose';

const TEXT_FIELDS = ['name', 'slug', 'format', 'description', 'style_guide'] as const;
import { deleteAttachment, saveAttachment, fileInside, listFolderFiles, topLevelName, zipFolder, FolderFile, workspaceEntry } from '../utils/files';

const fileService = new FileService();
const workspaceService = new WorkspaceService();

/**
 * The output-template schema and task deliverables use lower-case formats ("pptx"), but templates
 * written by hand (and the ones shipped before this fix) say "PPTX". Normalise on read so both work.
 */
function normaliseFormat(format: unknown): OutputFormat {
  return (typeof format === 'string' && format.trim() ? format.trim().toLowerCase() : 'md') as OutputFormat;
}

function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode: status });
}

export class OutputService {
  /**
   * outputs/templates, checked to stay inside the workspace: neither it nor `outputs` may be a link, so templates (and
   * their attached files) are never read or written through a linked folder. Links below it are skipped by listFiles.
   */
  private async getTemplatesDir(): Promise<string> {
    const ws = workspaceService.getWorkspacePath();
    return workspaceEntry(ws, path.join(ws, 'outputs', 'templates'), true);
  }

  /** The folder of a template found by id, checked again right before it is used: 404 when there is no such template. */
  private async templateFolder(id: string): Promise<string> {
    const filePath = await this.findTemplateFile(id);
    if (!filePath) throw new Error(`Output template not found: ${id}`);
    return workspaceEntry(workspaceService.getWorkspacePath(), path.dirname(filePath)).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') throw new Error(`Output template not found: ${id}`);
      throw err;
    });
  }

  async listTemplates(): Promise<OutputTemplate[]> {
    const templatesDir = await this.getTemplatesDir();
    await fileService.ensureDir(templatesDir);

    const files = await fileService.listFiles(templatesDir, 'output.md');
    const results: OutputTemplate[] = [];

    for (const filePath of files) {
      try {
        const { data } = await fileService.readMarkdown<OutputTemplate>(filePath);
        results.push({
          ...data,
          // A template written by hand may have no name: listed under its id, never dropped.
          name: textOf(data.name).trim() || textOf(data.id) || path.basename(path.dirname(filePath)),
          format: normaliseFormat(data.format),
          tags: textList(data.tags),
          required_sections: data.required_sections ?? [],
          created_at: data.created_at || new Date().toISOString(),
          updated_at: data.updated_at || new Date().toISOString(),
          path: filePath,
        });
      } catch {
        // Skip malformed files
      }
    }

    return results.sort((a, b) => a.name.localeCompare(b.name));
  }

  async getTemplate(id: string): Promise<OutputTemplate> {
    const filePath = await this.findTemplateFile(id);
    if (!filePath) throw new Error(`Output template not found: ${id}`);

    const { data } = await fileService.readMarkdown<OutputTemplate>(filePath);
    return {
      ...data,
      id,
      name: textOf(data.name).trim() || id,
      format: normaliseFormat(data.format),
      tags: textList(data.tags),
      required_sections: data.required_sections ?? [],
      created_at: data.created_at || new Date().toISOString(),
      updated_at: data.updated_at || new Date().toISOString(),
      path: filePath,
    };
  }

  async createTemplate(data: Partial<OutputTemplate>): Promise<OutputTemplate> {
    requireText(data, TEXT_FIELDS);
    requireList(data, ['tags', 'required_sections']);
    const now = new Date().toISOString();
    const slug = data.slug || titleSlug(data.name || 'untitled', 'template');
    const id = `OUT-${slug}`;
    const templateDir = await workspaceEntry(workspaceService.getWorkspacePath(), path.join(await this.getTemplatesDir(), topLevelName(slug)), true);
    const filePath = path.join(templateDir, 'output.md');

    // Names that differ only in case or punctuation share a slug: check and create under one cross-process lock.
    const ws = workspaceService.getWorkspacePath();
    const locks = await workspaceEntry(ws, path.join(ws, '.situation-board', 'template-locks'), true);
    await fileService.ensureDir(locks);
    const lockFile = await workspaceEntry(ws, path.join(locks, `${topLevelName(id)}.lock`), true);
    const held = await lock(lockFile, 5000, () => httpError(409, 'This output template is being created elsewhere. Try again.'));
    try {
      // Never replace another template (and take over its uploaded files) by creating one with a similar name.
      if (await fileService.exists(filePath)) throw httpError(409, `An output template named "${slug}" already exists. Edit it, or choose another name.`);
      await fileService.ensureDir(await workspaceEntry(ws, templateDir, true));

      const template: OutputTemplate = {
        id,
        slug,
        name: data.name || 'Untitled Template',
        format: data.format || 'md',
        description: data.description,
        required_sections: data.required_sections ?? [],
        style_guide: data.style_guide,
        tags: data.tags ?? [],
        created_at: now,
        updated_at: now,
      };

      const { path: _path, ...frontmatter } = template;
      await fileService.writeMarkdown(filePath, frontmatter as Record<string, unknown>, data.description || '');
      return { ...template, path: filePath };
    } finally {
      await unlock(held);
    }
  }

  async updateTemplate(id: string, data: Partial<OutputTemplate>): Promise<OutputTemplate> {
    requireText(data, TEXT_FIELDS);
    requireList(data, ['tags', 'required_sections']);
    const existing = await this.getTemplate(id);
    const filePath = existing.path!;

    const updated: OutputTemplate = {
      ...existing,
      ...data,
      id,
      required_sections: data.required_sections ?? existing.required_sections ?? [],
      tags: data.tags ?? existing.tags ?? [],
      updated_at: new Date().toISOString(),
    };

    // Agents read the body, the dashboard never shows it. A template created here starts with the description as
    // its body: keep that copy in step, but never replace a body someone wrote.
    const { content } = await fileService.readMarkdown(filePath);
    const body = content === String(existing.description ?? '').trim() ? updated.description || '' : content;
    const { path: _path, ...frontmatter } = updated;
    await fileService.writeMarkdown(filePath, frontmatter as Record<string, unknown>, body);
    return { ...updated, path: filePath };
  }

  async deleteTemplate(id: string): Promise<void> {
    // Delete the whole template directory (fs.rm never follows links inside it)
    await fsp.rm(await this.templateFolder(id), { recursive: true, force: true });
  }

  async listTemplateFiles(id: string): Promise<FolderFile[]> {
    return listFolderFiles(await this.templateFolder(id), ['output.md']);
  }

  /** The template's whole folder (output.md and every file) as one ZIP. */
  async templateArchive(id: string): Promise<{ name: string; data: Buffer }> {
    return zipFolder(await this.templateFolder(id), 'output.md');
  }

  /** Absolute path of one file in the template's folder (404 if missing, 400 if outside the folder). */
  async templateFilePath(id: string, name: string): Promise<string> {
    return fileInside(await this.templateFolder(id), name);
  }

  async saveTemplateFile(id: string, originalName: string, buffer: Buffer): Promise<{ name: string; size: number; modified: string; type: string }> {
    return saveAttachment(await this.templateFolder(id), originalName, buffer, 'output.md', workspaceService.getWorkspacePath());
  }

  async deleteTemplateFile(id: string, filename: string): Promise<void> {
    const templateDir = await this.templateFolder(id);
    const safe = topLevelName(filename);
    if (safe.toLowerCase() === 'output.md') throw new Error('Invalid file name: cannot delete output.md');
    await deleteAttachment(templateDir, safe, workspaceService.getWorkspacePath());
  }

  private async findTemplateFile(id: string): Promise<string | null> {
    const files = await fileService.listFiles(await this.getTemplatesDir(), 'output.md');
    for (const filePath of files) {
      try {
        const { data } = await fileService.readMarkdown<{ id?: string }>(filePath);
        if (data.id === id) return filePath;
      } catch {
        // continue
      }
    }
    return null;
  }
}
