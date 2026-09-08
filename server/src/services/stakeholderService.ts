import * as path from 'path';
import * as fsp from 'fs/promises';
import { Stakeholder, InfluenceLevel } from '../types';
import { FileService } from './fileService';
import { WorkspaceService } from './workspace';

const fileService = new FileService();
const workspaceService = new WorkspaceService();

export class StakeholderService {
  private getPeopleDir(): string {
    return path.join(workspaceService.getWorkspacePath(), 'stakeholders', 'people');
  }

  private getGroupsDir(): string {
    return path.join(workspaceService.getWorkspacePath(), 'stakeholders', 'groups');
  }

  async listStakeholders(type?: 'people' | 'groups'): Promise<Stakeholder[]> {
    const dirs = type === 'groups' ? [this.getGroupsDir()] : type === 'people' ? [this.getPeopleDir()] : [this.getPeopleDir(), this.getGroupsDir()];
    const results: Stakeholder[] = [];

    for (const dir of dirs) {
      await fileService.ensureDir(dir);
      const files = await fileService.listFiles(dir, '*.md');
      for (const filePath of files) {
        try {
          const { data, content } = await fileService.readMarkdown<Stakeholder>(filePath);
          results.push({
            ...data,
            tags: data.tags || [],
            influence: data.influence || 'informed',
            created_at: data.created_at || new Date().toISOString(),
            updated_at: data.updated_at || new Date().toISOString(),
            notes: content || data.notes || undefined,
            path: filePath,
          });
        } catch {
          // Skip malformed files
        }
      }
    }

    return results.sort((a, b) => a.name.localeCompare(b.name));
  }

  async getStakeholder(id: string): Promise<Stakeholder> {
    const filePath = await this.findStakeholderFile(id);
    if (!filePath) throw new Error(`Stakeholder not found: ${id}`);

    const { data, content } = await fileService.readMarkdown<Stakeholder>(filePath);
    return {
      ...data,
      id,
      tags: data.tags || [],
      influence: data.influence || 'informed',
      created_at: data.created_at || new Date().toISOString(),
      updated_at: data.updated_at || new Date().toISOString(),
      notes: content || data.notes || undefined,
      path: filePath,
    };
  }

  async createStakeholder(data: Partial<Stakeholder> & { type?: 'people' | 'groups' }): Promise<Stakeholder> {
    const isGroup = data.type === 'groups';
    const id = await this.generateId(isGroup);
    const now = new Date().toISOString();
    const dir = isGroup ? this.getGroupsDir() : this.getPeopleDir();
    const slug = id.toLowerCase();
    const filePath = path.join(dir, `${slug}.md`);

    const stk: Stakeholder = {
      id,
      name: data.name || 'Unknown',
      role: data.role,
      organization: data.organization,
      email: data.email,
      tags: data.tags || [],
      influence: data.influence || 'informed',
      what_matters: data.what_matters,
      notes: data.notes,
      avatar_initials: data.avatar_initials || this.getInitials(data.name || 'Unknown'),
      created_at: now,
      updated_at: now,
    };

    const { path: _path, notes, ...frontmatter } = stk;
    await fileService.writeMarkdown(filePath, frontmatter as Record<string, unknown>, notes || '');
    return { ...stk, path: filePath };
  }

  async updateStakeholder(id: string, data: Partial<Stakeholder>): Promise<Stakeholder> {
    const existing = await this.getStakeholder(id);
    const filePath = existing.path!;
    const { content } = await fileService.readMarkdown<Stakeholder>(filePath);

    const updated: Stakeholder = {
      ...existing,
      ...data,
      id,
      updated_at: new Date().toISOString(),
    };

    const { path: _path, notes, ...frontmatter } = updated;
    await fileService.writeMarkdown(filePath, frontmatter as Record<string, unknown>, data.notes !== undefined ? data.notes || '' : content);
    return { ...updated, path: filePath };
  }

  async deleteStakeholder(id: string): Promise<void> {
    const filePath = await this.findStakeholderFile(id);
    if (!filePath) throw new Error(`Stakeholder not found: ${id}`);
    await fileService.deleteFile(filePath);
  }

  private async findStakeholderFile(id: string): Promise<string | null> {
    const dirs = [this.getPeopleDir(), this.getGroupsDir()];
    for (const dir of dirs) {
      await fileService.ensureDir(dir);
      const files = await fileService.listFiles(dir, '*.md');
      for (const filePath of files) {
        try {
          const { data } = await fileService.readMarkdown<{ id?: string }>(filePath);
          if (data.id === id) return filePath;
        } catch {
          // continue
        }
      }
    }
    return null;
  }

  private async generateId(isGroup: boolean): Promise<string> {
    const prefix = isGroup ? 'GRP' : 'STK';
    const pattern = isGroup ? /^GRP-(\d+)$/ : /^STK-(\d+)$/;
    const dir = isGroup ? this.getGroupsDir() : this.getPeopleDir();
    await fileService.ensureDir(dir);
    const files = await fileService.listFiles(dir, '*.md');
    let maxSeq = 0;
    for (const filePath of files) {
      try {
        const { data } = await fileService.readMarkdown<{ id?: string }>(filePath);
        const match = data.id?.match(pattern);
        if (match) {
          const seq = parseInt(match[1], 10);
          if (seq > maxSeq) maxSeq = seq;
        }
      } catch { /* skip */ }
    }
    const nextSeq = String(maxSeq + 1).padStart(4, '0');
    return `${prefix}-${nextSeq}`;
  }

  private getInitials(name: string): string {
    return name
      .split(' ')
      .map((w) => w[0])
      .join('')
      .toUpperCase()
      .slice(0, 2);
  }
}
