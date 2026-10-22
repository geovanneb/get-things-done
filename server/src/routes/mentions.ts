import { Router, Request, Response } from 'express';
import { MentionService } from '../services/mentionService';

const router = Router();
const mentionService = new MentionService();

// GET /api/mentions?q=&limit=  (picker for @-mentions in a task's Objective)
router.get('/', async (req: Request, res: Response) => {
  const q = (req.query['q'] as string | undefined) ?? '';
  const limit = Math.min(Math.max(parseInt((req.query['limit'] as string) || '8', 10) || 8, 1), 50);
  res.json(await mentionService.search(q, limit));
});

export default router;
