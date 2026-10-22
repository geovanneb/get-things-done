/**
 * Per-chart view preferences (people panel, collapsed cards…), stored in this browser.
 *
 * Keyed by workspace path and chart id, because chart ids (ORG-0001…) repeat across workspaces.
 * Like the other appearance settings, nothing here is written to the workspace.
 */

export interface OrgChartPrefs {
  /** Whether the "Add people" panel is open. Absent = no explicit choice yet. */
  panelOpen?: boolean;
  /** Refs of collapsed cards. Absent = no explicit choice yet. */
  collapsed?: string[];
}

const keyFor = (workspace: string) => `gtd:org-chart-prefs:${workspace}`;

function readAll(workspace: string): Record<string, OrgChartPrefs> {
  try {
    const raw = localStorage.getItem(keyFor(workspace));
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function readChartPrefs(workspace: string, chartId: string): OrgChartPrefs {
  return readAll(workspace)[chartId] ?? {};
}

export function writeChartPrefs(workspace: string, chartId: string, patch: Partial<OrgChartPrefs>): void {
  try {
    const all = readAll(workspace);
    all[chartId] = { ...all[chartId], ...patch };
    localStorage.setItem(keyFor(workspace), JSON.stringify(all));
  } catch {
    // Storage unavailable: the preference still applies for this session.
  }
}

const LIST_KEY = 'gtd:org-chart-list-collapsed';

export function readListCollapsed(): boolean {
  try {
    return localStorage.getItem(LIST_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeListCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(LIST_KEY, collapsed ? '1' : '0');
  } catch {
    // Storage unavailable: the preference still applies for this session.
  }
}
