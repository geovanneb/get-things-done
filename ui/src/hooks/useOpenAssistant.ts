import { useState } from 'react';
import { useLanguage } from '../i18n/LanguageProvider';
import { useAppDispatch, useAppState } from '../store';
import { apiPost } from '../utils/api';
import { openAssistant, type OpenAssistantResult, type StartRequest } from '../utils/openAssistant';
import { ASSISTANT_LABELS } from '../utils/assistant';
import type { AiToolId } from '../utils/setup';
import { useAssistant } from './useAssistant';

/**
 * Opens the workspace's assistant at the workspace folder and says how it went (see utils/openAssistant).
 * `workspace` pins the launch to that workspace; `keepClipboard` keeps a failed launch's command off the clipboard.
 * `start` opens it with that request already sent (run a task, analyze or apply an update); `tool` opens another of
 * the workspace's assistants. A refusal because another workspace is open is left to the caller to say.
 */
export function useOpenAssistant() {
  const { workspace: open } = useAppState();
  const dispatch = useAppDispatch();
  const { t } = useLanguage();
  const assistant = useAssistant();
  const [opening, setOpening] = useState(false);

  const launch = async ({ keepClipboard = false, workspace, start, tool = assistant.tool }: { keepClipboard?: boolean; workspace?: string; start?: StartRequest; tool?: AiToolId } = {}): Promise<OpenAssistantResult> => {
    setOpening(true);
    const label = ASSISTANT_LABELS[tool];
    try {
      const result = await openAssistant({
        tool,
        workspace,
        start,
        fallbackPath: workspace ?? open?.path ?? '.',
        windows: navigator.platform.toLowerCase().startsWith('win'),
        keepClipboard,
        post: (path, body, ws) => apiPost<{ via: 'terminal' | 'editor' }>(path, body, ws),
        copy: (text) => navigator.clipboard.writeText(text),
      });
      if (result.opened) {
        const message = result.typed ? t('assistantStarted', { label, text: result.text ?? '' })
          : result.text ? (result.copied ? t('assistantStartedInEditor', { text: result.text }) : t('assistantStartedInEditorNoCopy', { text: result.text }))
            : result.via === 'editor' ? t('assistantOpenedInEditor') : t('assistantOpened', { label });
        dispatch({ type: 'ADD_NOTIFICATION', payload: { type: 'success', message } });
      } else if (result.reason === 'failed') {
        // The launch failed: fall back to handing the user the command (with the request, when there is one).
        const message = start
          ? (result.copied ? t('terminalCopiedWithRequest', { label, command: result.command }) : t('terminalRunWithRequest', { label, command: result.command }))
          : (result.copied ? t('terminalCopied', { command: result.command }) : t('terminalRun', { command: result.command }));
        dispatch({ type: 'ADD_NOTIFICATION', payload: { type: 'warning', message } });
      }
      return result;
    } finally {
      setOpening(false);
    }
  };

  return { ...assistant, opening, open: launch };
}
