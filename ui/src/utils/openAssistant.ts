import { assistantCommand } from '../../../server/src/utils/assistantCommand';
import type { AiToolId } from './setup';

export type OpenAssistantResult =
  | { opened: true; via: 'terminal' | 'editor' }
  /** The server has another workspace open (another tab switched it): nothing was launched. */
  | { opened: false; reason: 'other_workspace' }
  /** The launch failed: the command to run by hand, and whether it was copied. */
  | { opened: false; reason: 'failed'; command: string; copied: boolean };

/**
 * Asks the server to open the workspace's assistant (POST /api/workspace/open-assistant).
 *
 * With `workspace`, the request says which workspace it is for (X-GTD-Workspace), so the server refuses it when
 * another one is open instead of launching there. Without it, it opens in whichever workspace is open (the header's
 * button). When the launch fails the user gets the command; it is copied unless `keepClipboard` is set.
 */
export async function openAssistant({ tool, workspace, fallbackPath, windows, keepClipboard = false, post, copy }: {
  tool: AiToolId;
  workspace?: string;
  /** The folder the fallback command changes to. */
  fallbackPath: string;
  windows: boolean;
  keepClipboard?: boolean;
  post: (path: string, body: unknown, workspace?: string) => Promise<{ via: 'terminal' | 'editor' }>;
  copy: (text: string) => Promise<void>;
}): Promise<OpenAssistantResult> {
  try {
    const opened = await post('/api/workspace/open-assistant', { tool }, workspace);
    return { opened: true, via: opened.via };
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code === 'other_workspace') return { opened: false, reason: 'other_workspace' };
    const command = assistantCommand(fallbackPath, tool === 'claude-code' ? 'claude' : tool, windows);
    let copied = false;
    if (!keepClipboard) {
      try {
        await copy(command);
        copied = true;
      } catch {
        // clipboard unavailable
      }
    }
    return { opened: false, reason: 'failed', command, copied };
  }
}
