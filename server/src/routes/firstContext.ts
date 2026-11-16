// The first context: the interview and files a new workspace starts its memory from (services/firstContext.ts).
import { Router, Request, Response } from 'express';
import { FirstContextService } from '../services/firstContext';

const router = Router();
const service = new FirstContextService();

const body = (req: Request): Record<string, unknown> =>
  (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;

// GET /api/first-context  the draft, its update and whether the dashboard should offer it
router.get('/', async (_req: Request, res: Response) => {
  res.json(await service.get());
});

// PUT /api/first-context  { answers }  saves the draft as the executive types
router.put('/', async (req: Request, res: Response) => {
  res.json(await service.saveDraft(body(req)['answers']));
});

// POST /api/first-context/update  { title }  the update the files go into, made on the first file
router.post('/update', async (req: Request, res: Response) => {
  res.json(await service.ensureUpdate(body(req)['title']));
});

// POST /api/first-context/submit  { answers, title }  sends the interview to the update
router.post('/submit', async (req: Request, res: Response) => {
  res.json(await service.submit({ answers: body(req)['answers'], title: body(req)['title'] }));
});

// POST /api/first-context/skip  "Not now": stop offering it; the answers are kept
router.post('/skip', async (_req: Request, res: Response) => {
  res.json(await service.skip());
});

// POST /api/first-context/restart  start again after sending, with the answers as a starting point
router.post('/restart', async (_req: Request, res: Response) => {
  res.json(await service.restart());
});

export default router;
