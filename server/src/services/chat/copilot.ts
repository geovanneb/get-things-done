import * as fs from 'fs';
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
 * process per conversation. Read-only by rule, not by asking: Copilot runs commands it sees as read-only without
 * asking and honours approvals the user saved for a folder, so shell, writes, URLs and memory are denied outright
 * (`--deny-tool` wins over every allow), the built-in and the user's own MCP servers are turned off, and any
 * permission question that still comes is refused. Custom model providers (BYOK) are removed from its environment,
 * so it uses the Copilot plan of the GitHub account it is signed in to.
 *
 * Copilot does not report plan usage over ACP, and each message counts toward the plan's premium requests; the
 * page says so next to the picker.
 */

const STATUS_TTL_MS = 10 * 60 * 1000;
const PROBE_TIMEOUT_MS = 30_000;
const SERVER_NAME = /^[A-Za-z0-9_.-]{1,64}$/;

export function copilotEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const name of Object.keys(env)) {
    if (name.startsWith('COPILOT_PROVIDER_') || name === 'COPILOT_PROVIDERS_CONFIG' || name === 'COPILOT_ALLOW_ALL' || name === 'COPILOT_OFFLINE') delete env[name];
  }
  return env;
}

/** The MCP servers the user set up for Copilot, by name: each is turned off for the chat. */
export function userMcpServers(env: NodeJS.ProcessEnv): string[] {
  const home = env['COPILOT_HOME'] ?? path.join(env['HOME'] ?? os.homedir(), '.copilot');
  try {
    const config = JSON.parse(fs.readFileSync(path.join(home, 'mcp-config.json'), 'utf-8')) as unknown;
    const servers = isObject(config) && isObject(config['mcpServers']) ? Object.keys(config['mcpServers']) : [];
    return servers.filter((name) => SERVER_NAME.test(name));
  } catch {
    return [];
  }
}

export function copilotArgs(env: NodeJS.ProcessEnv, model: string | null, effort: string | null): string[] {
  const deny = ['shell', 'write', 'url', 'memory'];
  const servers = userMcpServers(env);
  return [
    '--acp', '--stdio', '--disable-builtin-mcps', '--disallow-temp-dir', '--no-ask-user',
    ...deny.flatMap((rule) => [`--deny-tool=${rule}`]),
    ...servers.flatMap((name) => ['--disable-mcp-server', name, `--deny-tool=${name}`]),
    ...(model ? ['--model', model] : []),
    ...(effort ? ['--effort', effort] : []),
  ];
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

  private async check(workspace: string): Promise<ProviderStatus> {
    const base = { id: this.id, label: this.label, notes: ['premium_requests', 'no_usage_report'] as ProviderStatus['notes'], plan: null, models: [] as ChatModel[], limits: null };
    const bin = this.binary();
    if (!bin) return { ...base, installed: false, ready: false, problems: [{ code: 'not_installed', message: 'GitHub Copilot CLI is not installed on this computer. Install it, sign in once with copilot login, then try again.' }] };
    const env = this.env();
    let conn: Awaited<ReturnType<typeof connect>>;
    try { conn = await connect(bin, copilotArgs(env, null, null), workspace, env); } catch {
      return { ...base, installed: true, ready: false, problems: [{ code: 'check_failed', message: 'Could not check whether GitHub Copilot is signed in. Open a terminal, run copilot to make sure it starts and is signed in, then try again.' }] };
    }
    try {
      const created = await conn.rpc.request<Record<string, unknown>>('session/new', { cwd: workspace, mcpServers: [] }, PROBE_TIMEOUT_MS);
      const id = typeof created?.['sessionId'] === 'string' ? created['sessionId'] : null;
      const caps = isObject(conn.init['agentCapabilities']) ? conn.init['agentCapabilities'] : {};
      const canClose = isObject(caps['sessionCapabilities']) && 'close' in caps['sessionCapabilities'];
      if (id && canClose) await conn.rpc.request('session/close', { sessionId: id }, 5_000).catch(() => {});
      return { ...base, installed: true, ready: true, problems: [], models: copilotModels(created) };
    } catch (err) {
      if (isAuthError(err)) return { ...base, installed: true, ready: false, problems: [{ code: 'not_signed_in', message: 'GitHub Copilot is not signed in. Open a terminal, run copilot login, sign in, then try again.' }] };
      return { ...base, installed: true, ready: false, problems: [{ code: 'check_failed', message: 'Could not check whether GitHub Copilot is signed in. Open a terminal, run copilot to make sure it starts and is signed in, then try again.' }] };
    } finally {
      killTree(conn.child, true);
    }
  }

  async open(options: ChatOpenOptions): Promise<ChatSession> {
    const bin = this.binary();
    if (!bin) throw Object.assign(new Error('GitHub Copilot CLI is not installed on this computer.'), { statusCode: 409 });
    const session = new CopilotSession(options.instructions);
    const env = this.env();
    await session.start(bin, copilotArgs(env, options.model, options.effort), options, env);
    return session;
  }
}

class CopilotSession implements ChatSession {
  sessionId: string | null = null;
  private child: ChildProcess | null = null;
  private rpc: RpcConnection | null = null;
  private turn: { onEvent: (e: ChatEvent) => void; interrupted: boolean; ended: boolean } | null = null;
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
        if (content['type'] === 'text' && typeof content['text'] === 'string') this.emit({ type: 'text', text: content['text'] });
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
    this.turn = { onEvent, interrupted: false, ended: false };
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
