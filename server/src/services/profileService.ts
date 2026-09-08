import * as path from 'path';
import { Profile } from '../types';
import { FileService } from './fileService';
import { WorkspaceService } from './workspace';

const fileService = new FileService();
const workspaceService = new WorkspaceService();

const SECTION_LABELS: Record<string, keyof Profile> = {
  'Responsibilities':       'responsibilities',
  'Communication Style':    'communication_style',
  'Decision Making':        'decision_making',
  'Language Preferences':   'language_preferences',
  'Recurring Expectations': 'recurring_expectations',
  'Principles':             'principles',
};

const SECTION_ORDER: Array<{ label: string; key: keyof Profile }> = [
  { label: 'Responsibilities',       key: 'responsibilities' },
  { label: 'Communication Style',    key: 'communication_style' },
  { label: 'Decision Making',        key: 'decision_making' },
  { label: 'Language Preferences',   key: 'language_preferences' },
  { label: 'Recurring Expectations', key: 'recurring_expectations' },
  { label: 'Principles',             key: 'principles' },
];

function parseSections(body: string): Partial<Profile> {
  const result: Partial<Profile> = {};
  const lines = body.split('\n');
  let currentKey: keyof Profile | null = null;
  let currentLines: string[] = [];

  const flush = () => {
    if (currentKey) {
      result[currentKey] = currentLines.join('\n').trim() as never;
    }
  };

  for (const line of lines) {
    const match = line.match(/^## (.+)$/);
    if (match) {
      flush();
      const heading = match[1].trim();
      currentKey = SECTION_LABELS[heading] ?? null;
      currentLines = [];
    } else if (currentKey) {
      currentLines.push(line);
    }
  }
  flush();

  return result;
}

function buildBody(profile: Profile): string {
  return SECTION_ORDER
    .filter(({ key }) => profile[key])
    .map(({ label, key }) => `## ${label}\n\n${profile[key]}`)
    .join('\n\n');
}

export class ProfileService {
  private getProfilePath(): string {
    return path.join(workspaceService.getWorkspacePath(), 'profile', 'executive-profile.md');
  }

  async getProfile(): Promise<Profile> {
    const filePath = this.getProfilePath();

    if (!(await fileService.exists(filePath))) {
      return {
        name: 'Executive',
        updated_at: new Date().toISOString(),
      } as Profile;
    }

    const { data, content } = await fileService.readMarkdown<Profile>(filePath);
    const sections = parseSections(content);

    return {
      ...sections,
      name: data.name || 'Executive',
      role: data.role,
      organization: data.organization,
      updated_at: data.updated_at || new Date().toISOString(),
    } as Profile;
  }

  async updateProfile(data: Partial<Profile>): Promise<Profile> {
    const existing = await this.getProfile();
    const filePath = this.getProfilePath();

    const updated: Profile = {
      ...existing,
      ...data,
      updated_at: new Date().toISOString(),
    };

    const frontmatter: Record<string, unknown> = {
      schema_version: '1.0',
      type: 'profile',
      name: updated.name,
      role: updated.role,
      organization: updated.organization,
      updated_at: updated.updated_at,
    };

    const body = buildBody(updated);
    await fileService.writeMarkdown(filePath, frontmatter, body);
    return updated;
  }
}
