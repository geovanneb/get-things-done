import { useLanguage } from '@/i18n/LanguageProvider';
import Button, { type ButtonSize, type ButtonVariant } from '@/components/common/Button';
import { useOpenAssistant } from '@/hooks/useOpenAssistant';
import { useNotify } from '@/hooks/useNotify';
import { ASSISTANT_LABELS, type AssistantRequest } from '@/utils/assistant';
import type { AiToolId } from '@/utils/setup';

/**
 * "Run in Claude Code" (or Codex, Copilot): opens the assistant in a new terminal window at the workspace with the
 * request already sent, the same text the user would copy and paste. It runs as the user's own session, in a window
 * they see, under the tool's usual permission prompts. Copilot without its CLI opens VS Code and the request is copied.
 * How it went (or the command to run by hand) is said in a notification.
 */
export default function RunInAssistant({ request, id, tool, workspace, variant = 'secondary', size = 'md', hint = false, nextAction = false }: {
  request: AssistantRequest;
  id: string;
  /** Another of the workspace's assistants; the first one by default. */
  tool?: AiToolId;
  /** Pins the launch to this workspace: nothing is launched when another one is open. */
  workspace?: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Says under the button what it does. */
  hint?: boolean;
  /** The page's next step: the page moves focus here when it becomes due (`data-next-action`). */
  nextAction?: boolean;
}) {
  const { t } = useLanguage();
  const assistant = useOpenAssistant();
  const notify = useNotify();
  const target = tool ?? assistant.tool;
  const name = ASSISTANT_LABELS[target];
  const run = async () => {
    const result = await assistant.open({ start: { request, id }, tool: target, workspace });
    // Pinned to this page's workspace while another tab switched the dashboard: nothing was launched.
    if (!result.opened && result.reason === 'other_workspace') notify.warning(t('assistantOtherWorkspace', { label: name }));
  };
  const button = (
    <Button variant={variant} size={size} loading={assistant.opening} data-next-action={nextAction ? '' : undefined}
      onClick={() => void run()}>
      {t('runInAssistant', { label: name })}
    </Button>
  );
  if (!hint) return button;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 'var(--space-1)' }}>
      {button}
      <p style={{ margin: 0, fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
        {t('runInAssistantHint', { label: name })}
        {target === 'copilot' && <> {t('runInAssistantHintEditor')}</>}
      </p>
    </div>
  );
}
