import { Router, Request, Response } from 'express';
import { SituationService } from '../services/situationService';

const router = Router();
const situationService = new SituationService();

// GET /api/situation
router.get('/', async (req: Request, res: Response) => {
  const data = await situationService.getSituationData();
  res.json(data);
});

export default router;
