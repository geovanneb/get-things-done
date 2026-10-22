import { Router, Request, Response } from 'express';
import { mentionService } from '../services/mentionService';

const router = Router();

// GET /api/mentions — everything a task can @mention: stakeholders, contexts, templates, tasks
router.get('/', async (_req: Request, res: Response) => {
  const candidates = await mentionService.listCandidates();
  res.json(candidates);
});

export default router;
