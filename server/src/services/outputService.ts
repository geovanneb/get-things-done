import * as path from 'path';
import * as fsp from 'fs/promises';
import { OutputTemplate, OutputFormat } from '../types';
import { FileService } from './fileService';
import { WorkspaceService } from './workspace';
import { fileInside, listFolderFiles, topLevelName, FolderFile } from '../utils/files';

const fileService = new FileService();
const workspaceService = new WorkspaceService();

/**
 * The output-template schema and task deliverables use lower-case formats ("pptx"), but templates
 * written by hand (and the ones shipped before this fix) say "PPTX". Normalise on read so both work.
 */
function normaliseFormat(format: unknown): OutputFormat {
  return (typeof format === 'string' && format.trim() ? format.trim().toLowerCase() : 'md') as OutputFormat;
}

export class OutputService {
  private getTemplatesDir(): string {
    return path.join(workspaceService.getWorkspacePath(), 'outputs', 'templates');
  }

  async listTemplates(): Promise<OutputTemplate[]> {
    const templatesDir = this.getTemplatesDir();
    await fileService.ensureDir(templatesDir);

    const files = await fileService.listFiles(templatesDir, 'output.md');
    const results: OutputTemplate[] = [];

    for (const filePath of files) {
      try {
        const { data } = await fileService.readMarkdown<OutputTemplate>(filePath);
        results.push({
          ...data,
          format: normaliseFormat(data.format),
          tags: data.tags ?? [],
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
      format: normaliseFormat(data.format),
      tags: data.tags ?? [],
      required_sections: data.required_sections ?? [],
      created_at: data.created_at || new Date().toISOString(),
      updated_at: data.updated_at || new Date().toISOString(),
      path: filePath,
    };
  }

  async createTemplate(data: Partial<OutputTemplate>): Promise<OutputTemplate> {
    const now = new Date().toISOString();
    const slug = data.slug || this.slugify(data.name || 'untitled');
    const id = `OUT-${slug}`;
    const templateDir = path.join(this.getTemplatesDir(), slug);
    const filePath = path.join(templateDir, 'output.md');

    await fileService.ensureDir(templateDir);

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
  }

  async updateTemplate(id: string, data: Partial<OutputTemplate>): Promise<OutputTemplate> {
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

    const { path: _path, ...frontmatter } = updated;
    await fileService.writeMarkdown(filePath, frontmatter as Record<string, unknown>, updated.description || '');
    return { ...updated, path: filePath };
  }

  async deleteTemplate(id: string): Promise<void> {
    const filePath = await this.findTemplateFile(id);
    if (!filePath) throw new Error(`Output template not found: ${id}`);
    // Delete the whole template directory
    const templateDir = path.dirname(filePath);
    await fsp.rm(templateDir, { recursive: true, force: true });
  }

  async listTemplateFiles(id: string): Promise<FolderFile[]> {
    const filePath = await this.findTemplateFile(id);
    if (!filePath) throw new Error(`Output template not found: ${id}`);
    return listFolderFiles(path.dirname(filePath), ['output.md']);
  }

  /** Absolute path of one file in the template's folder (404 if missing, 400 if outside the folder). */
  async templateFilePath(id: string, name: string): Promise<string> {
    const filePath = await this.findTemplateFile(id);
    if (!filePath) throw new Error(`Output template not found: ${id}`);
    return fileInside(path.dirname(filePath), name);
  }

  async saveTemplateFile(id: string, originalName: string, buffer: Buffer): Promise<{ name: string; size: number; modified: string; type: string }> {
    const filePath = await this.findTemplateFile(id);
    if (!filePath) throw new Error(`Output template not found: ${id}`);
    const templateDir = path.dirname(filePath);
    const safe = path.basename(originalName).replace(/[^\w.\-]/g, '_');
    const fp = path.join(templateDir, safe);
    await fsp.writeFile(fp, buffer);
    const stat = await fsp.stat(fp);
    return { name: safe, size: stat.size, modified: stat.mtime.toISOString(), type: path.extname(safe).slice(1).toLowerCase() || 'file' };
  }

  async deleteTemplateFile(id: string, filename: string): Promise<void> {
    const filePath = await this.findTemplateFile(id);
    if (!filePath) throw new Error(`Output template not found: ${id}`);
    const safe = topLevelName(filename);
    if (safe === 'output.md') throw new Error('Cannot delete output.md');
    const templateDir = path.dirname(filePath);
    await fsp.unlink(path.join(templateDir, safe));
  }

  private async findTemplateFile(id: string): Promise<string | null> {
    const files = await fileService.listFiles(this.getTemplatesDir(), 'output.md');
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

  private slugify(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 64);
  }
}
