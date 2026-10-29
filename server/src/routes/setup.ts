// First-run setup: lets the dashboard create or open a workspace without the terminal (`gtd init`).
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Router, Request, Response } from 'express';
import { WorkspaceService } from '../services/workspace';
import { AiTool } from '../services/scaffold';
import { detectAiTools } from '../services/aiToolDetection';
import { activateWorkspace } from '../services/workspaceActivation';

const router = Router();
const workspaceService = new WorkspaceService();

const AI_TOOLS: readonly AiTool[] = ['claude-code', 'copilot', 'codex'];
const MAX_TEXT = 120;
const MAX_PATH = 1024;
// Line breaks and other control characters would end up inside YAML and the agent instruction files.
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** Where a new workspace goes by default: Documents/Get Things Done, or the home folder without Documents. */
function suggestedPath(): string {
  const documents = path.join(os.homedir(), 'Documents');
  return path.join(fs.existsSync(documents) ? documents : os.homedir(), 'Get Things Done');
}

function currentWorkspace(): string | null {
  try {
    const workspacePath = workspaceService.getWorkspacePath();
    return workspaceService.isExistingWorkspace(workspacePath) ? workspacePath : null;
  } catch {
    return null;
  }
}

/** A trimmed one-line string, or an error message. Missing means empty. */
function text(value: unknown, field: string, max = MAX_TEXT): string | { error: string } {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') return { error: `${field} must be text.` };
  const trimmed = value.trim();
  if (CONTROL_CHARS.test(trimmed)) return { error: `${field} must be a single line.` };
  if (trimmed.length > max) return { error: `${field} is too long (at most ${max} characters).` };
  return trimmed;
}

// GET /api/setup — is a workspace open, and what the setup screen needs to offer
router.get('/', (_req: Request, res: Response) => {
  const workspacePath = currentWorkspace();
  const recent = workspaceService.listRecentWorkspaces().filter((entry) => entry.available);
  res.json({
    configured: workspacePath !== null,
    workspace_path: workspacePath,
    suggested_path: suggestedPath(),
    suggested_path_is_workspace: workspaceService.isExistingWorkspace(suggestedPath()),
    recent,
    ai_tools: detectAiTools(),
  });
});

// POST /api/setup — create a workspace (or open an existing one) and make it the open workspace
router.post('/', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;

  const rawPath = text(body['path'], 'The folder', MAX_PATH);
  if (typeof rawPath !== 'string') { res.status(400).json(rawPath); return; }
  if (!rawPath) { res.status(400).json({ error: 'Please choose a folder.' }); return; }

  const profileBody = (body['profile'] ?? {}) as Record<string, unknown>;
  if (typeof profileBody !== 'object' || Array.isArray(profileBody)) {
    res.status(400).json({ error: 'profile must be an object.' });
    return;
  }
  const fields = {
    workspaceName: text(body['workspace_name'], 'The workspace name'),
    name: text(profileBody['name'], 'Your name'),
    role: text(profileBody['role'], 'Your role'),
    organization: text(profileBody['organization'], 'The organization'),
  };
  for (const value of Object.values(fields)) {
    if (typeof value !== 'string') { res.status(400).json(value); return; }
  }

  const rawTools = body['ai_tools'] ?? [];
  if (!Array.isArray(rawTools) || rawTools.some((tool) => !AI_TOOLS.includes(tool as AiTool))) {
    res.status(400).json({ error: `ai_tools must be a list of: ${AI_TOOLS.join(', ')}.` });
    return;
  }
  const aiTools = [...new Set(rawTools as AiTool[])];

  const workspacePath = workspaceService.resolveUserPath(rawPath);
  if (!fs.existsSync(workspacePath)) {
    if (body['create'] !== true) {
      res.status(400).json({ error: `This folder does not exist: ${workspacePath}` });
      return;
    }
    try {
      fs.mkdirSync(workspacePath, { recursive: true });
    } catch {
      res.status(400).json({ error: `Could not create the folder: ${workspacePath}` });
      return;
    }
  }
  if (!(await workspaceService.validateWorkspacePath(workspacePath))) {
    res.status(400).json({ error: `Not a folder this app can write to: ${workspacePath}` });
    return;
  }

  // "Open an existing workspace" must not quietly create one: the screen asks first.
  if (body['require_existing'] === true && !workspaceService.isExistingWorkspace(workspacePath)) {
    res.status(409).json({ error: 'This folder is not a Get Things Done workspace yet.', needs_init: true, path: workspacePath });
    return;
  }

  // An existing workspace is opened as it is: setup never changes its profile or agent files.
  const { initialized } = await activateWorkspace(workspacePath, {
    workspaceName: (fields.workspaceName as string) || 'Executive Workspace',
    profile: { name: fields.name as string, role: fields.role as string, organization: fields.organization as string },
    aiTools,
  });
  res.status(initialized ? 201 : 200).json({ initialized, config: workspaceService.getWorkspaceConfig() });
});

export default router;
