import { topLevelName } from '../utils/files';
import * as path from 'path';
import * as fsp from 'fs/promises';
import { parseMarkdown } from '../utils/markdown';
import { ClaudeAgent, Skill, AgentScope, MarketplaceSkill } from '../types';
import { FileService } from './fileService';
import { WorkspaceService } from './workspace';

const GITHUB_ORG = 'anthropics';
const GITHUB_REPO = 'skills';
const SKILLS_PATH = 'skills';
const CACHE_TTL_MS = 5 * 60 * 1000;

const fileService = new FileService();
const workspaceService = new WorkspaceService();

export class AgentService {
  private marketplaceCache: { skills: MarketplaceSkill[]; timestamp: number } | null = null;

  private getAgentsDir(): string {
    return path.join(workspaceService.getWorkspacePath(), '.claude', 'agents');
  }

  private getSkillsDir(): string {
    return path.join(workspaceService.getWorkspacePath(), '.claude', 'skills');
  }

  async listAgents(): Promise<ClaudeAgent[]> {
    const agentsDir = this.getAgentsDir();
    await fileService.ensureDir(agentsDir);

    const files = await fileService.listFiles(agentsDir, '*.md');
    const agents: ClaudeAgent[] = [];

    for (const filePath of files) {
      try {
        const agent = await this.parseAgentFile(filePath);
        agents.push(agent);
      } catch {
        // Skip malformed files
      }
    }

    return agents.sort((a, b) => a.name.localeCompare(b.name));
  }

  async getAgent(name: string): Promise<ClaudeAgent> {
    const agentsDir = this.getAgentsDir();
    const filePath = path.join(agentsDir, `${topLevelName(name)}.md`);

    if (!(await fileService.exists(filePath))) {
      // Try case-insensitive search
      const files = await fileService.listFiles(agentsDir, '*.md');
      const found = files.find((f) => path.basename(f, '.md').toLowerCase() === name.toLowerCase());
      if (!found) throw new Error(`Agent not found: ${name}`);
      return this.parseAgentFile(found);
    }

    return this.parseAgentFile(filePath);
  }

  async listSkills(): Promise<Skill[]> {
    const skillsDir = this.getSkillsDir();
    await fileService.ensureDir(skillsDir);

    const skills: Skill[] = [];

    // Check if skills are in subdirectories with SKILL.md or *.md
    const entries = await fsp.readdir(skillsDir, { withFileTypes: true }).catch(() => []);

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const skillDir = path.join(skillsDir, entry.name);
        const skillMainFile =
          (await fileService.exists(path.join(skillDir, 'SKILL.md')))
            ? path.join(skillDir, 'SKILL.md')
            : (await fileService.listFiles(skillDir, '*.md'))[0];

        if (skillMainFile) {
          try {
            const skill = await this.parseSkillFile(skillMainFile, entry.name, skillDir);
            skills.push(skill);
          } catch {
            // Skip malformed skills
          }
        }
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        try {
          const filePath = path.join(skillsDir, entry.name);
          const skill = await this.parseSkillFile(filePath, path.basename(entry.name, '.md'), skillsDir);
          skills.push(skill);
        } catch {
          // Skip malformed files
        }
      }
    }

    return skills.sort((a, b) => a.name.localeCompare(b.name));
  }

  async getSkill(name: string): Promise<Skill> {
    const skillsDir = this.getSkillsDir();
    const skillDir = path.join(skillsDir, topLevelName(name));

    if (await fileService.exists(skillDir)) {
      const mainFile = (await fileService.exists(path.join(skillDir, 'SKILL.md')))
        ? path.join(skillDir, 'SKILL.md')
        : (await fileService.listFiles(skillDir, '*.md'))[0];

      if (mainFile) return this.parseSkillFile(mainFile, name, skillDir);
    }

    // Try as direct file
    const filePath = path.join(skillsDir, `${topLevelName(name)}.md`);
    if (await fileService.exists(filePath)) {
      return this.parseSkillFile(filePath, name, skillsDir);
    }

    throw new Error(`Skill not found: ${name}`);
  }

  async listMarketplaceSkills(): Promise<MarketplaceSkill[]> {
    const installed = await this.listSkills();
    const installedNames = new Set(installed.map((s) => s.name.toLowerCase()));

    if (this.marketplaceCache && Date.now() - this.marketplaceCache.timestamp < CACHE_TTL_MS) {
      return this.marketplaceCache.skills.map((s) => ({
        ...s,
        installed: installedNames.has(s.slug.toLowerCase()) || installedNames.has(s.name.toLowerCase()),
      }));
    }

    const ghHeaders: Record<string, string> = { 'User-Agent': 'GTD-Executive-Workspace' };
    const listUrl = `https://api.github.com/repos/${GITHUB_ORG}/${GITHUB_REPO}/contents/${SKILLS_PATH}`;
    const listRes = await fetch(listUrl, { headers: ghHeaders });
    if (!listRes.ok) throw new Error(`GitHub API error: ${listRes.status}`);
    const dirs = (await listRes.json()) as Array<{ name: string; type: string }>;
    const skillDirs = dirs.filter((d) => d.type === 'dir');

    const skills = await Promise.all(
      skillDirs.map(async (dir): Promise<MarketplaceSkill | null> => {
        try {
          const rawUrl = `https://raw.githubusercontent.com/${GITHUB_ORG}/${GITHUB_REPO}/main/${SKILLS_PATH}/${dir.name}/SKILL.md`;
          const mdRes = await fetch(rawUrl, { headers: ghHeaders });
          if (!mdRes.ok) return null;
          const raw = await mdRes.text();
          const parsed = parseMarkdown(raw);
          return {
            slug: dir.name,
            name: (parsed.data['name'] as string) || dir.name,
            description: (parsed.data['description'] as string) || '',
            license: parsed.data['license'] as string | undefined,
            installed: false,
          };
        } catch {
          return null;
        }
      }),
    );

    const valid = skills.filter((s): s is MarketplaceSkill => s !== null);
    this.marketplaceCache = { skills: valid, timestamp: Date.now() };

    return valid.map((s) => ({
      ...s,
      installed: installedNames.has(s.slug.toLowerCase()) || installedNames.has(s.name.toLowerCase()),
    }));
  }

  async installSkill(slug: string): Promise<void> {
    const safeSlug = topLevelName(slug);
    const ghHeaders: Record<string, string> = { 'User-Agent': 'GTD-Executive-Workspace' };
    const contentsUrl = `https://api.github.com/repos/${GITHUB_ORG}/${GITHUB_REPO}/contents/${SKILLS_PATH}/${encodeURIComponent(safeSlug)}`;
    const contentsRes = await fetch(contentsUrl, { headers: ghHeaders });
    if (!contentsRes.ok) throw new Error(`Skill not found in marketplace: ${slug}`);
    const contents = (await contentsRes.json()) as Array<{
      name: string;
      type: string;
      download_url: string | null;
    }>;

    const targetDir = path.join(this.getSkillsDir(), safeSlug);
    await fsp.mkdir(targetDir, { recursive: true });

    for (const file of contents) {
      if (file.type === 'file' && file.name.endsWith('.md') && file.download_url) {
        const fileRes = await fetch(file.download_url, { headers: ghHeaders });
        if (!fileRes.ok) continue;
        const content = await fileRes.text();
        await fsp.writeFile(path.join(targetDir, topLevelName(file.name)), content, 'utf-8');
      }
    }

    this.marketplaceCache = null;
  }

  async deleteSkill(name: string): Promise<void> {
    const skillsDir = this.getSkillsDir();
    const skillDir = path.join(skillsDir, topLevelName(name));

    if (await fileService.exists(skillDir)) {
      await fsp.rm(skillDir, { recursive: true, force: true });
      this.marketplaceCache = null;
      return;
    }

    const filePath = path.join(skillsDir, `${topLevelName(name)}.md`);
    if (await fileService.exists(filePath)) {
      await fsp.unlink(filePath);
      this.marketplaceCache = null;
      return;
    }

    throw new Error(`Skill not found: ${name}`);
  }

  private async parseAgentFile(filePath: string): Promise<ClaudeAgent> {
    const raw = await fileService.readFile(filePath);
    const parsed = parseMarkdown(raw);
    const fm = parsed.data;
    const stat = await fsp.stat(filePath);

    return {
      name: fm['name'] || path.basename(filePath, '.md'),
      description: fm['description'] || parsed.content.split('\n').find((l: string) => l.trim())?.trim(),
      scope: (fm['scope'] as AgentScope) || 'workspace',
      model: fm['model'],
      tools: fm['tools'] ? (Array.isArray(fm['tools']) ? fm['tools'] : [fm['tools']]) : undefined,
      allowed_tools: fm['allowed_tools'] ? (Array.isArray(fm['allowed_tools']) ? fm['allowed_tools'] : [fm['allowed_tools']]) : undefined,
      disallowed_tools: fm['disallowed_tools'] ? (Array.isArray(fm['disallowed_tools']) ? fm['disallowed_tools'] : [fm['disallowed_tools']]) : undefined,
      last_modified: stat.mtime.toISOString(),
      validation_state: 'valid',
      raw_content: raw,
      path: filePath,
    };
  }

  private async parseSkillFile(filePath: string, name: string, dir: string): Promise<Skill> {
    const raw = await fileService.readFile(filePath);
    const parsed = parseMarkdown(raw);
    const fm = parsed.data;
    const stat = await fsp.stat(filePath);

    const files = await fileService.listFiles(dir, '*.md');

    return {
      name: fm['name'] || name,
      scope: (fm['scope'] as AgentScope) || 'workspace',
      version: fm['version'],
      description: fm['description'] || parsed.content.split('\n').find((l: string) => l.trim())?.trim(),
      file_count: files.length,
      validation_state: 'valid',
      raw_content: raw,
      path: filePath,
    };
  }
}
