import { Router, Request, Response } from 'express';
import { AgentActivityService } from '../services/agentActivityService';

const router = Router();
const service = new AgentActivityService();

// GET /api/agent-activity — snapshot of pile sizes and in-flight work
router.get('/', async (_req: Request, res: Response) => {
  const snapshot = await service.getSnapshot();
  res.json(snapshot);
});

export default router;
