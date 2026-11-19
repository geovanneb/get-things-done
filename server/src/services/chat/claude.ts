import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { ChildProcess } from 'child_process';
import { findCommand } from '../aiToolDetection';
import { ClaudeCodeAdapter, RUNNER_SETTINGS, childEnv, killTree, launch, runnerSettingsFile, stopTree } from '../agentRunner';
import { stepsFromMessage } from '../runSteps';
import { atomicWrite } from '../../utils/atomicWrite';
import {
  isObject, isoFromEpoch, lineReader, parseLine, shortDetail, turnError,
  type ChatAdapter, type ChatEvent, type ChatModel, type ChatOpenOptions, type ChatProblem, type ChatSession, type ProviderStatus, type TurnOutcome, type UsageWindow,
} from './types';

/**
 * Claude Code as a chat: one `claude -p` process per conversation, reading user messages as stream-json on stdin.
 * The same guarantees as the agent runner (agentRunner.ts): the Claude plan only (API-key and provider variables
 * removed, a run that reports an API key stopped at once), the workspace's own settings only, no hooks, no MCP
 * servers (the claude.ai connectors included). On top of that the chat is read-only: Read, Glob and Grep are the
 * only tools, and `dontAsk` refuses anything else. Folder trust is not required, unlike for the runner: Claude Code
 * ignores a workspace's allow rules until it trusts the folder, and a read-only chat needs none of them.
 */

const TOOLS = 'Read,Glob,Grep';
const MAX_TURNS_PER_MESSAGE = 40;
const MODELS_TTL_MS = 10 * 60 * 1000;
const PROBE_TIMEOUT_MS = 20_000;
const STDERR_KEEP = 4096;

/** The chat's instructions, as a file: no text with newlines or quotes goes through a command line. */
export function chatInstructionsFile(workspace: string): string {
  return path.join(workspace, '.situation-board', 'chat', 'instructions.md');
}

/** The plan's usage windows from a `rate_limit_event`. */
export function claudeLimits(info: unknown): UsageWindow[] | null {
  if (!isObject(info)) return null;
  const windows = isObject(info['unifiedWindows']) ? info['unifiedWindows'] : null;
  const out: UsageWindow[] = [];
  const kinds: Record<string, UsageWindow['kind']> = { five_hour: 'five_hour', seven_day: 'weekly' };
  if (windows) {
    for (const [name, value] of Object.entries(windows)) {
      if (!isObject(value)) continue;
      const used = typeof value['utilization'] === 'number' ? Math.round(Math.min(1, Math.max(0, value['utilization'])) * 100) : null;
      out.push({ kind: kinds[name] ?? 'other', used_percent: used, resets_at: isoFromEpoch(value['resetsAt']), limited: value['status'] === 'rejected' });
    }
  } else if (typeof info['rateLimitType'] === 'string') {
    out.push({ kind: kinds[info['rateLimitType']] ?? 'other', used_percent: null, resets_at: isoFromEpoch(info['resetsAt']), limited: info['status'] === 'rejected' });
  }
  return out.length ? out : null;
}

/** Context used by the last request: everything the model read (cached or not) plus what it wrote. */
export function claudeContextUsed(usage: unknown): number | null {
  if (!isObject(usage)) return null;
  const n = (key: string) => (typeof usage[key] === 'number' ? (usage[key] as number) : 0);
  const total = n('input_tokens') + n('cache_read_input_tokens') + n('cache_creation_input_tokens') + n('output_tokens');
  return total > 0 ? total : null;
}

function contextWindowOf(result: Record<string, unknown>, model: string | null): number | null {
  const usage = isObject(result['modelUsage']) ? result['modelUsage'] : null;
  if (!usage) return null;
  const entries = Object.entries(usage).filter(([, v]) => isObject(v) && typeof v['contextWindow'] === 'number') as [string, Record<string, number>][];
  const match = entries.find(([name]) => name === model) ?? entries[0];
  return match ? match[1]['contextWindow']! : null;
}

export function claudeModels(raw: unknown): ChatModel[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((m): ChatModel[] => {
    if (!isObject(m) || typeof m['value'] !== 'string' || !m['value']) return [];
    const efforts = Array.isArray(m['supportedEffortLevels']) ? m['supportedEffortLevels'].filter((e): e is string => typeof e === 'string') : [];
    return [{
      id: m['value'],
      label: shortDetail(m['displayName'], 60) ?? m['value'],
      description: shortDetail(m['description'], 120),
      efforts,
      is_default: m['value'] === 'default',
    }];
  });
}

/** The model check: the same lock-down as a conversation (read tools only, no hooks, no MCP servers), nothing saved. */
export function modelProbeArgs(settingsFile: string): string[] {
  return [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--setting-sources', 'project', '--strict-mcp-config', '--settings', settingsFile,
    '--permission-mode', 'dontAsk', '--tools', TOOLS, '--no-session-persistence',
  ];
}

/** A conversation's process, new or resumed: the same lock-down either way. */
export function conversationArgs(settingsFile: string, instructionsFile: string, options: Pick<ChatOpenOptions, 'model' | 'effort' | 'resume'>): string[] {
  return [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--setting-sources', 'project', '--strict-mcp-config', '--settings', settingsFile,
    '--permission-mode', 'dontAsk', '--tools', TOOLS, '--max-turns', String(MAX_TURNS_PER_MESSAGE),
    '--append-system-prompt-file', instructionsFile,
    ...(options.model ? ['--model', options.model] : []),
    ...(options.effort ? ['--effort', options.effort] : []),
    ...(options.resume ? ['--resume', options.resume] : []),
  ];
}

const lastLimits = new Map<string, UsageWindow[]>();

export class ClaudeChatAdapter implements ChatAdapter {
  id = 'claude-code' as const;
  label = 'Claude Code';
  private models: { at: number; bin: string; list: Promise<ChatModel[]> } | null = null;
  private readonly runner: ClaudeCodeAdapter;

  /** `binary` and `env` are for tests; by default the installed `claude` and this process's environment. */
  constructor(
    private readonly binary: () => string | null = () => findCommand('claude'),
    private readonly env: () => NodeJS.ProcessEnv = () => childEnv(),
  ) {
    this.runner = new ClaudeCodeAdapter(binary, env);
  }

  async status(workspace: string, options: { fresh?: boolean } = {}): Promise<ProviderStatus> {
    const base = { id: this.id, label: this.label, notes: [] as ProviderStatus['notes'] };
    const runner = await this.runner.status(workspace);
    // Trust only matters for the workspace's allow rules, which a read-only chat never needs: not a problem here.
    const problems: ChatProblem[] = runner.problems.filter((p) => p.code !== 'not_trusted').map((p) => ({
      code: p.code === 'not_logged_in' ? 'not_signed_in' : p.code === 'auth_unknown' ? 'check_failed' : p.code,
      message: p.message,
    }));
    const bin = this.binary();
    const models = runner.installed && bin && !problems.some((p) => p.code === 'not_signed_in' || p.code === 'check_failed')
      ? await this.listModels(bin, options.fresh === true)
      : [];
    return {
      ...base,
      installed: runner.installed,
      ready: runner.installed && problems.length === 0,
      problems,
      plan: runner.account?.plan ?? null,
      models,
      limits: lastLimits.get(this.id) ?? null,
    };
  }

  /**
   * The models this sign-in offers, from Claude Code itself (`initialize`): no message is sent, nothing is used.
   * Locked down like a conversation: no hooks (Claude Code runs SessionStart hooks even for this), no MCP servers,
   * only the read tools. It starts in an empty folder of its own, so no folder's settings apply (in the home folder,
   * the personal settings would count as that folder's), and the folder is removed afterwards.
   */
  private listModels(bin: string, fresh: boolean): Promise<ChatModel[]> {
    if (!fresh && this.models && this.models.bin === bin && Date.now() - this.models.at < MODELS_TTL_MS) return this.models.list;
    const list = this.probeModels(bin);
    this.models = { at: Date.now(), bin, list };
    // A failed probe is not cached for long: the next status check tries again.
    void list.then((l) => { if (!l.length && this.models?.list === list) this.models = null; });
    return list;
  }

  private async probeModels(bin: string): Promise<ChatModel[]> {
    let dir: string;
    try { dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-chat-models-')); } catch { return []; }
    try {
      // Inside the cleanup: a folder whose settings could not be written is removed too.
      try { await fsp.writeFile(path.join(dir, 'settings.json'), RUNNER_SETTINGS); } catch { return []; }
      return await new Promise<ChatModel[]>((resolve) => {
        let child: ChildProcess;
        try { child = launch(bin, modelProbeArgs(path.join(dir, 'settings.json')), dir, this.env(), 'pipe'); } catch { resolve([]); return; }
        let settled = false;
        const settle = (value: ChatModel[]) => { if (settled) return; settled = true; clearTimeout(timer); killTree(child, true); resolve(value); };
        const timer = setTimeout(() => settle([]), PROBE_TIMEOUT_MS);
        const reader = lineReader((line) => {
          const m = parseLine(line);
          if (m?.['type'] !== 'control_response') return;
          const response = isObject(m['response']) && isObject(m['response']['response']) ? m['response']['response'] : {};
          settle(claudeModels(response['models']));
        });
        child.stdout?.setEncoding('utf-8');
        child.stdout?.on('data', (c: string) => reader.push(c));
        child.on('error', () => settle([]));
        child.on('exit', () => settle([]));
        child.stdin?.on('error', () => settle([]));
        child.stdin?.write(JSON.stringify({ type: 'control_request', request_id: 'gtd-models', request: { subtype: 'initialize' } }) + '\n');
      });
    } finally {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async open(options: ChatOpenOptions): Promise<ChatSession> {
    const bin = this.binary();
    if (!bin) throw Object.assign(new Error('Claude Code is not installed on this computer.'), { statusCode: 409 });
    const instructions = chatInstructionsFile(options.workspace);
    await fsp.mkdir(path.dirname(instructions), { recursive: true });
    await atomicWrite(instructions, options.instructions);
    // A workspace that never ran an analysis has no runs folder yet.
    await fsp.mkdir(path.dirname(runnerSettingsFile(options.workspace)), { recursive: true });
    await atomicWrite(runnerSettingsFile(options.workspace), RUNNER_SETTINGS);
    const args = conversationArgs(runnerSettingsFile(options.workspace), instructions, options);
    return new ClaudeSession(launch(bin, args, options.workspace, this.env(), 'pipe'), options, (w) => lastLimits.set(this.id, w));
  }
}

interface Turn { onEvent: (e: ChatEvent) => void; interrupted: boolean; streamed: boolean; ended: boolean }

class ClaudeSession implements ChatSession {
  sessionId: string | null;
  alive = true;
  private turn: Turn | null = null;
  private stderr = '';
  private model: string | null = null;
  private stopping: 'api_key' | null = null;
  private readonly roots: string[];

  constructor(private readonly child: ChildProcess, options: ChatOpenOptions, private readonly onLimits: (w: UsageWindow[]) => void) {
    this.sessionId = options.resume;
    this.roots = [options.workspace];
    try { this.roots.push(fs.realpathSync(options.workspace)); } catch { /* the path alone */ }
    const reader = lineReader((line) => { const m = parseLine(line); if (m) this.onMessage(m); });
    child.stdout?.setEncoding('utf-8');
    child.stdout?.on('data', (c: string) => reader.push(c));
    child.stderr?.setEncoding('utf-8');
    child.stderr?.on('data', (c: string) => {
      this.stderr = (this.stderr + c).slice(-STDERR_KEEP);
    });
    child.stdin?.on('error', () => { /* the exit handler reports it */ });
    const gone = () => {
      if (!this.alive) return;
      this.alive = false;
      reader.flush();
      const text = this.stderr;
      if (this.stopping === 'api_key') this.end({ status: 'error', error: { code: 'api_billing', detail: null } });
      else if (this.turn?.interrupted) this.end({ status: 'stopped' });
      else this.end({ status: 'error', error: turnError(text, 'crashed') });
      killTree(child, true);
    };
    child.on('error', gone);
    child.on('exit', () => setTimeout(gone, 300).unref());
    child.on('close', gone);
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

  private onMessage(m: Record<string, unknown>): void {
    const type = m['type'];
    if (typeof m['session_id'] === 'string' && m['session_id'] && m['session_id'] !== this.sessionId) {
      this.sessionId = m['session_id'];
      this.emit({ type: 'session', id: this.sessionId });
    }
    if (type === 'system' && m['subtype'] === 'init') {
      // Started with an API key after all (from somewhere the dashboard cannot see): stopped before anything is billed.
      if (m['apiKeySource'] && m['apiKeySource'] !== 'none') { this.stopping = 'api_key'; killTree(this.child, true); return; }
      if (typeof m['model'] === 'string') { this.model = m['model']; this.emit({ type: 'model', model: m['model'] }); }
      return;
    }
    if (type === 'system' && m['subtype'] === 'compact_boundary') { this.emit({ type: 'compacted' }); return; }
    if (type === 'rate_limit_event') {
      const windows = claudeLimits(m['rate_limit_info']);
      if (windows) { this.onLimits(windows); this.emit({ type: 'limits', windows }); }
      return;
    }
    if (type === 'stream_event' && isObject(m['event']) && m['parent_tool_use_id'] == null) {
      const e = m['event'];
      if (e['type'] === 'message_start' && this.turn) this.turn.streamed = false;
      const delta = isObject(e['delta']) ? e['delta'] : null;
      if (e['type'] === 'content_block_delta' && delta?.['type'] === 'text_delta' && typeof delta['text'] === 'string') {
        if (this.turn) this.turn.streamed = true;
        this.emit({ type: 'text', text: delta['text'] });
      }
      return;
    }
    if (type === 'assistant' && isObject(m['message']) && m['parent_tool_use_id'] == null) {
      const message = m['message'];
      for (const { step } of stepsFromMessage(m, this.roots)) this.emit({ type: 'step', step });
      // Without partial messages (an older Claude Code), the text comes whole with the message.
      if (this.turn && !this.turn.streamed && Array.isArray(message['content'])) {
        for (const block of message['content']) if (isObject(block) && block['type'] === 'text' && typeof block['text'] === 'string') this.emit({ type: 'text', text: block['text'] });
      }
      const used = claudeContextUsed(message['usage']);
      if (used !== null) this.emit({ type: 'usage', context_used: used, context_window: null });
      return;
    }
    if (type === 'result') {
      const window = contextWindowOf(m, this.model);
      if (window !== null) this.emit({ type: 'usage', context_used: null, context_window: window });
      if (this.turn?.interrupted) { this.end({ status: 'stopped' }); return; }
      const failed = m['is_error'] === true || m['subtype'] !== 'success';
      if (!failed) { this.end({ status: 'done' }); return; }
      const errors = Array.isArray(m['errors']) ? m['errors'].filter((x) => typeof x === 'string').join(' ') : '';
      const said = `${typeof m['result'] === 'string' ? m['result'] : ''} ${errors}`.trim() || String(m['subtype'] ?? '');
      this.end({ status: 'error', error: turnError(said) });
    }
  }

  send(text: string, onEvent: (event: ChatEvent) => void): void {
    if (!this.alive) { onEvent({ type: 'end', outcome: { status: 'error', error: { code: 'crashed', detail: null } } }); return; }
    if (this.turn) throw Object.assign(new Error('The assistant is still answering. Wait for it, or stop it first.'), { statusCode: 409 });
    this.turn = { onEvent, interrupted: false, streamed: false, ended: false };
    this.child.stdin?.write(JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n');
  }

  async interrupt(): Promise<void> {
    if (!this.turn || !this.alive) return;
    this.turn.interrupted = true;
    this.child.stdin?.write(JSON.stringify({ type: 'control_request', request_id: `gtd-stop-${Date.now()}`, request: { subtype: 'interrupt' } }) + '\n');
  }

  async close(): Promise<void> {
    try { this.child.stdin?.end(); } catch { /* already closed */ }
    await stopTree(this.child);
  }
}
