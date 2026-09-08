import { Router, Request, Response } from 'express';
import { InsightsService } from '../services/insightsService';

const router = Router();
const insightsService = new InsightsService();

// GET /api/insights
router.get('/', async (req: Request, res: Response) => {
  const data = await insightsService.getInsightsData();
  res.json(data);
});

export default router;
