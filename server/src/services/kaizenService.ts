import * as fsp from 'fs/promises';
import * as path from 'path';
import { WorkspaceService } from './workspace';

const workspaceService = new WorkspaceService();

export interface KaizenProposal {
  id: string;
  title: string;
  status: 'proposed' | 'applied' | 'rejected';
  area: string;
  root_cause: string;
  proposed_fix: string;
  files_affected: string[];
  created_at: string;
  applied_at: string | null;
  body: string;
}

function parseFrontmatter(raw: string): { meta: Record<string, unknown>; body: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: raw };

  const meta: Record<string, unknown> = {};
  const lines = match[1].split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const kv = line.match(/^(\w+):\s*(.*)/);
    if (!kv) { i++; continue; }
    const key = kv[1];
    const val = kv[2].trim();

    if (val === '|') {
      // Block scalar — collect indented lines
      const block: string[] = [];
      i++;
      while (i < lines.length && (lines[i].startsWith('  ') || lines[i] === '')) {
        block.push(lines[i].replace(/^  /, ''));
        i++;
      }
      meta[key] = block.join('\n').trim();
      continue;
    }

    if (val === '') {
      meta[key] = null;
    } else if (val.startsWith("'") && val.endsWith("'")) {
      meta[key] = val.slice(1, -1);
    } else if (val === 'true') {
      meta[key] = true;
    } else if (val === 'false') {
      meta[key] = false;
    } else if (val === 'null') {
      meta[key] = null;
    } else if (!isNaN(Number(val))) {
      meta[key] = Number(val);
    } else {
      meta[key] = val;
    }
    i++;
  }

  // Parse list fields (files_affected)
  const listMeta: Record<string, unknown> = {};
  let inList = false;
  let listKey = '';
  const listLines = match[1].split('\n');
  for (const line of listLines) {
    const listHeader = line.match(/^(\w+):\s*$/);
    if (listHeader) { inList = true; listKey = listHeader[1]; listMeta[listKey] = []; continue; }
    if (inList && line.match(/^  - /)) {
      (listMeta[listKey] as string[]).push(line.replace(/^  - /, '').trim());
    } else if (inList && !line.startsWith('  ')) {
      inList = false;
    }
  }
  Object.assign(meta, listMeta);

  return { meta, body: match[2].trim() };
}

function serializeFrontmatter(proposal: KaizenProposal, body: string): string {
  const filesYaml = proposal.files_affected.length
    ? `files_affected:\n${proposal.files_affected.map((f) => `  - ${f}`).join('\n')}`
    : 'files_affected: []';

  return `---
schema_version: '1.0'
id: ${proposal.id}
type: kaizen
title: ${proposal.title}
status: ${proposal.status}
area: ${proposal.area}
root_cause: |
${proposal.root_cause.split('\n').map((l) => `  ${l}`).join('\n')}
proposed_fix: |
${proposal.proposed_fix.split('\n').map((l) => `  ${l}`).join('\n')}
${filesYaml}
created_at: '${proposal.created_at}'
applied_at: ${proposal.applied_at ? `'${proposal.applied_at}'` : 'null'}
---

${body}
`;
}

export class KaizenService {
  private kaizenDir(): string {
    return path.join(workspaceService.getWorkspacePath(), 'kaizen');
  }

  async listKaizen(): Promise<KaizenProposal[]> {
    const dir = this.kaizenDir();
    let entries: string[] = [];
    try {
      const dirEntries = await fsp.readdir(dir);
      entries = dirEntries.filter((f) => f.endsWith('.md')).sort().reverse();
    } catch {
      return [];
    }

    const proposals: KaizenProposal[] = [];
    for (const filename of entries) {
      const p = await this.readKaizenFile(path.join(dir, filename));
      if (p) proposals.push(p);
    }
    return proposals;
  }

  async getKaizen(id: string): Promise<KaizenProposal | null> {
    const file = path.join(this.kaizenDir(), `${id}.md`);
    return this.readKaizenFile(file);
  }

  async updateKaizen(id: string, patch: Partial<Pick<KaizenProposal, 'status' | 'applied_at'>>): Promise<KaizenProposal | null> {
    const file = path.join(this.kaizenDir(), `${id}.md`);
    const proposal = await this.readKaizenFile(file);
    if (!proposal) return null;

    const updated = { ...proposal, ...patch };
    const raw = await fsp.readFile(file, 'utf-8');
    const { body } = parseFrontmatter(raw);
    await fsp.writeFile(file, serializeFrontmatter(updated, body), 'utf-8');
    return updated;
  }

  private async readKaizenFile(file: string): Promise<KaizenProposal | null> {
    try {
      const raw = await fsp.readFile(file, 'utf-8');
      const { meta, body } = parseFrontmatter(raw);
      return {
        id: String(meta['id'] ?? ''),
        title: String(meta['title'] ?? ''),
        status: (meta['status'] as KaizenProposal['status']) ?? 'proposed',
        area: String(meta['area'] ?? ''),
        root_cause: String(meta['root_cause'] ?? ''),
        proposed_fix: String(meta['proposed_fix'] ?? ''),
        files_affected: Array.isArray(meta['files_affected']) ? (meta['files_affected'] as string[]) : [],
        created_at: String(meta['created_at'] ?? ''),
        applied_at: meta['applied_at'] ? String(meta['applied_at']) : null,
        body,
      };
    } catch {
      return null;
    }
  }
}
