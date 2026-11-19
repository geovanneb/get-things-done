import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { ChildProcess } from 'child_process';
import { findCommand } from '../aiToolDetection';
import { killTree, launch, stopTree } from '../agentRunner';
import { RpcConnection } from './rpc';
import {
  isObject, shortDetail, turnError, TURN_TIMEOUT_MS,
  type ChatAdapter, type ChatEvent, type ChatModel, type ChatOpenOptions, type ChatSession, type ProviderStatus, type RunStepKind, type TurnOutcome,
} from './types';

/**
 * GitHub Copilot as a chat, through `copilot --acp`: the Agent Client Protocol server of the Copilot CLI. One
 * process per conversation. Read-only by an allow-list: `--available-tools` leaves the model only Copilot's read
 * and search tools (`view`, `grep`, `glob`), so shell, edits, subagents, SQL, workflows and every MCP tool are
 * not even offered. On top of that, shell, writes, URLs and memory are denied outright (`--deny-tool` wins over
 * every allow, including approvals the user saved for a folder), any permission question that still comes is
 * refused, and nothing the user set up starts: the built-in MCP servers and every server in the user's and the
 * workspace's MCP files are turned off by name, plugins are not discovered (`COPILOT_PLUGIN_DIR_ONLY`), and
 * experimental features (extensions) are off. Custom model providers (BYOK) are removed from its environment,
 * so it uses the Copilot plan of the GitHub account it is signed in to.
 *
 * Copilot has no option that turns hooks off for a run (`disableAllHooks` in its settings leaves the hooks folder
 * and the repository's hooks on), so a workspace or profile with hooks set up is not used for the chat, and a
 * Copilot CLI without the options above is not used either: both are reported as the reason.
 *
 * Copilot does not report plan usage over ACP, and each message counts toward the plan's premium requests; the
 * page says so next to the picker.
 */

const STATUS_TTL_MS = 10 * 60 * 1000;
const PROBE_TIMEOUT_MS = 30_000;

/** The only tools the chat's model is offered: Copilot's own file reading and search. */
export const COPILOT_TOOLS = ['view', 'grep', 'glob'];
/** The options the lock-down needs; a Copilot CLI without one of them is not used. */
const REQUIRED_OPTIONS = ['--available-tools', '--deny-tool', '--disable-builtin-mcps', '--disable-mcp-server', '--no-experimental', '--no-ask-user'];
/** Copilot's note that the allow-list hid tools, sent as answer text before the answer itself. */
const DISABLED_TOOLS_NOTE = /^Info: Disabled tools: [^\n]*\n?$/;

export function copilotEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const name of Object.keys(env)) {
    if (name.startsWith('COPILOT_PROVIDER_') || name === 'COPILOT_PROVIDERS_CONFIG' || name === 'COPILOT_ALLOW_ALL' || name === 'COPILOT_OFFLINE') delete env[name];
    // Opt-ins that load a folder's hooks and extensions.
    if (name.startsWith('GITHUB_COPILOT_PROMPT_MODE_')) delete env[name];
  }
  // Only plugins passed with --plugin-dir load, and the chat passes none: no plugin hooks, MCP servers or agents.
  env['COPILOT_PLUGIN_DIR_ONLY'] = 'true';
  return env;
}

function copilotHome(env: NodeJS.ProcessEnv): string {
  return env['COPILOT_HOME'] ?? path.join(env['HOME'] ?? os.homedir(), '.copilot');
}

/**
 * JSON with comments, as Copilot reads its settings: a leading byte order mark, `//` comments (ended by LF, CR or
 * CRLF), `/* *\/` comments and trailing commas (also when a comment follows the comma) are dropped outside strings,
 * then the text is parsed as JSON. Throws when it still is not JSON.
 */
export function parseJsonc(text: string): unknown {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  // Pass 1: comments out, strings kept as they are.
  let bare = '';
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!;
    if (c === '"') {
      let j = i + 1;
      while (j < source.length && source[j] !== '"') j += source[j] === '\\' ? 2 : 1;
      bare += source.slice(i, j + 1);
      i = j;
    } else if (c === '/' && source[i + 1] === '/') {
      while (i + 1 < source.length && source[i + 1] !== '\n' && source[i + 1] !== '\r') i++;
      bare += ' ';
    } else if (c === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      if (end < 0) throw new SyntaxError('Unclosed comment');
      i = end + 1;
      bare += ' ';
    } else {
      bare += c;
    }
  }
  // Pass 2: a comma followed only by white space and a closing bracket is dropped.
  let out = '';
  for (let i = 0; i < bare.length; i++) {
    const c = bare[i]!;
    if (c === '"') {
      let j = i + 1;
      while (j < bare.length && bare[j] !== '"') j += bare[j] === '\\' ? 2 : 1;
      out += bare.slice(i, j + 1);
      i = j;
    } else if (c === ',') {
      let j = i + 1;
      while (j < bare.length && /\s/.test(bare[j]!)) j++;
      if (bare[j] !== '}' && bare[j] !== ']') out += c;
    } else {
      out += c;
    }
  }
  return JSON.parse(out) as unknown;
}

/** What one scan of the user's and the workspace's Copilot configuration found. */
export interface CopilotScan {
  /** Every MCP server name the chat turns off. */
  servers: string[];
  /** Files whose hooks Copilot would run. */
  hooks: string[];
  /** Configuration that exists but could not be read: what it sets up is unknown, so Copilot is not used. */
  unreadable: string[];
}

/** A file's parsed content, `undefined` when it does not exist; an unreadable one is added to `unreadable`. */
function readConfig(file: string, unreadable: string[]): unknown {
  let text: string;
  try { text = fs.readFileSync(file, 'utf-8'); } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') unreadable.push(file);
    return undefined;
  }
  try { return parseJsonc(text); } catch { unreadable.push(file); return undefined; }
}

function hookFiles(dir: string, unreadable: string[]): string[] {
  try { return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => path.join(dir, f)); } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT' && (err as NodeJS.ErrnoException).code !== 'ENOTDIR') unreadable.push(dir);
    return [];
  }
}

/** The folders Copilot reads a workspace's configuration from: the workspace up to its repository's root. */
function configFolders(workspace: string): string[] {
  const chain: string[] = [];
  for (let dir = path.resolve(workspace); ; dir = path.dirname(dir)) {
    chain.push(dir);
    if (fs.existsSync(path.join(dir, '.git'))) return chain;
    // Outside a repository, only the folder itself.
    if (path.dirname(dir) === dir) return [path.resolve(workspace)];
  }
}

function hasHooks(config: unknown): boolean {
  const hooks = isObject(config) ? config['hooks'] : null;
  return isObject(hooks) && Object.values(hooks).some((list) => Array.isArray(list) ? list.length > 0 : list != null);
}

/** Whether Copilot trusts the workspace: it, or a folder above it, is in `trustedFolders` of its own config. */
function trusted(home: string, workspace: string): boolean {
  let config: unknown;
  try { config = parseJsonc(fs.readFileSync(path.join(home, 'config.json'), 'utf-8')); } catch { return false; }
  const folders = isObject(config) && Array.isArray(config['trustedFolders']) ? config['trustedFolders'].filter((f): f is string => typeof f === 'string') : [];
  const targets = [path.resolve(workspace)];
  try { targets.push(fs.realpathSync(workspace)); } catch { /* the path alone */ }
  return folders.some((f) => targets.some((t) => t === path.resolve(f) || t.startsWith(path.resolve(f) + path.sep)));
}

/**
 * The user's and (when given) the workspace's Copilot configuration: the MCP servers to turn off, and the hooks
 * Copilot would run in a conversation there. Hooks come from the user's settings and hooks folder, and from the
 * workspace's (up to its repository root) `.github/hooks`, Copilot settings and Claude Code settings, which
 * Copilot also reads. Settings are JSON with comments, as Copilot reads them.
 *
 * Inline hooks in settings files follow what Copilot 1.0.114 did with them: a personal `disableAllHooks: true`
 * turns off only the personal settings' hooks; in a workspace Copilot trusts, a repository settings file with
 * `disableAllHooks: true` (and none setting it to false) turns off the personal and the repository settings'
 * hooks. Repository settings are read only in a trusted workspace, but their hooks are counted either way unless
 * they are turned off: trust can change before the chat starts. Hook files (`hooks/`, `.github/hooks/`) count
 * whatever the settings say; Copilot ran them with `disableAllHooks` set.
 */
export function copilotScan(env: NodeJS.ProcessEnv, workspace: string | null): CopilotScan {
  const home = copilotHome(env);
  const scan: CopilotScan = { servers: [], hooks: [], unreadable: [] };
  const serversIn = (file: string) => {
    const config = readConfig(file, scan.unreadable);
    if (isObject(config) && isObject(config['mcpServers'])) scan.servers.push(...Object.keys(config['mcpServers']));
  };
  const personal = readConfig(path.join(home, 'settings.json'), scan.unreadable);
  const hookFileHits: string[] = [];
  const settings: { file: string; config: unknown }[] = [];
  serversIn(path.join(home, 'mcp-config.json'));
  for (const file of hookFiles(path.join(home, 'hooks'), scan.unreadable)) if (hasHooks(readConfig(file, scan.unreadable))) hookFileHits.push(file);
  if (workspace) {
    for (const dir of configFolders(workspace)) {
      // A folder's `.github/mcp.json` counts only when it has no `.mcp.json`; both are turned off, to be safe.
      serversIn(path.join(dir, '.mcp.json'));
      serversIn(path.join(dir, '.github', 'mcp.json'));
      for (const file of hookFiles(path.join(dir, '.github', 'hooks'), scan.unreadable)) if (hasHooks(readConfig(file, scan.unreadable))) hookFileHits.push(file);
      for (const file of [
        path.join(dir, '.github', 'copilot', 'settings.json'), path.join(dir, '.github', 'copilot', 'settings.local.json'),
        path.join(dir, '.claude', 'settings.json'), path.join(dir, '.claude', 'settings.local.json'),
      ]) {
        const config = readConfig(file, scan.unreadable);
        if (config !== undefined) settings.push({ file, config });
      }
    }
  }
  const flag = (config: unknown) => (isObject(config) ? config['disableAllHooks'] : undefined);
  const repoOff = !!workspace && trusted(home, workspace)
    && settings.some((s) => flag(s.config) === true) && !settings.some((s) => flag(s.config) === false);
  if (hasHooks(personal) && flag(personal) !== true && !repoOff) scan.hooks.push(path.join(home, 'settings.json'));
  scan.hooks.push(...hookFileHits);
  for (const s of settings) if (hasHooks(s.config) && flag(s.config) !== true && !repoOff) scan.hooks.push(s.file);
  scan.servers = [...new Set(scan.servers)];
  return scan;
}

/** A server name that cannot be passed on a command line: control characters, or what cmd.exe would read. */
function unrepresentable(name: string, viaCmd: boolean): boolean {
  // eslint-disable-next-line no-control-regex
  return name === '' || /[\u0000-\u001f\u007f]/.test(name) || (viaCmd && /["%!^]/.test(name));
}

/**
 * Deny rules take `name(tool)` patterns, and Copilot 1.0.114 refuses to start on a rule it cannot read (`a@b:c`,
 * `ünï` and `eq=x` were refused; letters, digits, `_ . / -` accepted). Only such a name gets a rule of its own;
 * every server is still turned off by name, and the read-tool allow-list hides its tools either way.
 */
const PLAIN_RULE = /^[A-Za-z0-9_./-]+$/;

export function copilotArgs(env: NodeJS.ProcessEnv, workspace: string | null, model: string | null, effort: string | null, scan: CopilotScan = copilotScan(env, workspace)): string[] {
  const deny = ['shell', 'write', 'url', 'memory'];
  return [
    '--acp', '--stdio', '--disable-builtin-mcps', '--disallow-temp-dir', '--no-ask-user', '--no-experimental',
    `--available-tools=${COPILOT_TOOLS.join(',')}`,
    ...deny.flatMap((rule) => [`--deny-tool=${rule}`]),
    // One argument each (`--option=value`), never through a shell: any name, a leading dash or an `=` included.
    ...scan.servers.flatMap((name) => [`--disable-mcp-server=${name}`, ...(PLAIN_RULE.test(name) ? [`--deny-tool=${name}`] : [])]),
    ...(model ? ['--model', model] : []),
    ...(effort ? ['--effort', effort] : []),
  ];
}

function shown(file: string, workspace: string): string {
  const home = os.homedir();
  const rel = path.relative(workspace, file);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel;
  return file.startsWith(home + path.sep) ? `~${file.slice(home.length)}` : file;
}

/** Why Copilot cannot be used read-only for this workspace, or null. */
export function copilotLockdownProblem(help: string | null, scan: CopilotScan, workspace: string, viaCmd = false): string | null {
  if (help === null || REQUIRED_OPTIONS.some((option) => !help.includes(option))) {
    return 'This GitHub Copilot CLI version cannot be limited to reading files for the chat. Update it (copilot update), then try again.';
  }
  if (scan.unreadable.length) {
    const where = scan.unreadable.slice(0, 3).map((f) => shown(f, workspace)).join(', ');
    return `GitHub Copilot's configuration in ${where} could not be read, so the dashboard cannot tell which hooks and MCP servers it would start. Fix the file, or use another tool for the chat.`;
  }
  const bad = scan.servers.filter((name) => unrepresentable(name, viaCmd));
  if (bad.length) {
    return `GitHub Copilot has an MCP server whose name cannot be passed to it to turn it off (${JSON.stringify(bad[0])}). Rename it, or use another tool for the chat.`;
  }
  if (scan.hooks.length) {
    const where = scan.hooks.slice(0, 3).map((f) => shown(f, workspace)).join(', ');
    return `GitHub Copilot would run the hooks set up in ${where}, and it cannot turn them off for one chat. Remove them, or use another tool for the chat.`;
  }
  return null;
}

/** `copilot --help`, to see which options this version has; null when it does not start. */
function helpText(bin: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try { child = launch(bin, ['--help'], os.tmpdir(), env, 'ignore'); } catch { resolve(null); return; }
    let out = '';
    const timer = setTimeout(() => { killTree(child, true); resolve(null); }, PROBE_TIMEOUT_MS);
    child.stdout?.setEncoding('utf-8');
    child.stdout?.on('data', (c: string) => { if (out.length < 512 * 1024) out += c; });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', (code) => { clearTimeout(timer); resolve(code === 0 ? out : null); });
  });
}

/** Models from a `session/new` answer, in either form ACP servers use (`models` or a `model` config option). */
export function copilotModels(result: unknown): ChatModel[] {
  if (!isObject(result)) return [];
  const out: ChatModel[] = [];
  const models = isObject(result['models']) ? result['models'] : null;
  const current = typeof models?.['currentModelId'] === 'string' ? models['currentModelId'] : null;
  if (models && Array.isArray(models['availableModels'])) {
    for (const m of models['availableModels']) {
      if (!isObject(m) || typeof m['modelId'] !== 'string' || !m['modelId']) continue;
      out.push({ id: m['modelId'], label: shortDetail(m['name'], 60) ?? m['modelId'], description: shortDetail(m['description'], 120), efforts: [], is_default: m['modelId'] === current });
    }
  }
  if (!out.length && Array.isArray(result['configOptions'])) {
    const option = result['configOptions'].find((o) => isObject(o) && (o['category'] === 'model' || o['id'] === 'model'));
    if (isObject(option) && Array.isArray(option['options'])) {
      for (const o of option['options']) {
        if (!isObject(o) || typeof o['value'] !== 'string' || !o['value']) continue;
        out.push({ id: o['value'], label: shortDetail(o['name'], 60) ?? o['value'], description: shortDetail(o['description'], 120), efforts: [], is_default: o['value'] === option['currentValue'] });
      }
    }
  }
  return out;
}

const KINDS: Record<string, RunStepKind> = { read: 'read', search: 'search', edit: 'edit', delete: 'edit', move: 'edit', execute: 'command', fetch: 'other', think: 'other' };

/** Every permission Copilot asks for is refused, once: a later question is refused again. */
export function refusePermission(params: Record<string, unknown>): unknown {
  const options = Array.isArray(params['options']) ? params['options'].filter(isObject) : [];
  const reject = options.find((o) => o['kind'] === 'reject_once') ?? options.find((o) => o['kind'] === 'reject_always');
  return reject && typeof reject['optionId'] === 'string'
    ? { outcome: { outcome: 'selected', optionId: reject['optionId'] } }
    : { outcome: { outcome: 'cancelled' } };
}

const isAuthError = (err: unknown) => {
  const e = err as { rpcCode?: unknown; message?: string };
  return e?.rpcCode === -32000 || /authenticat|log ?in|sign ?in/i.test(e?.message ?? '');
};

async function connect(bin: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, handlers: Partial<ConstructorParameters<typeof RpcConnection>[1]> = {}) {
  const child = launch(bin, args, cwd, env, 'pipe');
  const rpc = new RpcConnection(child, {
    onNotification: handlers.onNotification ?? (() => {}),
    onRequest: (method, params) => (method === 'session/request_permission' ? refusePermission(params) : handlers.onRequest?.(method, params)),
    onExit: handlers.onExit ?? (() => {}),
  });
  try {
    const init = await rpc.request<Record<string, unknown>>('initialize', {
      protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    }, PROBE_TIMEOUT_MS);
    return { child, rpc, init: isObject(init) ? init : {} };
  } catch (err) {
    killTree(child, true);
    throw err;
  }
}

export class CopilotChatAdapter implements ChatAdapter {
  id = 'copilot' as const;
  label = 'GitHub Copilot';
  private cached: { at: number; workspace: string; result: Promise<ProviderStatus> } | null = null;
  private help: { at: number; bin: string; text: Promise<string | null> } | null = null;

  constructor(
    private readonly binary: () => string | null = () => findCommand('copilot'),
    private readonly env: () => NodeJS.ProcessEnv = () => copilotEnv(),
  ) {}

  status(workspace: string, options: { fresh?: boolean } = {}): Promise<ProviderStatus> {
    if (!options.fresh && this.cached && this.cached.workspace === workspace && Date.now() - this.cached.at < STATUS_TTL_MS) return this.cached.result;
    const result = this.check(workspace);
    this.cached = { at: Date.now(), workspace, result };
    // A failed check is not kept: the next one tries again.
    void result.then((s) => { if (!s.ready && this.cached?.result === result) this.cached = null; });
    return result;
  }

  /** Why this Copilot cannot be used read-only for the workspace, or null. */
  private async lockdownProblem(bin: string, env: NodeJS.ProcessEnv, workspace: string, scan: CopilotScan): Promise<string | null> {
    if (!this.help || this.help.bin !== bin || Date.now() - this.help.at > STATUS_TTL_MS) {
      const text = helpText(bin, env);
      this.help = { at: Date.now(), bin, text };
      void text.then((t) => { if (t === null && this.help?.text === text) this.help = null; });
    }
    return copilotLockdownProblem(await this.help.text, scan, workspace, process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin));
  }

  private async check(workspace: string): Promise<ProviderStatus> {
    const base = { id: this.id, label: this.label, notes: ['premium_requests', 'no_usage_report'] as ProviderStatus['notes'], plan: null, models: [] as ChatModel[], limits: null };
    const bin = this.binary();
    if (!bin) return { ...base, installed: false, ready: false, problems: [{ code: 'not_installed', message: 'GitHub Copilot CLI is not installed on this computer. Install it, sign in once with copilot login, then try again.' }] };
    const env = this.env();
    const lockdown = await this.lockdownProblem(bin, env, workspace, copilotScan(env, workspace));
    if (lockdown) return { ...base, installed: true, ready: false, problems: [{ code: 'not_read_only', message: lockdown }] };
    // The sign-in check opens a session (the only way ACP says whether one can be opened, and with which models),
    // in an empty folder of its own: nothing of the workspace is loaded or recorded for it.
    let dir: string;
    try { dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-chat-copilot-')); } catch {
      return { ...base, installed: true, ready: false, problems: [{ code: 'check_failed', message: 'Could not check whether GitHub Copilot is signed in. Open a terminal, run copilot to make sure it starts and is signed in, then try again.' }] };
    }
    let conn: Awaited<ReturnType<typeof connect>> | null = null;
    try {
      try { conn = await connect(bin, copilotArgs(env, null, null, null), dir, env); } catch {
        return { ...base, installed: true, ready: false, problems: [{ code: 'check_failed', message: 'Could not check whether GitHub Copilot is signed in. Open a terminal, run copilot to make sure it starts and is signed in, then try again.' }] };
      }
      const created = await conn.rpc.request<Record<string, unknown>>('session/new', { cwd: dir, mcpServers: [] }, PROBE_TIMEOUT_MS);
      const id = typeof created?.['sessionId'] === 'string' ? created['sessionId'] : null;
      const caps = isObject(conn.init['agentCapabilities']) ? conn.init['agentCapabilities'] : {};
      const canClose = isObject(caps['sessionCapabilities']) && 'close' in caps['sessionCapabilities'];
      if (id && canClose) await conn.rpc.request('session/close', { sessionId: id }, 5_000).catch(() => {});
      return { ...base, installed: true, ready: true, problems: [], models: copilotModels(created) };
    } catch (err) {
      if (isAuthError(err)) return { ...base, installed: true, ready: false, problems: [{ code: 'not_signed_in', message: 'GitHub Copilot is not signed in. Open a terminal, run copilot login, sign in, then try again.' }] };
      return { ...base, installed: true, ready: false, problems: [{ code: 'check_failed', message: 'Could not check whether GitHub Copilot is signed in. Open a terminal, run copilot to make sure it starts and is signed in, then try again.' }] };
    } finally {
      if (conn) await stopTree(conn.child);
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async open(options: ChatOpenOptions): Promise<ChatSession> {
    const bin = this.binary();
    if (!bin) throw Object.assign(new Error('GitHub Copilot CLI is not installed on this computer.'), { statusCode: 409 });
    const env = this.env();
    // Checked again here (a hook added since the last status check would otherwise run), and the servers it turns
    // off come from this same reading of the configuration.
    const scan = copilotScan(env, options.workspace);
    const lockdown = await this.lockdownProblem(bin, env, options.workspace, scan);
    if (lockdown) throw Object.assign(new Error(lockdown), { statusCode: 409, turnError: { code: 'provider', detail: lockdown } });
    const session = new CopilotSession(options.instructions);
    await session.start(bin, copilotArgs(env, options.workspace, options.model, options.effort, scan), options, env);
    return session;
  }
}

class CopilotSession implements ChatSession {
  sessionId: string | null = null;
  private child: ChildProcess | null = null;
  private rpc: RpcConnection | null = null;
  private turn: { onEvent: (e: ChatEvent) => void; interrupted: boolean; ended: boolean; answered: boolean } | null = null;
  /** ACP has no system prompt: a new session gets the instructions with its first message. */
  private instruct = true;

  constructor(private readonly instructions: string) {}

  get alive(): boolean {
    return this.rpc?.alive ?? false;
  }

  async start(bin: string, args: string[], options: ChatOpenOptions, env: NodeJS.ProcessEnv): Promise<void> {
    const conn = await connect(bin, args, options.workspace, env, {
      onNotification: (method, params) => this.onNotification(method, params),
      onExit: () => {
        if (this.turn?.interrupted) this.end({ status: 'stopped' });
        else this.end({ status: 'error', error: turnError(this.rpc?.stderr ?? '', 'crashed') });
      },
    });
    this.child = conn.child;
    this.rpc = conn.rpc;
    const caps = isObject(conn.init['agentCapabilities']) ? conn.init['agentCapabilities'] : {};
    try {
      if (options.resume && caps['loadSession'] === true) {
        // The history it replays while loading arrives before any turn, so it is not shown again.
        await conn.rpc.request('session/load', { sessionId: options.resume, cwd: options.workspace, mcpServers: [] }, PROBE_TIMEOUT_MS);
        this.sessionId = options.resume;
        this.instruct = false;
      } else if (options.resume) {
        throw Object.assign(new Error('This Copilot version cannot continue a saved session.'), { turnError: { code: 'resume_failed', detail: null } });
      } else {
        const created = await conn.rpc.request<Record<string, unknown>>('session/new', { cwd: options.workspace, mcpServers: [] }, PROBE_TIMEOUT_MS);
        this.sessionId = typeof created?.['sessionId'] === 'string' ? created['sessionId'] : null;
      }
    } catch (err) {
      killTree(conn.child, true);
      const e = err as Error & { turnError?: unknown };
      e.turnError ??= isAuthError(err) ? { code: 'sign_in', detail: shortDetail(e.message) } : turnError(e.message, options.resume ? 'resume_failed' : 'crashed');
      throw e;
    }
  }

  private end(outcome: TurnOutcome): void {
    const turn = this.turn;
    if (!turn || turn.ended) return;
    turn.ended = true;
    this.turn = null;
    turn.onEvent({ type: 'end', outcome });
  }

  private emit(event: ChatEvent): void {
    if (this.turn && !this.turn.ended) this.turn.onEvent(event);
  }

  private onNotification(method: string, p: Record<string, unknown>): void {
    if (method !== 'session/update' || p['sessionId'] !== this.sessionId) return;
    const u = isObject(p['update']) ? p['update'] : {};
    const content = isObject(u['content']) ? u['content'] : {};
    switch (u['sessionUpdate']) {
      case 'agent_message_chunk':
        if (content['type'] !== 'text' || typeof content['text'] !== 'string') return;
        // Copilot's own one-line note about the tools the allow-list hid, before any answer: not part of it.
        if (this.turn && !this.turn.answered && u['messageId'] === undefined && DISABLED_TOOLS_NOTE.test(content['text'])) return;
        if (this.turn) this.turn.answered = true;
        this.emit({ type: 'text', text: content['text'] });
        return;
      case 'tool_call':
        this.emit({ type: 'step', step: { kind: KINDS[String(u['kind'])] ?? 'other', path: null } });
        return;
      case 'usage_update':
        this.emit({ type: 'usage', context_used: typeof u['used'] === 'number' ? u['used'] : null, context_window: typeof u['size'] === 'number' ? u['size'] : null });
        return;
      default:
        return;
    }
  }

  send(text: string, onEvent: (event: ChatEvent) => void): void {
    if (!this.alive || !this.rpc || !this.sessionId) { onEvent({ type: 'end', outcome: { status: 'error', error: { code: 'crashed', detail: null } } }); return; }
    if (this.turn) throw Object.assign(new Error('The assistant is still answering. Wait for it, or stop it first.'), { statusCode: 409 });
    this.turn = { onEvent, interrupted: false, ended: false, answered: false };
    const prompt = this.instruct ? `${this.instructions}\n\n---\n\n${text}` : text;
    this.instruct = false;
    this.rpc.request<Record<string, unknown>>('session/prompt', { sessionId: this.sessionId, prompt: [{ type: 'text', text: prompt }] }, TURN_TIMEOUT_MS + 60_000)
      .then((r) => {
        const reason = r?.['stopReason'];
        if (reason === 'cancelled' || this.turn?.interrupted) this.end({ status: 'stopped' });
        else if (reason === 'refusal') this.end({ status: 'error', error: { code: 'provider', detail: 'Copilot declined to answer this message.' } });
        else this.end({ status: 'done' });
      })
      .catch((err: Error) => {
        if (this.turn?.interrupted) this.end({ status: 'stopped' });
        else this.end({ status: 'error', error: isAuthError(err) ? { code: 'sign_in', detail: shortDetail(err.message) } : turnError(err.message) });
      });
  }

  async interrupt(): Promise<void> {
    if (!this.turn || !this.rpc) return;
    this.turn.interrupted = true;
    this.rpc.notify('session/cancel', { sessionId: this.sessionId });
  }

  async close(): Promise<void> {
    if (this.child) await stopTree(this.child);
  }
}
