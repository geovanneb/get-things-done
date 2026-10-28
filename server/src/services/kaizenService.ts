import { topLevelName } from '../utils/files';
import { parseMarkdown, stringifyMarkdown } from '../utils/markdown';
import { atomicWrite } from '../utils/atomicWrite';
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
  rejected_at: string | null;
  body: string;
}

function parseFrontmatter(raw: string, source?: string): { meta: Record<string, unknown>; body: string } {
  let match: RegExpMatchArray | null = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);

  // A file with an opening fence but no closing one would otherwise fail the match
  // outright and render as a blank card. Parse what is there and say which file needs
  // fixing, so a missing "---" degrades instead of disappearing.
  if (!match && raw.startsWith('---\n')) {
    console.warn(`[kaizen] ${source ?? 'file'}: frontmatter has no closing "---". Parsing what is there; add the closing fence.`);
    match = [raw, raw.slice(4), ''] as unknown as RegExpMatchArray;
  }

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
        block.push(lines[i].replace(/^ {2}/, ''));
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
    if (inList && line.match(/^ {2}- /)) {
      (listMeta[listKey] as string[]).push(line.replace(/^ {2}- /, '').trim());
    } else if (inList && !line.startsWith('  ')) {
      inList = false;
    }
  }
  Object.assign(meta, listMeta);

  return { meta, body: match[2].trim() };
}

export class KaizenService {
  private kaizenDir(): string {
    return path.join(workspaceService.getWorkspacePath(), 'kaizen');
  }

  async listKaizen(): Promise<KaizenProposal[]> {
    return (await this.listKaizenFiles()).map((f) => f.proposal);
  }

  /** Every readable proposal with its file name, which the frontmatter id does not always match. */
  async listKaizenFiles(): Promise<{ filename: string; proposal: KaizenProposal }[]> {
    const dir = this.kaizenDir();
    let entries: string[];
    try {
      const dirEntries = await fsp.readdir(dir);
      entries = dirEntries.filter((f) => f.endsWith('.md')).sort().reverse();
    } catch {
      return [];
    }

    const out: { filename: string; proposal: KaizenProposal }[] = [];
    for (const filename of entries) {
      const p = await this.readKaizenFile(path.join(dir, filename));
      if (p) out.push({ filename, proposal: p });
    }
    return out;
  }

  async getKaizen(id: string): Promise<KaizenProposal | null> {
    const file = path.join(this.kaizenDir(), `${topLevelName(id)}.md`);
    return this.readKaizenFile(file);
  }

  async updateKaizen(id: string, patch: Partial<Pick<KaizenProposal, 'status' | 'applied_at'>>): Promise<KaizenProposal | null> {
    const file = path.join(this.kaizenDir(), `${topLevelName(id)}.md`);
    const proposal = await this.readKaizenFile(file);
    if (!proposal) return null;

    if (patch.status !== undefined && !['proposed', 'applied', 'rejected'].includes(patch.status)) {
      throw Object.assign(new Error('Invalid kaizen status'), { statusCode: 400 });
    }
    if (patch.applied_at !== undefined && patch.applied_at !== null
      && (typeof patch.applied_at !== 'string' || !Number.isFinite(Date.parse(patch.applied_at)))) {
      throw Object.assign(new Error('Invalid applied_at'), { statusCode: 400 });
    }
    const updated = { ...proposal, ...patch,
      ...(patch.status === 'rejected' && proposal.status !== 'rejected' ? { rejected_at: new Date().toISOString() } : {}),
    };
    const raw = await fsp.readFile(file, 'utf-8');
    const { data, content } = parseMarkdown(raw);
    await atomicWrite(file, stringifyMarkdown(content, { ...data, ...patch, rejected_at: updated.rejected_at }));
    return updated;
  }

  private async readKaizenFile(file: string): Promise<KaizenProposal | null> {
    try {
      const raw = await fsp.readFile(file, 'utf-8');
      const { meta, body } = parseFrontmatter(raw, path.basename(file));
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
        rejected_at: meta['rejected_at'] ? String(meta['rejected_at']) : null,
        body,
      };
    } catch {
      return null;
    }
  }
}
