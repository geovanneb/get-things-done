import * as path from 'path';
import * as fsp from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { Router, Request, Response } from 'express';
import { WorkspaceService } from '../services/workspace';
import { ValidationService } from '../services/validationService';
import { GitService } from '../services/gitService';

const router = Router();
const workspaceService = new WorkspaceService();
const validationService = new ValidationService();
const gitService = new GitService();
const execFileAsync = promisify(execFile);

/** Wrap a string as a single-quoted POSIX shell argument. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Wrap a string as an AppleScript string literal. */
function appleScriptQuote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Launch `claude` in a new terminal window at the workspace directory.
 * The command is built entirely from server-side state — nothing from the
 * request body reaches the shell.
 */
async function openClaudeCode(workspacePath: string): Promise<void> {
  const shellCommand = `cd ${shellQuote(workspacePath)} && claude`;

  if (process.platform === 'darwin') {
    const script = [
      'tell application "Terminal"',
      '  activate',
      `  do script ${appleScriptQuote(shellCommand)}`,
      'end tell',
    ].join('\n');
    await execFileAsync('osascript', ['-e', script]);
    return;
  }

  if (process.platform === 'win32') {
    await execFileAsync('cmd', ['/c', 'start', '', 'cmd', '/k', `cd /d "${workspacePath}" && claude`]);
    return;
  }

  // Linux — try the common terminal emulators in order.
  const candidates = ['x-terminal-emulator', 'gnome-terminal', 'konsole', 'xfce4-terminal', 'xterm'];
  for (const term of candidates) {
    try {
      await execFileAsync(term, ['-e', 'bash', '-lc', `${shellCommand}; exec bash`]);
      return;
    } catch {
      // try the next one
    }
  }
  throw new Error('No supported terminal emulator found.');
}

// GET /api/workspace
router.get('/', async (req: Request, res: Response) => {
  const config = workspaceService.getWorkspaceConfig();
  const git_enabled = await gitService.isGitRepo();
  res.json({ ...config, git_enabled });
});

// PUT /api/workspace — update workspace name
router.put('/', async (req: Request, res: Response) => {
  const { name } = req.body;
  if (!name || typeof name !== 'string' || !name.trim()) {
    res.status(400).json({ error: 'Bad Request', message: 'name is required' });
    return;
  }
  workspaceService.updateWorkspaceName(name.trim());
  const config = workspaceService.getWorkspaceConfig();
  res.json(config);
});

// POST /api/workspace/init
router.post('/init', async (req: Request, res: Response) => {
  const { path: workspacePath, name } = req.body;
  if (!workspacePath) {
    res.status(400).json({ error: 'Bad Request', message: 'path is required' });
    return;
  }

  const isValid = await workspaceService.validateWorkspacePath(workspacePath);
  if (!isValid) {
    res.status(400).json({ error: 'Bad Request', message: `Path is not accessible or not a directory: ${workspacePath}` });
    return;
  }

  await workspaceService.initWorkspace(workspacePath);
  const config = workspaceService.getWorkspaceConfig();
  res.status(201).json({ message: 'Workspace initialized', config });
});

// POST /api/workspace/reinitialize — re-run scaffold on the current workspace
router.post('/reinitialize', async (req: Request, res: Response) => {
  const workspacePath = workspaceService.getWorkspacePath();

  const isValid = await workspaceService.validateWorkspacePath(workspacePath);
  if (!isValid) {
    res.status(400).json({ error: 'Bad Request', message: `Workspace path is not accessible: ${workspacePath}` });
    return;
  }

  await workspaceService.initWorkspace(workspacePath);
  const config = workspaceService.getWorkspaceConfig();
  res.json({ message: 'Workspace re-initialized', config });
});

// POST /api/workspace/open — open the workspace in Finder (macOS) or file manager
router.post('/open', async (req: Request, res: Response) => {
  const workspacePath = workspaceService.getWorkspacePath();
  try {
    if (process.platform === 'darwin') {
      await execFileAsync('open', [workspacePath]);
    } else if (process.platform === 'win32') {
      await execFileAsync('explorer', [workspacePath]);
    } else {
      await execFileAsync('xdg-open', [workspacePath]);
    }
    res.json({ opened: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: 'Failed to open folder', message });
  }
});

// POST /api/workspace/open-claude — open Claude Code in a terminal at the workspace
router.post('/open-claude', async (req: Request, res: Response) => {
  const workspacePath = workspaceService.getWorkspacePath();
  const command = `cd "${workspacePath}" && claude`;

  try {
    await openClaudeCode(workspacePath);
    res.json({ opened: true, command });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: 'Failed to open Claude Code', message, command });
  }
});

// GET /api/workspace/validate
router.get('/validate', async (req: Request, res: Response) => {
  const results = await validationService.validateWorkspace();
  res.json(results);
});

// GET /api/workspace/validation/count
router.get('/validation/count', async (req: Request, res: Response) => {
  const results = await validationService.validateWorkspace();
  const errors = results.filter((r) => r.level === 'error').length;
  const warnings = results.filter((r) => r.level === 'warning').length;
  res.json({ errors, warnings });
});

// GET /api/workspace/git/status
router.get('/git/status', async (req: Request, res: Response) => {
  const status = await gitService.getStatus();
  res.json(status);
});

// GET /api/workspace/git/diff
router.get('/git/diff', async (req: Request, res: Response) => {
  const filePath = req.query['file'] as string | undefined;
  const diff = await gitService.getDiff(filePath);
  res.json(diff);
});

// GET /api/workspace/git/log
router.get('/git/log', async (req: Request, res: Response) => {
  const limit = req.query['limit'] ? parseInt(req.query['limit'] as string, 10) : 20;
  const log = await gitService.getLog(limit);
  res.json(log);
});

// POST /api/workspace/git/stage
router.post('/git/stage', async (req: Request, res: Response) => {
  const { file } = req.body;
  if (!file) {
    res.status(400).json({ error: 'Bad Request', message: 'file is required' });
    return;
  }
  await gitService.stageFile(file);
  res.json({ message: `Staged: ${file}` });
});

// POST /api/workspace/git/commit
router.post('/git/commit', async (req: Request, res: Response) => {
  const { message } = req.body;
  if (!message) {
    res.status(400).json({ error: 'Bad Request', message: 'commit message is required' });
    return;
  }
  await gitService.commit(message);
  res.json({ message: 'Committed successfully' });
});

// GET /api/workspace/git/enabled
router.get('/git/enabled', async (req: Request, res: Response) => {
  const isRepo = await gitService.isGitRepo();
  res.json({ git_enabled: isRepo });
});

// GET /api/workspace/files/* — serve any file from within the workspace
router.get('/files/*', async (req: Request, res: Response) => {
  const workspacePath = workspaceService.getWorkspacePath();
  const relativePath = (req.params as Record<string, string>)[0] ?? '';
  const fullPath = path.resolve(path.join(workspacePath, relativePath));

  // Prevent path traversal outside the workspace
  if (!fullPath.startsWith(path.resolve(workspacePath) + path.sep) &&
      fullPath !== path.resolve(workspacePath)) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }

  try {
    await fsp.access(fullPath);
  } catch {
    res.status(404).json({ error: 'Not found' });
    return;
  }

  res.sendFile(fullPath);
});

export default router;
