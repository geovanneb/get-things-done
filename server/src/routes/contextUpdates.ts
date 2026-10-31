import { Router, Request, Response } from 'express';
import multer from 'multer';
import { param } from '../utils/params';
import { sendFile } from '../utils/files';
import { ContextUpdateService } from '../services/contextUpdateService';
import { AgentRunnerService } from '../services/agentRunner';
import { scheduleKaizenIntake } from '../services/kaizenIntake';

const router = Router();
const service = new ContextUpdateService();
const runner = new AgentRunnerService();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

const body = (req: Request): Record<string, unknown> =>
  (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;

// GET /api/context-updates
router.get('/', async (_req: Request, res: Response) => {
  // A Kaizen note the watcher missed is opened before the list is read, so the user never waits for the next tick.
  // Without notes this is one folder read.
  await scheduleKaizenIntake();
  res.json(await service.list());
});

// POST /api/context-updates  { title?, source_date?, notes?, text? }
router.post('/', async (req: Request, res: Response) => {
  res.status(201).json(await service.create(body(req)));
});

// GET /api/context-updates/:id  (with proposals, current and proposed content)
router.get('/:id', async (req: Request, res: Response) => {
  res.json(await service.get(param(req, 'id')));
});

// PATCH /api/context-updates/:id  { title?, source_date?, notes? }
router.patch('/:id', async (req: Request, res: Response) => {
  res.json(await service.edit(param(req, 'id'), body(req)));
});

// DELETE /api/context-updates/:id
router.delete('/:id', async (req: Request, res: Response) => {
  await service.remove(param(req, 'id'));
  res.status(204).send();
});

// POST /api/context-updates/:id/materials  (multipart, one "file")
router.post('/:id/materials', upload.single('file'), async (req: Request, res: Response) => {
  if (!req.file) { res.status(400).json({ error: 'Bad Request', message: 'No file provided' }); return; }
  res.status(201).json(await service.addMaterial(param(req, 'id'), req.file.originalname, req.file.buffer));
});

// GET /api/context-updates/:id/materials/<name>  open in the browser; ?download=1 to save it
router.get('/:id/materials/*name', async (req: Request, res: Response) => {
  sendFile(res, await service.materialPath(param(req, 'id'), param(req, 'name')), req.query['download'] === '1');
});

// DELETE /api/context-updates/:id/materials/:name
router.delete('/:id/materials/:name', async (req: Request, res: Response) => {
  await service.removeMaterial(param(req, 'id'), param(req, 'name'));
  res.status(204).send();
});

// PUT /api/context-updates/:id/keep-materials  { keep: boolean }  keep the files after the update is done, or release them
router.put('/:id/keep-materials', async (req: Request, res: Response) => {
  res.json(await service.keepMaterials(param(req, 'id'), body(req)['keep']));
});

// PUT /api/context-updates/:id/decisions  { decisions: { "P-01": { decision, reviewer_note } } }
router.put('/:id/decisions', async (req: Request, res: Response) => {
  res.json(await service.saveDecisions(param(req, 'id'), body(req)['decisions']));
});

// PUT /api/context-updates/:id/meeting-records  { records: { "M-01": "confirmed" | "rejected" | null } }
router.put('/:id/meeting-records', async (req: Request, res: Response) => {
  res.json(await service.saveMeetingRecords(param(req, 'id'), body(req)['records']));
});

// POST /api/context-updates/:id/meeting-records/:recordId/tasks  { item, revision, task }
// 201 with the new task, or 200 with the task the action item already has.
router.post('/:id/meeting-records/:recordId/tasks', async (req: Request, res: Response) => {
  const result = await service.createActionItemTask(param(req, 'id'), param(req, 'recordId'), body(req));
  res.status(result.created ? 201 : 200).json(result);
});

// PUT /api/context-updates/:id/meeting-records/:recordId/speaker  { label, source, person, revision }  null: unknown
router.put('/:id/meeting-records/:recordId/speaker', async (req: Request, res: Response) => {
  res.json(await service.setSpeaker(param(req, 'id'), param(req, 'recordId'), body(req)));
});

// GET /api/context-updates/:id/run  the current or last run started from the dashboard (null if none)
router.get('/:id/run', async (req: Request, res: Response) => {
  res.json(await runner.get(param(req, 'id')));
});

// POST /api/context-updates/:id/run  { command: "analyze" | "apply" }  runs /gtd-context-analyze or /gtd-context-apply
// with the installed AI tool, without a window
router.post('/:id/run', async (req: Request, res: Response) => {
  res.status(202).json(await runner.start(param(req, 'id'), body(req)['command'] as 'analyze' | 'apply'));
});

// POST /api/context-updates/:id/run/cancel
router.post('/:id/run/cancel', async (req: Request, res: Response) => {
  res.json(await runner.cancel(param(req, 'id')));
});

// The analysis-run endpoints from the first runner release: kept as aliases of /run with command "analyze".
router.get('/:id/analysis-run', async (req: Request, res: Response) => {
  res.json(await runner.get(param(req, 'id')));
});
router.post('/:id/analysis-run', async (req: Request, res: Response) => {
  res.status(202).json(await runner.start(param(req, 'id'), 'analyze'));
});
router.post('/:id/analysis-run/cancel', async (req: Request, res: Response) => {
  res.json(await runner.cancel(param(req, 'id')));
});

// State changes made from the dashboard. The agent commands make the others by editing update.md.
router.post('/:id/approve', async (req: Request, res: Response) => {
  res.json(await service.approve(param(req, 'id')));
});
router.post('/:id/back-to-review', async (req: Request, res: Response) => {
  res.json(await service.backToReview(param(req, 'id')));
});
router.post('/:id/reopen', async (req: Request, res: Response) => {
  res.json(await service.reopen(param(req, 'id')));
});
router.post('/:id/close', async (req: Request, res: Response) => {
  res.json(await service.close(param(req, 'id')));
});

export default router;
