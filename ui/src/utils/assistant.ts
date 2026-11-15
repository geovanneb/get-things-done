import type { AiToolId } from './setup';

/**
 * The AI assistant the dashboard talks to for a workspace: the first one the workspace was set up for (`ai_tools` from
 * GET /api/workspace), Claude Code for an older server that does not say.
 */

export const ASSISTANT_LABELS: Record<AiToolId, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  copilot: 'Copilot',
};

/** What the executive asks an assistant to do with one ID. */
export type AssistantRequest = 'task' | 'analyze' | 'apply';

const SLASH: Record<AssistantRequest, string> = { task: '/gtd-task', analyze: '/gtd-context-analyze', apply: '/gtd-context-apply' };
/** Codex and Copilot have no slash commands: the workspace instructions and skills answer to these words. */
const WORDS: Record<AssistantRequest, string> = { task: 'Execute task', analyze: 'Analyze context update', apply: 'Apply context update' };

const KNOWN = new Set<string>(Object.keys(ASSISTANT_LABELS));

/** The workspace's assistants in the server's order, never empty. */
export function workspaceAssistants(tools: readonly string[] | undefined | null): AiToolId[] {
  const known = (tools ?? []).filter((tool): tool is AiToolId => KNOWN.has(tool));
  return known.length ? [...new Set(known)] : ['claude-code'];
}

/** The text to paste into `tool` so it runs the request for `id`. */
export function requestText(tool: AiToolId, request: AssistantRequest, id: string): string {
  return tool === 'claude-code' ? `${SLASH[request]} ${id}` : `${WORDS[request]} ${id}`;
}

/**
 * The same request for the workspace's other assistants, grouped by text: Codex and Copilot share theirs.
 * Empty when the workspace has one assistant.
 */
export function otherRequests(tools: readonly AiToolId[], request: AssistantRequest, id: string): { labels: string; text: string }[] {
  const [primary, ...rest] = tools;
  const groups = new Map<string, string[]>();
  for (const tool of rest) {
    const text = requestText(tool, request, id);
    if (primary && text === requestText(primary, request, id)) continue;
    groups.set(text, [...(groups.get(text) ?? []), ASSISTANT_LABELS[tool]]);
  }
  return [...groups].map(([text, labels]) => ({ labels: labels.join(' / '), text }));
}
