/** Names and terms check (#85): which deliverables it can read, and which findings to show. */

export interface NameCheckFinding {
  key: string;
  kind: 'person' | 'abbreviation';
  found: string;
  suggestion?: string;
  line: number;
  snippet: string;
  count: number;
  dismissed: boolean;
}

export interface NameCheckRun {
  deliverable: string;
  file: string;
  checked_at: string;
  findings: NameCheckFinding[];
  total: number;
  recorded: boolean;
}

/** Results are kept per task, deliverable and file: one for another task's DEL-01, or an older file, is never shown. */
export function runKey(taskId: string, deliverableId: string, filePath: string): string {
  return `${taskId}\u0000${deliverableId}\u0000${filePath}`;
}

const CHECKABLE = /\.(md|markdown|html?|txt)$/i;

/** Deliverables with a saved Markdown, HTML or text file (Office files and PDFs are not read). */
export function checkableDeliverables<T extends { id?: string; file_path?: string | null }>(items: T[]): Array<T & { id: string; file_path: string }> {
  return items.filter((d): d is T & { id: string; file_path: string } => !!d.id && typeof d.file_path === 'string' && CHECKABLE.test(d.file_path));
}

/** Findings still to look at first, in file order; dismissed ones apart. */
export function visibleFindings(findings: NameCheckFinding[]): { shown: NameCheckFinding[]; dismissed: NameCheckFinding[] } {
  return { shown: findings.filter((f) => !f.dismissed), dismissed: findings.filter((f) => f.dismissed) };
}
