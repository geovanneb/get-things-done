import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { quoteYaml } from '../utils/yamlScalar';
import { parseMarkdown } from '../utils/markdown';
import { portableSkillFiles, type PortableFile, type TemplateTransform } from './portableSkills';

/**
 * Single source of truth for creating and upgrading a workspace.
 *
 * Both the CLI (`esb init` / `esb upgrade`) and the server
 * (`POST /api/workspace/init`) go through this module, so the two can never
 * disagree about the directory layout or the workspace.yaml shape.
 */

export interface WorkspaceProfile {
  name: string;
  role: string;
  organization: string;
  [key: string]: string;
}

export type AiTool = 'claude-code' | 'copilot' | 'codex';

export interface ScaffoldOptions {
  profile: WorkspaceProfile;
  workspaceName?: string;
  aiTools?: AiTool[];
}

export interface ScaffoldResult {
  created: string[];
  skipped: string[];
}

export interface UpgradeResult {
  updated: string[];
  added: string[];
  conflicted: string[];
  unchanged: string[];
  /** Files the app no longer ships, removed because they were still exactly as installed. */
  removed: string[];
  /** Files the app no longer ships, kept because the user changed them. */
  retired_kept: string[];
  /** Files the user changed and said they merged this exact app version into: kept, with no `.new`. */
  merged: string[];
  fromVersion: string | null;
  toVersion: string;
}

/** Directories every workspace has. Empty ones are placeholders the UI fills in. */
export const WORKSPACE_DIRS = [
  'tasks/active',
  'tasks/archive',
  'stakeholders/people',
  'stakeholders/groups',
  'stakeholders/org-charts',
  'outputs/templates',
  'context/company',
  'context/organization',
  'context/strategy',
  'context/programs',
  'context/decisions',
  'context/risks',
  'context/glossary',
  'context/situation',
  'context-updates',
  'profile',
  'kaizen',
  'routines',
  'workflows',
  '.claude/agents',
  '.claude/commands',
  '.claude/skills',
  '.situation-board/cache',
  '.situation-board/logs',
  '.situation-board/trash',
  '.situation-board/routines',
];

export const MANIFEST_RELATIVE_PATH = path.join('.situation-board', 'app-manifest.json');

/**
 * App files a newer version no longer ships. An upgrade removes one only while it is exactly what the app
 * installed (its hash in the previous manifest); a changed copy is the user's and stays. Listed by name, so
 * choosing fewer AI tools never removes the files of the others.
 */
const RETIRED_APP_FILES = [
  // Kaizen notes open as context updates now: /gtd-context-analyze and /gtd-context-apply handle them.
  path.join('.claude', 'commands', 'gtd-kaizen.md'),
];

/** Files whose contents are interpolated and hashed as text. Everything else is copied byte-for-byte. */
const TEXT_EXTENSIONS = new Set(['.md', '.json', '.yaml', '.yml', '.txt', '.html', '.css', '.js']);

/** Template filenames that npm cannot ship under their real name. */
const TEMPLATE_NAME_MAP: Record<string, string> = {
  // npm unconditionally strips `.gitignore` from published tarballs.
  gitignore: '.gitignore',
};

export interface ManifestEntry {
  path: string;
  sha256: string;
  /** The `<path>.new` the app wrote beside a file the user changed, as it wrote it. Absent: any `.new` is the user's. */
  new_sha256?: string;
  /**
   * The app version (`sha256`) the user said they merged into their own file. While the app ships exactly that
   * version, their file is not a conflict and no `.new` is written; a later version clears it and the `.new` comes back.
   */
  merged_sha256?: string;
  /**
   * The app version this file was based on: the one the user last had untouched (installed, updated, or equal to it)
   * or resolved in Settings ("Keep my version", "Use the app's version"). Its exact bytes are kept under
   * `.situation-board/app-files/<sha256>`, so the dashboard can show what a later release changed. A skipped release or
   * an unresolved update keeps the old pointer. Absent: not known (an older app did not record it); never guessed.
   */
  base_sha256?: string;
}

export interface AppManifest {
  appVersion: string;
  generatedAt: string;
  files: ManifestEntry[];
  /** Set by apps that record `new_sha256`. Without it the manifest is older and says nothing about `.new` files. */
  newCopiesTracked?: boolean;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Where the exact bytes the app shipped for a file are kept, named by their SHA-256. */
export const APP_FILES_RELATIVE_PATH = path.join('.situation-board', 'app-files');

/**
 * The record of a "Use the app's version" in progress (see instructionReplace). While it names an app version, that
 * version's kept text is never pruned: it is what finishing the replace needs.
 */
export const REPLACE_JOURNAL_RELATIVE_PATH = path.join('.situation-board', 'instruction-replace.json');

/**
 * The app version an unfinished replace names: null only when there is no journal (confirmed absent), or 'unknown' when
 * something is there that cannot be read or understood (a link, a folder, an error, not a journal): pruning then waits.
 */
function journalPin(workspacePath: string): string | null | 'unknown' {
  const file = path.join(workspacePath, REPLACE_JOURNAL_RELATIVE_PATH);
  try {
    const st = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!st) return null;
    if (!noLinkBelow(workspacePath, file) || !st.isFile()) return 'unknown';
    const hash = (JSON.parse(fs.readFileSync(file, 'utf-8')) as { app_sha256?: unknown }).app_sha256;
    return typeof hash === 'string' && SHA256_HEX.test(hash) ? hash : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** A copy being written to the app files folder: `.<sha256>.<pid>-<random>.tmp`. */
const APP_FILE_TEMP = /^\.([0-9a-f]{64})\.(\d+)-[0-9a-f]{8}\.tmp$/;

/** A folder below the workspace that is a real folder (no link), made when missing. False when it cannot be. */
function plainFolder(workspacePath: string, relDir: string): boolean {
  let current = path.resolve(workspacePath);
  for (const part of relDir.split(path.sep)) {
    current = path.join(current, part);
    try {
      const st = fs.lstatSync(current);
      if (st.isSymbolicLink() || !st.isDirectory()) return false;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return false;
      try { fs.mkdirSync(current); } catch { return false; }
    }
  }
  return true;
}

/**
 * Keeps the exact bytes of an app version under `.situation-board/app-files/<sha256>`, written whole (a reader sees
 * the complete copy or none). An existing copy is kept when it still has exactly those bytes. Never through a link;
 * true only when the copy is there and verified.
 */
export function storeAppFile(workspacePath: string, content: Buffer): boolean {
  const hash = sha256(content);
  try {
    if (!plainFolder(workspacePath, APP_FILES_RELATIVE_PATH)) return false;
    const dest = path.join(workspacePath, APP_FILES_RELATIVE_PATH, hash);
    const existing = fs.lstatSync(dest, { throwIfNoEntry: false });
    if (existing && !existing.isFile()) return false;
    if (existing && sha256(fs.readFileSync(dest)) === hash) return true;
    const temp = path.join(path.dirname(dest), `.${hash}.${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`);
    try {
      fs.writeFileSync(temp, content, { flag: 'wx', mode: 0o644 });
      fs.renameSync(temp, dest);
    } finally {
      fs.rmSync(temp, { force: true });
    }
    return sha256(fs.readFileSync(dest)) === hash;
  } catch {
    return false;
  }
}

/** The versions the app files folder must keep: every base a file points to, and every current app version. */
export function appFilesInUse(files: ManifestEntry[]): Set<string> {
  const keep = new Set<string>();
  for (const f of files) {
    if (SHA256_HEX.test(f.sha256)) keep.add(f.sha256);
    if (typeof f.base_sha256 === 'string' && SHA256_HEX.test(f.base_sha256)) keep.add(f.base_sha256);
  }
  return keep;
}

/**
 * Removes kept app versions nothing points to any more, so the folder holds at most a base and the current version per
 * file. Only plain files named exactly like a kept version (or a copy left by a writer that is gone) are removed;
 * anything else there is left alone. Call it after the manifest that points to the versions to keep is written, so an
 * interruption leaves an extra copy, never a missing one. Never stops the caller.
 */
export function pruneAppFiles(workspacePath: string, keep: Set<string>): void {
  try {
    for (const part of ['.situation-board', APP_FILES_RELATIVE_PATH]) {
      const st = fs.lstatSync(path.join(workspacePath, part), { throwIfNoEntry: false });
      if (!st || st.isSymbolicLink() || !st.isDirectory()) return;
    }
    const dir = path.join(workspacePath, APP_FILES_RELATIVE_PATH);
    const pinned = journalPin(workspacePath);
    // What an unfinished replace needs cannot be told: nothing is removed until it can.
    if (pinned === 'unknown') return;
    if (pinned) keep = new Set([...keep, pinned]);
    for (const name of fs.readdirSync(dir)) {
      const temp = APP_FILE_TEMP.exec(name);
      const stale = SHA256_HEX.test(name) ? !keep.has(name) : temp !== null && !processAlive(Number(temp[2]));
      if (!stale) continue;
      const file = path.join(dir, name);
      try { if (fs.lstatSync(file).isFile()) fs.rmSync(file); } catch { /* left for the next time */ }
    }
  } catch {
    // Pruning is housekeeping: the next upgrade tries again.
  }
}

function processAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function sha256(buf: Buffer | string): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** The hash of a `.new` only when it is a plain file that can be read; a link, folder or failed read gives null. */
export function appNewCopyHash(newPath: string): string | null {
  try {
    if (!fs.lstatSync(newPath).isFile()) return null;
    return sha256(fs.readFileSync(newPath));
  } catch {
    return null;
  }
}

/**
 * Whether every folder from the workspace down to `target` (and `target` itself, when there) is a real entry, not a
 * link, and `target` is below the workspace. What is removed or replaced in the workspace is never reached through one.
 */
export function noLinkBelow(workspacePath: string, target: string): boolean {
  const base = path.resolve(workspacePath);
  const full = path.resolve(target);
  const rel = path.relative(base, full);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  let current = base;
  for (const part of rel.split(path.sep)) {
    current = path.join(current, part);
    const st = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!st) return current === full;
    if (st.isSymbolicLink()) return false;
  }
  return true;
}

/**
 * Removes the app's own `.new` when it still has exactly `expected`; anything else is left. With `workspacePath`, only
 * when no folder on its way below the workspace is a link. Never stops the upgrade.
 */
export function removeNewCopy(newPath: string, expected: string, workspacePath?: string): boolean {
  try {
    if (workspacePath !== undefined && !noLinkBelow(workspacePath, newPath)) return false;
    if (appNewCopyHash(newPath) !== expected) return false;
    fs.rmSync(newPath);
    return true;
  } catch {
    return false;
  }
}

/** Replaces the app's own `.new` with this version. A failure leaves it as it was, without stopping the upgrade. */
function replaceNewCopy(newPath: string, content: string | Buffer, expected: string): boolean {
  try {
    return replaceFile(newPath, content, expected);
  } catch {
    return false;
  }
}

/** Sorts object keys and array items, so two JSON values compare equal when only their order differs. */
function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => JSON.stringify(canonicalJson(item))).sort();
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(obj).sort().map((key) => [key, canonicalJson(obj[key])]));
  }
  return value;
}

/**
 * True when both buffers are JSON holding the same data in a different order or layout
 * (an editor or a hand merge rewrote it). Such a file is kept as it is, so nothing is lost.
 */
function isEquivalentJson(relPath: string, a: Buffer, b: Buffer): boolean {
  if (path.extname(relPath).toLowerCase() !== '.json') return false;
  try {
    const left = JSON.stringify(canonicalJson(JSON.parse(a.toString('utf-8'))));
    return left === JSON.stringify(canonicalJson(JSON.parse(b.toString('utf-8'))));
  } catch {
    return false;
  }
}

function isTextFile(name: string): boolean {
  return TEXT_EXTENSIONS.has(path.extname(name).toLowerCase()) || name in TEMPLATE_NAME_MAP;
}

/**
 * Resolves the shipped `templates/` directory.
 *
 * Compiled output lands at `dist/server/services/` when packaged and
 * `server/dist/services/` in the source tree; three levels up is the package
 * root in both cases.
 */
export function getTemplatesPath(): string {
  const override = process.env['ESB_TEMPLATES_PATH'];
  if (override) return override;

  const candidates = [
    path.resolve(__dirname, '../../..', 'templates'),
    path.resolve(__dirname, '../../../..', 'templates'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return candidates[0] as string;
}

let appVersion: string | null = null;

/**
 * The version of the app running in this process, read once: an update installed while it runs changes the files on
 * disk, not the code running (#284).
 */
export function getAppVersion(): string {
  appVersion ??= readAppVersion();
  return appVersion;
}

/** The version in the app's package.json now, as installed on disk. */
export function readAppVersion(): string {
  const candidates = [
    path.resolve(__dirname, '../../..', 'package.json'),
    path.resolve(__dirname, '../../../..', 'package.json'),
  ];
  for (const candidate of candidates) {
    try {
      const pkg = JSON.parse(fs.readFileSync(candidate, 'utf-8'));
      if (pkg && pkg.name && pkg.version) return String(pkg.version);
    } catch {
      // try the next candidate
    }
  }
  return '0.0.0';
}

export function isExistingWorkspace(dir: string): boolean {
  return fs.existsSync(path.join(dir, 'workspace.yaml'));
}

export function ensureWorkspaceDirs(workspacePath: string): void {
  for (const dir of WORKSPACE_DIRS) {
    fs.mkdirSync(path.join(workspacePath, dir), { recursive: true });
  }
}

/**
 * Fills the profile placeholders only. `{{date}}` and `{{due_date}}` are routine title
 * placeholders, so the instructions and schemas must show them as written.
 */
function interpolate(content: string, vars: Record<string, string>): string {
  // Functions, not strings, so `$$` or `$&` in a value is written as typed, not read as a replacement pattern.
  // One pass also keeps placeholder-looking text inside a profile value literal.
  return content.replace(/\{\{(name|role|organization)\}\}/g, (_match, key: string) => vars[key] || '');
}

/** The exact bytes a template file produces for this workspace. `transform` reshapes a text file before the profile fills it. */
function renderTemplate(srcPath: string, vars: Record<string, string>, transform?: TemplateTransform): Buffer {
  const name = path.basename(srcPath);
  if (!isTextFile(name)) return fs.readFileSync(srcPath);
  const raw = fs.readFileSync(srcPath, 'utf-8');
  return Buffer.from(interpolate(transform ? transform(raw) : raw, vars), 'utf-8');
}

/** Walks a template tree and yields [absoluteSourcePath, workspaceRelativeDestPath] pairs. */
function walkTemplates(src: string, relBase = ''): [string, string][] {
  if (!fs.existsSync(src)) return [];

  const out: [string, string][] = [];
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destName = TEMPLATE_NAME_MAP[entry.name] ?? entry.name;
    const relPath = relBase ? path.join(relBase, destName) : destName;

    if (entry.isDirectory()) {
      out.push(...walkTemplates(srcPath, relPath));
    } else {
      out.push([srcPath, relPath]);
    }
  }
  return out;
}

/** The AI tools that read the workspace procedures as Agent Skills from `.agents/skills/` (Claude Code has its own). */
const PORTABLE_SKILL_TOOLS: readonly AiTool[] = ['codex', 'copilot'];

/**
 * Every app-owned template file for this workspace, given the selected AI tools, as [source, workspace path,
 * transform]. Codex and Copilot also get Claude Code's procedures, specialists and skills as Agent Skills, once.
 */
function collectAppFiles(aiTools: AiTool[] = []): PortableFile[] {
  const templatesPath = getTemplatesPath();
  const files: PortableFile[] = walkTemplates(path.join(templatesPath, 'workspace'));

  for (const tool of aiTools) {
    files.push(...walkTemplates(path.join(templatesPath, 'ai', tool)));
  }
  if (aiTools.some((tool) => PORTABLE_SKILL_TOOLS.includes(tool))) {
    files.push(...portableSkillFiles(path.join(templatesPath, 'ai', 'claude-code')));
  }
  return files;
}

export function writeWorkspaceYaml(workspacePath: string, workspaceName: string): boolean {
  const yamlPath = path.join(workspacePath, 'workspace.yaml');
  if (fs.existsSync(yamlPath)) return false;

  // `git_enabled` and `schema_versions` are top-level because
  // WorkspaceService.getWorkspaceConfig() parses them from there.
  // `schema_versions` must precede the nested blocks: that parser stays in
  // schema mode until it sees a line with no leading whitespace.
  const content = [
    `name: ${quoteYaml(workspaceName)}`,
    'version: "1.0"',
    `created_at: "${new Date().toISOString()}"`,
    'git_enabled: false',
    'schema_versions:',
    '  task: "1.0"',
    '  stakeholder: "1.0"',
    '  context: "1.0"',
    '  output: "1.0"',
    '  profile: "1.0"',
    'settings:',
    '  git:',
    '    enabled: false',
    '    auto_commit: false',
    '  validation:',
    '    strict_mode: false',
    '    warn_on_missing_refs: true',
    '  ui:',
    '    default_view: situation',
    '    kanban_wip_limit: 5',
    '    items_per_page: 25',
    'paths:',
    '  tasks: tasks',
    '  stakeholders: stakeholders',
    '  outputs: outputs',
    '  context: context',
    '  context_updates: context-updates',
    '  profile: profile',
    '  kaizen: kaizen',
    '  routines: routines',
    '  agents: .claude/agents',
    '  skills: .claude/skills',
    '  cache: .situation-board/cache',
    '',
  ].join('\n');

  fs.writeFileSync(yamlPath, content, 'utf-8');
  return true;
}

export function writeExecutiveProfile(workspacePath: string, profile: WorkspaceProfile): boolean {
  const profilePath = path.join(workspacePath, 'profile', 'executive-profile.md');
  if (fs.existsSync(profilePath)) return false;

  fs.mkdirSync(path.dirname(profilePath), { recursive: true });

  const today = new Date().toISOString().split('T')[0];
  const content = [
    '---',
    `name: ${quoteYaml(profile.name)}`,
    `role: ${quoteYaml(profile.role)}`,
    `organization: ${quoteYaml(profile.organization)}`,
    `updated_at: "${today}"`,
    '---',
    '',
    '## Responsibilities',
    '',
    '<!-- Describe your main responsibilities here -->',
    '',
    '## Communication Style',
    '',
    '<!-- How do you prefer to communicate? Direct, formal, data-driven? -->',
    '',
    '## Decision Making',
    '',
    '<!-- How do you make decisions? What matters most to you? -->',
    '',
    '## Language Preferences',
    '',
    '<!-- English, Japanese, or both? Any style guidelines? -->',
    '',
    '## Recurring Expectations',
    '',
    '<!-- What do you always expect in deliverables? -->',
    '',
    '## Principles',
    '',
    '<!-- What principles guide your work? -->',
    '',
  ].join('\n');

  fs.writeFileSync(profilePath, content, 'utf-8');
  return true;
}

function writeUiPreferences(workspacePath: string): void {
  const uiPrefsPath = path.join(workspacePath, '.situation-board', 'ui-preferences.json');
  if (fs.existsSync(uiPrefsPath)) return;
  fs.mkdirSync(path.dirname(uiPrefsPath), { recursive: true });
  fs.writeFileSync(
    uiPrefsPath,
    JSON.stringify({ theme: 'system', default_view: 'situation', sidebar_collapsed: false }, null, 2),
    'utf-8'
  );
}

/**
 * Writes a whole file at once: a reader sees the old file or the new one, never a half-written one. It keeps the
 * file's permissions. With `expected`, only while the file still has that hash, which narrows (it cannot close) the
 * window for a change made meanwhile. False when it was not written.
 */
function replaceFile(dest: string, content: string | Buffer, expected: string | null): boolean {
  const temp = `${dest}.${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    const mode = fs.existsSync(dest) ? fs.statSync(dest).mode & 0o777 : undefined;
    fs.writeFileSync(temp, content, { flag: 'wx', ...(mode !== undefined ? { mode } : {}) });
    if (mode !== undefined) fs.chmodSync(temp, mode);
    if (expected !== null && sha256(fs.readFileSync(dest)) !== expected) return false;
    fs.renameSync(temp, dest);
    return true;
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

export function readManifest(workspacePath: string): AppManifest | null {
  const manifestPath = path.join(workspacePath, MANIFEST_RELATIVE_PATH);
  if (!fs.existsSync(manifestPath)) return null;
  try {
    const value: unknown = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const manifest = value as AppManifest;
    if (typeof manifest.appVersion !== 'string' || !Array.isArray(manifest.files)
      || !manifest.files.every((file) => file && typeof file.path === 'string' && typeof file.sha256 === 'string')) return null;
    return manifest;
  } catch {
    return null;
  }
}

export function writeManifest(workspacePath: string, files: ManifestEntry[]): void {
  const manifestPath = path.join(workspacePath, MANIFEST_RELATIVE_PATH);
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  // Nothing changed: the file stays as it is, so an opening leaves a git workspace clean.
  // One key order, whoever built the entries, so the same record is the same text.
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path)).map((f): ManifestEntry => ({
    path: f.path,
    sha256: f.sha256,
    ...(f.base_sha256 !== undefined ? { base_sha256: f.base_sha256 } : {}),
    ...(f.new_sha256 !== undefined ? { new_sha256: f.new_sha256 } : {}),
    ...(f.merged_sha256 !== undefined ? { merged_sha256: f.merged_sha256 } : {}),
  }));
  const previous = readManifest(workspacePath);
  if (previous?.appVersion === getAppVersion() && previous.newCopiesTracked && JSON.stringify(previous.files) === JSON.stringify(sorted)) return;

  const manifest: AppManifest = {
    appVersion: getAppVersion(),
    generatedAt: new Date().toISOString(),
    files: sorted,
    newCopiesTracked: true,
  };
  replaceFile(manifestPath, JSON.stringify(manifest, null, 2), null);
}

/**
 * Creates a workspace. Existing files are never overwritten, so this is safe to
 * re-run over a partially created directory.
 */
export function scaffoldWorkspace(workspacePath: string, opts: ScaffoldOptions): ScaffoldResult {
  const { profile, workspaceName = 'Executive Workspace', aiTools = [] } = opts;

  ensureWorkspaceDirs(workspacePath);

  const created: string[] = [];
  const skipped: string[] = [];
  const manifestEntries: ManifestEntry[] = [];

  for (const [srcPath, relPath, transform] of collectAppFiles(aiTools)) {
    const destPath = path.join(workspacePath, relPath);
    const content = renderTemplate(srcPath, profile, transform);

    // Record provenance even when skipping, so upgrade can still reason about the file.
    const entry: ManifestEntry = { path: relPath, sha256: sha256(content) };
    manifestEntries.push(entry);
    // Every version the app ships is kept, so a later release can be compared from it.
    const stored = storeAppFile(workspacePath, content);

    if (fs.existsSync(destPath)) {
      skipped.push(relPath);
      // A file that was there already is the user's: its base is known only when it is exactly this version.
      try {
        if (fs.lstatSync(destPath).isFile() && sha256(fs.readFileSync(destPath)) === entry.sha256 && stored) entry.base_sha256 = entry.sha256;
      } catch { /* no base */ }
      continue;
    }

    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, content);
    if (stored) entry.base_sha256 = entry.sha256;
    created.push(relPath);
  }

  if (writeWorkspaceYaml(workspacePath, workspaceName)) created.push('workspace.yaml');
  if (writeExecutiveProfile(workspacePath, profile)) created.push('profile/executive-profile.md');
  writeUiPreferences(workspacePath);

  writeManifest(workspacePath, manifestEntries);
  pruneAppFiles(workspacePath, appFilesInUse(manifestEntries));

  return { created, skipped };
}

/**
 * Refreshes app-owned files after the package is updated.
 *
 * A file is safe to overwrite only when its current bytes still match what the
 * manifest recorded. Anything else is treated as a user edit and preserved, with
 * the new version written alongside as `<file>.new`.
 */
export function upgradeWorkspace(workspacePath: string, opts: ScaffoldOptions): UpgradeResult {
  const { profile, aiTools = [] } = opts;

  ensureWorkspaceDirs(workspacePath);

  const previous = readManifest(workspacePath);
  const previousByPath = new Map((previous?.files ?? []).map((f) => [f.path, f.sha256]));
  // Which `.new` beside a file is still the app's own copy. An older manifest did not record them: its `.new` is
  // the app's only while it is exactly the version that manifest lists, which is what that release wrote.
  // What the user acknowledged merging, only from a manifest that records `.new` copies (an older one never wrote it).
  const mergedVersion = new Map((previous?.newCopiesTracked ? previous.files : []).flatMap((f) =>
    (typeof f.merged_sha256 === 'string' && SHA256_HEX.test(f.merged_sha256) ? [[f.path, f.merged_sha256] as const] : [])));
  // The version each file was based on. Only a pointer is carried over; an older manifest has none and none is guessed.
  const previousBase = new Map((previous?.files ?? []).flatMap((f) =>
    (typeof f.base_sha256 === 'string' && SHA256_HEX.test(f.base_sha256) ? [[f.path, f.base_sha256] as const] : [])));
  const appNewCopy = new Map((previous?.files ?? []).flatMap((f) => {
    const hash = previous?.newCopiesTracked ? f.new_sha256 : f.sha256;
    return hash ? [[f.path, hash] as const] : [];
  }));

  const result: UpgradeResult = {
    updated: [],
    added: [],
    conflicted: [],
    unchanged: [],
    removed: [],
    retired_kept: [],
    merged: [],
    fromVersion: previous?.appVersion ?? null,
    toVersion: getAppVersion(),
  };

  const manifestEntries: ManifestEntry[] = [];

  for (const [srcPath, relPath, transform] of collectAppFiles(aiTools)) {
    const destPath = path.join(workspacePath, relPath);
    const nextContent = renderTemplate(srcPath, profile, transform);
    const nextHash = sha256(nextContent);

    const entry: ManifestEntry = { path: relPath, sha256: nextHash };
    manifestEntries.push(entry);
    // Until it is known that the user has this version (below), the file keeps the base it had: a skipped release or
    // an unresolved update compares from the version they last had.
    const keptBase = previousBase.get(relPath);
    if (keptBase) entry.base_sha256 = keptBase;
    // Every version the app ships is kept (best effort: a failure never stops the upgrade; that version then compares
    // as unknown), whether or not the base moves to it: an unresolved update is compared from
    // its base to exactly this text, and resolving it later makes this the base.
    const stored = storeAppFile(workspacePath, nextContent);
    const baseIsThisVersion = () => {
      if (stored) entry.base_sha256 = nextHash;
      else delete entry.base_sha256;
    };
    // The app's own `.new` from before stays recorded while it is unchanged, whatever happens to the file this time:
    // a conflict that comes back in a later release still finds it.
    const newPath = `${destPath}.new`;
    const ours = appNewCopy.get(relPath);
    const existingNew = ours ? appNewCopyHash(newPath) : null;
    if (ours && existingNew === ours) entry.new_sha256 = ours;
    // An acknowledgement holds only for the exact version the app ships now, whatever happens to the file this time.
    if (mergedVersion.get(relPath) === nextHash) entry.merged_sha256 = nextHash;
    // An "I merged it" interrupted before its `.new` was removed: the app's own unchanged copy of this exact version goes
    // now, whatever the file looks like since. Any other `.new` is the user's and stays.
    if (entry.merged_sha256 && entry.new_sha256 === nextHash && existingNew === nextHash && removeNewCopy(newPath, nextHash, workspacePath)) delete entry.new_sha256;

    if (!fs.existsSync(destPath)) {
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      replaceFile(destPath, nextContent, null);
      baseIsThisVersion();
      result.added.push(relPath);
      continue;
    }

    const currentContent = fs.readFileSync(destPath);
    const currentHash = sha256(currentContent);
    if (currentHash === nextHash || isEquivalentJson(relPath, currentContent, nextContent)) {
      baseIsThisVersion();
      result.unchanged.push(relPath);
      continue;
    }

    const recordedHash = previousByPath.get(relPath);
    if (recordedHash && recordedHash === currentHash) {
      // Untouched since we wrote it, so replacing it loses nothing; unless it changes while this runs.
      if (replaceFile(destPath, nextContent, currentHash)) {
        baseIsThisVersion();
        result.updated.push(relPath);
      } else {
        result.conflicted.push(relPath);
      }
    } else if (entry.merged_sha256) {
      // The user merged this exact version into their own file: not a conflict, and no `.new` for it.
      baseIsThisVersion();
      result.merged.push(relPath);
    } else {
      // Either user-edited, or predates the manifest. Never clobber it, nor a `.new` someone may be merging. A new one
      // is made only where there is none.
      try {
        fs.writeFileSync(newPath, nextContent, { flag: 'wx' });
        entry.new_sha256 = nextHash;
      } catch (err) {
        // Only one already there is kept; any other failure is a failure.
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        // Still the app's copy from an earlier release: it would show an outdated version, so it becomes this one.
        // Changed since, unreadable or not a plain file, it is the user's and stays as it is, untracked.
        if (entry.new_sha256 && existingNew !== nextHash && replaceNewCopy(newPath, nextContent, entry.new_sha256)) entry.new_sha256 = nextHash;
      }
      result.conflicted.push(relPath);
    }
  }

  for (const relPath of RETIRED_APP_FILES) {
    const destPath = path.join(workspacePath, relPath);
    let current: Buffer;
    try {
      if (!fs.lstatSync(destPath).isFile()) continue;
      current = fs.readFileSync(destPath);
    } catch {
      continue;
    }
    const recordedHash = previousByPath.get(relPath);
    if (recordedHash && recordedHash === sha256(current)) {
      fs.rmSync(destPath);
      result.removed.push(relPath);
    } else {
      result.retired_kept.push(relPath);
    }
  }

  writeManifest(workspacePath, manifestEntries);
  pruneAppFiles(workspacePath, appFilesInUse(manifestEntries));

  return result;
}

/** The executive's name, role and organization from the profile, so templates render as `gtd init` rendered them. */
export function readWorkspaceProfile(workspacePath: string): WorkspaceProfile {
  const profile: WorkspaceProfile = { name: '', role: '', organization: '' };
  const profilePath = path.join(workspacePath, 'profile', 'executive-profile.md');
  if (!fs.existsSync(profilePath)) return profile;
  let data: Record<string, unknown>;
  try { data = parseMarkdown(fs.readFileSync(profilePath, 'utf-8')).data as Record<string, unknown>; } catch { return profile; }
  for (const key of ['name', 'role', 'organization'] as const) if (typeof data[key] === 'string') profile[key] = data[key].trim();
  return profile;
}

/** Whether version `a` is newer than `b` (both like 0.8.1). */
export function newerVersion(a: string, b: string): boolean {
  const parts = (v: string) => v.split(/[.-]/).slice(0, 3).map((n) => Number.parseInt(n, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
}

/** The AI tools the workspace already has: a refresh never adds one. Every workspace has `.claude/`, so it is no sign. */
export function detectAiTools(workspacePath: string): AiTool[] {
  const markers: Record<AiTool, string> = {
    'claude-code': 'CLAUDE.md',
    copilot: path.join('.github', 'copilot-instructions.md'),
    codex: 'AGENTS.md',
  };
  return (Object.keys(markers) as AiTool[]).filter((tool) => fs.existsSync(path.join(workspacePath, markers[tool])));
}

/**
 * The app's current version of every file it ships to this workspace, rendered as an upgrade would render it now:
 * workspace-relative path, bytes and hash. What an upgrade compares against; never read from the manifest.
 */
export function appFileVersions(workspacePath: string, profile = readWorkspaceProfile(workspacePath)): Map<string, { content: Buffer; sha256: string }> {
  const versions = new Map<string, { content: Buffer; sha256: string }>();
  for (const [srcPath, relPath, transform] of collectAppFiles(detectAiTools(workspacePath))) {
    const content = renderTemplate(srcPath, profile, transform);
    versions.set(relPath, { content, sha256: sha256(content) });
  }
  return versions;
}

/**
 * The app's current version of one file it ships to this workspace, rendered as `appFileVersions` renders it, without
 * reading any other template. Undefined when the app does not ship that path here.
 */
export function appFileVersion(workspacePath: string, relPath: string, profile = readWorkspaceProfile(workspacePath)): { content: Buffer; sha256: string } | undefined {
  // The last one wins, as in `appFileVersions`.
  const found = collectAppFiles(detectAiTools(workspacePath)).filter(([, rel]) => rel === relPath).pop();
  if (!found) return undefined;
  const content = renderTemplate(found[0], profile, found[2]);
  return { content, sha256: sha256(content) };
}

/** Whether two versions of an app file mean the same (equal bytes, or JSON that only differs in order). */
export function sameAppFile(relPath: string, a: Buffer, b: Buffer): boolean {
  return sha256(a) === sha256(b) || isEquivalentJson(relPath, a, b);
}

/**
 * Brings a workspace's app-provided files (agent instructions, procedures, schemas) up to this version of the app,
 * like `gtd upgrade`: a file the user changed is never replaced. The dashboard does it when a workspace opens, so the
 * desktop app, which has no terminal, keeps its agents in step with the app.
 */
export function refreshAppFiles(workspacePath: string): UpgradeResult | null {
  // An older app never takes a workspace back: two versions would rewrite the files in turn.
  const recorded = readManifest(workspacePath)?.appVersion;
  if (recorded && newerVersion(recorded, getAppVersion())) return null;
  return upgradeWorkspace(workspacePath, { profile: readWorkspaceProfile(workspacePath), aiTools: detectAiTools(workspacePath) });
}
