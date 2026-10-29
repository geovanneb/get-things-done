import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { Router, Request, Response, NextFunction } from 'express';
import { fileInside, sendFile } from '../utils/files';
import { param } from '../utils/params';
import { WorkspaceService } from '../services/workspace';
import { ValidationService } from '../services/validationService';
import { GitService, GitUnavailableError } from '../services/gitService';
import { activateWorkspace } from '../services/workspaceActivation';

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
 * The Windows launch passes the workspace as the working directory, not inside the command line:
 * Node escapes quotes in a way cmd does not read, so a `&` or `%` in the path would run as cmd syntax.
 * `start` opens the new window in the current directory.
 */
export function windowsClaudeLaunch(workspacePath: string): {
  file: string;
  args: string[];
  options: { cwd: string };
} {
  return { file: 'cmd', args: ['/c', 'start', '', 'cmd', '/k', 'claude'], options: { cwd: workspacePath } };
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
    const launch = windowsClaudeLaunch(workspacePath);
    await execFileAsync(launch.file, launch.args, launch.options);
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

/**
 * Open the OS-native folder picker and return the chosen absolute path, or null on cancel.
 * Nothing from the request reaches the command line.
 */
async function pickFolder(): Promise<string | null> {
  const prompt = 'Choose a workspace folder';

  if (process.platform === 'darwin') {
    try {
      const { stdout } = await execFileAsync('osascript', [
        '-e', `POSIX path of (choose folder with prompt ${appleScriptQuote(prompt)})`,
      ], { timeout: 10 * 60 * 1000 });
      return stdout.trim() || null;
    } catch (err) {
      // osascript exits with "User canceled. (-128)" when the dialog is dismissed.
      if (err instanceof Error && /-128/.test(err.message)) return null;
      throw err;
    }
  }

  if (process.platform === 'win32') {
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
      `$d.Description = '${prompt}'`,
      "if ($d.ShowDialog() -eq 'OK') { Write-Output $d.SelectedPath }",
    ].join('; ');
    const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-STA', '-Command', script], {
      timeout: 10 * 60 * 1000,
    });
    return stdout.trim() || null;
  }

  try {
    const { stdout } = await execFileAsync('zenity', ['--file-selection', '--directory', `--title=${prompt}`], {
      timeout: 10 * 60 * 1000,
    });
    return stdout.trim() || null;
  } catch (err) {
    // zenity exits with code 1 on cancel.
    if ((err as { code?: unknown }).code === 1) return null;
    throw err;
  }
}

// GET /api/workspace
router.get('/', async (req: Request, res: Response) => {
  const config = workspaceService.getWorkspaceConfig();
  const git_enabled = await gitService.isGitRepo();
  const git_installed = await gitService.isInstalled();
  res.json({ ...config, git_enabled, git_installed });
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

// POST /api/workspace/switch — point the app at another folder
router.post('/switch', async (req: Request, res: Response) => {
  const { path: rawPath, initialize } = req.body ?? {};
  if (!rawPath || typeof rawPath !== 'string' || !rawPath.trim()) {
    res.status(400).json({ error: 'Please enter a folder path.' });
    return;
  }

  const workspacePath = workspaceService.resolveUserPath(rawPath);

  const isValid = await workspaceService.validateWorkspacePath(workspacePath);
  if (!isValid) {
    res.status(400).json({ error: `Folder not found, not a directory, or not writable: ${workspacePath}` });
    return;
  }

  const isWorkspace = workspaceService.isExistingWorkspace(workspacePath);
  if (!isWorkspace && initialize !== true) {
    res.status(409).json({
      error: 'This folder is not a Get Things Done workspace yet.',
      needs_init: true,
      path: workspacePath,
    });
    return;
  }

  await activateWorkspace(workspacePath);

  const config = workspaceService.getWorkspaceConfig();
  const git_enabled = await gitService.isGitRepo();
  const git_installed = await gitService.isInstalled();
  res.json({ message: 'Workspace changed', initialized: !isWorkspace, config: { ...config, git_enabled, git_installed } });
});

// GET /api/workspace/recent — workspaces opened on this machine, for one-click switching
router.get('/recent', async (_req: Request, res: Response) => {
  res.json(workspaceService.listRecentWorkspaces());
});

// POST /api/workspace/recent/forget — remove one from that list (the folder stays on disk)
router.post('/recent/forget', async (req: Request, res: Response) => {
  const { path: rawPath } = req.body ?? {};
  if (!rawPath || typeof rawPath !== 'string') {
    res.status(400).json({ error: 'Missing workspace path.' });
    return;
  }
  const workspacePath = workspaceService.resolveUserPath(rawPath);
  if (workspaceService.listRecentWorkspaces().some((w) => w.current && path.resolve(w.path) === workspacePath)) {
    res.status(400).json({ error: 'The workspace you are in cannot be removed from the list.' });
    return;
  }
  workspaceService.forgetWorkspace(workspacePath);
  res.json(workspaceService.listRecentWorkspaces());
});

// POST /api/workspace/pick-folder — native folder picker on the machine running the server
router.post('/pick-folder', async (req: Request, res: Response) => {
  try {
    const picked = await pickFolder();
    res.json({ path: picked });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(501).json({ error: 'Folder picker is not available on this system. Type the path instead.', message });
  }
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
  const git_installed = await gitService.isInstalled();
  res.json({ git_enabled: isRepo, git_installed });
});

// GET /api/workspace/files/* — serve any file from within the workspace
router.get('/files/*splat', async (req: Request, res: Response) => {
  const fullPath = await fileInside(workspaceService.getWorkspacePath(), param(req, 'splat'));
  sendFile(res, fullPath, req.query['download'] === '1');
});

// Git is optional: answer with a readable 503 (the shared handler hides messages of 5xx errors).
router.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
  if (err instanceof GitUnavailableError) {
    res.status(503).json({ error: 'Git not available', message: err.message });
    return;
  }
  next(err);
});

export default router;
