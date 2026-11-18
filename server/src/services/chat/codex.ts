import * as os from 'os';
import type { ChildProcess } from 'child_process';
import { findCommand } from '../aiToolDetection';
import { killTree, launch, stopTree } from '../agentRunner';
import { RpcConnection } from './rpc';
import {
  isObject, isoFromEpoch, shortDetail, turnError,
  type ChatAdapter, type ChatEvent, type ChatModel, type ChatOpenOptions, type ChatProblem, type ChatSession, type ProviderStatus,
  type TurnError, type TurnOutcome, type UsageWindow,
} from './types';

/**
 * OpenAI Codex as a chat, through `codex app-server`: the JSON-RPC protocol its own editor extensions use. One
 * process per conversation, one thread in it. The thread runs in Codex's read-only sandbox without network, never
 * asks for approval (anything that would need one is refused), and has web search off. Only a ChatGPT sign-in
 * counts: an API-key sign-in or another model provider is refused, and API-key variables are removed from its
 * environment.
 */

const BILLING_OVERRIDES = ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_ORG_ID', 'OPENAI_PROJECT_ID', 'AZURE_OPENAI_API_KEY'];
const STATUS_TTL_MS = 60_000;
const PROBE_TIMEOUT_MS = 20_000;
const CLIENT = { name: 'get-things-done', title: 'Get Things Done', version: '1' };

export function codexEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const name of BILLING_OVERRIDES) delete env[name];
  return env;
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
async function connect(bin: string, cwd: string, env: NodeJS.ProcessEnv, handlers: Partial<ConstructorParameters<typeof RpcConnection>[1]> = {}): Promise<{ child: ChildProcess; rpc: RpcConnection }> {
  const child = launch(bin, ['app-server'], cwd, env, 'pipe');
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
  private cached: { at: number; result: Promise<ProviderStatus> } | null = null;

  constructor(
    private readonly binary: () => string | null = () => findCommand('codex'),
    private readonly env: () => NodeJS.ProcessEnv = () => codexEnv(),
  ) {}

  status(_workspace: string, options: { fresh?: boolean } = {}): Promise<ProviderStatus> {
    if (!options.fresh && this.cached && Date.now() - this.cached.at < STATUS_TTL_MS) {
      return this.cached.result.then((s) => ({ ...s, limits: lastLimits.windows ?? s.limits }));
    }
    const result = this.check();
    this.cached = { at: Date.now(), result };
    return result;
  }

  private async check(): Promise<ProviderStatus> {
    const base = { id: this.id, label: this.label, notes: [] as ProviderStatus['notes'], plan: null as string | null, models: [] as ChatModel[], limits: null as UsageWindow[] | null };
    const bin = this.binary();
    if (!bin) return { ...base, installed: false, ready: false, problems: [{ code: 'not_installed', message: 'OpenAI Codex is not installed on this computer. Install it, sign in once with your ChatGPT account, then try again.' }] };
    let conn: { child: ChildProcess; rpc: RpcConnection };
    try { conn = await connect(bin, os.homedir(), this.env()); } catch {
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
      const signedIn = problems.length === 0;
      const models = signedIn ? codexModels(await conn.rpc.request('model/list', {}, PROBE_TIMEOUT_MS).catch(() => null)) : [];
      const limits = signedIn ? codexLimits(await conn.rpc.request('account/rateLimits/read', {}, PROBE_TIMEOUT_MS).catch(() => null)) : null;
      if (limits) lastLimits.windows = limits;
      return { ...base, installed: true, ready: signedIn, problems, plan: account ? shortDetail(account['planType'], 40) : null, models, limits };
    } finally {
      killTree(conn.child, true);
    }
  }

  async open(options: ChatOpenOptions): Promise<ChatSession> {
    const bin = this.binary();
    if (!bin) throw Object.assign(new Error('OpenAI Codex is not installed on this computer.'), { statusCode: 409 });
    // Not cached for the next check: a session can change the sign-in (an expired token refreshed or not).
    this.cached = null;
    const session = new CodexSession();
    await session.start(bin, options, this.env());
    return session;
  }
}

class CodexSession implements ChatSession {
  sessionId: string | null = null;
  private child: ChildProcess | null = null;
  private rpc: RpcConnection | null = null;
  private turn: { onEvent: (e: ChatEvent) => void; id: string | null; interrupted: boolean; ended: boolean } | null = null;

  get alive(): boolean {
    return this.rpc?.alive ?? false;
  }

  async start(bin: string, options: ChatOpenOptions, env: NodeJS.ProcessEnv): Promise<void> {
    const { child, rpc } = await connect(bin, options.workspace, env, {
      onNotification: (method, params) => this.onNotification(method, params),
      onRequest: refuse,
      onExit: () => {
        const text = this.rpc?.stderr ?? '';
        if (this.turn?.interrupted) this.end({ status: 'stopped' });
        else this.end({ status: 'error', error: turnError(text, 'crashed') });
      },
    });
    this.child = child;
    this.rpc = rpc;
    // The same limits on a new thread and a resumed one: a resumed thread never keeps looser settings.
    const settings = {
      cwd: options.workspace, sandbox: 'read-only', approvalPolicy: 'never',
      developerInstructions: options.instructions, config: { web_search: 'disabled' },
      ...(options.model ? { model: options.model } : {}),
    };
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
    this.effort = options.effort;
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
