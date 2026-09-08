import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import matter from 'gray-matter';
import { WorkspaceService } from './workspace';

const workspaceService = new WorkspaceService();

export class FileService {
  async readMarkdown<T>(filePath: string): Promise<{ data: T; content: string }> {
    const raw = await fsp.readFile(filePath, 'utf-8');
    const parsed = matter(raw);
    return { data: parsed.data as T, content: parsed.content.trim() };
  }

  async writeMarkdown<T extends Record<string, unknown>>(
    filePath: string,
    frontmatter: T,
    content: string
  ): Promise<void> {
    await this.ensureDir(path.dirname(filePath));
    await this.backupFile(filePath);

    // js-yaml cannot serialize undefined — strip those keys before dumping
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(frontmatter)) {
      if (v !== undefined) clean[k] = v;
    }

    const body = matter.stringify(content, clean);
    await this.atomicWrite(filePath, body);
  }

  async deleteFile(filePath: string): Promise<void> {
    if (!(await this.exists(filePath))) return;

    let trashDir: string;
    try {
      const workspacePath = workspaceService.getWorkspacePath();
      trashDir = path.join(workspacePath, '.situation-board', 'trash');
    } catch {
      trashDir = path.join(path.dirname(filePath), '.trash');
    }

    await fsp.mkdir(trashDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const basename = path.basename(filePath);
    const trashPath = path.join(trashDir, `${timestamp}-${basename}`);
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
    await this.atomicWrite(filePath, content);
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

  private async atomicWrite(filePath: string, content: string): Promise<void> {
    const tmpPath = `${filePath}.tmp`;
    await fsp.writeFile(tmpPath, content, 'utf-8');
    await fsp.rename(tmpPath, filePath);
  }

  private async backupFile(filePath: string): Promise<void> {
    if (!(await this.exists(filePath))) return;

    let trashDir: string;
    try {
      const workspacePath = workspaceService.getWorkspacePath();
      trashDir = path.join(workspacePath, '.situation-board', 'trash');
    } catch {
      return;
    }

    await fsp.mkdir(trashDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const basename = path.basename(filePath);
    const backupPath = path.join(trashDir, `${timestamp}-${basename}`);
    await fsp.copyFile(filePath, backupPath);
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
