import { assistantCommand } from '../../../server/src/utils/assistantCommand';
import { requestText, type AssistantRequest } from '../../../server/src/utils/assistantRequest';
import type { AiToolId } from './setup';

/** A request the assistant starts with: run a task, analyze or apply a context update. */
export interface StartRequest { request: AssistantRequest; id: string }

export type OpenAssistantResult =
  /**
   * Opened. With a request, `text` is its text: `typed` when the assistant started with it already sent; otherwise
   * (VS Code, which cannot be handed a prompt) it is for the user to paste, copied when `copied`.
   */
  | { opened: true; via: 'terminal' | 'editor'; typed: boolean; text?: string; copied?: boolean }
  /** The server has another workspace open (another tab switched it): nothing was launched. */
  | { opened: false; reason: 'other_workspace' }
  /** The launch failed: the command to run by hand (with the request, when there is one), and whether it was copied. */
  | { opened: false; reason: 'failed'; command: string; copied: boolean };

/**
 * Asks the server to open the workspace's assistant (POST /api/workspace/open-assistant), with `start` already sent
 * when given.
 *
 * With `workspace`, the request says which workspace it is for (X-GTD-Workspace), so the server refuses it when
 * another one is open instead of launching there. Without it, it opens in whichever workspace is open (the header's
 * button). When the launch fails the user gets the command; it is copied unless `keepClipboard` is set.
 */
export async function openAssistant({ tool, workspace, fallbackPath, windows, keepClipboard = false, start, post, copy }: {
  tool: AiToolId;
  workspace?: string;
  /** The folder the fallback command changes to. */
  fallbackPath: string;
  windows: boolean;
  keepClipboard?: boolean;
  start?: StartRequest;
  post: (path: string, body: unknown, workspace?: string) => Promise<{ via: 'terminal' | 'editor'; typed?: boolean; text?: string }>;
  copy: (text: string) => Promise<void>;
}): Promise<OpenAssistantResult> {
  const tryCopy = async (text: string) => {
    if (keepClipboard) return false;
    try {
      await copy(text);
      return true;
    } catch {
      return false; // clipboard unavailable
    }
  };
  try {
    const opened = await post('/api/workspace/open-assistant', start ? { tool, request: start } : { tool }, workspace);
    if (!start) return { opened: true, via: opened.via, typed: false };
    // An older server ignores the request: it opened the assistant without it, so the text is handed over to paste.
    const text = opened.text ?? requestText(tool, start.request, start.id);
    if (opened.typed) return { opened: true, via: opened.via, typed: true, text };
    return { opened: true, via: opened.via, typed: false, text, copied: await tryCopy(text) };
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code === 'other_workspace') return { opened: false, reason: 'other_workspace' };
    const prompt = start ? requestText(tool, start.request, start.id) : undefined;
    const command = assistantCommand(fallbackPath, tool === 'claude-code' ? 'claude' : tool, windows, prompt);
    return { opened: false, reason: 'failed', command, copied: await tryCopy(command) };
  }
}
