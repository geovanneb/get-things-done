import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * One step of a run, as the dashboard shows it while the run goes (#246): what kind of tool call it was and the
 * workspace file or folder it touched. Never file contents, search terms, commands, their output or the agent's
 * own text. Kept in memory for the run only, never saved.
 */
export interface RunStep {
  kind: 'read' | 'search' | 'list' | 'write' | 'edit' | 'command' | 'skill' | 'other';
  /**
   * Workspace-relative, with "/" separators, and only for a file or folder that exists in the workspace (through any
   * symlinks): the agent picks this text, so a name it made up, which could be copied content, is never shown.
   * null when the call named none, the workspace itself, or a path that could not be confirmed.
   */
  path: string | null;
  /** A new file being written: the existing workspace folder it goes in ("" for the workspace itself), not its name. */
  folder?: string;
  /** The call named a path outside the workspace: shown as such, never the path. */
  outside?: boolean;
  /** For a skill or another tool: its name, when it is a plain name. */
  name?: string;
}

const MAX_PATH = 300;
const NAME = /^[A-Za-z][\w:.-]{0,63}$/;

/** Claude Code's tools and what each one's step is: its kind and the input that names a file or folder. */
const TOOLS: Record<string, { kind: RunStep['kind']; input?: string }> = {
  Read: { kind: 'read', input: 'file_path' },
  Write: { kind: 'write', input: 'file_path' },
  Edit: { kind: 'edit', input: 'file_path' },
  MultiEdit: { kind: 'edit', input: 'file_path' },
  NotebookEdit: { kind: 'edit', input: 'notebook_path' },
  Grep: { kind: 'search', input: 'path' },
  Glob: { kind: 'list', input: 'path' },
  LS: { kind: 'list', input: 'path' },
  Bash: { kind: 'command' },
  Skill: { kind: 'skill' },
};
/** Bookkeeping, not work the user would recognise as a step. */
const SKIPPED = new Set(['TodoWrite', 'ToolSearch']);

/** Control, format (direction) and line-separator characters: a value holding any is not shown at all. */
const UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
/** Home and UNC spellings, and off Windows drive letters and backslashes: never resolved here, so never shown. */
const FOREIGN = /^~|^[\\/]{2}[^\\/]/;
const FOREIGN_POSIX = /^[A-Za-z]:|\\/;

const inside = (rel: string) => rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
/** The name to show, or null when the real name holds unsafe characters (a link can lead to one). */
const shown = (rel: string): string | null => {
  if (UNSAFE.test(rel)) return null;
  const text = rel.split(path.sep).join('/');
  return text.length > MAX_PATH ? `…${text.slice(-MAX_PATH)}` : text;
};
const exists = (p: string) => { try { fs.lstatSync(p); return true; } catch { return false; } };
const real = (p: string): string | null => { try { return fs.realpathSync(p); } catch { return null; } };

/**
 * What a step may show of a path the agent named. `roots` are the workspace path and its real path. Shown only when it
 * exists in the workspace once symlinks are followed; a new file (`write`) shows the existing folder it goes in.
 */
function relative(raw: unknown, roots: string[], write: boolean): Pick<RunStep, 'path' | 'folder' | 'outside'> {
  if (typeof raw !== 'string' || !raw.trim() || UNSAFE.test(raw) || raw.length > 4096) return { path: null };
  if (FOREIGN.test(raw) || (path.sep === '/' && FOREIGN_POSIX.test(raw))) return { path: null, outside: true };
  const realRoot = real(roots[roots.length - 1]!) ?? roots[0]!;
  let named: string | null = null;
  for (const root of roots) {
    const rel = path.relative(root, path.resolve(root, raw));
    if (inside(rel)) { named = path.join(realRoot, rel); break; }
  }
  if (named === null) return { path: null, outside: true };
  const target = real(named);
  if (target !== null) {
    const rel = path.relative(realRoot, target);
    if (!inside(rel)) return { path: null, outside: true };
    return { path: rel === '' ? null : shown(rel) };
  }
  // Not there yet: the folder it goes in, if that exists in the workspace. A dangling link is not a new file.
  if (!write || exists(named)) return { path: null };
  const parent = real(path.dirname(named));
  if (parent === null) return { path: null };
  const rel = path.relative(realRoot, parent);
  if (!inside(rel)) return { path: null, outside: true };
  if (rel === '') return { path: null, folder: '' };
  const folder = shown(rel);
  return folder === null ? { path: null } : { path: null, folder };
}

/** The steps in one line of Claude Code's stream-json output: one per tool call in an assistant message. */
export function stepsFromMessage(message: Record<string, unknown>, roots: string[]): { id: string; step: RunStep }[] {
  if (message['type'] !== 'assistant') return [];
  const inner = message['message'];
  const content = typeof inner === 'object' && inner !== null ? (inner as Record<string, unknown>)['content'] : undefined;
  if (!Array.isArray(content)) return [];
  const steps: { id: string; step: RunStep }[] = [];
  for (const block of content as unknown[]) {
    if (typeof block !== 'object' || block === null) continue;
    const b = block as Record<string, unknown>;
    if (b['type'] !== 'tool_use' || typeof b['id'] !== 'string' || typeof b['name'] !== 'string') continue;
    if (SKIPPED.has(b['name'])) continue;
    const input = typeof b['input'] === 'object' && b['input'] !== null ? b['input'] as Record<string, unknown> : {};
    const tool = TOOLS[b['name']];
    let step: RunStep;
    if (!tool) step = { kind: 'other', path: null, ...(NAME.test(b['name']) ? { name: b['name'] } : {}) };
    else if (tool.kind === 'skill') step = { kind: 'skill', path: null, ...(typeof input['skill'] === 'string' && NAME.test(input['skill']) ? { name: input['skill'] } : {}) };
    else step = { kind: tool.kind, ...(tool.input ? relative(input[tool.input], roots, tool.kind === 'write' || tool.kind === 'edit') : { path: null }) };
    steps.push({ id: b['id'], step });
  }
  return steps;
}
