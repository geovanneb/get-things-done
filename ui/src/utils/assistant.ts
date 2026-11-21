import { requestText, type AssistantRequest } from '../../../server/src/utils/assistantRequest';
import type { AiToolId } from './setup';

export { requestText, type AssistantRequest };

/**
 * The AI assistant the dashboard talks to for a workspace: the first one the workspace was set up for (`ai_tools` from
 * GET /api/workspace), Claude Code for an older server that does not say.
 */

export const ASSISTANT_LABELS: Record<AiToolId, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  copilot: 'Copilot',
};

const KNOWN = new Set<string>(Object.keys(ASSISTANT_LABELS));

/** The workspace's assistants in the server's order, never empty. */
export function workspaceAssistants(tools: readonly string[] | undefined | null): AiToolId[] {
  const known = (tools ?? []).filter((tool): tool is AiToolId => KNOWN.has(tool));
  return known.length ? [...new Set(known)] : ['claude-code'];
}

/**
 * The same request for the workspace's other assistants, grouped by text: Codex and Copilot share theirs.
 * Empty when the workspace has one assistant.
 */
export function otherRequests(tools: readonly AiToolId[], request: AssistantRequest, id: string): { labels: string; text: string; tools: AiToolId[] }[] {
  const [primary, ...rest] = tools;
  const groups = new Map<string, AiToolId[]>();
  for (const tool of rest) {
    const text = requestText(tool, request, id);
    if (primary && text === requestText(primary, request, id)) continue;
    groups.set(text, [...(groups.get(text) ?? []), tool]);
  }
  return [...groups].map(([text, group]) => ({ labels: group.map((tool) => ASSISTANT_LABELS[tool]).join(' / '), text, tools: group }));
}
