import { Router, Request, Response } from 'express';
import { KaizenService } from '../services/kaizenService';

const router = Router();
const kaizenService = new KaizenService();

router.get('/', async (_req: Request, res: Response) => {
  const proposals = await kaizenService.listKaizen();
  res.json(proposals);
});

router.get('/:id', async (req: Request, res: Response) => {
  const proposal = await kaizenService.getKaizen(req.params['id']);
  if (!proposal) { res.status(404).json({ error: 'Not found' }); return; }
  res.json(proposal);
});

router.patch('/:id', async (req: Request, res: Response) => {
  const { status, applied_at } = req.body as { status?: string; applied_at?: string };
  const patch: Parameters<typeof kaizenService.updateKaizen>[1] = {};
  if (status) patch.status = status as 'proposed' | 'applied' | 'rejected';
  if (applied_at !== undefined) patch.applied_at = applied_at;
  const updated = await kaizenService.updateKaizen(req.params['id'], patch);
  if (!updated) { res.status(404).json({ error: 'Not found' }); return; }
  res.json(updated);
});

export default router;
