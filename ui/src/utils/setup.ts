/** First-run setup: what the setup screen shows and sends. The screen itself is views/SetupView.tsx. */

export type AiToolId = 'claude-code' | 'copilot' | 'codex';

export interface AiToolInfo {
  id: AiToolId;
  label: string;
  description: string;
  installed: boolean;
  install_url: string;
}

export interface RecentWorkspace {
  path: string;
  name: string;
  available: boolean;
}

export interface SetupStatus {
  configured: boolean;
  workspace_path: string | null;
  suggested_path: string;
  suggested_path_is_workspace: boolean;
  recent: RecentWorkspace[];
  ai_tools: AiToolInfo[];
}

export interface SetupAnswers {
  path: string;
  workspaceName: string;
  name: string;
  role: string;
  organization: string;
  aiTools: AiToolId[];
}

/** The installed assistants, or Claude Code when none is (the same default as `gtd init`). */
export function defaultAiTools(tools: AiToolInfo[]): AiToolId[] {
  const installed = tools.filter((tool) => tool.installed).map((tool) => tool.id);
  return installed.length ? installed : ['claude-code'];
}

export function initialAnswers(status: SetupStatus): SetupAnswers {
  return {
    path: status.suggested_path,
    workspaceName: '',
    name: '',
    role: '',
    organization: '',
    aiTools: defaultAiTools(status.ai_tools),
  };
}

/** The body of POST /api/setup for a new workspace. Empty fields are sent empty; the server fills defaults. */
export function createRequest(answers: SetupAnswers) {
  return {
    path: answers.path.trim(),
    create: true,
    workspace_name: answers.workspaceName.trim(),
    profile: { name: answers.name.trim(), role: answers.role.trim(), organization: answers.organization.trim() },
    ai_tools: answers.aiTools,
  };
}

export function toggleTool(selected: AiToolId[], id: AiToolId, on: boolean): AiToolId[] {
  const without = selected.filter((tool) => tool !== id);
  return on ? [...without, id] : without;
}

/** The chosen assistants that still need installing, for the last step. */
export function toolsToInstall(answers: SetupAnswers, tools: AiToolInfo[]): AiToolInfo[] {
  return tools.filter((tool) => answers.aiTools.includes(tool.id) && !tool.installed);
}
