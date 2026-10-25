import * as fsp from 'fs/promises';
import * as path from 'path';

/**
 * Reading the per-task `executions/` folder.
 *
 * The `/gtd-task` command writes one markdown file per run, named after the
 * timestamp. These logs are the only durable record of when an agent actually
 * worked on a task, so both the Agent Floor and Insights read them.
 */

/** One execution log, with whatever timing the file actually carries. */
export interface ExecutionRecord {
  /** Absolute path of the log file. */
  path: string;
  /** Filename, which doubles as the sort key. */
  filename: string;
  /** Best available ISO timestamp for "when this run happened". */
  timestamp: string;
  /** `started_at` from frontmatter, when the log records one. */
  started_at?: string;
  /** `completed_at` or `executed_at` from frontmatter, when present. */
  completed_at?: string;
  /** `agent` from frontmatter. */
  agent?: string;
}

/**
 * List the execution log files for a task, oldest first. Filenames are
 * timestamps, so lexical order is chronological order.
 *
 * A task lives under `tasks/active/` until `archiveTask` renames its folder into
 * `tasks/archive/`, so both roots are tried. Looking only in `active` would make
 * every archived task report zero runs.
 */
export async function listExecutionFiles(
  workspacePath: string,
  taskId: string,
): Promise<{ files: string[]; dir: string }> {
  const roots = ['active', 'archive'];
  let fallbackDir = path.join(workspacePath, 'tasks', 'active', taskId, 'executions');

  for (const root of roots) {
    const dir = path.join(workspacePath, 'tasks', root, taskId, 'executions');
    if (root === 'active') fallbackDir = dir;
    try {
      const entries = await fsp.readdir(dir);
      const files = entries.filter((f) => f.endsWith('.md')).sort();
      if (files.length > 0) return { files, dir };
    } catch {
      // Not under this root — try the next one.
    }
  }
  return { files: [], dir: fallbackDir };
}

/** Pull the first meaningful line out of an execution log as a one-line summary. */
export async function summariseExecution(filePath: string): Promise<string> {
  try {
    const raw = await fsp.readFile(filePath, 'utf-8');
    const body = raw.replace(/^---[\s\S]*?\n---\n/, '');
    for (const line of body.split('\n')) {
      const trimmed = line.replace(/^[#>*\-\s]+/, '').trim();
      if (trimmed.length > 3) return trimmed.slice(0, 160);
    }
  } catch {
    // Unreadable log — the caller is still useful without a summary.
  }
  return '';
}

/**
 * Turn an execution filename into an ISO stamp.
 *
 * Real logs are named inconsistently, so all of these have to work:
 * `2026-01-05T12-30-00.md`, `2026-01-06T16-57-00Z.md`, `2026-01-07T074500.md`
 * and `2026-01-08T0830.md`. The trailing `Z` has to be consumed by the pattern
 * rather than left behind, otherwise it survives into the rebuilt string as a
 * second `Z` and the parse fails.
 */
export function timestampFromFilename(filename: string, fallback: string): string {
  const base = filename.replace(/\.md$/, '');
  const match = base.match(
    /^(\d{4}-\d{2}-\d{2})(?:[T_ ]?(\d{2})[-:]?(\d{2})(?:[-:]?(\d{2}))?)?Z?$/,
  );
  if (!match) return fallback;

  const [, date, hh = '00', mm = '00', ss = '00'] = match;
  const parsed = Date.parse(`${date}T${hh}:${mm}:${ss}Z`);
  return Number.isNaN(parsed) ? fallback : new Date(parsed).toISOString();
}

/** Read one scalar out of a simple `key: value` frontmatter block. */
function scalar(frontmatter: string, key: string): string | undefined {
  const match = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
  if (!match) return undefined;
  const value = match[1].trim().replace(/^['"]|['"]$/g, '');
  return value && value !== 'null' ? value : undefined;
}

/** Normalise a frontmatter date to ISO, dropping anything unparseable. */
function isoOrUndefined(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
}

/**
 * Stand-in timestamp for a run log with no time in its name or frontmatter.
 * It sorts such runs first, but it is not a date: anything that places runs
 * in time must skip it, or the run lands on 1 January 1970.
 */
export const UNKNOWN_TIMESTAMP = new Date(0).toISOString();

/**
 * Read every execution log for a task, oldest first.
 *
 * Log frontmatter is not uniform in the wild — some runs record
 * `started_at` + `completed_at`, some only `executed_at`, and some neither.
 * Anything missing falls back to the timestamp in the filename, which is always
 * present because the command names the file after the run.
 */
export async function readExecutions(
  workspacePath: string,
  taskId: string,
): Promise<ExecutionRecord[]> {
  const { files, dir } = await listExecutionFiles(workspacePath, taskId);

  return Promise.all(files.map(async (filename) => {
    const filePath = path.join(dir, filename);
    let frontmatter = '';
    try {
      const raw = await fsp.readFile(filePath, 'utf-8');
      frontmatter = raw.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
    } catch {
      // Unreadable log — the filename still tells us when the run happened.
    }

    const startedAt = isoOrUndefined(scalar(frontmatter, 'started_at'));
    const completedAt =
      isoOrUndefined(scalar(frontmatter, 'completed_at')) ??
      isoOrUndefined(scalar(frontmatter, 'executed_at'));

    const record: ExecutionRecord = {
      path: filePath,
      filename,
      timestamp:
        completedAt ?? timestampFromFilename(filename, startedAt ?? UNKNOWN_TIMESTAMP),
    };
    if (startedAt) record.started_at = startedAt;
    if (completedAt) record.completed_at = completedAt;

    const agent = scalar(frontmatter, 'agent');
    if (agent) record.agent = agent;

    return record;
  }));
}
