import { Router, Request, Response } from 'express';
import { MAX_RESOLVE_BATCH, MentionService } from '../services/mentionService';

const router = Router();
const mentionService = new MentionService();

// GET /api/mentions?q=&limit=  (picker for @-mentions in a task's Objective)
router.get('/', async (req: Request, res: Response) => {
  const q = (req.query['q'] as string | undefined) ?? '';
  const limit = Math.min(Math.max(parseInt((req.query['limit'] as string) || '8', 10) || 8, 1), 50);
  res.json(await mentionService.search(q, limit));
});

// GET /api/mentions/resolve?href=  → { exists, route, label?, type? }  (chips show deleted files struck through)
router.get('/resolve', async (req: Request, res: Response) => {
  const href = typeof req.query['href'] === 'string' ? req.query['href'] : '';
  // A mention's href is a link: its URL syntax is decoded once, here, into the literal workspace path.
  let ref: string;
  try { ref = decodeURIComponent(href); } catch { ref = ''; }
  if (!ref) { res.json({ exists: false, route: null }); return; }
  // The same answer as one reference of the batch below.
  res.json((await mentionService.targets([ref]))[ref]);
});

// POST /api/mentions/resolve  { refs: [literal workspace path or id, …] } (never decoded) → { targets: { [ref]: { exists, route, label?, type? } } }
// Many references at once (a chat answer can name dozens): at most MAX_RESOLVE_BATCH per request.
router.post('/resolve', async (req: Request, res: Response) => {
  const refs = (req.body as { refs?: unknown } | undefined)?.refs;
  if (!Array.isArray(refs) || refs.length > MAX_RESOLVE_BATCH || refs.some((r) => typeof r !== 'string')) {
    res.status(400).json({ error: `refs must be a list of at most ${MAX_RESOLVE_BATCH} strings` });
    return;
  }
  res.json({ targets: await mentionService.targets(refs as string[]) });
});

export default router;
