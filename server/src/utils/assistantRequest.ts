/**
 * What the executive asks an assistant to do with one ID, and the exact text that asks it. Shared by the dashboard
 * (the text it shows and copies) and the server (the text it types into an assistant it opens), so the two never
 * differ. The workspace commands and instructions stay the source of truth: this is only what the user would type.
 */

export type AssistantTool = 'claude-code' | 'codex' | 'copilot';

export type AssistantRequest = 'task' | 'analyze' | 'apply';

export const ASSISTANT_REQUESTS: readonly AssistantRequest[] = ['task', 'analyze', 'apply'];

const SLASH: Record<AssistantRequest, string> = { task: '/gtd-task', analyze: '/gtd-context-analyze', apply: '/gtd-context-apply' };
/** Codex and Copilot have no slash commands: the workspace instructions and skills answer to these words. */
const WORDS: Record<AssistantRequest, string> = { task: 'Execute task', analyze: 'Analyze context update', apply: 'Apply context update' };

/** The ID each request takes: a task for `task`, a context update for the others. */
const ID: Record<AssistantRequest, RegExp> = { task: /^TASK-\d{4}-\d{4}$/, analyze: /^CU-\d{4}-\d{4}$/, apply: /^CU-\d{4}-\d{4}$/ };

/** The text to type into `tool` so it runs the request for `id`. */
export function requestText(tool: AssistantTool, request: AssistantRequest, id: string): string {
  return tool === 'claude-code' ? `${SLASH[request]} ${id}` : `${WORDS[request]} ${id}`;
}

/**
 * A request from a JSON body, checked: a known kind and an ID of the shape it takes. The ID ends up on a command
 * line, so only these fixed shapes (letters, digits and dashes) are accepted. Null for anything else.
 */
export function parseAssistantRequest(value: unknown): { request: AssistantRequest; id: string } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { request, id } = value as Record<string, unknown>;
  if (typeof request !== 'string' || !(ASSISTANT_REQUESTS as readonly string[]).includes(request)) return null;
  if (typeof id !== 'string' || !ID[request as AssistantRequest].test(id)) return null;
  return { request: request as AssistantRequest, id };
}
