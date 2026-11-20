/**
 * The workspace chat's page logic, kept free of React so it can be tested: what the server sends (it mirrors
 * server/src/services/chat), how a stream event changes a conversation, and what to tell the user.
 */

export type ChatProviderId = 'claude-code' | 'codex' | 'copilot';

export interface ChatModel { id: string; label: string; description: string | null; efforts: string[]; is_default: boolean }
export interface UsageWindow { kind: 'five_hour' | 'weekly' | 'other'; used_percent: number | null; resets_at: string | null; limited: boolean }
export interface ChatProblem { code: string; message: string }
export interface ProviderStatus {
  id: ChatProviderId;
  label: string;
  installed: boolean;
  ready: boolean;
  problems: ChatProblem[];
  plan: string | null;
  models: ChatModel[];
  limits: UsageWindow[] | null;
  notes: ('premium_requests' | 'no_usage_report')[];
}

export interface RunStepLike { kind: 'read' | 'search' | 'list' | 'write' | 'edit' | 'command' | 'skill' | 'other'; path: string | null }

export type TurnErrorCode = 'sign_in' | 'plan_limit' | 'context_full' | 'api_billing' | 'not_trusted' | 'crashed' | 'timeout' | 'resume_failed' | 'provider';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'notice';
  text: string;
  created_at: string;
  status?: 'streaming' | 'done' | 'stopped' | 'error';
  error?: { code: TurnErrorCode; detail: string | null; resets_at?: string | null };
  steps?: number;
  last_step?: RunStepLike | null;
  page?: string | null;
  notice?: 'restarted' | 'provider_changed' | 'compacted';
  provider?: ChatProviderId;
  model?: string | null;
}

export interface Conversation {
  id: string;
  title: string;
  provider: ChatProviderId;
  model: string | null;
  effort: string | null;
  carry_over: boolean;
  created_at: string;
  updated_at: string;
  messages: ChatMessage[];
  usage: { context_used: number | null; context_window: number | null } | null;
  busy?: boolean;
}

export interface ConversationSummary { id: string; title: string; provider: ChatProviderId; updated_at: string; messages: number; busy: boolean }

export type ChatStreamEvent =
  | { type: 'text'; message_id: string; text: string }
  | { type: 'step'; message_id: string; step: RunStepLike; steps: number }
  | { type: 'usage'; usage: Conversation['usage'] }
  | { type: 'limits'; provider: ChatProviderId; windows: UsageWindow[] }
  | { type: 'conversation'; conversation: Conversation }
  | { type: 'deleted' };

/** A stream event applied to the conversation shown. The whole conversation, when it comes, always wins. */
export function applyStreamEvent(current: Conversation | null, event: ChatStreamEvent): Conversation | null {
  if (event.type === 'conversation') return event.conversation;
  if (event.type === 'deleted') return null;
  if (!current) return current;
  if (event.type === 'usage') return { ...current, usage: event.usage };
  if (event.type === 'limits') return current;
  const index = current.messages.findIndex((m) => m.id === event.message_id);
  if (index < 0) return current;
  const message = current.messages[index]!;
  const next = event.type === 'text'
    ? { ...message, text: message.text + event.text }
    : { ...message, steps: event.steps, last_step: event.step };
  const messages = [...current.messages];
  messages[index] = next;
  return { ...current, messages };
}

/**
 * A failed chat request in the chat's own words: refused because the server has another workspace open (the shared
 * text speaks of an update), it says so for the chat. Anything else is passed on as it came.
 */
export function chatError(err: unknown, otherWorkspace: () => string): unknown {
  if (!(err instanceof Error) || (err as Error & { code?: string }).code !== 'other_workspace') return err;
  return Object.assign(new Error(otherWorkspace()), { status: (err as Error & { status?: number }).status, code: 'other_workspace' });
}

/**
 * The conversation to show once a request for it is answered: a send's HTTP 202, or the whole conversation read again.
 * The stream can be ahead of that answer, even finished, with the same messages: what is shown is kept when it
 * already has every message the answer has, taking from the answer only progress within a message the page missed.
 */
export function newerOf(current: Conversation | null, fetched: Conversation): Conversation {
  if (current?.id !== fetched.id) return fetched;
  const read = new Map(fetched.messages.map((m) => [m.id, m]));
  const shown = new Set(current.messages.map((m) => m.id));
  if (!fetched.messages.every((m) => shown.has(m.id))) return fetched;
  let changed = false;
  let ended = false;
  const messages = current.messages.map((m) => {
    const f = read.get(m.id);
    const next = f ? furtherOf(m, f) : m;
    if (next !== m) changed = true;
    if (next === f && m.status === 'streaming' && f.status !== 'streaming') ended = true;
    return next;
  });
  // An answer that ended in what was read: the conversation is no longer busy with it either, when it says so.
  return changed ? { ...current, messages, ...(ended ? { busy: fetched.busy } : {}) } : current;
}

/**
 * One message as shown and as read again: an ended answer wins (the shown one first, and the read one even with the
 * same words), then the text that has the other in it. Otherwise the read text is a beginning the page missed (words that came before it showed the answer):
 * it goes in front, without repeating where the two meet. Until the answer ends, then the whole conversation comes.
 */
function furtherOf(shown: ChatMessage, read: ChatMessage): ChatMessage {
  if (shown.status !== 'streaming') return shown;
  if (read.status !== 'streaming') return read;
  if (shown.text === read.text) return shown;
  if (shown.text.includes(read.text)) return shown;
  const steps = (read.steps ?? 0) > (shown.steps ?? 0) ? { steps: read.steps, last_step: read.last_step } : {};
  if (read.text.includes(shown.text)) return { ...shown, text: read.text, ...steps };
  let overlap = Math.min(read.text.length, shown.text.length);
  while (overlap > 0 && !read.text.endsWith(shown.text.slice(0, overlap))) overlap--;
  return { ...shown, text: read.text + shown.text.slice(overlap), ...steps };
}

/**
 * The workspace whose tools are being checked, once the check for `workspace` ended: a check of another workspace
 * that is still going stays, so switching while one goes never leaves the new workspace unchecked.
 */
export function checkEnded(checkingFor: string | null, workspace: string | null): string | null {
  return checkingFor === workspace ? null : checkingFor;
}

/** How full the conversation's context is, 0 to 100, or null when the tool has not said. */
export function contextPercent(usage: Conversation['usage']): number | null {
  if (!usage || !usage.context_used || !usage.context_window) return null;
  return Math.min(100, Math.round((usage.context_used / usage.context_window) * 100));
}

/** When to suggest a new chat: the tool summarizes on its own near the end, but answers get slower and vaguer. */
export const CONTEXT_WARN_PERCENT = 80;

/** The plan window closest to its limit: the one worth showing. */
export function tightestWindow(windows: UsageWindow[] | null | undefined): UsageWindow | null {
  if (!windows?.length) return null;
  const limited = windows.find((w) => w.limited);
  if (limited) return limited;
  return [...windows].sort((a, b) => (b.used_percent ?? -1) - (a.used_percent ?? -1))[0] ?? null;
}

export type ErrorAction = 'check_again' | 'retry' | 'new_chat' | 'switch_provider';

/** What the user can do about an answer that failed, most useful first. */
export function errorActions(code: TurnErrorCode): ErrorAction[] {
  switch (code) {
    case 'sign_in': return ['check_again', 'retry'];
    case 'plan_limit': return ['switch_provider'];
    case 'context_full': return ['new_chat'];
    case 'api_billing': case 'not_trusted': return ['check_again'];
    case 'resume_failed': case 'crashed': case 'timeout': case 'provider': return ['retry', 'switch_provider'];
    default: return ['retry'];
  }
}

/**
 * What a key press in the message box does. Enter sends and Shift+Enter starts a new line; while an input method
 * is composing (Japanese, Chinese, Korean), Enter confirms the text and never sends.
 */
export function composerKey(e: { key: string; shiftKey: boolean; isComposing?: boolean; keyCode?: number }): 'send' | null {
  if (e.key !== 'Enter' || e.shiftKey) return null;
  // Safari reports a composing Enter as keyCode 229 without isComposing.
  if (e.isComposing || e.keyCode === 229) return null;
  return 'send';
}

/**
 * The tool to start a new chat with: the one the conversation used before, else the first the workspace was set
 * up for that is ready, else any ready one, else the first set up (so the page can say what it needs).
 */
export function defaultProvider(providers: ProviderStatus[], workspaceTools: string[] = [], previous?: string | null): ChatProviderId | null {
  const ready = providers.filter((p) => p.ready);
  const pick = (ids: string[]) => ids.map((id) => ready.find((p) => p.id === id)).find(Boolean)?.id ?? null;
  return pick(previous ? [previous] : []) ?? pick(workspaceTools) ?? ready[0]?.id
    ?? providers.find((p) => workspaceTools.includes(p.id) && p.installed)?.id ?? providers.find((p) => p.installed)?.id ?? null;
}

/**
 * The assistant's answer as Markdown the chat shows. Images become links: an answer could be steered (by text
 * in a meeting transcript, for example) into an image whose address carries workspace data, and the browser would
 * fetch it without a click. The page's security policy blocks that too; this keeps it from even being tried.
 */
/**
 * What tells one conversation from another with the same id (a workspace copied with its chats, say): its id, when
 * it was created and its first message. The same in two workspaces only for a true copy of the same conversation.
 */
export function conversationIdentity(c: Pick<Conversation, 'id' | 'created_at' | 'messages'>): string {
  return JSON.stringify([c.id, c.created_at, c.messages[0]?.id ?? null, c.messages[0]?.created_at ?? null]);
}

/**
 * The workspace in which what a conversation's answers name may be looked up, or undefined (they stay plain text).
 * Only the workspace the chat shows, while it is still the open one, and only once the server gave back, for that
 * workspace, the very conversation on screen (`confirmed`, by identity).
 */
export function referenceWorkspace({ shown, chatWorkspace, openWorkspace, confirmed }: {
  shown: Pick<Conversation, 'id' | 'created_at' | 'messages'> | null;
  chatWorkspace: string | null;
  openWorkspace: string | null;
  confirmed: { identity: string; workspace: string } | null;
}): string | undefined {
  if (!shown || !chatWorkspace || chatWorkspace !== openWorkspace || !confirmed) return undefined;
  return confirmed.identity === conversationIdentity(shown) && confirmed.workspace === chatWorkspace ? chatWorkspace : undefined;
}

export function safeMarkdown(text: string): string {
  return text.replace(/!\[/g, '[');
}

/** The dashboard page the user is on, as the chat tells the assistant: the path only, never the query. */
export function pageContext(pathname: string): string | null {
  if (!pathname || pathname === '/' || !/^\/[\w\-./%]{0,199}$/.test(pathname) || pathname.includes('..')) return null;
  return pathname;
}

/** Whole minutes or hours until a time, for "resets in …"; null when it is past or unknown. */
export function untilText(iso: string | null | undefined, now: number, locale: string): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso) - now;
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const minutes = Math.ceil(ms / 60_000);
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'always', style: 'long' });
  if (minutes < 60) return format.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (hours < 48) return format.format(hours, 'hour');
  return format.format(Math.round(hours / 24), 'day');
}

/** The models offered for a tool, with the tool's own default first. */
export function modelOptions(provider: ProviderStatus | undefined): ChatModel[] {
  if (!provider) return [];
  return [...provider.models].sort((a, b) => Number(b.is_default) - Number(a.is_default));
}

/** Effort levels for the chosen model; a model the list does not know offers none. */
export function effortOptions(provider: ProviderStatus | undefined, model: string | null): string[] {
  const list = modelOptions(provider);
  const chosen = (model ? list.find((m) => m.id === model) : null) ?? list.find((m) => m.is_default) ?? null;
  return chosen?.efforts ?? [];
}
