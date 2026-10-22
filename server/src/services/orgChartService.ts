import * as path from 'path';
import { OrgChart, OrgChartMember, Stakeholder } from '../types';
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
}

/** Where one stakeholder sits in one chart, with the people around them resolved to names. */
export interface OrgPosition {
  chart: { id: string; name: string; organization?: string };
  manager: StakeholderSummary | null;
  direct_reports: StakeholderSummary[];
  peers: StakeholderSummary[];
}

/** Returns the member list with dangling and self-references cleared, or throws on a reporting loop. */
export function normalizeMembers(raw: unknown): OrgChartMember[] {
  if (!Array.isArray(raw)) return [];
  const members: OrgChartMember[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const ref = typeof item?.ref === 'string' ? item.ref.trim() : '';
    if (!ref || seen.has(ref)) continue;
    seen.add(ref);
    const reportsTo = typeof item?.reports_to === 'string' ? item.reports_to.trim() : '';
    // Omit the key entirely rather than writing `undefined`, which the YAML writer cannot serialize.
    members.push(reportsTo && reportsTo !== ref ? { ref, reports_to: reportsTo } : { ref });
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

export class OrgChartService {
  private getDir(): string {
    return path.join(workspaceService.getWorkspacePath(), 'stakeholders', 'org-charts');
  }

  private async readChart(filePath: string): Promise<OrgChart> {
    const { data, content } = await fileService.readMarkdown<Partial<OrgChart>>(filePath);
    return {
      id: data.id || path.basename(filePath, '.md').toUpperCase(),
      name: data.name || 'Untitled chart',
      organization: data.organization || undefined,
      description: data.description || undefined,
      members: Array.isArray(data.members) ? data.members : [],
      notes: content.trim() || undefined,
      created_at: data.created_at || new Date().toISOString(),
      updated_at: data.updated_at || new Date().toISOString(),
      path: filePath,
    };
  }

  private async writeChart(chart: OrgChart, filePath: string): Promise<OrgChart> {
    const frontmatter = {
      schema_version: '1.0',
      id: chart.id,
      type: 'org_chart',
      name: chart.name,
      organization: chart.organization || undefined,
      description: chart.description || undefined,
      members: chart.members,
      created_at: chart.created_at,
      updated_at: chart.updated_at,
    };
    await fileService.writeMarkdown(filePath, frontmatter, chart.notes || '');
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

  async createChart(data: Partial<OrgChart>): Promise<OrgChart> {
    const name = typeof data.name === 'string' ? data.name.trim() : '';
    if (!name) throw new OrgChartError('Chart name is required');
    const id = await this.generateId();
    const now = new Date().toISOString();
    const chart: OrgChart = {
      id,
      name,
      organization: data.organization?.trim() || undefined,
      description: data.description?.trim() || undefined,
      members: normalizeMembers(data.members),
      notes: data.notes?.trim() || undefined,
      created_at: now,
      updated_at: now,
    };
    return this.writeChart(chart, path.join(this.getDir(), `${id.toLowerCase()}.md`));
  }

  async updateChart(id: string, data: Partial<OrgChart>): Promise<OrgChart> {
    const existing = await this.getChart(id);
    const name = data.name !== undefined ? String(data.name).trim() : existing.name;
    if (!name) throw new OrgChartError('Chart name is required');
    const updated: OrgChart = {
      ...existing,
      name,
      organization: data.organization !== undefined ? data.organization.trim() || undefined : existing.organization,
      description: data.description !== undefined ? data.description.trim() || undefined : existing.description,
      members: data.members !== undefined ? normalizeMembers(data.members) : existing.members,
      notes: data.notes !== undefined ? data.notes.trim() || undefined : existing.notes,
      id,
      updated_at: new Date().toISOString(),
    };
    return this.writeChart(updated, existing.path!);
  }

  async deleteChart(id: string): Promise<void> {
    const existing = await this.getChart(id);
    await fileService.deleteFile(existing.path!);
  }

  /** Takes a deleted stakeholder out of every chart; their direct reports move up to their manager. */
  async removeStakeholder(ref: string): Promise<void> {
    for (const chart of await this.listCharts()) {
      const member = chart.members.find((m) => m.ref === ref);
      if (!member) continue;
      const members = chart.members
        .filter((m) => m.ref !== ref)
        .map((m) => (m.reports_to === ref ? (member.reports_to ? { ref: m.ref, reports_to: member.reports_to } : { ref: m.ref }) : m));
      await this.writeChart({ ...chart, members, updated_at: new Date().toISOString() }, chart.path!);
    }
  }

  async getPositions(ref: string): Promise<OrgPosition[]> {
    const charts = (await this.listCharts()).filter((c) => c.members.some((m) => m.ref === ref));
    if (charts.length === 0) return [];
    const byId = new Map<string, Stakeholder>((await stakeholderService.listStakeholders()).map((s) => [s.id, s]));
    const summary = (id: string): StakeholderSummary => {
      const s = byId.get(id);
      return { id, name: s?.name ?? id, role: s?.role || undefined };
    };
    return charts.map((chart) => {
      const me = chart.members.find((m) => m.ref === ref)!;
      return {
        chart: { id: chart.id, name: chart.name, organization: chart.organization },
        manager: me.reports_to ? summary(me.reports_to) : null,
        direct_reports: chart.members.filter((m) => m.reports_to === ref).map((m) => summary(m.ref)),
        peers: me.reports_to
          ? chart.members.filter((m) => m.reports_to === me.reports_to && m.ref !== ref).map((m) => summary(m.ref))
          : [],
      };
    });
  }

  private async generateId(): Promise<string> {
    let max = 0;
    for (const chart of await this.listCharts()) {
      const match = chart.id.match(/^ORG-(\d+)$/);
      if (match) max = Math.max(max, parseInt(match[1], 10));
    }
    return `ORG-${String(max + 1).padStart(4, '0')}`;
  }
}

export const orgChartService = new OrgChartService();
