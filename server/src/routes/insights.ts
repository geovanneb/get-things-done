import { Router, Request, Response } from 'express';
import { InsightsService } from '../services/insightsService';

const router = Router();
const insightsService = new InsightsService();

/** Windows the UI offers. `all` disables the time filter. */
const ALLOWED_WINDOWS = new Set([7, 30, 90]);

function parseWindow(raw: unknown): number | null {
  if (raw === 'all') return null;
  const days = Number(raw);
  return ALLOWED_WINDOWS.has(days) ? days : 30;
}

// GET /api/insights?days=30 | 7 | 90 | all
router.get('/', async (req: Request, res: Response) => {
  try {
    const data = await insightsService.getInsightsData(parseWindow(req.query.days));
    res.json(data);
  } catch (error) {
    console.error('Failed to build insights:', error);
    res.status(500).json({ error: 'Failed to build insights' });
  }
});

export default router;
