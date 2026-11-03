import { Router, Request, Response } from 'express';
import { checkNow, dismiss, setAutoCheck, updateStatus } from '../services/appUpdates';
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

export default router;
