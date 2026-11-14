import * as path from 'path';
import * as fsp from 'fs/promises';
import { Stakeholder, InfluenceLevel } from '../types';
import { FileService } from './fileService';
import { WorkspaceService } from './workspace';
import { reserveIds, reservedSequence } from './idReservations';
import { requireText, requireList, textList, textOf } from '../utils/loose';

const TEXT_FIELDS = ['name', 'role', 'organization', 'email', 'what_matters', 'notes', 'avatar_initials', 'influence'] as const;

const fileService = new FileService();
const workspaceService = new WorkspaceService();

/** The address to store, or undefined for an empty one: the schema has no empty email, so it is left out. */
function presentEmail(email: unknown): string | undefined {
  if (email === null || (typeof email === 'string' && !email.trim())) return undefined;
  return email as string | undefined;
}

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
            // A file written by hand may have no name, or one YAML reads as a number: listed under its id, never dropped.
            name: textOf(data.name).trim() || textOf(data.id) || path.basename(filePath, '.md'),
            tags: textList(data.tags),
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
      name: textOf(data.name).trim() || id,
      tags: textList(data.tags),
      influence: data.influence || 'informed',
      created_at: data.created_at || new Date().toISOString(),
      updated_at: data.updated_at || new Date().toISOString(),
      notes: content || data.notes || undefined,
      path: filePath,
    };
  }

  async createStakeholder(data: Partial<Stakeholder> & { type?: 'people' | 'groups' }): Promise<Stakeholder> {
    requireText(data, TEXT_FIELDS);
    requireList(data, ['tags']);
    const isGroup = data.type === 'groups';
    const id = await this.generateId(isGroup);
    const now = new Date().toISOString();
    const dir = isGroup ? this.getGroupsDir() : this.getPeopleDir();

    const stk: Stakeholder = {
      id,
      name: data.name || 'Unknown',
      role: data.role,
      organization: data.organization,
      email: presentEmail(data.email),
      tags: data.tags || [],
      influence: data.influence || 'informed',
      what_matters: data.what_matters,
      notes: data.notes,
      avatar_initials: data.avatar_initials || this.getInitials(data.name || 'Unknown'),
      created_at: now,
      updated_at: now,
    };

    const { path: _path, notes, ...frontmatter } = stk;
    // Two creates at the same moment can pick the same number, and a plain write would silently replace the
    // other person. The exclusive create lets only one have it; the other takes the next number.
    let filePath = path.join(dir, `${stk.id.toLowerCase()}.md`);
    for (let attempt = 0; ; attempt++) {
      try { await fileService.createMarkdown(filePath, frontmatter as Record<string, unknown>, notes || ''); break; } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        if (attempt === 19) throw Object.assign(new Error(`Could not reserve a new ${isGroup ? 'group' : 'stakeholder'} id; try again`), { statusCode: 409 });
        stk.id = frontmatter.id = stk.id.replace(/\d+$/, (n) => String(Number(n) + 1).padStart(4, '0'));
        filePath = path.join(dir, `${stk.id.toLowerCase()}.md`);
      }
    }
    return { ...stk, path: filePath };
  }

  async updateStakeholder(id: string, data: Partial<Stakeholder>): Promise<Stakeholder> {
    requireText(data, TEXT_FIELDS);
    requireList(data, ['tags']);
    const existing = await this.getStakeholder(id);
    const filePath = existing.path!;
    const { content } = await fileService.readMarkdown<Stakeholder>(filePath);

    const updated: Stakeholder = {
      ...existing,
      ...data,
      id,
      updated_at: new Date().toISOString(),
    };
    // A cleared email is sent empty: it removes the address rather than keeping the old one or writing an empty one.
    if ('email' in data) updated.email = presentEmail(data.email);

    const { path: _path, notes, ...frontmatter } = updated;
    await fileService.writeMarkdown(filePath, frontmatter as Record<string, unknown>, data.notes !== undefined ? data.notes || '' : content);
    return { ...updated, path: filePath };
  }

  async deleteStakeholder(id: string): Promise<void> {
    const filePath = await this.findStakeholderFile(id);
    if (!filePath) throw new Error(`Stakeholder not found: ${id}`);
    // Keep the id taken: tasks and @mentions that name this person must not point at the next new one.
    await reserveIds([id]);
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
    maxSeq = Math.max(maxSeq, await reservedSequence(prefix));
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
