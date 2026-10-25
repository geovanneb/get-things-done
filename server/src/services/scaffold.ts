import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

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
  'workflows',
  '.claude/agents',
  '.claude/commands',
  '.claude/skills',
  '.situation-board/cache',
  '.situation-board/logs',
  '.situation-board/trash',
];

export const MANIFEST_RELATIVE_PATH = path.join('.situation-board', 'app-manifest.json');

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
}

export interface AppManifest {
  appVersion: string;
  generatedAt: string;
  files: ManifestEntry[];
}

function sha256(buf: Buffer | string): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
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

export function getAppVersion(): string {
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

function interpolate(content: string, vars: Record<string, string>): string {
  return content
    .replace(/\{\{name\}\}/g, vars['name'] || '')
    .replace(/\{\{role\}\}/g, vars['role'] || '')
    .replace(/\{\{organization\}\}/g, vars['organization'] || '')
    .replace(/\{\{date\}\}/g, new Date().toISOString().split('T')[0] ?? '');
}

/** The exact bytes a template file produces for this workspace. */
function renderTemplate(srcPath: string, vars: Record<string, string>): Buffer {
  const name = path.basename(srcPath);
  if (!isTextFile(name)) return fs.readFileSync(srcPath);
  return Buffer.from(interpolate(fs.readFileSync(srcPath, 'utf-8'), vars), 'utf-8');
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

/** Every app-owned template file for this workspace, given the selected AI tools. */
function collectAppFiles(aiTools: AiTool[] = []): [string, string][] {
  const templatesPath = getTemplatesPath();
  const files = walkTemplates(path.join(templatesPath, 'workspace'));

  for (const tool of aiTools) {
    files.push(...walkTemplates(path.join(templatesPath, 'ai', tool)));
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
    `name: "${workspaceName}"`,
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
    `name: "${profile.name}"`,
    `role: "${profile.role}"`,
    `organization: "${profile.organization}"`,
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

export function readManifest(workspacePath: string): AppManifest | null {
  const manifestPath = path.join(workspacePath, MANIFEST_RELATIVE_PATH);
  if (!fs.existsSync(manifestPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as AppManifest;
  } catch {
    return null;
  }
}

export function writeManifest(workspacePath: string, files: ManifestEntry[]): void {
  const manifestPath = path.join(workspacePath, MANIFEST_RELATIVE_PATH);
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });

  const manifest: AppManifest = {
    appVersion: getAppVersion(),
    generatedAt: new Date().toISOString(),
    files: [...files].sort((a, b) => a.path.localeCompare(b.path)),
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
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

  for (const [srcPath, relPath] of collectAppFiles(aiTools)) {
    const destPath = path.join(workspacePath, relPath);
    const content = renderTemplate(srcPath, profile);

    // Record provenance even when skipping, so upgrade can still reason about the file.
    manifestEntries.push({ path: relPath, sha256: sha256(content) });

    if (fs.existsSync(destPath)) {
      skipped.push(relPath);
      continue;
    }

    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, content);
    created.push(relPath);
  }

  if (writeWorkspaceYaml(workspacePath, workspaceName)) created.push('workspace.yaml');
  if (writeExecutiveProfile(workspacePath, profile)) created.push('profile/executive-profile.md');
  writeUiPreferences(workspacePath);

  writeManifest(workspacePath, manifestEntries);

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

  const result: UpgradeResult = {
    updated: [],
    added: [],
    conflicted: [],
    unchanged: [],
    fromVersion: previous?.appVersion ?? null,
    toVersion: getAppVersion(),
  };

  const manifestEntries: ManifestEntry[] = [];

  for (const [srcPath, relPath] of collectAppFiles(aiTools)) {
    const destPath = path.join(workspacePath, relPath);
    const nextContent = renderTemplate(srcPath, profile);
    const nextHash = sha256(nextContent);

    manifestEntries.push({ path: relPath, sha256: nextHash });

    if (!fs.existsSync(destPath)) {
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.writeFileSync(destPath, nextContent);
      result.added.push(relPath);
      continue;
    }

    const currentHash = sha256(fs.readFileSync(destPath));
    if (currentHash === nextHash) {
      result.unchanged.push(relPath);
      continue;
    }

    const recordedHash = previousByPath.get(relPath);
    if (recordedHash && recordedHash === currentHash) {
      // Untouched since we wrote it, so replacing it loses nothing.
      fs.writeFileSync(destPath, nextContent);
      result.updated.push(relPath);
    } else {
      // Either user-edited, or predates the manifest. Never clobber it.
      fs.writeFileSync(`${destPath}.new`, nextContent);
      result.conflicted.push(relPath);
    }
  }

  writeManifest(workspacePath, manifestEntries);

  return result;
}
