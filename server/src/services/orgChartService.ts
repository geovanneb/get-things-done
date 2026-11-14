import { requireText } from '../utils/loose';
import * as path from 'path';
import { createHash } from 'crypto';
import { lock, tryLock, unlock } from '../utils/fileLock';
import { topLevelName, workspaceEntry } from '../utils/files';
import { OrgChart, OrgChartMember, OrgUnit, Stakeholder } from '../types';
import { FileService } from './fileService';
import { WorkspaceService } from './workspace';
import { StakeholderService } from './stakeholderService';

const fileService = new FileService();
const workspaceService = new WorkspaceService();
const stakeholderService = new StakeholderService();

class OrgChartError extends Error {
  statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = message;
  }
}

export interface StakeholderSummary {
  id: string;
  name: string;
  role?: string;
  /** True for a chart placeholder (not a stakeholder file). */
  placeholder?: boolean;
}

export interface UnitSummary {
  id: string;
  name: string;
  /** Unit names from the top of the chart down to this unit. */
  path: string[];
  head: StakeholderSummary | null;
}

/** Where one stakeholder sits in one chart, with the people around them resolved to names. */
export interface OrgPosition {
  chart: { id: string; name: string; organization?: string };
  /** This person's title in the chart, when it differs from their stakeholder role. */
  title?: string;
  /** The unit they belong to, when the chart uses units. */
  unit?: UnitSummary;
  /** Units they lead. */
  head_of?: Array<{ id: string; name: string }>;
  manager: StakeholderSummary | null;
  direct_reports: StakeholderSummary[];
  peers: StakeholderSummary[];
}

/** Chart-local placeholder ids: someone known only by role, or not yet added as a stakeholder. */
export const isPlaceholder = (ref: string) => /^P-\d+$/.test(ref);

/** One member with only known fields; empty optional fields are left out (the YAML writer cannot write `undefined`). */
function cleanMember(item: Record<string, unknown>, ref: string): OrgChartMember {
  const member: OrgChartMember = { ref };
  if (isPlaceholder(ref)) {
    const name = typeof item.name === 'string' ? item.name.trim().slice(0, 120) : '';
    member.name = name || 'Unnamed placeholder';
  }
  const reportsTo = typeof item.reports_to === 'string' ? item.reports_to.trim() : '';
  if (reportsTo && reportsTo !== ref) member.reports_to = reportsTo;
  const title = typeof item.title === 'string' ? item.title.trim() : '';
  if (title) member.title = title.slice(0, 200);
  const unit = typeof item.unit === 'string' ? item.unit.trim() : '';
  if (unit) member.unit = unit;
  return member;
}

const UNIT_ID = /^U-\d+$/;

/**
 * Returns the units with names trimmed, missing or duplicate ids replaced, and references to unknown
 * parents dropped; throws when units are nested in a loop. Heads and member units are checked later
 * against the final member list (see reconcileUnits).
 */
export function normalizeUnits(raw: unknown): OrgUnit[] {
  if (!Array.isArray(raw)) return [];
  const units: OrgUnit[] = [];
  const ids = new Set<string>();
  let next = 1 + raw.reduce((max: number, u) => {
    const m = typeof u?.id === 'string' ? u.id.trim().match(/^U-(\d+)$/) : null;
    return m ? Math.max(max, parseInt(m[1], 10)) : max;
  }, 0);
  for (const item of raw) {
    const name = typeof item?.name === 'string' ? item.name.trim().slice(0, 120) : '';
    if (!name) continue;
    let id = typeof item.id === 'string' ? item.id.trim() : '';
    if (!UNIT_ID.test(id) || ids.has(id)) id = `U-${next++}`;
    ids.add(id);
    const unit: OrgUnit = { id, name };
    const parent = typeof item.parent === 'string' ? item.parent.trim() : '';
    if (parent && parent !== id) unit.parent = parent;
    const head = typeof item.head === 'string' ? item.head.trim() : '';
    if (head) unit.head = head;
    units.push(unit);
  }
  for (const u of units) {
    if (u.parent && !ids.has(u.parent)) delete u.parent;
  }
  const loop = findUnitLoop(units);
  if (loop) {
    const names = new Map(units.map((u) => [u.id, u.name]));
    throw new OrgChartError(`Invalid units: ${loop.map((id) => names.get(id) ?? id).join(' → ')} are nested in a loop`);
  }
  return units;
}

export function findUnitLoop(units: OrgUnit[]): string[] | null {
  return findLoop(units.map((u) => ({ ref: u.id, reports_to: u.parent })));
}

/** Drops unit heads who are not in the chart and member units that no longer exist. */
function reconcileUnits(members: OrgChartMember[], units: OrgUnit[]): { members: OrgChartMember[]; units: OrgUnit[] } {
  const refs = new Set(members.map((m) => m.ref));
  const ids = new Set(units.map((u) => u.id));
  return {
    members: members.map((m) => {
      if (!m.unit || ids.has(m.unit)) return m;
      const { unit: _gone, ...rest } = m;
      return rest;
    }),
    units: units.map((u) => {
      if (!u.head || refs.has(u.head)) return u;
      const { head: _gone, ...rest } = u;
      return rest;
    }),
  };
}

/** 1.1 only when a 1.1 field is used, so existing charts are written exactly as before. */
function schemaVersion(chart: OrgChart): string {
  const uses11 = (chart.units?.length ?? 0) > 0 || chart.members.some((m) => m.title || m.unit || isPlaceholder(m.ref));
  return uses11 ? '1.1' : '1.0';
}

/**
 * Returns the member list with dangling and self-references cleared, or throws on a reporting loop.
 * Every known member field is kept, so saving a chart never drops a title (or later fields).
 */
export function normalizeMembers(raw: unknown): OrgChartMember[] {
  if (!Array.isArray(raw)) return [];
  const members: OrgChartMember[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const ref = typeof item?.ref === 'string' ? item.ref.trim() : '';
    if (!ref || seen.has(ref)) continue;
    seen.add(ref);
    members.push(cleanMember(item, ref));
  }
  for (const m of members) {
    if (m.reports_to && !seen.has(m.reports_to)) delete m.reports_to;
  }
  const loop = findLoop(members);
  if (loop) throw new OrgChartError(`Invalid reporting line: ${loop.join(' → ')} forms a loop`);
  return members;
}

export function findLoop(members: OrgChartMember[]): string[] | null {
  const managerOf = new Map(members.map((m) => [m.ref, m.reports_to]));
  for (const start of managerOf.keys()) {
    const trail: string[] = [];
    let current: string | undefined = start;
    while (current) {
      if (trail.includes(current)) return [...trail.slice(trail.indexOf(current)), current];
      trail.push(current);
      current = managerOf.get(current);
    }
  }
  return null;
}

const CHART_TEXT_FIELDS = ['name', 'organization', 'description', 'notes'] as const;

/** The front-matter keys the app writes itself; any other key in a chart file is kept as it is on every save. */
const KNOWN_KEYS = new Set(['schema_version', 'id', 'type', 'name', 'organization', 'description', 'members', 'units', 'created_at', 'updated_at']);

/** How long a save waits for another save of the same chart before it is refused, as for tasks and context notes. */
const CHART_LOCK_WAIT_MS = 5000;

/** The lock file's name for a chart id; a hand-written id that is not a valid file name gets a hashed name. */
function lockName(id: string): string {
  try {
    if (Buffer.byteLength(id) <= 200) return topLevelName(id);
  } catch { /* not a file name */ }
  return `id-${createHash('sha256').update(id).digest('hex').slice(0, 32)}`;
}

/**
 * Told when a chart write has to wait for another one on the same chart. Tests use it to know the second write is
 * queued behind the lock, instead of guessing from elapsed time.
 */
export const chartLockWaits: { onWait: ((id: string) => void) | null } = { onWait: null };

/** A chart as read from its file, with the front-matter keys the app does not know. */
interface ChartFile {
  chart: OrgChart;
  extra: Record<string, unknown>;
}

export class OrgChartService {
  private getDir(): string {
    return path.join(workspaceService.getWorkspacePath(), 'stakeholders', 'org-charts');
  }

  private async readChart(filePath: string): Promise<OrgChart> {
    return (await this.readChartFile(filePath)).chart;
  }

  private async readChartFile(filePath: string): Promise<ChartFile> {
    const { data, content } = await fileService.readMarkdown<Partial<OrgChart> & Record<string, unknown>>(filePath);
    const extra = Object.fromEntries(Object.entries(data ?? {}).filter(([key]) => !KNOWN_KEYS.has(key)));
    const chart: OrgChart = {
      id: data.id || path.basename(filePath, '.md').toUpperCase(),
      name: data.name || 'Untitled chart',
      organization: data.organization || undefined,
      description: data.description || undefined,
      members: Array.isArray(data.members) ? data.members : [],
      units: Array.isArray(data.units) && data.units.length ? data.units : undefined,
      notes: content.trim() || undefined,
      created_at: data.created_at || new Date().toISOString(),
      updated_at: data.updated_at || new Date().toISOString(),
      path: filePath,
    };
    return { chart, extra };
  }

  /**
   * `create`: write a new file only, failing with EEXIST when the name is taken. `extra`: the file's own keys the app
   * does not know (an agent's `source_note`, say), written back unchanged so a save from the dashboard never drops them.
   */
  private async writeChart(chart: OrgChart, filePath: string, create = false, extra: Record<string, unknown> = {}): Promise<OrgChart> {
    const frontmatter = {
      ...extra,
      schema_version: schemaVersion(chart),
      id: chart.id,
      type: 'org_chart',
      name: chart.name,
      organization: chart.organization || undefined,
      description: chart.description || undefined,
      members: chart.members,
      units: chart.units?.length ? chart.units : undefined,
      created_at: chart.created_at,
      updated_at: chart.updated_at,
    };
    // Known keys are always written by the app (an emptied field is left out), never taken from `extra`.
    if (create) await fileService.createMarkdown(filePath, frontmatter, chart.notes || '');
    else await fileService.writeMarkdown(filePath, frontmatter, chart.notes || '');
    return { ...chart, path: filePath };
  }

  async listCharts(): Promise<OrgChart[]> {
    const dir = this.getDir();
    await fileService.ensureDir(dir);
    const files = await fileService.listFiles(dir, '*.md');
    const charts: OrgChart[] = [];
    for (const filePath of files) {
      try {
        charts.push(await this.readChart(filePath));
      } catch {
        // Skip malformed files; workspace validation reports them.
      }
    }
    return charts.sort((a, b) => a.name.localeCompare(b.name));
  }

  async getChart(id: string): Promise<OrgChart> {
    const chart = (await this.listCharts()).find((c) => c.id === id);
    if (!chart) throw new Error(`Org chart not found: ${id}`);
    return chart;
  }

  /** The chart as its file is now, read again for a write; null when it is gone. */
  private async findChart(id: string): Promise<ChartFile | null> {
    const dir = this.getDir();
    await fileService.ensureDir(dir);
    let found: ChartFile | null = null;
    for (const filePath of await fileService.listFiles(dir, '*.md')) {
      try {
        const file = await this.readChartFile(filePath);
        // The first by name, as listCharts sorts, when two files carry the same id.
        if (file.chart.id === id && (!found || file.chart.name.localeCompare(found.chart.name) < 0)) found = file;
      } catch {
        // Skip malformed files; workspace validation reports them.
      }
    }
    return found;
  }

  /**
   * One writer at a time per chart, across dashboards: `.situation-board/org-chart-locks/<id>.lock`. Update, delete,
   * taking a deleted stakeholder out and an accepted removal in a context update all take it and read the chart again
   * inside it, so none of them writes from a copy another has changed or deleted meanwhile. A writer holds one chart
   * lock at a time and never waits for another chart's lock while holding one. Waits 5 s, then 409 `org_chart_busy`.
   */
  async withChartLock<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const ws = workspaceService.getWorkspacePath();
    const locks = await workspaceEntry(ws, path.join(ws, '.situation-board', 'org-chart-locks'), true);
    await fileService.ensureDir(locks);
    const lockFile = await workspaceEntry(ws, path.join(locks, `${lockName(id)}.lock`), true);
    let held = await tryLock(lockFile);
    if (typeof held === 'string') {
      chartLockWaits.onWait?.(id);
      held = await lock(lockFile, CHART_LOCK_WAIT_MS, () => Object.assign(
        new OrgChartError('The org chart is being saved elsewhere; try again in a moment.'),
        { statusCode: 409, details: { code: 'org_chart_busy' } },
      ));
    }
    try {
      return await operation();
    } finally {
      await unlock(held);
    }
  }

  /** Runs `operation` under the lock of the chart stored in this file (by its id, as listCharts reads it). */
  async withChartFileLock<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
    let id = path.basename(filePath, '.md').toUpperCase();
    try {
      id = (await this.readChart(filePath)).id;
    } catch { /* unreadable or gone: the file name is the id listCharts would give it */ }
    return this.withChartLock(id, operation);
  }

  async createChart(data: Partial<OrgChart>): Promise<OrgChart> {
    requireText(data, CHART_TEXT_FIELDS);
    const name = typeof data.name === 'string' ? data.name.trim() : '';
    if (!name) throw new OrgChartError('Chart name is required');
    const now = new Date().toISOString();
    const { members, units } = reconcileUnits(await this.checkNewRefs(normalizeMembers(data.members), []), normalizeUnits(data.units));
    const chart: OrgChart = {
      id: '',
      name,
      organization: data.organization?.trim() || undefined,
      description: data.description?.trim() || undefined,
      members,
      units: units.length ? units : undefined,
      notes: data.notes?.trim() || undefined,
      created_at: now,
      updated_at: now,
    };
    // Two creates at the same moment can pick the same number, and a plain write would silently replace the
    // other chart. The exclusive create lets only one have it; the other takes the next number.
    let seq = await this.highestNumber();
    for (let attempt = 0; attempt < 20; attempt++) {
      chart.id = `ORG-${String(++seq).padStart(4, '0')}`;
      try {
        return await this.writeChart(chart, path.join(this.getDir(), `${chart.id.toLowerCase()}.md`), true);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
    }
    throw Object.assign(new OrgChartError('Could not reserve a new org chart id; try again'), { statusCode: 409 });
  }

  async updateChart(id: string, data: Partial<OrgChart>): Promise<OrgChart> {
    requireText(data, CHART_TEXT_FIELDS);
    return this.withChartLock(id, () => this.updateLocked(id, data));
  }

  private async updateLocked(id: string, data: Partial<OrgChart>): Promise<OrgChart> {
    // Read inside the lock, and new people checked against it: a person removed a moment ago is not written back.
    const file = await this.findChart(id);
    if (!file) throw new Error(`Org chart not found: ${id}`);
    const existing = file.chart;
    const name = data.name !== undefined ? String(data.name).trim() : existing.name;
    if (!name) throw new OrgChartError('Chart name is required');
    const { members, units } = reconcileUnits(
      data.members !== undefined ? await this.checkNewRefs(normalizeMembers(data.members), existing.members) : existing.members,
      data.units !== undefined ? normalizeUnits(data.units) : existing.units ?? [],
    );
    const updated: OrgChart = {
      ...existing,
      name,
      organization: data.organization !== undefined ? (data.organization ?? '').trim() || undefined : existing.organization,
      description: data.description !== undefined ? (data.description ?? '').trim() || undefined : existing.description,
      members,
      units: units.length ? units : undefined,
      notes: data.notes !== undefined ? (data.notes ?? '').trim() || undefined : existing.notes,
      id,
      updated_at: new Date().toISOString(),
    };
    return this.writeChart(updated, existing.path!, false, file.extra);
  }

  async deleteChart(id: string): Promise<void> {
    await this.withChartLock(id, async () => {
      const file = await this.findChart(id);
      if (!file) throw new Error(`Org chart not found: ${id}`);
      await fileService.deleteFile(file.chart.path!);
    });
  }

  /**
   * Takes a deleted stakeholder out of every chart; their direct reports move up to their manager. Every chart is
   * visited under its own lock, one at a time in id order, and whether the person is in it is decided from a fresh
   * read inside the lock: a chart whose save is adding them right now is checked after that save, a chart deleted
   * meanwhile is not recreated, and a member edit saved meanwhile is kept without putting the person back. A chart
   * that stays busy is left for the others to finish, then reported (409); a dangling member is tolerated when charts
   * are read and edited.
   */
  async removeStakeholder(ref: string): Promise<void> {
    // All charts, not only those listing the person now: an unlocked read cannot see a save that is about to add them.
    const ids = [...new Set((await this.listCharts()).map((c) => c.id))].sort();
    let failure: unknown = null;
    for (const id of ids) {
      try {
        await this.withChartLock(id, () => this.removeFromChart(id, ref));
      } catch (err) {
        failure ??= err;
      }
    }
    if (failure) throw failure;
  }

  private async removeFromChart(id: string, ref: string): Promise<void> {
    const file = await this.findChart(id);
    if (!file) return;
    const chart = file.chart;
    const member = chart.members.find((m) => m.ref === ref);
    if (!member) return;
    const members = chart.members
      .filter((m) => m.ref !== ref)
      .map((m) => {
        if (m.reports_to !== ref) return m;
        // Keep every other field (title…); only the manager changes.
        const { reports_to: _old, ...rest } = m;
        return member.reports_to ? { ...rest, reports_to: member.reports_to } : rest;
      });
    // A unit they led keeps its people but no longer has a head.
    const units = chart.units?.map((u) => {
      if (u.head !== ref) return u;
      const { head: _gone, ...rest } = u;
      return rest;
    });
    await this.writeChart({ ...chart, members, units, updated_at: new Date().toISOString() }, chart.path!, false, file.extra);
  }

  async getPositions(ref: string): Promise<OrgPosition[]> {
    const charts = (await this.listCharts()).filter((c) => c.members.some((m) => m.ref === ref));
    if (charts.length === 0) return [];
    const byId = new Map<string, Stakeholder>((await stakeholderService.listStakeholders()).map((s) => [s.id, s]));
    return charts.map((chart) => {
      // A title in the chart wins over the stakeholder's role, for everyone listed here.
      const titleIn = new Map(chart.members.map((m) => [m.ref, m.title]));
      const placeholderName = new Map(chart.members.filter((m) => isPlaceholder(m.ref)).map((m) => [m.ref, m.name]));
      const summary = (id: string): StakeholderSummary => {
        if (placeholderName.has(id)) {
          return { id, name: placeholderName.get(id) || id, role: titleIn.get(id) || undefined, placeholder: true };
        }
        const s = byId.get(id);
        return { id, name: s?.name ?? id, role: titleIn.get(id) || s?.role || undefined };
      };
      const me = chart.members.find((m) => m.ref === ref)!;
      const units = new Map((chart.units ?? []).map((u) => [u.id, u]));
      const unitPath = (id: string): string[] => {
        const names: string[] = [];
        const seen = new Set<string>();
        for (let u = units.get(id); u && !seen.has(u.id); u = u.parent ? units.get(u.parent) : undefined) {
          seen.add(u.id);
          names.unshift(u.name);
        }
        return names;
      };
      const myUnit = me.unit ? units.get(me.unit) : undefined;
      const headOf = (chart.units ?? []).filter((u) => u.head === ref).map((u) => ({ id: u.id, name: u.name }));
      return {
        chart: { id: chart.id, name: chart.name, organization: chart.organization },
        title: me.title,
        ...(myUnit ? { unit: { id: myUnit.id, name: myUnit.name, path: unitPath(myUnit.id), head: myUnit.head ? summary(myUnit.head) : null } } : {}),
        ...(headOf.length ? { head_of: headOf } : {}),
        manager: me.reports_to ? summary(me.reports_to) : null,
        direct_reports: chart.members.filter((m) => m.reports_to === ref).map((m) => summary(m.ref)),
        peers: me.reports_to
          ? chart.members.filter((m) => m.reports_to === me.reports_to && m.ref !== ref).map((m) => summary(m.ref))
          : [],
      };
    });
  }

  /**
   * Rejects stakeholder ids that are new to the chart and do not exist. Ids already in the chart stay
   * accepted, so a chart that lost a stakeholder (edited by hand, or deleted elsewhere) can still be edited.
   */
  private async checkNewRefs(members: OrgChartMember[], before: OrgChartMember[]): Promise<OrgChartMember[]> {
    const known = new Set(before.map((m) => m.ref));
    // Placeholders are chart-local, so they never need a stakeholder file.
    const added = members.filter((m) => !known.has(m.ref) && !isPlaceholder(m.ref)).map((m) => m.ref);
    if (added.length === 0) return members;
    const ids = new Set((await stakeholderService.listStakeholders()).map((s) => s.id));
    const unknown = added.filter((r) => !ids.has(r));
    if (unknown.length) throw new OrgChartError(`Unknown stakeholder: ${unknown.join(', ')}`);
    return members;
  }

  private async highestNumber(): Promise<number> {
    let max = 0;
    for (const chart of await this.listCharts()) {
      const match = chart.id.match(/^ORG-(\d+)$/);
      if (match) max = Math.max(max, parseInt(match[1], 10));
    }
    return max;
  }
}

export const orgChartService = new OrgChartService();
