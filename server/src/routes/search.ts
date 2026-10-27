import { Router, Request, Response } from 'express';
import { SearchService } from '../services/searchService';

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

  // The index connection belongs to this request, so a workspace switch cannot replace it
  // while collection is awaiting filesystem reads. It is closed on success and failure.
  const searchService = new SearchService();
  try {
    await searchService.buildIndex();
    const results = await searchService.search(q, types);
    res.json({ results, count: results.length, query: q });
  } finally {
    searchService.reset();
  }
});

export default router;
