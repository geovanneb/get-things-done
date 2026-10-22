import { Router, Request, Response } from 'express';
import { param } from '../utils/params';
import { StakeholderService } from '../services/stakeholderService';
import { orgChartService } from '../services/orgChartService';

const router = Router();
const stakeholderService = new StakeholderService();

// GET /api/stakeholders
router.get('/', async (req: Request, res: Response) => {
  const type = req.query['type'] as 'people' | 'groups' | undefined;
  const stakeholders = await stakeholderService.listStakeholders(type);
  res.json(stakeholders);
});

// POST /api/stakeholders
router.post('/', async (req: Request, res: Response) => {
  const stakeholder = await stakeholderService.createStakeholder(req.body);
  res.status(201).json(stakeholder);
});

// GET /api/stakeholders/:id
router.get('/:id', async (req: Request, res: Response) => {
  const stakeholder = await stakeholderService.getStakeholder(param(req, 'id'));
  res.json(stakeholder);
});

// PUT /api/stakeholders/:id
router.put('/:id', async (req: Request, res: Response) => {
  const stakeholder = await stakeholderService.updateStakeholder(param(req, 'id'), req.body);
  res.json(stakeholder);
});

// DELETE /api/stakeholders/:id
router.delete('/:id', async (req: Request, res: Response) => {
  await stakeholderService.deleteStakeholder(param(req, 'id'));
  await orgChartService.removeStakeholder(param(req, 'id'));
  res.status(204).send();
});

export default router;
