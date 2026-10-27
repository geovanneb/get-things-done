import { Router, Request, Response } from 'express';
import { param } from '../utils/params';
import { RoutineService, routineId } from '../services/routineService';

const router = Router();
const service = new RoutineService();

const body = (req: Request): Record<string, unknown> =>
  (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;

// GET /api/routines
router.get('/', async (_req: Request, res: Response) => {
  res.json(await service.list());
});

// GET /api/routines/history?limit=50
router.get('/history', async (req: Request, res: Response) => {
  const limit = Math.min(Math.max(parseInt(String(req.query['limit'] ?? '50'), 10) || 50, 1), 300);
  res.json(await service.history(limit));
});

// POST /api/routines/preview  { schedule, due_offset_days? }  summary and next runs, nothing saved
router.post('/preview', async (req: Request, res: Response) => {
  res.json(service.preview(body(req)['schedule'], body(req)['due_offset_days'], new Date(), body(req)['paused_until']));
});

// POST /api/routines/run-due  what the timer does, on demand
router.post('/run-due', async (_req: Request, res: Response) => {
  res.json(await service.runDue('manual'));
});

// POST /api/routines  { title, enabled?, schedule, catch_up?, task }
router.post('/', async (req: Request, res: Response) => {
  res.status(201).json(await service.create(body(req)));
});

// GET /api/routines/:id
router.get('/:id', async (req: Request, res: Response) => {
  res.json(await service.get(routineId(param(req, 'id'))));
});

// PATCH /api/routines/:id  any of the create fields
router.patch('/:id', async (req: Request, res: Response) => {
  res.json(await service.update(routineId(param(req, 'id')), body(req)));
});

// DELETE /api/routines/:id  (tasks it already created stay)
router.delete('/:id', async (req: Request, res: Response) => {
  await service.remove(routineId(param(req, 'id')));
  res.status(204).send();
});

// POST /api/routines/:id/run  create the task now
router.post('/:id/run', async (req: Request, res: Response) => {
  res.status(201).json(await service.runNow(routineId(param(req, 'id'))));
});

export default router;
