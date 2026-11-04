import { Router, Request, Response } from 'express';
import { cancelDesktopRestart, checkNow, dismiss, install, prepareDesktopRestart, setAutoCheck, updateHandoffFailed, updateStatus } from '../services/appUpdates';
import { WorkspaceService } from '../services/workspace';

/** The workspace this request is about, or none yet (the update state itself is the user's, not a workspace's). */
const workspace = (): string | null => { try { return new WorkspaceService().getWorkspacePath(); } catch { return null; } };

const router = Router();

// GET /api/app/update  this version, the newest one found, and how this install updates
router.get('/update', async (_req: Request, res: Response) => {
  res.json(await updateStatus(workspace()));
});

// POST /api/app/update/check  asks for the newest version now
router.post('/update/check', async (_req: Request, res: Response) => {
  res.json(await checkNow(workspace()));
});

// PUT /api/app/update/settings  { auto_check }  checks once a day by itself, or only when asked
router.put('/update/settings', async (req: Request, res: Response) => {
  res.json(await setAutoCheck((req.body as Record<string, unknown> | undefined)?.['auto_check'], workspace()));
});

// POST /api/app/update/dismiss  { version }  "Later": no notice for that version
router.post('/update/dismiss', async (req: Request, res: Response) => {
  res.json(await dismiss((req.body as Record<string, unknown> | undefined)?.['version'], workspace()));
});

// POST /api/app/update/install  { version }  updates a global npm install to the version found and restarts: a helper
// installs it once this dashboard has stopped, which it does right after answering. 409 while something important
// runs, or when npm can't update from here.
router.post('/update/install', async (req: Request, res: Response) => {
  const status = await install((req.body as Record<string, unknown> | undefined)?.['version'], workspace());
  res.on('finish', () => {
    setTimeout(() => process.kill(process.pid, 'SIGTERM'), 300).unref();
    // Still here long after the helper stopped waiting for it: nothing was installed, carry on as before.
    setTimeout(updateHandoffFailed, 45_000).unref();
  });
  res.json(status);
});

// POST /api/app/update/desktop-restart  the desktop app is about to stop this server to install its update: closes
// admission and checks again what runs (409 with the reason while something does). /cancel opens admission again.
router.post('/update/desktop-restart', async (_req: Request, res: Response) => {
  await prepareDesktopRestart(workspace());
  res.json({ ok: true });
});
router.post('/update/desktop-restart/cancel', (_req: Request, res: Response) => {
  cancelDesktopRestart();
  res.json({ ok: true });
});

export default router;
