import * as path from 'path';
import * as fsp from 'fs/promises';
import { WorkspaceService } from './workspace';
import { parseMarkdown, stringifyMarkdown } from '../utils/markdown';
import { atomicWrite } from '../utils/atomicWrite';
import { fileInside, listFolderFiles, saveAttachment, topLevelName, FolderFile } from '../utils/files';

const workspaceService = new WorkspaceService();

// Shared across service instances. Serializes this server's read-modify-write operations,
// including filename reservation; external agents/processes still need coordination.
const pendingUpdates = new Map<string, Promise<void>>();

/**
 * Context updates: raw material (transcripts, slides, images, spreadsheets) that may change the context.
 *
 *   context-updates/CU-YYYY-NNNN/
 *     update.md        record: frontmatter (status, proposals, decisions) + the user's notes as the body
 *     materials/       uploaded files, deleted when the update is done
 *     proposals/P-NN.md  the full proposed content of one target file, deleted when done
 *
 * The folder sits outside context/ on purpose: agents scan context/ for every task and must never
 * treat a raw transcript as distilled context.
 *
 * Status flow: ready -> analyzing -> in_review -> approved -> applying -> done.
 * The agent commands (/gtd-context-analyze, /gtd-context-apply) move analyzing/in_review and applying/done;
 * the dashboard moves everything else.
 */

export const UPDATE_STATUSES = ['ready', 'analyzing', 'in_review', 'approved', 'applying', 'done'] as const;
export type UpdateStatus = (typeof UPDATE_STATUSES)[number];

const CONTEXT_CATEGORIES = ['company', 'organization', 'strategy', 'programs', 'decisions', 'risks', 'glossary', 'situation'];
const STAKEHOLDER_FOLDERS = ['people', 'groups', 'org-charts'];

const ID_PATTERN = /^CU-\d{4}-\d{4}$/;
const PROPOSAL_ID_PATTERN = /^P-\d{2,3}$/;
const MAX_PROPOSALS = 50;
const MAX_NOTE = 2000;
const MAX_TEXT = 200_000;
/** Larger files are not shown as a diff; the dashboard offers to open them instead. */
const MAX_DIFF_BYTES = 512 * 1024;

export interface UpdateMaterial { name: string; size: number; type: string }

export interface UpdateProposal {
  id: string;
  action: 'create' | 'update';
  target: string;
  title: string;
  category: string;
  rationale: string;
  evidence: string;
  confidence: 'high' | 'medium' | 'low' | '';
  decision: 'accepted' | 'rejected' | null;
  reviewer_note: string;
  outcome: string;
  outcome_note: string;
}

export interface ContextUpdate {
  id: string;
  title: string;
  status: UpdateStatus;
  source_date: string;
  created_at: string;
  updated_at: string;
  analyzed_at: string | null;
  approved_at: string | null;
  applied_at: string | null;
  summary: string;
  notes: string;
  materials: UpdateMaterial[];
  proposals: UpdateProposal[];
  skipped: { topic: string; reason: string }[];
  unread: { name: string; reason: string }[];
}

export interface ProposalDetail extends UpdateProposal {
  /** Current content of the target, or null when it does not exist. */
  current: string | null;
  /** Content the agent proposes, or null when the draft is missing or too large. */
  proposed: string | null;
  target_exists: boolean;
  /** The target changed (or was created) after the analysis, so the diff is against newer content. */
  stale: boolean;
  /** Why this proposal cannot be shown or applied (bad target path, missing draft). */
  problem: string | null;
}

export interface ContextUpdateDetail extends ContextUpdate {
  proposals: ProposalDetail[];
  material_files: FolderFile[];
}

function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode: status });
}

/** YAML turns unquoted dates into Date objects; everything shown in the dashboard is a string. */
function str(value: unknown, dateOnly = false): string {
  if (value instanceof Date) return dateOnly ? value.toISOString().slice(0, 10) : value.toISOString();
  if (value === null || value === undefined) return '';
  return String(value);
}

function nullableStr(value: unknown): string | null {
  const s = str(value);
  return s ? s : null;
}

function isDateOnly(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** An update id from a request. Strict, because it becomes a folder name. */
export function updateId(value: unknown): string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) throw httpError(400, 'Invalid context update id');
  return topLevelName(value);
}

/**
 * A proposal target from the agent's frontmatter, as a workspace-relative POSIX path. Only Markdown files
 * under context/<category>/ and stakeholders/{people,groups,org-charts}/ can be proposed.
 * Returns null when the path is outside those folders or is not a plain relative path.
 */
export function proposalTarget(value: unknown): string | null {
  if (typeof value !== 'string' || !value || value.length > 300) return null;
  if (value.includes('\\') || value.includes('\0') || value.startsWith('/') || !value.endsWith('.md')) return null;
  const parts = value.split('/');
  if (parts.some((p) => !p || p === '.' || p === '..' || p.startsWith('.') || p.includes(':'))) return null;
  if (parts[0] === 'context') return parts.length >= 3 && CONTEXT_CATEGORIES.includes(parts[1]!) ? value : null;
  if (parts[0] === 'stakeholders') return parts.length >= 3 && STAKEHOLDER_FOLDERS.includes(parts[1]!) ? value : null;
  return null;
}

function normalizeProposal(raw: unknown, index: number): UpdateProposal {
  const p = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const decision = p['decision'] === 'accepted' || p['decision'] === 'rejected' ? p['decision'] : null;
  const confidence = ['high', 'medium', 'low'].includes(str(p['confidence'])) ? str(p['confidence']) as UpdateProposal['confidence'] : '';
  return {
    id: str(p['id']) || `P-${String(index + 1).padStart(2, '0')}`,
    action: p['action'] === 'create' ? 'create' : 'update',
    target: str(p['target']),
    title: str(p['title']),
    category: str(p['category']),
    rationale: str(p['rationale']),
    evidence: str(p['evidence']),
    confidence,
    decision,
    reviewer_note: str(p['reviewer_note']),
    outcome: str(p['outcome']),
    outcome_note: str(p['outcome_note']),
  };
}

function normalizePairs<K extends string, V extends string>(raw: unknown, k: K, v: V): Record<K | V, string>[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    const o = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    return { [k]: str(o[k]), [v]: str(o[v]) } as Record<K | V, string>;
  });
}

function normalize(data: Record<string, unknown>, body: string, folderId: string): ContextUpdate {
  const status = UPDATE_STATUSES.includes(data['status'] as UpdateStatus) ? data['status'] as UpdateStatus : 'ready';
  const materials = Array.isArray(data['materials'])
    ? (data['materials'] as unknown[]).map((m) => {
      const o = (m && typeof m === 'object' ? m : {}) as Record<string, unknown>;
      return { name: str(o['name']), size: Number(o['size']) || 0, type: str(o['type']) };
    })
    : [];
  return {
    // The folder name is the id: a file edited to say otherwise must not point the dashboard elsewhere.
    id: folderId,
    title: str(data['title']) || folderId,
    status,
    source_date: str(data['source_date'], true),
    created_at: str(data['created_at']),
    updated_at: str(data['updated_at']),
    analyzed_at: nullableStr(data['analyzed_at']),
    approved_at: nullableStr(data['approved_at']),
    applied_at: nullableStr(data['applied_at']),
    summary: str(data['summary']),
    notes: body,
    materials,
    proposals: Array.isArray(data['proposals']) ? (data['proposals'] as unknown[]).slice(0, MAX_PROPOSALS).map(normalizeProposal) : [],
    skipped: normalizePairs(data['skipped'], 'topic', 'reason'),
    unread: normalizePairs(data['unread'], 'name', 'reason'),
  };
}

/** Sanitizes a name the way saveAttachment does, then adds -2, -3... so a second "notes.txt" never replaces the first. */
async function uniqueName(dir: string, originalName: string): Promise<string> {
  const safe = path.basename(originalName).replace(/[^\w.\-]/g, '_') || 'file';
  const ext = path.extname(safe);
  const stem = safe.slice(0, safe.length - ext.length) || 'file';
  for (let n = 1; n < 1000; n++) {
    const candidate = n === 1 ? `${stem}${ext}` : `${stem}-${n}${ext}`;
    const taken = await fsp.lstat(path.join(dir, candidate)).then(() => true, () => false);
    if (!taken) return candidate;
  }
  throw httpError(409, 'Too many files with the same name');
}

export class ContextUpdateService {
  rootDir(): string {
    return path.join(workspaceService.getWorkspacePath(), 'context-updates');
  }

  private updateDir(id: string): string {
    return path.join(this.rootDir(), updateId(id));
  }

  private async serialized<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const key = this.updateDir(id);
    const previous = pendingUpdates.get(key) ?? Promise.resolve();
    const result = previous.then(operation);
    // A failed request must not prevent the next request from running.
    const settled = result.then(() => {}, () => {});
    pendingUpdates.set(key, settled);
    try {
      return await result;
    } finally {
      if (pendingUpdates.get(key) === settled) pendingUpdates.delete(key);
    }
  }

  private async read(id: string): Promise<{ update: ContextUpdate; data: Record<string, unknown>; file: string }> {
    const dir = this.updateDir(id);
    const file = path.join(dir, 'update.md');
    let raw: string;
    try {
      raw = await fsp.readFile(await fileInside(dir, 'update.md'), 'utf-8');
    } catch (err) {
      if ((err as Error).message?.includes('traversal')) throw err;
      throw httpError(404, `Context update not found: ${id}`);
    }
    const parsed = parseMarkdown(raw);
    const data = (parsed.data ?? {}) as Record<string, unknown>;
    return { update: normalize(data, parsed.content.trim(), path.basename(dir)), data, file };
  }

  /** Writes back the agent's frontmatter with only the given fields changed, so fields this service does not know survive. */
  private async write(file: string, data: Record<string, unknown>, body: string, patch: Record<string, unknown>): Promise<void> {
    const next: Record<string, unknown> = { ...data, ...patch, updated_at: new Date().toISOString() };
    for (const [k, v] of Object.entries(next)) if (v === undefined) delete next[k];
    await atomicWrite(file, stringifyMarkdown(body, next));
  }

  private requireStatus(update: ContextUpdate, allowed: UpdateStatus[], action: string): void {
    if (!allowed.includes(update.status)) {
      throw httpError(409, `Cannot ${action} while the update is "${update.status}"`);
    }
  }

  async list(): Promise<ContextUpdate[]> {
    const entries = await fsp.readdir(this.rootDir(), { withFileTypes: true }).catch(() => []);
    const updates: ContextUpdate[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !ID_PATTERN.test(entry.name)) continue;
      try {
        updates.push((await this.read(entry.name)).update);
      } catch {
        // A folder without a readable update.md is not an update.
      }
    }
    return updates.sort((a, b) => b.id.localeCompare(a.id));
  }

  async get(id: string): Promise<ContextUpdateDetail> {
    return this.serialized(id, async () => {
      const { update } = await this.read(id);
      const dir = this.updateDir(id);
      // The apply command deletes these itself, but an agent may lack permission to remove folders.
      // A done update never needs them again, so the dashboard finishes the cleanup.
      if (update.status === 'done') await this.cleanup(id);
      const proposals = await Promise.all(update.proposals.map((p) => this.proposalDetail(dir, update, p)));
      const material_files = await listFolderFiles(path.join(dir, 'materials'));
      return { ...update, proposals, material_files };
    });
  }

  private async proposalDetail(dir: string, update: ContextUpdate, p: UpdateProposal): Promise<ProposalDetail> {
    const detail: ProposalDetail = { ...p, current: null, proposed: null, target_exists: false, stale: false, problem: null };
    const target = proposalTarget(p.target);
    if (!target) return { ...detail, problem: 'The target is not a context note or stakeholder file, so it cannot be applied.' };
    if (!PROPOSAL_ID_PATTERN.test(p.id)) return { ...detail, problem: 'The proposal id is not valid (expected P-01, P-02...).' };

    const ws = workspaceService.getWorkspacePath();
    try {
      const full = await fileInside(ws, target);
      const stat = await fsp.stat(full);
      detail.target_exists = true;
      detail.current = stat.size <= MAX_DIFF_BYTES ? await fsp.readFile(full, 'utf-8') : null;
      const analyzed = update.analyzed_at ? Date.parse(update.analyzed_at) : NaN;
      // A create whose file now exists, or an update whose file was edited after the analysis.
      detail.stale = p.action === 'create' || (!Number.isNaN(analyzed) && stat.mtimeMs > analyzed + 1000);
    } catch (err) {
      if ((err as Error).message?.includes('traversal')) return { ...detail, problem: 'The target points outside the workspace.' };
      if (p.action === 'update') detail.stale = true; // the file was removed since the analysis
    }

    // The draft only exists until the update is done; afterwards the record keeps the decision, not the text.
    if (update.status !== 'done') {
      try {
        const draft = await fileInside(path.join(dir, 'proposals'), `${p.id}.md`);
        const stat = await fsp.stat(draft);
        if (stat.size <= MAX_DIFF_BYTES) detail.proposed = await fsp.readFile(draft, 'utf-8');
        else detail.problem = 'The proposed content is too large to show here. Open the file in the workspace folder.';
      } catch {
        detail.problem = `The proposed content is missing (proposals/${p.id}.md).`;
      }
    }
    // Once applying starts the targets change on purpose; "stale" only matters while reviewing.
    if (!['in_review', 'approved'].includes(update.status)) detail.stale = false;
    return detail;
  }

  private async nextId(): Promise<string> {
    const year = new Date().getFullYear();
    const prefix = `CU-${year}-`;
    const entries = await fsp.readdir(this.rootDir()).catch(() => [] as string[]);
    let max = 0;
    for (const e of entries) {
      if (!e.startsWith(prefix)) continue;
      const n = parseInt(e.slice(prefix.length), 10);
      if (!Number.isNaN(n) && n > max) max = n;
    }
    return `${prefix}${String(max + 1).padStart(4, '0')}`;
  }

  async create(input: { title?: unknown; source_date?: unknown; notes?: unknown; text?: unknown }): Promise<ContextUpdate> {
    const title = typeof input.title === 'string' ? input.title.trim().slice(0, 200) : '';
    const sourceDate = typeof input.source_date === 'string' && input.source_date ? input.source_date : new Date().toISOString().slice(0, 10);
    if (!isDateOnly(sourceDate)) throw httpError(400, 'Invalid source_date: use YYYY-MM-DD');
    const notes = typeof input.notes === 'string' ? input.notes.slice(0, MAX_NOTE * 5) : '';
    const text = typeof input.text === 'string' ? input.text : '';
    if (text.length > MAX_TEXT) throw httpError(413, 'Pasted text is too long; attach it as a file instead');

    await fsp.mkdir(this.rootDir(), { recursive: true });
    // Two saves at the same moment can pick the same number; the exclusive mkdir lets only one win.
    let id = '';
    let dir = '';
    for (let attempt = 0; attempt < 20; attempt++) {
      id = await this.nextId();
      dir = path.join(this.rootDir(), id);
      try { await fsp.mkdir(dir); break; } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        id = '';
      }
    }
    if (!id) throw httpError(409, 'Could not reserve a new context update id; try again');
    await fsp.mkdir(path.join(dir, 'materials'));

    if (text.trim()) {
      await saveAttachment(path.join(dir, 'materials'), 'pasted-text.md', Buffer.from(text, 'utf-8'), 'update.md');
    }

    const now = new Date().toISOString();
    const data: Record<string, unknown> = {
      schema_version: '1.0',
      id,
      type: 'context-update',
      title: title || `Update ${sourceDate}`,
      status: 'ready',
      source_date: sourceDate,
      created_at: now,
      materials: await this.materialList(dir),
      proposals: [],
    };
    await this.write(path.join(dir, 'update.md'), data, notes, {});
    return (await this.read(id)).update;
  }

  private async materialList(dir: string): Promise<UpdateMaterial[]> {
    const files = await listFolderFiles(path.join(dir, 'materials'));
    return files.map((f) => ({ name: f.name, size: f.size, type: f.type }));
  }

  async edit(id: string, input: { title?: unknown; source_date?: unknown; notes?: unknown }): Promise<ContextUpdate> {
    return this.serialized(id, async () => {
      const { update, data, file } = await this.read(id);
      this.requireStatus(update, ['ready'], 'edit the details');
      const patch: Record<string, unknown> = {};
      if (typeof input.title === 'string' && input.title.trim()) patch['title'] = input.title.trim().slice(0, 200);
      if (input.source_date !== undefined) {
        if (typeof input.source_date !== 'string' || !isDateOnly(input.source_date)) throw httpError(400, 'Invalid source_date: use YYYY-MM-DD');
        patch['source_date'] = input.source_date;
      }
      const body = typeof input.notes === 'string' ? input.notes.slice(0, MAX_NOTE * 5) : update.notes;
      await this.write(file, data, body, patch);
      return (await this.read(id)).update;
    });
  }

  async addMaterial(id: string, originalName: string, buffer: Buffer): Promise<FolderFile> {
    return this.serialized(id, async () => {
      const { update, data, file } = await this.read(id);
      this.requireStatus(update, ['ready'], 'add material');
      const dir = path.join(this.updateDir(id), 'materials');
      await fsp.mkdir(dir, { recursive: true });
      const saved = await saveAttachment(dir, await uniqueName(dir, originalName), buffer, 'update.md');
      await this.write(file, data, update.notes, { materials: await this.materialList(this.updateDir(id)) });
      return saved;
    });
  }

  async removeMaterial(id: string, name: string): Promise<void> {
    return this.serialized(id, async () => {
      const { update, data, file } = await this.read(id);
      this.requireStatus(update, ['ready'], 'remove material');
      const dir = path.join(this.updateDir(id), 'materials');
      await fsp.unlink(await fileInside(dir, topLevelName(name)));
      await this.write(file, data, update.notes, { materials: await this.materialList(this.updateDir(id)) });
    });
  }

  async materialPath(id: string, name: string): Promise<string> {
    await this.read(id);
    return fileInside(path.join(this.updateDir(id), 'materials'), name);
  }

  /** Saves the checkboxes and notes while the user reviews, so leaving the page loses nothing. */
  async saveDecisions(id: string, input: unknown): Promise<ContextUpdate> {
    return this.serialized(id, async () => {
      const { update, data, file } = await this.read(id);
      this.requireStatus(update, ['in_review'], 'change decisions');
      const decisions = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
      const known = new Set(update.proposals.map((p) => p.id));
      for (const key of Object.keys(decisions)) {
        if (!known.has(key)) throw httpError(400, `Invalid proposal id: ${key}`);
      }
      const proposals = this.rawProposals(data).map((raw, i) => {
        const p = normalizeProposal(raw, i);
        const change = decisions[p.id] as Record<string, unknown> | undefined;
        if (!change || typeof change !== 'object') return raw;
        const next = { ...(raw as Record<string, unknown>) };
        if ('decision' in change) {
          const d = change['decision'];
          if (d !== 'accepted' && d !== 'rejected' && d !== null) throw httpError(400, 'Invalid decision: use accepted, rejected or null');
          next['decision'] = d;
        }
        if ('reviewer_note' in change) {
          if (typeof change['reviewer_note'] !== 'string') throw httpError(400, 'Invalid reviewer_note');
          next['reviewer_note'] = change['reviewer_note'].slice(0, MAX_NOTE) || undefined;
        }
        return next;
      });
      await this.write(file, data, update.notes, { proposals: this.clean(proposals) });
      return (await this.read(id)).update;
    });
  }

  private rawProposals(data: Record<string, unknown>): unknown[] {
    return Array.isArray(data['proposals']) ? (data['proposals'] as unknown[]).slice(0, MAX_PROPOSALS) : [];
  }

  private clean(proposals: unknown[]): unknown[] {
    return proposals.map((p) => {
      if (!p || typeof p !== 'object') return p;
      return Object.fromEntries(Object.entries(p as Record<string, unknown>).filter(([, v]) => v !== undefined));
    });
  }

  /** Freezes the selection: everything not accepted is rejected, and the apply command may run. */
  async approve(id: string): Promise<ContextUpdate> {
    return this.serialized(id, async () => {
      const { update, data, file } = await this.read(id);
      this.requireStatus(update, ['in_review'], 'approve');
      if (!update.proposals.some((p) => p.decision === 'accepted')) {
        throw httpError(400, 'Invalid approval: select at least one proposal, or close the update without changes');
      }
      const proposals = this.rawProposals(data).map((raw, i) => {
        const p = normalizeProposal(raw, i);
        return p.decision === 'accepted' ? raw : { ...(raw as Record<string, unknown>), decision: 'rejected' };
      });
      await this.write(file, data, update.notes, { status: 'approved', approved_at: new Date().toISOString(), proposals: proposals });
      return (await this.read(id)).update;
    });
  }

  /** Back from approved to review, before the apply command has started. */
  async backToReview(id: string): Promise<ContextUpdate> {
    return this.serialized(id, async () => {
      const { update, data, file } = await this.read(id);
      this.requireStatus(update, ['approved'], 'go back to review');
      await this.write(file, data, update.notes, { status: 'in_review', approved_at: null });
      return (await this.read(id)).update;
    });
  }

  /**
   * Back to "ready" so the user can add material, or because an analysis stopped half way.
   * The old proposals are discarded: the next analysis must see all material at once.
   */
  async reopen(id: string): Promise<ContextUpdate> {
    return this.serialized(id, async () => {
      const { update, data, file } = await this.read(id);
      this.requireStatus(update, ['analyzing', 'in_review', 'approved'], 'reopen');
      await fsp.rm(path.join(this.updateDir(id), 'proposals'), { recursive: true, force: true });
      await this.write(file, data, update.notes, {
        status: 'ready', proposals: [], skipped: undefined, unread: undefined, summary: undefined,
        analyzed_at: undefined, approved_at: undefined,
      });
      return (await this.read(id)).update;
    });
  }

  /** Done without changing any context file. Keeps the record, deletes materials and drafts. */
  async close(id: string): Promise<ContextUpdate> {
    return this.serialized(id, async () => {
      const { update, data, file } = await this.read(id);
      this.requireStatus(update, ['in_review', 'approved'], 'close');
      const proposals = this.rawProposals(data).map((raw) => ({ ...(raw as Record<string, unknown>), decision: 'rejected', outcome: 'skipped' }));
      await this.cleanup(id);
      await this.write(file, data, update.notes, { status: 'done', applied_at: new Date().toISOString(), proposals });
      return (await this.read(id)).update;
    });
  }

  private async cleanup(id: string): Promise<void> {
    const dir = this.updateDir(id);
    await fsp.rm(path.join(dir, 'materials'), { recursive: true, force: true });
    await fsp.rm(path.join(dir, 'proposals'), { recursive: true, force: true });
  }

  async remove(id: string): Promise<void> {
    return this.serialized(id, async () => {
      const { update } = await this.read(id);
      // Applying may have written some files already; deleting the record would hide what happened.
      this.requireStatus(update, ['ready', 'analyzing', 'in_review', 'approved', 'done'], 'delete');
      await fsp.rm(this.updateDir(id), { recursive: true, force: true });
    });
  }
}
