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

// GET /api/mentions/resolve?href=  → { exists }  (chips show deleted files struck through)
router.get('/resolve', async (req: Request, res: Response) => {
  const href = (req.query['href'] as string | undefined) ?? '';
  res.json({ exists: Boolean(href) && (await mentionService.resolve(href)) !== null });
});

export default router;
