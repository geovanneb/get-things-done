import { Router, Request, Response } from 'express';
import { orgChartService } from '../services/orgChartService';

const router = Router();

// GET /api/org-charts            — every chart
// GET /api/org-charts?stakeholder=STK-0001 — that person's position in each chart they belong to
router.get('/', async (req: Request, res: Response) => {
  const stakeholder = req.query['stakeholder'];
  if (typeof stakeholder === 'string' && stakeholder) {
    res.json(await orgChartService.getPositions(stakeholder));
    return;
  }
  res.json(await orgChartService.listCharts());
});

// POST /api/org-charts
router.post('/', async (req: Request, res: Response) => {
  res.status(201).json(await orgChartService.createChart(req.body ?? {}));
});

// GET /api/org-charts/:id
router.get('/:id', async (req: Request, res: Response) => {
  res.json(await orgChartService.getChart(req.params['id']));
});

// PUT /api/org-charts/:id
router.put('/:id', async (req: Request, res: Response) => {
  res.json(await orgChartService.updateChart(req.params['id'], req.body ?? {}));
});

// DELETE /api/org-charts/:id
router.delete('/:id', async (req: Request, res: Response) => {
  await orgChartService.deleteChart(req.params['id']);
  res.status(204).send();
});

export default router;
