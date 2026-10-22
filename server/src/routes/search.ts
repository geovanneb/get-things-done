import { Router, Request, Response } from 'express';
import { searchService } from '../services/searchService';

const router = Router();

// GET /api/search?q=&types=
router.get('/', async (req: Request, res: Response) => {
  const q = req.query['q'] as string;
  const typesParam = req.query['types'] as string | undefined;

  if (!q || q.trim().length === 0) {
    res.status(400).json({ error: 'Bad Request', message: 'q parameter is required' });
    return;
  }

  const types = typesParam ? typesParam.split(',').map((t) => t.trim()) : undefined;

  // Try to build index (no-op if already built - fast path via SQLite)
  try {
    await searchService.buildIndex();
  } catch {
    // Proceed with potentially stale index
  }

  const results = await searchService.search(q, types);
  res.json({ results, count: results.length, query: q });
});

export default router;
