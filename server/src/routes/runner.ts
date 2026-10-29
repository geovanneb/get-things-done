import { Router, Request, Response } from 'express';
import { AgentRunnerService } from '../services/agentRunner';

const router = Router();
const service = new AgentRunnerService();

// GET /api/runner  whether the AI tool that runs commands for the dashboard is installed and signed in
router.get('/', async (_req: Request, res: Response) => {
  res.json(await service.status());
});

export default router;
