import { useAppState } from '../store';
import { ASSISTANT_LABELS, otherRequests, requestText, workspaceAssistants, type AssistantRequest } from '../utils/assistant';

/** The workspace's assistant, its name, and the text that asks it (or the others) to run a request. */
export function useAssistant() {
  const { workspace } = useAppState();
  const tools = workspaceAssistants(workspace?.ai_tools);
  const tool = tools[0]!;
  return {
    tool,
    tools,
    label: ASSISTANT_LABELS[tool],
    request: (request: AssistantRequest, id: string) => requestText(tool, request, id),
    others: (request: AssistantRequest, id: string) => otherRequests(tools, request, id),
  };
}
