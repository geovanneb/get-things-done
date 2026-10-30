import * as os from 'os';
import * as path from 'path';
import * as fsp from 'fs/promises';
import { spawn, ChildProcess } from 'child_process';
import { WorkspaceService } from './workspace';
import { findCommand } from './aiToolDetection';
import { ContextUpdateService, proposalTarget, updateId } from './contextUpdateService';
import { GATE_TOOL, readGateLog, removeApprovalGate, writeApprovalGate, type ApprovalGate } from './approvalGate';
import { processAlive, setAnalysisRunning } from './runState';
import { parseMarkdown } from '../utils/markdown';
import { atomicWrite } from '../utils/atomicWrite';

/**
 * Runs the workspace's own agent commands without a window, with the AI tool the user already has.
 *
 * The commands and the workspace instructions stay the only source of truth: the runner sends exactly what
 * the user would type (`/gtd-context-analyze CU-…`). It writes no prompt of its own.
 *
 * The first runner is the installed Claude Code CLI, signed in with the user's Claude plan:
 *   claude -p "/gtd-context-analyze CU-…" --setting-sources project --permission-mode dontAsk
 *     --strict-mcp-config --settings '{"disableAllHooks":true}' …
 * What that does and does not promise:
 * - It runs under the workspace's own permission rules, as when the user runs the command in Claude Code;
 *   `dontAsk` turns every permission prompt into a refusal. It is not a sandbox: the rules decide what it may
 *   write. Personal settings stay out (`project` only); hooks and MCP servers are off for unattended runs.
 * - It uses the plan, not an API account: API-key and provider variables are removed from its environment, a
 *   workspace that sets them is refused, Claude Code must report a claude.ai sign-in, and a run that still
 *   reports an API key at startup is stopped at once.
 * - Claude Code ignores a workspace's allow rules until the folder is trusted. The runner checks that before
 *   starting and stops a run that reports it anyway; it never changes trust itself.
 *
 * One run at a time, pinned to the workspace it started in, with its own process group so Stop ends everything
 * it started. A small record per update in `.situation-board/runs/` says how the last run ended.
 */

export type RunStatus = 'running' | 'succeeded' | 'failed' | 'cancelled';

/** The workspace commands the dashboard can run: analyze a ready update, apply an approved one. */
export type RunCommand = 'analyze' | 'apply';

export interface AgentRun {
  update_id: string;
  command: RunCommand;
  runner: string;
  status: RunStatus;
  started_at: string;
  ended_at: string | null;
  /** What happened, in plain words, and what to do next when it failed. */
  message: string;
  /** Tool calls the workspace rules refused. A few are normal; the agent finds another way. */
  refused: number;
  turns: number | null;
  /** What the run would cost at API prices, as reported by the tool. On a plan it counts toward the plan's usage. */
  usage_usd: number | null;
  /** The process that ran it, so a restart can tell a finished run from one still going. */
  pid?: number | null;
}

export type ProblemCode = 'not_installed' | 'not_logged_in' | 'not_subscription' | 'auth_unknown' | 'not_trusted' | 'workspace_auth';

export interface RunnerStatus {
  id: string;
  label: string;
  installed: boolean;
  /** null when it could not be checked. */
  logged_in: boolean | null;
  /** Whether Claude Code trusts the workspace folder; null when that could not be verified. */
  trusted: boolean | null;
  problems: { code: ProblemCode; message: string }[];
}

/** Why the runner ended a run itself, when it did. */
export type StopReason = 'cancelled' | 'timeout' | 'not_trusted' | 'api_key' | 'shutdown';

/** What a finished process left behind, for the runner to explain. */
export interface RunOutcome {
  exit_code: number | null;
  /** The tool's final result, if it got that far. */
  result: { subtype?: string; is_error?: boolean; result?: string; num_turns?: number; total_cost_usd?: number; permission_denials?: unknown[] } | null;
  /** The end of what the tool wrote to stderr. */
  stderr: string;
  stopped?: StopReason;
}

export interface RunHandle {
  pid: number | null;
  /** Ends the run and everything it started; resolves once it is gone (or after a bounded wait). */
  stop(reason: StopReason): Promise<void>;
}

/** One AI tool that can run a workspace command unattended. */
export interface AgentRunnerAdapter {
  id: string;
  label: string;
  status(workspace: string): Promise<RunnerStatus>;
  /** With `gate`, every permission prompt goes to the approval gate instead of being refused. */
  start(workspace: string, prompt: string, done: (outcome: RunOutcome) => void, gate?: ApprovalGate): RunHandle;
}

const MAX_TURNS = 80;
const TIMEOUT_MS = 30 * 60 * 1000;
const PROBE_TIMEOUT_MS = 15_000;
// Stop, then a hard stop after this; the whole sequence stays well under the server's 10-second forced exit.
const KILL_GRACE_MS = 3_000;
const STDERR_KEEP = 4096;
const MAX_LINE = 1024 * 1024;

/** Variables that would make Claude Code use an API account or another provider instead of the user's plan. */
const BILLING_OVERRIDES = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_BEDROCK_BASE_URL',
  'ANTHROPIC_VERTEX_BASE_URL', 'ANTHROPIC_FOUNDRY_API_KEY', 'ANTHROPIC_FOUNDRY_BASE_URL', 'ANTHROPIC_FOUNDRY_RESOURCE',
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode: status });
}

/** The environment for every Claude Code process the runner starts: the user's own, minus billing overrides. */
export function childEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const name of BILLING_OVERRIDES) delete env[name];
  return env;
}

/** Claude Code's settings file for this environment: `$CLAUDE_CONFIG_DIR/.claude.json`, or `~/.claude.json`. */
function claudeConfigFile(env: NodeJS.ProcessEnv): string {
  const dir = env['CLAUDE_CONFIG_DIR'];
  return dir ? path.join(dir, '.claude.json') : path.join(env['HOME'] ?? os.homedir(), '.claude.json');
}

/**
 * Whether Claude Code has trusted this folder (or a folder above it): true, false, or null when its settings
 * cannot be read. Claude Code keeps this in its own settings file; the runner only reads it.
 */
export async function workspaceTrusted(workspace: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean | null> {
  let projects: Record<string, { hasTrustDialogAccepted?: unknown }>;
  try {
    projects = (JSON.parse(await fsp.readFile(claudeConfigFile(env), 'utf-8')) as { projects?: typeof projects }).projects ?? {};
  } catch {
    return null;
  }
  const real = await fsp.realpath(workspace).catch(() => workspace);
  for (const start of new Set([path.resolve(workspace), real])) {
    for (let dir = start; ; dir = path.dirname(dir)) {
      if (projects[dir]?.hasTrustDialogAccepted === true) return true;
      if (path.dirname(dir) === dir) break;
    }
  }
  return false;
}

/** What the workspace's own `.claude/settings.json` does about billing: the names it sets, if any. */
async function workspaceBillingOverrides(workspace: string): Promise<string[]> {
  try {
    const settings = JSON.parse(await fsp.readFile(path.join(workspace, '.claude', 'settings.json'), 'utf-8')) as Record<string, unknown>;
    const env = (settings['env'] && typeof settings['env'] === 'object' ? settings['env'] : {}) as Record<string, unknown>;
    return [...BILLING_OVERRIDES.filter((n) => n in env), ...(settings['apiKeyHelper'] ? ['apiKeyHelper'] : [])];
  } catch {
    return [];
  }
}

/** Settings the runner adds on top of the workspace's for unattended runs: no hooks. A file, so no JSON goes through a shell. */
const RUNNER_SETTINGS = JSON.stringify({ disableAllHooks: true }, null, 2) + '\n';

function runnerSettingsFile(workspace: string): string {
  return path.join(workspace, '.situation-board', 'runs', 'runner-settings.json');
}

/** Windows starts .cmd and .bat programs only through cmd.exe. */
function viaCmd(bin: string): boolean {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin);
}

/**
 * Starts a program without a shell where possible. On Windows a .cmd shim needs cmd.exe: the whole command line
 * is quoted by hand (program path included) and anything cmd.exe would still interpret is refused.
 */
function launch(bin: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): ChildProcess {
  if (!viaCmd(bin)) {
    return spawn(bin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
  }
  const parts = [bin, ...args].map((part) => {
    if (/["%!^\r\n]/.test(part)) throw httpError(400, 'Claude Code is installed in a folder the dashboard cannot start it from');
    return `"${part}"`;
  });
  return spawn(process.env['ComSpec'] ?? 'cmd.exe', ['/d', '/s', '/c', `"${parts.join(' ')}"`],
    { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, windowsVerbatimArguments: true });
}

/** Ends a process and everything it started: its process group on macOS and Linux, its tree on Windows. */
function killTree(child: ChildProcess, hard: boolean): void {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', ...(hard ? ['/F'] : [])], { windowsHide: true, stdio: 'ignore' });
    } else {
      process.kill(-child.pid, hard ? 'SIGKILL' : 'SIGTERM');
    }
  } catch {
    // Already gone.
  }
}

const gone = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null;

/** Stops a process tree: a polite request first, then a hard stop. Resolves once the process has exited. */
function stopTree(child: ChildProcess): Promise<void> {
  if (gone(child)) return Promise.resolve();
  return new Promise((resolve) => {
    const hard = setTimeout(() => killTree(child, true), KILL_GRACE_MS);
    const giveUp = setTimeout(() => resolve(), KILL_GRACE_MS * 2);
    child.once('exit', () => { clearTimeout(hard); clearTimeout(giveUp); resolve(); });
    killTree(child, false);
  });
}

export class ClaudeCodeAdapter implements AgentRunnerAdapter {
  id = 'claude-code';
  label = 'Claude Code';
  private probe: { at: number; result: Promise<Record<string, unknown> | null> } | null = null;

  /** `binary`, `env` and `probeTimeoutMs` are for tests; by default the installed `claude` and this process's environment. */
  constructor(
    private readonly binary: () => string | null = () => findCommand('claude'),
    private readonly env: () => NodeJS.ProcessEnv = () => childEnv(),
    private readonly probeTimeoutMs = PROBE_TIMEOUT_MS,
  ) {}

  /** `claude auth status --json`, with a hard deadline. No model is called. Concurrent checks share one probe. */
  private authStatus(bin: string): Promise<Record<string, unknown> | null> {
    if (this.probe && Date.now() - this.probe.at < 5_000) return this.probe.result;
    const result = new Promise<Record<string, unknown> | null>((resolve) => {
      let out = '';
      let settled = false;
      // Set only once the probe has started: a launch that fails at once settles without it.
      const deadline: { timer?: ReturnType<typeof setTimeout> } = {};
      const settle = (value: Record<string, unknown> | null) => { if (!settled) { settled = true; if (deadline.timer) clearTimeout(deadline.timer); resolve(value); } };
      let child: ChildProcess;
      try { child = launch(bin, ['auth', 'status', '--json'], os.homedir(), this.env()); } catch { settle(null); return; }
      deadline.timer = setTimeout(() => { killTree(child, true); settle(null); }, this.probeTimeoutMs);
      child.stdout?.setEncoding('utf-8');
      child.stdout?.on('data', (chunk: string) => { out = (out + chunk).slice(-65536); });
      child.on('error', () => settle(null));
      child.on('exit', () => {
        let parsed: unknown = null;
        try { parsed = JSON.parse(out); } catch { /* not JSON */ }
        settle(isObject(parsed) ? parsed : null);
      });
    });
    this.probe = { at: Date.now(), result };
    return result;
  }

  async status(workspace: string): Promise<RunnerStatus> {
    const base = { id: this.id, label: this.label };
    const bin = this.binary();
    if (!bin) {
      return { ...base, installed: false, logged_in: null, trusted: null, problems: [{ code: 'not_installed', message: 'Claude Code is not installed on this computer. Install it, sign in once, then try again.' }] };
    }
    const problems: RunnerStatus['problems'] = [];
    const auth = await this.authStatus(bin);
    const loggedIn = auth ? auth['loggedIn'] === true : null;
    if (auth === null) {
      problems.push({ code: 'auth_unknown', message: 'Could not check whether Claude Code is signed in. Open a terminal, run claude to make sure it starts and is signed in, then try again.' });
    } else if (!loggedIn) {
      problems.push({ code: 'not_logged_in', message: 'Claude Code is not signed in. Open a terminal, run claude, sign in, then try again.' });
    } else if (auth['authMethod'] !== 'claude.ai') {
      problems.push({ code: 'not_subscription', message: 'Claude Code is signed in with an API account, not a Claude plan. Running from the dashboard uses a Claude plan only; sign in with your Claude account, or run the command in Claude Code yourself.' });
    }
    const overrides = await workspaceBillingOverrides(workspace);
    if (overrides.length) {
      problems.push({ code: 'workspace_auth', message: `This workspace's .claude/settings.json sets ${overrides.join(', ')}, which would bill an API account instead of your plan. Remove it to run from the dashboard.` });
    }
    let env: NodeJS.ProcessEnv | null = null;
    try { env = this.env(); } catch { /* reported by the sign-in check */ }
    const trusted = env ? await workspaceTrusted(workspace, env) : null;
    if (trusted === false) {
      problems.push({ code: 'not_trusted', message: 'Claude Code has not trusted this workspace folder yet, so it would ignore the workspace\'s permission rules. Open a terminal in the workspace folder, run claude once and accept "trust this folder", then try again.' });
    }
    return { ...base, installed: true, logged_in: loggedIn, trusted, problems };
  }

  start(workspace: string, prompt: string, done: (outcome: RunOutcome) => void, gate?: ApprovalGate): RunHandle {
    const bin = this.binary();
    if (!bin) throw httpError(409, 'Claude Code is not installed on this computer.');
    // Without a gate every prompt is refused (dontAsk). With one, prompts go to it: the only MCP server loaded.
    const permissions = gate
      ? ['--permission-mode', 'default', '--mcp-config', gate.mcpConfig, '--permission-prompt-tool', GATE_TOOL]
      : ['--permission-mode', 'dontAsk'];
    const args = ['-p', prompt, '--setting-sources', 'project', ...permissions,
      '--strict-mcp-config', '--settings', runnerSettingsFile(workspace),
      '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--max-turns', String(MAX_TURNS)];
    const child = launch(bin, args, workspace, this.env());
    let result: RunOutcome['result'] = null;
    let stderr = '';
    let pending = '';
    let stopped: StopReason | undefined;
    let finished = false;

    const stop = (reason: StopReason): Promise<void> => {
      stopped ??= reason;
      return stopTree(child);
    };
    const onLine = (line: string) => {
      let parsed: unknown;
      try { parsed = JSON.parse(line); } catch { return; }
      // Anything that is not a message object (null, a number, a list) is ignored, never read as one.
      if (!isObject(parsed)) return;
      const m = parsed;
      if (m['type'] === 'result') result = m as RunOutcome['result'];
      // Started with an API key after all (from somewhere the runner cannot see): stop before any work is billed.
      if (m['type'] === 'system' && m['subtype'] === 'init' && m['apiKeySource'] && m['apiKeySource'] !== 'none') void stop('api_key');
    };
    child.stdout?.setEncoding('utf-8');
    child.stdout?.on('data', (chunk: string) => {
      pending += chunk;
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      if (pending.length > MAX_LINE) pending = '';
      lines.forEach(onLine);
    });
    child.stderr?.setEncoding('utf-8');
    child.stderr?.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_KEEP);
      // Claude Code says this before any work: without trust its allow rules are ignored and nothing can be saved.
      // Checked on what was collected, so a message split across chunks is still seen.
      if (/has not been\s+trusted/i.test(stderr)) void stop('not_trusted');
    });
    const timer = setTimeout(() => void stop('timeout'), TIMEOUT_MS);
    const finish = (exit: number | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (pending) onLine(pending);
      // Whatever the run started goes with it, even when the main process ended on its own.
      killTree(child, true);
      done({ exit_code: exit, result, stderr, stopped });
    };
    child.on('error', () => finish(null));
    // A descendant can keep the output pipes open after the main process exits: do not wait for them forever.
    child.on('exit', (code) => setTimeout(() => finish(code), 2000).unref());
    child.on('close', (code) => finish(code));
    return { pid: child.pid ?? null, stop };
  }
}

const workspaceService = new WorkspaceService();

/** An accepted change that writes a file, as the run started with it. */
export interface AcceptedChange { id: string; action: string; target: string }

/** What an apply left behind: accepted changes the agent did not record as applied or merged, and the gate's log. */
export interface ApplyFacts { not_applied: string[]; refused_writes: string[] }

const WORDS: Record<RunCommand, { noun: string; again: string }> = {
  analyze: { noun: 'analysis', again: 'run the analysis again' },
  apply: { noun: 'apply', again: 'apply again' },
};

/** Turns what the tool left behind, and where the update ended up, into a status and a plain message. */
export function explainOutcome(outcome: RunOutcome, updateStatus: string | null, command: RunCommand = 'analyze', apply?: ApplyFacts): Pick<AgentRun, 'status' | 'message' | 'refused' | 'turns' | 'usage_usd'> {
  const r = outcome.result;
  const w = WORDS[command];
  const facts = {
    refused: Array.isArray(r?.permission_denials) ? r!.permission_denials!.length : 0,
    turns: typeof r?.num_turns === 'number' ? r.num_turns : null,
    usage_usd: typeof r?.total_cost_usd === 'number' ? r.total_cost_usd : null,
  };
  const failed = (message: string) => ({ ...facts, status: 'failed' as const, message });
  switch (outcome.stopped) {
    case 'cancelled': {
      const half = command === 'analyze' && updateStatus === 'analyzing'
        ? ' The update was left half analyzed: go back to collecting, then run the analysis again.'
        : command === 'apply' && updateStatus === 'applying'
        ? ' Some accepted changes may already be written. Apply again: it continues where it stopped, and changes already made are merged, not repeated.'
        : '';
      return { ...facts, status: 'cancelled', message: `Stopped.${half}` };
    }
    case 'shutdown': return failed(`The dashboard stopped while the ${w.noun} was running. ${capital(w.again)}.`);
    case 'timeout': return failed(`The ${w.noun} took longer than 30 minutes and was stopped. ${capital(w.again)}, or run the command in Claude Code yourself.`);
    case 'api_key': return failed('Claude Code started with an API key instead of your Claude plan, so the run was stopped as soon as it reported this. Remove the API key from your Claude Code setup, then try again.');
    case 'not_trusted': return failed(`Claude Code has not trusted this workspace folder, so it would ignore the workspace's permission rules; the run was stopped. Open a terminal in the workspace folder, run claude once and accept "trust this folder", then ${w.again}.`);
    default: break;
  }
  const clean = outcome.exit_code === 0 && r?.subtype === 'success' && r.is_error !== true;
  if (command === 'analyze') {
    if (updateStatus === 'in_review' && clean) return { ...facts, status: 'succeeded', message: 'The analysis finished. Review the proposals below.' };
    if (updateStatus === 'in_review') return failed('Proposals are ready to review, but Claude Code reported an error at the end of the run. Check them carefully.');
  } else {
    const missing = apply?.not_applied ?? [];
    const blocked = apply?.refused_writes.length ? ` Writes refused because you had not accepted them: ${apply.refused_writes.join(', ')}.` : '';
    if (updateStatus === 'done' && clean && missing.length === 0) return { ...facts, status: 'succeeded', message: `Your accepted changes are written.${blocked}` };
    if (updateStatus === 'done') {
      return failed(`The update is finished, but ${missing.length ? `these accepted changes are not recorded as applied: ${missing.join(', ')}` : 'Claude Code reported an error at the end of the run'}. Check the outcome of each change below.${blocked}`);
    }
  }
  const text = `${r?.result ?? ''}\n${outcome.stderr}`;
  if (/failed to authenticate|oauth session expired|not logged in|please run \/login/i.test(text)) {
    return failed(`Claude Code needs you to sign in again. Open a terminal, run claude, sign in, then ${w.again}.`);
  }
  if (r?.subtype === 'error_max_turns') return failed(`The ${w.noun} stopped after ${MAX_TURNS} steps without finishing. ${capital(w.again)}, or run the command in Claude Code yourself.`);
  const where = updateStatus ? ` The update is now "${updateStatus}".` : '';
  return failed(`The ${w.noun} did not finish.${where} ${capital(w.again)}, or run the command in Claude Code yourself to see what happens.`);
}

function capital(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

interface Active {
  workspace: string;
  run: AgentRun;
  handle: RunHandle | null;
  stopRequested: StopReason | null;
  /** Set once the run has ended: from then on no "running" record may be written. */
  terminal: boolean;
  /** For an apply: the approval gate (removed after the run) and the accepted changes the run started with. */
  gate: ApprovalGate | null;
  accepted: AcceptedChange[];
  /** Record writes for this run, one after the other, so an older one never lands after a newer one. */
  writes: Promise<void>;
  done: Promise<void>;
  resolveDone: () => void;
}

let active: Active | null = null;
/** How each update's last run ended, also when its record could not be saved. Keyed by workspace and update. */
const recent = new Map<string, AgentRun>();
const recentKey = (workspace: string, id: string) => `${workspace}\0${id}`;

export class AgentRunnerService {
  constructor(private readonly adapter: AgentRunnerAdapter = new ClaudeCodeAdapter()) {}

  status(): Promise<RunnerStatus> {
    return this.adapter.status(workspaceService.getWorkspacePath());
  }

  private runDir(workspace: string): string {
    return path.join(workspace, '.situation-board', 'runs');
  }

  private runFile(workspace: string, id: string): string {
    return path.join(this.runDir(workspace), `${updateId(id)}.json`);
  }

  private async save(workspace: string, run: AgentRun): Promise<void> {
    await fsp.mkdir(this.runDir(workspace), { recursive: true });
    await atomicWrite(this.runFile(workspace, run.update_id), JSON.stringify(run, null, 2) + '\n');
  }

  /** Queues a write of the run's record; a "running" record is skipped once the run has ended. */
  private record(current: Active): Promise<void> {
    current.writes = current.writes.then(async () => {
      if (current.run.status === 'running' && current.terminal) return;
      await this.save(current.workspace, current.run);
    });
    return current.writes;
  }

  private async readRecord(workspace: string, id: string): Promise<AgentRun | null> {
    try { return JSON.parse(await fsp.readFile(this.runFile(workspace, id), 'utf-8')) as AgentRun; } catch { return null; }
  }

  /** The update's status; null when it does not exist. An update.md that cannot be read is an error, not "not found". */
  private async updateStatus(workspace: string, id: string): Promise<string | null> {
    let raw: string;
    try {
      raw = await fsp.readFile(path.join(workspace, 'context-updates', updateId(id), 'update.md'), 'utf-8');
    } catch {
      return null;
    }
    let status: unknown;
    try { status = (parseMarkdown(raw).data as Record<string, unknown>)['status']; } catch { status = undefined; }
    if (typeof status !== 'string') throw httpError(409, `The file of ${updateId(id)} (update.md) cannot be read; fix or recreate it first`);
    return status;
  }

  /** A run recorded as going whose process still exists: from before a restart of the dashboard. */
  private async orphan(workspace: string): Promise<AgentRun | null> {
    const names = await fsp.readdir(this.runDir(workspace)).catch(() => [] as string[]);
    for (const name of names) {
      if (!/^CU-\d{4}-\d{4}\.json$/.test(name)) continue; // not runner-settings.json, gate files
      const run = await this.readRecord(workspace, name.slice(0, -5));
      if (run?.status === 'running' && processAlive(run.pid)) return run;
    }
    return null;
  }

  /** The current or last run for an update in this workspace, or null when there was none. */
  async get(id: string): Promise<AgentRun | null> {
    const uid = updateId(id);
    const workspace = workspaceService.getWorkspacePath();
    if (active && active.workspace === workspace && active.run.update_id === uid) return active.run;
    // The saved record, unless it could not be saved or is older than what this dashboard last saw.
    const saved = await this.readRecord(workspace, uid);
    const remembered = recent.get(recentKey(workspace, uid)) ?? null;
    // For the same run, the ended state this dashboard saw wins over a "running" record that was left on disk.
    const sameRun = saved && remembered && saved.started_at === remembered.started_at;
    const run = !saved ? remembered : !remembered ? saved
      : sameRun ? (remembered.status !== 'running' ? remembered : saved)
      : saved.started_at > remembered.started_at ? saved : remembered;
    if (run?.status !== 'running') return run;
    if (processAlive(run.pid)) {
      return { ...run, message: `A run started before the dashboard restarted may still be going (process ${run.pid}). Wait for it to end, or end it yourself, before starting another.` };
    }
    return { ...run, status: 'failed', message: 'The dashboard stopped while this was running. Start it again.' };
  }

  /** The accepted creates and updates of an approved update: what an apply may write. Removals are the dashboard's. */
  private async acceptedTargets(workspace: string, id: string): Promise<AcceptedChange[]> {
    const raw = await fsp.readFile(path.join(workspace, 'context-updates', updateId(id), 'update.md'), 'utf-8');
    const proposals = (parseMarkdown(raw).data as Record<string, unknown>)['proposals'];
    if (!Array.isArray(proposals)) return [];
    return proposals.flatMap((entry) => {
      const p = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
      const target = proposalTarget(p['target']);
      const writes = p['action'] === 'create' || p['action'] === 'update';
      return p['decision'] === 'accepted' && writes && target ? [{ id: String(p['id']), action: String(p['action']), target }] : [];
    });
  }

  /**
   * After an apply: the accepted changes the run started with that are not recorded, unchanged and accepted, with an
   * applied or merged outcome. A change dropped or altered by the agent, or an update.md that cannot be read, counts
   * as not done. This checks the record the agent kept, not the files themselves.
   */
  private async notApplied(workspace: string, id: string, started: AcceptedChange[]): Promise<string[]> {
    let proposals: unknown;
    try {
      const raw = await fsp.readFile(path.join(workspace, 'context-updates', updateId(id), 'update.md'), 'utf-8');
      proposals = (parseMarkdown(raw).data as Record<string, unknown>)['proposals'];
    } catch {
      return started.map((c) => `${c.id} (the update could not be read to check)`);
    }
    const now = new Map<string, Record<string, unknown>>();
    for (const entry of Array.isArray(proposals) ? proposals : []) {
      if (entry && typeof entry === 'object') now.set(String((entry as Record<string, unknown>)['id']), entry as Record<string, unknown>);
    }
    return started.flatMap((c) => {
      const p = now.get(c.id);
      const same = p && p['decision'] === 'accepted' && p['action'] === c.action && proposalTarget(p['target']) === c.target;
      const done = same && (p['outcome'] === 'applied' || p['outcome'] === 'merged');
      return done ? [] : [p && !same ? `${c.id} (changed during the run)` : c.id];
    });
  }

  /** Starts `/gtd-context-analyze <id>` for an update that is ready. One run at a time. */
  startAnalysis(id: string): Promise<AgentRun> {
    return this.start(id, 'analyze');
  }

  /**
   * Starts `/gtd-context-analyze <id>` for a ready update, or `/gtd-context-apply <id>` for an approved one. An apply
   * runs with the approval gate: it may write only the accepted files and the update's own folder. One run at a time.
   */
  async start(id: string, command: RunCommand): Promise<AgentRun> {
    if (command !== 'analyze' && command !== 'apply') throw httpError(400, 'Invalid command: use analyze or apply');
    const uid = updateId(id);
    const workspace = workspaceService.getWorkspacePath();
    // An apply that stopped half way (status "applying") can continue: the apply command resumes and skips what is done.
    const allowedStatus = command === 'analyze' ? ['ready'] : ['approved', 'applying'];
    if (active) throw httpError(409, `Another run is going (${active.run.update_id}). Wait for it, or stop it first.`);
    // Reserved before the first await, so two starts can never both pass the checks.
    let resolveDone!: () => void;
    const done = new Promise<void>((r) => { resolveDone = r; });
    const run: AgentRun = {
      update_id: uid, command, runner: this.adapter.id, status: 'running', started_at: new Date().toISOString(), ended_at: null,
      message: command === 'analyze' ? `${this.adapter.label} is analyzing the material.` : `${this.adapter.label} is writing your accepted changes.`,
      refused: 0, turns: null, usage_usd: null, pid: null,
    };
    const current: Active = { workspace, run, handle: null, stopRequested: null, terminal: false, gate: null, accepted: [], writes: Promise.resolve(), done, resolveDone };
    active = current;
    recent.delete(recentKey(workspace, uid));
    setAnalysisRunning(workspace, uid, true);
    const release = () => {
      if (active === current) active = null;
      setAnalysisRunning(workspace, uid, false);
      resolveDone();
    };
    try {
      // Changes to this update already under way finish first; new ones see the run and wait for it.
      await new ContextUpdateService().settled(uid);
      const orphan = await this.orphan(workspace);
      if (orphan) throw httpError(409, `A run started before the dashboard restarted may still be going (${orphan.update_id}, process ${orphan.pid}). Wait for it to end first.`);
      const before = await this.updateStatus(workspace, uid);
      if (before === null) throw httpError(404, `Context update not found: ${uid}`);
      if (!allowedStatus.includes(before)) throw httpError(409, `Cannot ${command} while the update is "${before}"`);
      const targets = command === 'apply' ? await this.acceptedTargets(workspace, uid) : [];
      if (command === 'apply' && targets.length === 0) throw httpError(409, 'Nothing to apply: no accepted change writes a file');
      const check = await this.adapter.status(workspace);
      if (check.problems.length) throw httpError(409, check.problems[0]!.message);
      // Checked again right before launch: the update may have changed during the checks.
      const now = await this.updateStatus(workspace, uid);
      if (now === null || !allowedStatus.includes(now)) throw httpError(409, now === null ? `Context update not found: ${uid}` : `Cannot ${command} while the update is "${now}"`);
      await this.record(current);
      await atomicWrite(runnerSettingsFile(workspace), RUNNER_SETTINGS);
      const gate = command === 'apply' ? await writeApprovalGate(workspace, uid, targets.map((t) => t.target)) : undefined;
      current.gate = gate ?? null;
      current.accepted = targets;
      if (current.stopRequested) {
        await this.finish(current, { exit_code: null, result: null, stderr: '', stopped: current.stopRequested });
        return current.run;
      }
      const prompt = command === 'analyze' ? `/gtd-context-analyze ${uid}` : `/gtd-context-apply ${uid}`;
      current.handle = this.adapter.start(workspace, prompt, (outcome) => {
        void this.finish(current, { ...outcome, stopped: outcome.stopped ?? current.stopRequested ?? undefined });
      }, gate);
      if (!current.terminal) {
        current.run = { ...current.run, pid: current.handle.pid };
        await this.record(current).catch(() => {});
      }
      // Stop or shutdown asked for while the process was starting: end it now.
      if (current.stopRequested) void current.handle.stop(current.stopRequested);
    } catch (err) {
      if (current.gate) await removeApprovalGate(current.gate);
      release();
      throw err;
    }
    return current.run;
  }

  /** Records how a run ended. A failed save never crashes the dashboard: the outcome stays in memory until then. */
  private async finish(current: Active, outcome: RunOutcome): Promise<void> {
    current.terminal = true;
    try {
      const status = await this.updateStatus(current.workspace, current.run.update_id).catch(() => null);
      const apply = current.run.command === 'apply'
        ? { not_applied: await this.notApplied(current.workspace, current.run.update_id, current.accepted), refused_writes: current.gate ? (await readGateLog(current.gate.log)).refused : [] }
        : undefined;
      current.run = { ...current.run, ...explainOutcome(outcome, status, current.run.command, apply), ended_at: new Date().toISOString() };
      recent.set(recentKey(current.workspace, current.run.update_id), current.run);
      await this.record(current);
    } catch (err) {
      console.error(`Could not save how the run of ${current.run.update_id} ended: ${(err as Error).message}`);
    } finally {
      if (current.gate) await removeApprovalGate(current.gate);
      if (active === current) active = null;
      setAnalysisRunning(current.workspace, current.run.update_id, false);
      current.resolveDone();
    }
  }

  async cancel(id: string): Promise<AgentRun> {
    const workspace = workspaceService.getWorkspacePath();
    if (!active || active.workspace !== workspace || active.run.update_id !== updateId(id)) throw httpError(409, 'Nothing is running for this update');
    const current = active;
    current.stopRequested ??= 'cancelled';
    // Before launch the start sees the request and never launches; after launch the process tree is ended.
    if (current.handle) await current.handle.stop('cancelled');
    await Promise.race([current.done, new Promise((r) => setTimeout(r, KILL_GRACE_MS * 2.5))]);
    return current.run;
  }

  /** Ends a running analysis when the server shuts down, and waits (bounded) for it and its record. */
  static async stopAll(): Promise<void> {
    const current = active;
    if (!current) return;
    current.stopRequested ??= 'shutdown';
    await current.handle?.stop('shutdown');
    await Promise.race([current.done, new Promise((r) => setTimeout(r, KILL_GRACE_MS * 2.5))]);
  }
}
