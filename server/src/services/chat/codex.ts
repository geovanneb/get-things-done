import * as os from 'os';
import type { ChildProcess } from 'child_process';
import { findCommand } from '../aiToolDetection';
import { killTree, launch, stopTree } from '../agentRunner';
import { CHOSEN_FOLDER_PROBLEM, accountKey, holdFolder, withChosenFolder } from '../assistantAccountFolder';
import { RpcConnection } from './rpc';
import {
  accountChangedError, isObject, isoFromEpoch, shortDetail, turnError,
  type ChatAdapter, type ChatEvent, type ChatModel, type ChatOpenOptions, type ChatProblem, type ChatSession, type ProviderStatus,
  type TurnError, type TurnOutcome, type UsageWindow,
} from './types';

/**
 * OpenAI Codex as a chat, through `codex app-server`: the JSON-RPC protocol its own editor extensions use. One
 * process per conversation, one thread in it. The thread runs in Codex's read-only sandbox without network, never
 * asks for approval (anything that would need one is refused), and has web search off. Only a ChatGPT sign-in
 * counts: an API-key sign-in or another model provider is refused, and API-key variables are removed from its
 * environment.
 *
 * Nothing the user set up for Codex runs in the chat either: the process starts with hooks, apps (connectors),
 * plugins, memories and the other tools that do more than read turned off (`-c features.<name>=false`; a name a
 * Codex version does not know is ignored). The MCP servers Codex would load for the workspace (personal and
 * project config, as `config/read` reports them) are read by a short-lived process that starts no thread, and the
 * chat's process starts with each of them off; before a thread starts, Codex must report every configured server
 * off, else the chat is not opened. An empty `mcp_servers` table would not do: Codex merges it into the configured
 * one. The thread gets the same overrides, new or resumed, and after it starts it is checked again as Codex
 * reports it: no MCP server (including any a plugin or app would bring) and no hook may be on. A Codex that cannot
 * report this, or still has one on, is not used.
 */

const BILLING_OVERRIDES = ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_ORG_ID', 'OPENAI_PROJECT_ID', 'AZURE_OPENAI_API_KEY'];
const STATUS_TTL_MS = 60_000;
const PROBE_TIMEOUT_MS = 20_000;
const CLIENT = { name: 'get-things-done', title: 'Get Things Done', version: '1' };

/** Codex features that run the user's own code or add tools beyond reading files: off for the chat's process. */
export const CODEX_FEATURES_OFF = [
  'hooks', 'apps', 'plugins', 'remote_plugin', 'memories', 'image_generation', 'browser_use', 'browser_use_external',
  'computer_use', 'in_app_browser', 'multi_agent', 'multi_agent_v2', 'tool_suggest', 'skill_mcp_dependency_install',
  'request_permissions_tool',
];

const BARE_KEY = /^[A-Za-z0-9_-]+$/;

/**
 * `codex app-server` for the chat and for its checks, with the named MCP servers turned off for the whole process
 * (before any thread can start them). They go in one inline table: Codex splits a dotted `-c` path at every dot
 * and does not read quoted keys there, so `mcp_servers.<name>.enabled` cannot name `a.b` or `a/b`; the value of
 * `-c mcp_servers=...` is TOML, where any name can be quoted, and Codex merges it into the configured servers.
 * Plain names need no quotes, which a Windows `.cmd` launch refuses.
 */
export function codexLaunchArgs(mcpServers: string[] = []): string[] {
  const off = mcpServers.map((name) => `${BARE_KEY.test(name) ? name : JSON.stringify(name)}={enabled=false}`);
  return [
    'app-server', ...CODEX_FEATURES_OFF.flatMap((name) => ['-c', `features.${name}=false`]), '-c', 'web_search=disabled',
    ...(off.length ? ['-c', `mcp_servers={${off.join(',')}}`] : []),
  ];
}

/** The MCP servers in Codex's effective configuration for a folder, and which of them are not turned off. */
export function codexConfiguredServers(result: unknown): { names: string[]; on: string[] } | null {
  const config = isObject(result) && isObject(result['config']) ? result['config'] : null;
  if (!config) return null;
  const servers = isObject(config['mcp_servers']) ? config['mcp_servers'] : {};
  const names = Object.keys(servers);
  return { names, on: names.filter((name) => !isObject(servers[name]) || servers[name]['enabled'] !== false) };
}

/** A thread's settings, the same for a new thread and a resumed one: a resumed thread never keeps looser ones. */
export function codexThreadSettings(options: Pick<ChatOpenOptions, 'workspace' | 'instructions' | 'model'>, mcpServers: string[]): Record<string, unknown> {
  return {
    cwd: options.workspace, sandbox: 'read-only', approvalPolicy: 'never',
    developerInstructions: options.instructions,
    config: { web_search: 'disabled', mcp_servers: Object.fromEntries(mcpServers.map((name) => [name, { enabled: false }])) },
    ...(options.model ? { model: options.model } : {}),
  };
}

const NOT_READ_ONLY = 'This Codex version cannot be limited to reading files for the chat: it does not confirm that hooks and MCP servers are off. Update Codex, then try again.';

/** Why Codex is not used, or null: the hooks it reports for a folder or thread must all be off. */
export function codexHooksProblem(result: unknown): string | null {
  if (!isObject(result) || !Array.isArray(result['data'])) return NOT_READ_ONLY;
  for (const entry of result['data']) {
    const hooks = isObject(entry) && Array.isArray(entry['hooks']) ? entry['hooks'] : null;
    if (!hooks) return NOT_READ_ONLY;
    if (hooks.some((h) => !isObject(h) || h['enabled'] !== false)) {
      return 'Codex would run hooks you set up, and the dashboard chat cannot turn them off in this Codex version. Update Codex, then try again.';
    }
  }
  return null;
}

/** The MCP servers Codex reports for a thread: null when every one is off, else what is still on. */
export function codexServersOn(result: unknown): string[] | null {
  if (!isObject(result) || !Array.isArray(result['data'])) return ['(unknown)'];
  const on = result['data'].filter((s) => !isObject(s) || s['runtimeStatus'] !== 'disabled').map((s) => (isObject(s) && typeof s['name'] === 'string' ? s['name'] : '(unnamed)'));
  return on.length ? on : null;
}

export function codexEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const name of BILLING_OVERRIDES) delete env[name];
  return env;
}

/** codexEnv, with `CODEX_HOME` set to the account chosen in Settings → Assistant accounts (#505), if any. */
export function codexChosenEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return withChosenFolder('codex', codexEnv(base));
}

/**
 * Who is signed in to the Codex config folder `env` points to (`CODEX_HOME`), from Codex's own `account/read`: the
 * same check the chat makes. No thread is started and no model is called. Null when it could not be checked.
 */
export async function codexAccount(bin: string, env: NodeJS.ProcessEnv): Promise<{ signed_in: boolean; method: string | null; email: string | null; plan: string | null } | null> {
  let conn: { child: ChildProcess; rpc: RpcConnection };
  try { conn = await connect(bin, os.homedir(), env); } catch { return null; }
  try {
    const read = await conn.rpc.request<Record<string, unknown>>('account/read', {}, PROBE_TIMEOUT_MS).catch(() => null);
    if (!read) return null;
    if (read['requiresOpenaiAuth'] === false) return { signed_in: true, method: 'provider', email: null, plan: null };
    const account = isObject(read['account']) ? read['account'] : null;
    if (!account) return { signed_in: false, method: null, email: null, plan: null };
    return { signed_in: true, method: shortDetail(account['type'], 40), email: shortDetail(account['email']), plan: shortDetail(account['planType'], 40) };
  } finally {
    killTree(conn.child, true);
  }
}

export function codexModels(raw: unknown): ChatModel[] {
  const list = isObject(raw) && Array.isArray(raw['data']) ? raw['data'] : [];
  return list.flatMap((m): ChatModel[] => {
    if (!isObject(m) || m['hidden'] === true) return [];
    const id = typeof m['model'] === 'string' ? m['model'] : typeof m['id'] === 'string' ? m['id'] : null;
    if (!id) return [];
    const efforts = Array.isArray(m['supportedReasoningEfforts'])
      ? m['supportedReasoningEfforts'].flatMap((e) => (isObject(e) && typeof e['reasoningEffort'] === 'string' ? [e['reasoningEffort']] : typeof e === 'string' ? [e] : []))
      : [];
    return [{ id, label: shortDetail(m['displayName'], 60) ?? id, description: shortDetail(m['description'], 120), efforts, is_default: m['isDefault'] === true }];
  });
}

export function codexLimits(raw: unknown): UsageWindow[] | null {
  const limits = isObject(raw) && isObject(raw['rateLimits']) ? raw['rateLimits'] : isObject(raw) && isObject(raw['primary']) ? raw : null;
  if (!limits) return null;
  const reached = limits['rateLimitReachedType'] != null;
  const out: UsageWindow[] = [];
  for (const key of ['primary', 'secondary']) {
    const w = limits[key];
    if (!isObject(w)) continue;
    const minutes = typeof w['windowDurationMins'] === 'number' ? w['windowDurationMins'] : null;
    const used = typeof w['usedPercent'] === 'number' ? Math.round(Math.min(100, Math.max(0, w['usedPercent']))) : null;
    out.push({
      kind: minutes === 300 ? 'five_hour' : minutes === 10080 ? 'weekly' : 'other',
      used_percent: used,
      resets_at: isoFromEpoch(w['resetsAt']),
      limited: (used !== null && used >= 100) || (reached && used !== null && used >= 95),
    });
  }
  return out.length ? out : null;
}

/** A Codex turn error in the chat's terms: its structured code first, then its words. */
export function codexTurnError(error: unknown, resetsAt: string | null = null): TurnError {
  const e = isObject(error) ? error : {};
  const message = `${typeof e['message'] === 'string' ? e['message'] : ''} ${typeof e['additionalDetails'] === 'string' ? e['additionalDetails'] : ''}`.trim();
  const info = e['codexErrorInfo'];
  const detail = shortDetail(message);
  if (info === 'contextWindowExceeded') return { code: 'context_full', detail };
  if (info === 'usageLimitExceeded' || info === 'sessionBudgetExceeded') return { code: 'plan_limit', detail, resets_at: resetsAt };
  if (info === 'unauthorized') return { code: 'sign_in', detail };
  return turnError(message, 'provider', resetsAt);
}

const lastLimits: { windows: UsageWindow[] | null } = { windows: null };

/** Starts `codex app-server` and says hello. Rejects when it cannot start or does not answer. */
async function connect(bin: string, cwd: string, env: NodeJS.ProcessEnv, handlers: Partial<ConstructorParameters<typeof RpcConnection>[1]> = {}, mcpServers: string[] = []): Promise<{ child: ChildProcess; rpc: RpcConnection }> {
  const child = launch(bin, codexLaunchArgs(mcpServers), cwd, env, 'pipe');
  const rpc = new RpcConnection(child, {
    onNotification: handlers.onNotification ?? (() => {}),
    onRequest: handlers.onRequest ?? refuse,
    onExit: handlers.onExit ?? (() => {}),
  });
  try {
    await rpc.request('initialize', { clientInfo: CLIENT }, PROBE_TIMEOUT_MS);
    rpc.notify('initialized');
  } catch (err) {
    killTree(child, true);
    throw err;
  }
  return { child, rpc };
}

/** Every approval Codex asks for is refused: the chat never runs a command or changes a file. */
export function refuse(method: string): unknown {
  if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') return { decision: 'decline' };
  if (method === 'applyPatchApproval' || method === 'execCommandApproval') return { decision: 'denied' };
  if (method === 'item/permissions/requestApproval') return { permissions: {} };
  if (method === 'mcpServer/elicitation/request') return { action: 'decline' };
  return undefined;
}

export class CodexChatAdapter implements ChatAdapter {
  id = 'codex' as const;
  label = 'OpenAI Codex';
  private cached: { at: number; workspace: string; folder: string; result: Promise<ProviderStatus> } | null = null;

  constructor(
    private readonly binary: () => string | null = () => findCommand('codex'),
    private readonly env: () => NodeJS.ProcessEnv = () => codexChosenEnv(),
  ) {}

  /** The account checks use now (folder and sign-in generation): a change of account is checked again at once. */
  private folder(): string {
    try { return accountKey('codex', this.env()); } catch { return '\0unusable'; }
  }

  status(workspace: string, options: { fresh?: boolean } = {}): Promise<ProviderStatus> {
    const folder = this.folder();
    if (!options.fresh && this.cached && this.cached.workspace === workspace && this.cached.folder === folder && Date.now() - this.cached.at < STATUS_TTL_MS) {
      return this.cached.result.then((s) => ({ ...s, limits: lastLimits.windows ?? s.limits }));
    }
    const result = this.check(workspace);
    this.cached = { at: Date.now(), workspace, folder, result };
    return result;
  }

  private async check(workspace: string): Promise<ProviderStatus> {
    const base = { id: this.id, label: this.label, notes: [] as ProviderStatus['notes'], plan: null as string | null, models: [] as ChatModel[], limits: null as UsageWindow[] | null };
    const bin = this.binary();
    if (!bin) return { ...base, installed: false, ready: false, problems: [{ code: 'not_installed', message: 'OpenAI Codex is not installed on this computer. Install it, sign in once with your ChatGPT account, then try again.' }] };
    let env: NodeJS.ProcessEnv;
    try { env = this.env(); } catch {
      return { ...base, installed: true, ready: false, problems: [{ code: 'check_failed', message: CHOSEN_FOLDER_PROBLEM }] };
    }
    const launchKey = accountKey('codex', env);
    let conn: { child: ChildProcess; rpc: RpcConnection };
    try { conn = await connect(bin, os.homedir(), env); } catch {
      return { ...base, installed: true, ready: false, problems: [{ code: 'check_failed', message: 'Could not check whether Codex is signed in. Open a terminal, run codex to make sure it starts and is signed in, then try again.' }] };
    }
    try {
      const problems: ChatProblem[] = [];
      const read = await conn.rpc.request<Record<string, unknown>>('account/read', {}, PROBE_TIMEOUT_MS).catch(() => null);
      const account = read && isObject(read['account']) ? read['account'] : null;
      if (read === null) {
        problems.push({ code: 'check_failed', message: 'Could not check whether Codex is signed in. Open a terminal, run codex to make sure it starts and is signed in, then try again.' });
      } else if (read['requiresOpenaiAuth'] === false) {
        problems.push({ code: 'not_subscription', message: 'Codex is set up to use another model provider, not your ChatGPT plan. The dashboard chat uses a ChatGPT plan only.' });
      } else if (!account) {
        problems.push({ code: 'not_signed_in', message: 'Codex is not signed in. Open a terminal, run codex login, sign in with your ChatGPT account, then try again.' });
      } else if (account['type'] !== 'chatgpt') {
        problems.push({ code: 'not_subscription', message: 'Codex is signed in with an API key, not a ChatGPT plan. The dashboard chat uses a ChatGPT plan only; run codex login and sign in with ChatGPT.' });
      }
      // Hooks are checked for the workspace without starting a thread; MCP servers only start with one, so they
      // are checked when a conversation opens.
      if (problems.length === 0) {
        const hooks = codexHooksProblem(await conn.rpc.request('hooks/list', { cwds: [workspace] }, PROBE_TIMEOUT_MS).catch(() => null));
        if (hooks) problems.push({ code: 'not_read_only', message: hooks });
      }
      const signedIn = problems.every((p) => p.code === 'not_read_only');
      const models = signedIn ? codexModels(await conn.rpc.request('model/list', {}, PROBE_TIMEOUT_MS).catch(() => null)) : [];
      const limits = signedIn ? codexLimits(await conn.rpc.request('account/rateLimits/read', {}, PROBE_TIMEOUT_MS).catch(() => null)) : null;
      if (limits) lastLimits.windows = limits;
      return { ...base, installed: true, ready: problems.length === 0, problems, plan: account ? shortDetail(account['planType'], 40) : null, models, limits, launch_key: launchKey };
    } finally {
      killTree(conn.child, true);
    }
  }

  async open(options: ChatOpenOptions): Promise<ChatSession> {
    const bin = this.binary();
    if (!bin) throw Object.assign(new Error('OpenAI Codex is not installed on this computer.'), { statusCode: 409 });
    // Not cached for the next check: a session can change the sign-in (an expired token refreshed or not).
    this.cached = null;
    const env = this.env();
    if (options.launch_key !== undefined && options.launch_key !== accountKey('codex', env)) throw accountChangedError();
    // Nobody signs this account out from the dashboard while the conversation starts and while its process lives.
    const release = holdFolder('codex', env);
    const session = new CodexSession();
    try {
      await session.start(bin, options, env, release);
    } catch (err) {
      release();
      throw err;
    }
    return session;
  }
}

/** The MCP server names Codex reads for a folder, from a short-lived process that never starts a thread. */
async function discoverServers(bin: string, workspace: string, env: NodeJS.ProcessEnv): Promise<string[]> {
  let conn: { child: ChildProcess; rpc: RpcConnection };
  try { conn = await connect(bin, workspace, env); } catch (err) {
    throw Object.assign(err as Error, { turnError: turnError((err as Error).message, 'crashed') });
  }
  try {
    const configured = codexConfiguredServers(await conn.rpc.request('config/read', { cwd: workspace, includeLayers: false }, PROBE_TIMEOUT_MS).catch(() => null));
    if (!configured) throw notReadOnly(NOT_READ_ONLY);
    return configured.names;
  } finally {
    await stopTree(conn.child);
  }
}

function notReadOnly(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 409, turnError: { code: 'provider', detail: message } satisfies TurnError });
}

class CodexSession implements ChatSession {
  sessionId: string | null = null;
  private child: ChildProcess | null = null;
  private rpc: RpcConnection | null = null;
  private turn: { onEvent: (e: ChatEvent) => void; id: string | null; interrupted: boolean; ended: boolean } | null = null;

  get alive(): boolean {
    return this.rpc?.alive ?? false;
  }

  async start(bin: string, options: ChatOpenOptions, env: NodeJS.ProcessEnv, release: () => void = () => {}): Promise<void> {
    // 1. Which MCP servers Codex would load for this folder (personal and project config), read by a process that
    //    starts no thread: reading the configuration starts no server.
    const names = await discoverServers(bin, options.workspace, env);
    if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin) && names.some((name) => !BARE_KEY.test(name))) {
      throw notReadOnly('Codex has an MCP server whose name cannot be passed to it from here to turn it off (use letters, digits, - and _ only, or install the Codex app). Rename it, or use another tool for the chat.');
    }
    // 2. The chat's process starts with every one of them off, and only with the account the message's check approved:
    //    a sign-in may have changed while the configuration was read.
    if (options.launch_key !== undefined && options.launch_key !== accountKey('codex', env)) throw accountChangedError();
    let conn: { child: ChildProcess; rpc: RpcConnection };
    try {
      conn = await connect(bin, options.workspace, env, {
        onNotification: (method, params) => this.onNotification(method, params),
        onRequest: refuse,
        onExit: () => {
          const text = this.rpc?.stderr ?? '';
          if (this.turn?.interrupted) this.end({ status: 'stopped' });
          else this.end({ status: 'error', error: turnError(text, 'crashed') });
        },
      }, names);
    } catch (err) {
      throw Object.assign(err as Error, { turnError: turnError((err as Error).message, 'crashed') });
    }
    const { child, rpc } = conn;
    this.child = child;
    this.rpc = rpc;
    // The account stays held while the conversation's process lives.
    child.on('exit', release);
    // 3. Before any thread: Codex itself must report every configured server off. One added since step 1, or an
    //    override it did not take, means the chat does not start.
    const configured = codexConfiguredServers(await rpc.request('config/read', { cwd: options.workspace, includeLayers: false }).catch(() => null));
    if (!configured) { killTree(child, true); throw notReadOnly(NOT_READ_ONLY); }
    if (configured.on.length) {
      killTree(child, true);
      throw notReadOnly(`Codex would start MCP servers in the chat (${configured.on.slice(0, 5).join(', ')}). Try again; if it keeps happening, update Codex.`);
    }
    // The thread gets the same overrides, a second time.
    const settings = codexThreadSettings(options, configured.names);
    try {
      const result = options.resume
        ? await rpc.request<Record<string, unknown>>('thread/resume', { threadId: options.resume, ...settings })
        : await rpc.request<Record<string, unknown>>('thread/start', { ...settings, ephemeral: false });
      const thread = isObject(result?.['thread']) ? result['thread'] : null;
      this.sessionId = typeof thread?.['id'] === 'string' ? thread['id'] : options.resume;
    } catch (err) {
      killTree(child, true);
      throw Object.assign(err as Error, { turnError: turnError((err as Error).message, options.resume ? 'resume_failed' : 'crashed') });
    }
    // Checked as Codex reports the thread, before any message: no MCP server and no hook on.
    const problem = await this.lockedDown(rpc, this.sessionId);
    if (problem) { killTree(child, true); throw notReadOnly(problem); }
    this.effort = options.effort;
  }

  private async lockedDown(rpc: RpcConnection, threadId: string | null): Promise<string | null> {
    // Never asked without a thread: Codex would then start the configured servers to list them.
    if (!threadId) return NOT_READ_ONLY;
    const hooks = codexHooksProblem(await rpc.request('hooks/list', { threadId }, PROBE_TIMEOUT_MS).catch(() => null));
    if (hooks) return hooks;
    let cursor: string | null = null;
    for (let page = 0; page < 20; page++) {
      const result: unknown = await rpc.request('mcpServerStatus/list', { threadId, detail: 'toolsAndAuthOnly', ...(cursor ? { cursor } : {}) }, PROBE_TIMEOUT_MS).catch(() => null);
      const on = codexServersOn(result);
      if (on) return result === null || on[0] === '(unknown)' ? NOT_READ_ONLY : `Codex kept MCP servers on for the chat (${on.slice(0, 5).join(', ')}). Update Codex, then try again.`;
      cursor = isObject(result) && typeof result['nextCursor'] === 'string' ? result['nextCursor'] : null;
      if (!cursor) return null;
    }
    return NOT_READ_ONLY;
  }

  private effort: string | null = null;

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
    if (p['threadId'] !== undefined && p['threadId'] !== this.sessionId) return;
    switch (method) {
      case 'turn/started': {
        const turn = isObject(p['turn']) ? p['turn'] : {};
        if (this.turn && typeof turn['id'] === 'string') {
          this.turn.id = turn['id'];
          // Stop was asked for before Codex said which turn this is: sent now.
          if (this.turn.interrupted) void this.rpc?.request('turn/interrupt', { threadId: this.sessionId, turnId: turn['id'] }, 10_000).catch(() => {});
        }
        return;
      }
      case 'item/agentMessage/delta':
        if (typeof p['delta'] === 'string') this.emit({ type: 'text', text: p['delta'] });
        return;
      case 'item/started': {
        const item = isObject(p['item']) ? p['item'] : {};
        const kind = item['type'] === 'commandExecution' ? 'command' : item['type'] === 'fileChange' ? 'edit' : item['type'] === 'webSearch' ? 'search' : item['type'] === 'mcpToolCall' ? 'other' : null;
        if (kind) this.emit({ type: 'step', step: { kind, path: null } });
        return;
      }
      case 'thread/tokenUsage/updated': {
        const usage = isObject(p['tokenUsage']) ? p['tokenUsage'] : {};
        const last = isObject(usage['last']) ? usage['last'] : {};
        const used = typeof last['totalTokens'] === 'number' ? last['totalTokens'] : null;
        const window = typeof usage['modelContextWindow'] === 'number' ? usage['modelContextWindow'] : null;
        this.emit({ type: 'usage', context_used: used, context_window: window });
        return;
      }
      case 'account/rateLimits/updated': {
        const windows = codexLimits(p);
        if (windows) { lastLimits.windows = windows; this.emit({ type: 'limits', windows }); }
        return;
      }
      case 'thread/compacted':
        this.emit({ type: 'compacted' });
        return;
      case 'error':
        // A retry Codex makes on its own is not the end of the turn.
        if (p['willRetry'] === true) return;
        this.end({ status: 'error', error: codexTurnError(p['error'], this.resetsAt()) });
        return;
      case 'turn/completed': {
        const turn = isObject(p['turn']) ? p['turn'] : {};
        const status = turn['status'];
        if (status === 'interrupted' || this.turn?.interrupted) this.end({ status: 'stopped' });
        else if (status === 'failed') this.end({ status: 'error', error: codexTurnError(turn['error'], this.resetsAt()) });
        else this.end({ status: 'done' });
        return;
      }
      default:
        return;
    }
  }

  private resetsAt(): string | null {
    const limited = lastLimits.windows?.filter((w) => w.limited || (w.used_percent ?? 0) >= 95) ?? [];
    return limited.map((w) => w.resets_at).filter((x): x is string => !!x).sort().pop() ?? null;
  }

  send(text: string, onEvent: (event: ChatEvent) => void): void {
    if (!this.alive || !this.rpc || !this.sessionId) { onEvent({ type: 'end', outcome: { status: 'error', error: { code: 'crashed', detail: null } } }); return; }
    if (this.turn) throw Object.assign(new Error('The assistant is still answering. Wait for it, or stop it first.'), { statusCode: 409 });
    this.turn = { onEvent, id: null, interrupted: false, ended: false };
    this.rpc.request<Record<string, unknown>>('turn/start', {
      threadId: this.sessionId, input: [{ type: 'text', text }], approvalPolicy: 'never',
      ...(this.effort ? { effort: this.effort } : {}),
    }, 60_000).then((r) => {
      const turn = isObject(r?.['turn']) ? r['turn'] : null;
      if (this.turn && typeof turn?.['id'] === 'string') this.turn.id = turn['id'];
    }).catch((err: Error) => this.end({ status: 'error', error: turnError(err.message) }));
  }

  async interrupt(): Promise<void> {
    if (!this.turn || !this.rpc) return;
    this.turn.interrupted = true;
    if (this.turn.id) await this.rpc.request('turn/interrupt', { threadId: this.sessionId, turnId: this.turn.id }, 10_000).catch(() => {});
  }

  async close(): Promise<void> {
    if (this.child) await stopTree(this.child);
  }
}
