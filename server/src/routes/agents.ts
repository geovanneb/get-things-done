import { Router, Request, Response } from 'express';
import { AgentService } from '../services/agentService';

const agentService = new AgentService();

// Agents router
export const agentsRouter = Router();

// GET /api/agents
agentsRouter.get('/', async (req: Request, res: Response) => {
  const agents = await agentService.listAgents();
  res.json(agents);
});

// GET /api/agents/:name
agentsRouter.get('/:name', async (req: Request, res: Response) => {
  const agent = await agentService.getAgent(req.params['name']);
  res.json(agent);
});

// Skills router
export const skillsRouter = Router();

// GET /api/skills
skillsRouter.get('/', async (req: Request, res: Response) => {
  const skills = await agentService.listSkills();
  res.json(skills);
});

// GET /api/skills/marketplace — must come before /:name
skillsRouter.get('/marketplace', async (req: Request, res: Response) => {
  try {
    const skills = await agentService.listMarketplaceSkills();
    res.json(skills);
  } catch (err: unknown) {
    res.status(502).json({ error: err instanceof Error ? err.message : 'Failed to fetch marketplace' });
  }
});

// POST /api/skills/install
skillsRouter.post('/install', async (req: Request, res: Response) => {
  const { slug } = req.body as { slug?: string };
  if (!slug) { res.status(400).json({ error: 'slug is required' }); return; }
  try {
    await agentService.installSkill(slug);
    res.json({ ok: true });
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Install failed' });
  }
});

// DELETE /api/skills/:name
skillsRouter.delete('/:name', async (req: Request, res: Response) => {
  try {
    await agentService.deleteSkill(req.params['name']);
    res.json({ ok: true });
  } catch (err: unknown) {
    res.status(404).json({ error: err instanceof Error ? err.message : 'Delete failed' });
  }
});

// GET /api/skills/:name
skillsRouter.get('/:name', async (req: Request, res: Response) => {
  const skill = await agentService.getSkill(req.params['name']);
  res.json(skill);
});
