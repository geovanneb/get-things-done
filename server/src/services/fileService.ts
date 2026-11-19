import { atomicCreate, atomicWrite } from '../utils/atomicWrite';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { parseMarkdown, stringifyMarkdown } from '../utils/markdown';
import { WorkspaceService } from './workspace';
import { trashDir as workspaceTrash } from './trash';
import { workspaceEntry } from '../utils/files';

const workspaceService = new WorkspaceService();

export class FileService {
  async readMarkdown<T>(filePath: string): Promise<{ data: T; content: string }> {
    const raw = await fsp.readFile(filePath, 'utf-8');
    const parsed = parseMarkdown(raw);
    return { data: parsed.data as T, content: parsed.content.trim() };
  }

  /** `backup: false` when the caller already saved the previous version with `backup()` (for example before a move). */
  async writeMarkdown<T extends Record<string, unknown>>(
    filePath: string,
    frontmatter: T,
    content: string,
    options: { backup?: boolean } = {},
  ): Promise<void> {
    await this.ensureDir(path.dirname(filePath));
    if (options.backup !== false) await this.backupFile(filePath);

    // js-yaml cannot serialize undefined — strip those keys before dumping
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(frontmatter)) {
      if (v !== undefined) clean[k] = v;
    }

    const body = stringifyMarkdown(content, clean);
    await atomicWrite(filePath, body);
  }

  /**
   * Writes a new Markdown file and fails with EEXIST when the name is taken, so two writers can never share it. The
   * file appears only once it is complete (see atomicCreate), so a failed write never blocks the name.
   */
  async createMarkdown(filePath: string, frontmatter: Record<string, unknown>, content: string): Promise<void> {
    await this.ensureDir(path.dirname(filePath));
    const clean = Object.fromEntries(Object.entries(frontmatter).filter(([, v]) => v !== undefined));
    await atomicCreate(filePath, stringifyMarkdown(content, clean), await this.staging());
  }

  /**
   * Where a new file is written before it is published: `.situation-board/tmp`, checked like the trash, so owner
   * folders never hold (or lose) staging files. Null without a workspace (staged beside the file, never swept).
   */
  private async staging(): Promise<string | null> {
    let workspacePath: string;
    try { workspacePath = workspaceService.getWorkspacePath(); } catch { return null; }
    const dir = path.join(workspacePath, '.situation-board', 'tmp');
    await this.appFolderReady(workspacePath, dir);
    return dir;
  }

  async deleteFile(filePath: string): Promise<void> {
    if (!(await this.exists(filePath))) return;

    let trashDir: string;
    let workspacePath: string | null = null;
    try {
      workspacePath = workspaceService.getWorkspacePath();
      trashDir = workspaceTrash(workspacePath);
    } catch {
      trashDir = path.join(path.dirname(filePath), '.trash');
    }

    await this.appFolderReady(workspacePath, trashDir);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const basename = path.basename(filePath);
    const trashPath = path.join(trashDir, `${timestamp}-${crypto.randomUUID()}-${basename}`);
    await fsp.rename(filePath, trashPath);
  }

  async listFiles(dir: string, pattern: string): Promise<string[]> {
    if (!(await this.exists(dir))) return [];

    const results: string[] = [];
    await this.walkDir(dir, results, pattern);
    return results;
  }

  async readFile(filePath: string): Promise<string> {
    return fsp.readFile(filePath, 'utf-8');
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    await this.ensureDir(path.dirname(filePath));
    await atomicWrite(filePath, content);
  }

  async ensureDir(dir: string): Promise<void> {
    await fsp.mkdir(dir, { recursive: true });
  }

  async exists(filePath: string): Promise<boolean> {
    try {
      await fsp.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  async getFileStats(filePath: string): Promise<{ size: number; mtime: Date; hash: string }> {
    const stat = await fsp.stat(filePath);
    const content = await fsp.readFile(filePath);
    const hash = crypto.createHash('sha256').update(content).digest('hex');
    return { size: stat.size, mtime: stat.mtime, hash };
  }

  /**
   * Saves the current version of `filePath` to the trash, as every Markdown write does first. For a caller that must
   * know the backup worked before it changes anything else (it then writes with `backup: false`).
   */
  backup(filePath: string): Promise<void> {
    return this.backupFile(filePath);
  }

  private async backupFile(filePath: string): Promise<void> {
    if (!(await this.exists(filePath))) return;

    let trashDir: string;
    let workspacePath: string;
    try {
      workspacePath = workspaceService.getWorkspacePath();
      trashDir = workspaceTrash(workspacePath);
    } catch {
      return;
    }

    await this.appFolderReady(workspacePath, trashDir);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const basename = path.basename(filePath);
    const backupPath = path.join(trashDir, `${timestamp}-${crypto.randomUUID()}-${basename}`);
    await fsp.copyFile(filePath, backupPath, fsp.constants.COPYFILE_EXCL);
  }

  /**
   * Makes one of the app's folders (the trash, the staging folder), refusing (before and after making it) a
   * `.situation-board` or that folder when it is a link, so a deleted file, a previous version or a new file being
   * written never leaves the workspace. Without a workspace (`null`), the
   * fallback `.trash` beside the file is used as before.
   */
  private async appFolderReady(workspacePath: string | null, dir: string): Promise<void> {
    if (workspacePath) await workspaceEntry(workspacePath, dir, true);
    await fsp.mkdir(dir, { recursive: true });
    if (workspacePath) await workspaceEntry(workspacePath, dir);
  }

  private async walkDir(dir: string, results: string[], pattern: string): Promise<void> {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    const regex = this.globToRegex(pattern);

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await this.walkDir(fullPath, results, pattern);
      } else if (entry.isFile() && regex.test(entry.name)) {
        results.push(fullPath);
      }
    }
  }

  private globToRegex(pattern: string): RegExp {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
    return new RegExp(`^${escaped}$`);
  }
}
