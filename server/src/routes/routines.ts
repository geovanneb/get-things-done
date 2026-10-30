import { Router, Request, Response } from 'express';
import { param } from '../utils/params';
import { RoutineService, routineId } from '../services/routineService';
import { MeetingTranscriptionService } from '../services/meetingTranscription';

import { TranscriptionModelService } from '../services/transcriptionModels';
const router = Router();
const service = new RoutineService();
const transcription = new MeetingTranscriptionService();

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

// GET /api/routines/system-cleanup  the built-in job: settings, schedule, last run
router.get('/system-cleanup', async (_req: Request, res: Response) => {
  res.json(await service.systemCleanup());
});

// PUT /api/routines/system-cleanup  any of the settings; missing ones keep their value
router.put('/system-cleanup', async (req: Request, res: Response) => {
  res.json(await service.updateSystemCleanup(body(req)));
});

// POST /api/routines/system-cleanup/preview  { settings? }  what a run would do now, nothing changed
router.post('/system-cleanup/preview', async (req: Request, res: Response) => {
  res.json(await service.previewSystemCleanup(body(req)['settings']));
});

// POST /api/routines/system-cleanup/run  run it now
router.post('/system-cleanup/run', async (_req: Request, res: Response) => {
  res.status(201).json(await service.runSystemCleanupNow());
});

// GET /api/routines/meeting-digest  the built-in digest: settings, schedule, queue, open digest, last run
router.get('/meeting-digest', async (_req: Request, res: Response) => {
  // With the transcription running in this dashboard, if any, and its progress.
  // Which models are downloaded: a recording fixed to one that is not waits, and the card says which to download.
  const models = (await new TranscriptionModelService().view().catch(() => null))?.models.filter((m) => m.installed) ?? null;
  res.json({
    ...await service.meetingDigest(), transcription: transcription.progress(),
    installed_models: models ? models.map((m) => m.id) : null,
    // How fast each is on this computer, when tested: for how long a recording will take.
    model_speeds: Object.fromEntries((models ?? []).flatMap((m) => (m.speed ? [[m.id, m.speed.realtime_x]] : []))),
  });
});

// PUT /api/routines/meeting-digest  { enabled?, schedule?, max_meetings? }  missing ones keep their value
router.put('/meeting-digest', async (req: Request, res: Response) => {
  res.json(await service.updateMeetingDigest(body(req)));
});

// POST /api/routines/meeting-digest/run  make a digest now from the queue
router.post('/meeting-digest/run', async (_req: Request, res: Response) => {
  res.status(201).json(await service.runMeetingDigestNow());
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
