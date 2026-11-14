import * as path from 'path';
import * as fsp from 'fs/promises';
import { createHash } from 'crypto';
import { Stakeholder, InfluenceLevel } from '../types';
import { FileService } from './fileService';
import { WorkspaceService } from './workspace';
import { reserveIds, reservedSequence } from './idReservations';
import { requireText, requireList, textList, textOf } from '../utils/loose';
import { lock, unlock } from '../utils/fileLock';
import { topLevelName, workspaceEntry } from '../utils/files';

const TEXT_FIELDS = ['name', 'role', 'organization', 'email', 'what_matters', 'notes', 'avatar_initials', 'influence'] as const;

/**
 * The fields an edit may change: the stakeholder schema's own fields plus the initials the app keeps. Anything else in
 * a request (the id, the dates the app sets, `path`, or a token such as `version` or `expected_version`) is never
 * written into the file. Keys already in the file are kept as they are.
 */
const EDITABLE_FIELDS = ['name', 'role', 'organization', 'email', 'phone', 'influence', 'decision_role', 'what_matters', 'communication_preferences', 'tags', 'avatar_initials'] as const;

/** How long a save waits for another save or delete of the same stakeholder before it answers 409. */
const STAKEHOLDER_LOCK_WAIT_MS = 5000;

/** The lock file's name: the id, or a hash of it when a hand-written id is not a valid file name. */
function lockName(id: string): string {
  try {
    if (Buffer.byteLength(id) <= 200) return topLevelName(id);
  } catch { /* not a file name */ }
  return `id-${createHash('sha256').update(id).digest('hex').slice(0, 32)}`;
}

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
    return this.view(id, data, content, filePath);
  }

  /** The stakeholder as the API shows it, from the file's front matter and body. */
  private view(id: string, data: Partial<Stakeholder>, content: string, filePath: string): Stakeholder {
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
    return this.withStakeholderLock(id, async () => {
      // Found and read under the lock: a save never writes back a person deleted a moment ago, and never builds on a
      // copy another save has just replaced.
      const filePath = await this.findStakeholderFile(id);
      if (!filePath) throw new Error(`Stakeholder not found: ${id}`);
      const { data: file, content } = await fileService.readMarkdown<Record<string, unknown>>(filePath);
      const current = this.view(id, file as Partial<Stakeholder>, content, filePath);

      // Built from the file, so keys an agent added stay; only the editable fields of the request are applied.
      const frontmatter: Record<string, unknown> = {
        ...file,
        id,
        name: current.name,
        tags: current.tags,
        influence: current.influence,
        created_at: current.created_at,
      };
      for (const key of EDITABLE_FIELDS) {
        if (key in data) frontmatter[key] = data[key as keyof Stakeholder];
      }
      // A cleared email is sent empty: it removes the address rather than keeping the old one or writing an empty one.
      if ('email' in data) {
        const email = presentEmail(data.email);
        if (email === undefined) delete frontmatter.email;
        else frontmatter.email = email;
      }
      frontmatter.updated_at = new Date().toISOString();
      // The notes are the body. Notes an older file kept in its front matter move to the body instead of being lost.
      const body = data.notes !== undefined ? data.notes || '' : (current.notes ?? '');
      delete frontmatter.notes;

      await fileService.writeMarkdown(filePath, frontmatter, body);
      return this.view(id, frontmatter as Partial<Stakeholder>, body, filePath);
    });
  }

  async deleteStakeholder(id: string): Promise<void> {
    await this.withStakeholderLock(id, async () => {
      const filePath = await this.findStakeholderFile(id);
      if (!filePath) throw new Error(`Stakeholder not found: ${id}`);
      // Keep the id taken: tasks and @mentions that name this person must not point at the next new one.
      // Lock order: this stakeholder's lock, then the id reservations lock inside reserveIds. Nothing takes them the
      // other way round: reserveIds holds only its own lock and calls nothing that locks a stakeholder.
      await reserveIds([id]);
      await fileService.deleteFile(filePath);
    });
  }

  /**
   * One writer at a time per stakeholder, across dashboards: `.situation-board/stakeholder-locks/<id>.lock`. Update and
   * delete take it, so a save never writes back a person deleted a moment ago and two saves never build on the same
   * old copy. It does not refuse a save made from an older view (that needs a version check), and agents that edit
   * the file directly do not take it.
   */
  private async withStakeholderLock<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const ws = workspaceService.getWorkspacePath();
    const locks = await workspaceEntry(ws, path.join(ws, '.situation-board', 'stakeholder-locks'), true);
    await fileService.ensureDir(locks);
    const lockFile = await workspaceEntry(ws, path.join(locks, `${lockName(id)}.lock`), true);
    // A busy lock is not a newer version: its own code lets the dashboard keep the user's draft and try again.
    const held = await lock(lockFile, STAKEHOLDER_LOCK_WAIT_MS, () => Object.assign(
      new Error('This stakeholder is being saved elsewhere; try again in a moment.'),
      { statusCode: 409, details: { code: 'stakeholder_busy' } },
    ));
    try {
      return await operation();
    } finally {
      await unlock(held);
    }
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
