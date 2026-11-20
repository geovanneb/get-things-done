import { useState } from 'react';
import { useLanguage } from '../i18n/LanguageProvider';
import { useAppDispatch, useAppState } from '../store';
import { apiPost } from '../utils/api';
import { openAssistant, type OpenAssistantResult } from '../utils/openAssistant';
import { useAssistant } from './useAssistant';

/**
 * Opens the workspace's assistant at the workspace folder and says how it went (see utils/openAssistant).
 * `workspace` pins the launch to that workspace; `keepClipboard` keeps a failed launch's command off the clipboard.
 * A refusal because another workspace is open is left to the caller to say.
 */
export function useOpenAssistant() {
  const { workspace: open } = useAppState();
  const dispatch = useAppDispatch();
  const { t } = useLanguage();
  const assistant = useAssistant();
  const [opening, setOpening] = useState(false);

  const launch = async ({ keepClipboard = false, workspace }: { keepClipboard?: boolean; workspace?: string } = {}): Promise<OpenAssistantResult> => {
    setOpening(true);
    try {
      const result = await openAssistant({
        tool: assistant.tool,
        workspace,
        fallbackPath: workspace ?? open?.path ?? '.',
        windows: navigator.platform.toLowerCase().startsWith('win'),
        keepClipboard,
        post: (path, body, ws) => apiPost<{ via: 'terminal' | 'editor' }>(path, body, ws),
        copy: (text) => navigator.clipboard.writeText(text),
      });
      if (result.opened) {
        dispatch({
          type: 'ADD_NOTIFICATION',
          payload: { type: 'success', message: result.via === 'editor' ? t('assistantOpenedInEditor') : t('assistantOpened', { label: assistant.label }) },
        });
      } else if (result.reason === 'failed') {
        // The launch failed: fall back to handing the user the command.
        dispatch({
          type: 'ADD_NOTIFICATION',
          payload: { type: 'warning', message: result.copied ? t('terminalCopied', { command: result.command }) : t('terminalRun', { command: result.command }) },
        });
      }
      return result;
    } finally {
      setOpening(false);
    }
  };

  return { ...assistant, opening, open: launch };
}
