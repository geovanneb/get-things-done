import type { RunStep } from '../runSteps';
import { isPlanLimit } from '../agentRunner';

/**
 * The workspace chat: a conversation with the AI tool the user already has, signed in with their own plan.
 * Each provider is the tool's own command line, started without a window, read-only, in the workspace folder.
 * The server never holds a password, a token or an API key; it only starts the tool the user signed in to.
 */

export type ChatProviderId = 'claude-code' | 'codex' | 'copilot';
export const CHAT_PROVIDERS: ChatProviderId[] = ['claude-code', 'codex', 'copilot'];

export type ChatProblemCode =
  | 'not_installed' | 'not_signed_in' | 'not_subscription' | 'check_failed' | 'not_trusted' | 'workspace_auth' | 'billing_env'
  /** The tool cannot be limited to reading files here (a hook it would run, or a version without the needed option). */
  | 'not_read_only';

export interface ChatProblem { code: ChatProblemCode; message: string }

export interface ChatModel {
  id: string;
  label: string;
  description: string | null;
  /** Reasoning effort levels the model takes; empty when it takes none or the tool does not say. */
  efforts: string[];
  is_default: boolean;
}

/** One of the plan's usage windows, as the tool reports it (Claude and Codex do; Copilot does not over ACP). */
export interface UsageWindow {
  kind: 'five_hour' | 'weekly' | 'other';
  /** 0 to 100; null when the tool only says whether it is allowed. */
  used_percent: number | null;
  resets_at: string | null;
  limited: boolean;
}

export interface ProviderStatus {
  id: ChatProviderId;
  label: string;
  installed: boolean;
  /** Installed, signed in with a plan, and nothing in the way: a message can be sent. */
  ready: boolean;
  problems: ChatProblem[];
  /** The plan's name as the tool reports it ("pro", "plus", "Copilot Business"), never the account's email. */
  plan: string | null;
  models: ChatModel[];
  /** Last usage the tool reported in this dashboard; null when it has not said yet or never says. */
  limits: UsageWindow[] | null;
  /** Fixed notes the page shows next to the picker, by code. */
  notes: ('premium_requests' | 'no_usage_report')[];
  /**
   * Which account this check approved (its config folder and the dashboard's sign-in generation): a session opened for
   * a message this check let through starts only with that same account (#505).
   */
  launch_key?: string;
}

export type TurnErrorCode =
  | 'sign_in' | 'plan_limit' | 'context_full' | 'api_billing' | 'not_trusted' | 'crashed' | 'timeout' | 'resume_failed' | 'provider';

export interface TurnError {
  code: TurnErrorCode;
  /** The tool's own short text, when it said something; shown quoted. */
  detail: string | null;
  /** For a plan limit: when the tool says it resets. */
  resets_at?: string | null;
}

export interface TurnOutcome { status: 'done' | 'stopped' | 'error'; error?: TurnError }

export type ChatEvent =
  | { type: 'session'; id: string }
  | { type: 'text'; text: string }
  | { type: 'step'; step: RunStep }
  | { type: 'usage'; context_used: number | null; context_window: number | null }
  | { type: 'limits'; windows: UsageWindow[] }
  | { type: 'model'; model: string }
  | { type: 'compacted' }
  | { type: 'end'; outcome: TurnOutcome };

export interface ChatOpenOptions {
  workspace: string;
  model: string | null;
  effort: string | null;
  /** The tool's own session id to continue; null starts a new one. */
  resume: string | null;
  /** What the chat tells the tool about itself (read-only, answer briefly). */
  instructions: string;
  /** The `launch_key` of the check that approved this message: the session is refused when the account changed since. */
  launch_key?: string;
}

/** Refused at open: another account was chosen, or a sign-in changed, after the check that approved the message. */
export function accountChangedError(): Error {
  const message = 'The account for this assistant changed while the message was being sent. Send it again.';
  return Object.assign(new Error(message), { statusCode: 409, turnError: { code: 'provider', detail: message } });
}

/** One live conversation with a tool: one process, one turn at a time. */
export interface ChatSession {
  /** The tool's session id once known: what a later open resumes. */
  readonly sessionId: string | null;
  readonly alive: boolean;
  /** Sends one user message. Events arrive through `onEvent` and always end with exactly one `end`. */
  send(text: string, onEvent: (event: ChatEvent) => void): void;
  /** Asks the tool to stop the turn going now; the turn still ends with its `end` event. */
  interrupt(): Promise<void>;
  /** Ends the process and everything it started. */
  close(): Promise<void>;
}

export interface ChatAdapter {
  id: ChatProviderId;
  label: string;
  status(workspace: string, options?: { fresh?: boolean }): Promise<ProviderStatus>;
  open(options: ChatOpenOptions): Promise<ChatSession>;
}

export const MAX_MESSAGE_CHARS = 20_000;
export const TURN_TIMEOUT_MS = 10 * 60 * 1000;

const SIGN_IN = /failed to authenticate|oauth (?:session|token) (?:has )?expired|session (?:has )?expired|not (?:logged|signed) in|please (?:run \/login|log ?in|sign ?in)|authentication required|re-?authenticate|invalid[_ ](?:grant|api key|token)|token (?:has )?expired|refresh token|\b401\b|unauthorized/i;
const CONTEXT_FULL = /prompt is too long|context (?:window|length) (?:exceeded|is full)|maximum context length|too many tokens|context_length_exceeded|exceeds the context/i;
const OTHER_LIMIT = /usage limit|quota (?:exceeded|reached)|premium requests?|out of credits|insufficient[_ ]quota/i;
/** A limit said not to be the plan's, or a server slowing requests down: waiting for a plan reset would not help. */
const NOT_PLAN = /\bnot (?:your |the )?(?:usage |plan )?limit\b|\blimit (?:is |was |has )?not\b|\brate[- ]limit/i;
const RESUME_FAILED = /no (?:conversation|session|rollout) found|session not found|thread not found|could not (?:resume|load) (?:the )?session|unknown session/i;

/** A short single-line string, or null. */
export function shortDetail(value: unknown, max = 300): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/g, ' ').trim();
  return text ? (text.length > max ? `${text.slice(0, max - 1)}…` : text) : null;
}

/**
 * What an error the tool reported means for the user. Sign-in first: an expired sign-in is often reported with
 * words that also look like a limit. A plan limit is told apart from other limits (`isPlanLimit`), so the page says
 * "wait for the reset" only when waiting helps.
 */
export function classifyError(text: string, fallback: TurnErrorCode = 'provider'): TurnErrorCode {
  if (!text) return fallback;
  if (RESUME_FAILED.test(text)) return 'resume_failed';
  if (SIGN_IN.test(text)) return 'sign_in';
  if (CONTEXT_FULL.test(text)) return 'context_full';
  if (isPlanLimit(text) || (OTHER_LIMIT.test(text) && !NOT_PLAN.test(text))) return 'plan_limit';
  return fallback;
}

export function turnError(text: string, fallback: TurnErrorCode = 'provider', resetsAt: string | null = null): TurnError {
  const code = classifyError(text, fallback);
  return { code, detail: shortDetail(text), ...(code === 'plan_limit' ? { resets_at: resetsAt } : {}) };
}

/** A Unix time in seconds (or milliseconds) as an ISO date, or null. */
export function isoFromEpoch(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  const ms = value < 1e12 ? value * 1000 : value;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Splits a byte stream into lines, never holding more than `max` characters of an unfinished one: a tool that
 * writes a giant line drops that line, not the dashboard.
 */
export function lineReader(onLine: (line: string) => void, max = 4 * 1024 * 1024): { push(chunk: string): void; flush(): void } {
  let pending = '';
  return {
    push(chunk: string) {
      pending += chunk;
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      if (pending.length > max) pending = '';
      for (const line of lines) if (line.trim()) onLine(line);
    },
    flush() {
      if (pending.trim()) onLine(pending);
      pending = '';
    },
  };
}

/** Parses a JSON line into an object, or null for anything else. */
export function parseLine(line: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line);
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

export type RunStepKind = RunStep['kind'];
