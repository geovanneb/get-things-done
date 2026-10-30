import { Router, Request, Response } from 'express';
import { param } from '../utils/params';
import { TranscriptionModelService } from '../services/transcriptionModels';
import { TranscriptionEngine } from '../services/transcription/engine';

import { runSpeedTest } from '../services/transcription/speedTest';

const router = Router();
const service = new TranscriptionModelService();
const engine = new TranscriptionEngine(service);

// GET /api/transcription  the models on offer, which are installed, download progress, and the settings
router.get('/', async (_req: Request, res: Response) => {
  res.json(await service.view());
});

// PUT /api/transcription/settings  { model?, language?, keep_recordings? }  how recordings are transcribed and kept
router.put('/settings', async (req: Request, res: Response) => {
  res.json(await service.updateSettings(req.body));
});

// POST /api/transcription/models/:id/download  starts the download; progress arrives as "transcription" events
router.post('/models/:id/download', async (req: Request, res: Response) => {
  res.status(202).json(await service.download(param(req, 'id')));
});

// POST /api/transcription/models/:id/cancel  stops the download; what was downloaded is kept for next time
router.post('/models/:id/cancel', async (req: Request, res: Response) => {
  res.json(await service.cancel(param(req, 'id')));
});

// GET /api/transcription/engine  whether the transcription engine loads on this computer (no model needed)
router.get('/engine', async (_req: Request, res: Response) => {
  res.json(await engine.status());
});

// POST /api/transcription/models/:id/check  loads an installed model in the worker: it works, and how fast it loads
router.post('/models/:id/check', async (req: Request, res: Response) => {
  res.json(await engine.check(param(req, 'id')));
});

// POST /api/transcription/models/:id/speed-test  measures how fast the downloaded model transcribes on this computer
router.post('/models/:id/speed-test', async (req: Request, res: Response) => {
  const id = param(req, 'id');
  if (!(await service.view()).models.some((m) => m.id === id && m.installed)) {
    res.status(409).json({ error: 'Conflict', message: 'Download the model first' });
    return;
  }
  res.json(await runSpeedTest(engine, id));
});

// DELETE /api/transcription/models/:id  removes the model's files
router.delete('/models/:id', async (req: Request, res: Response) => {
  res.json(await service.remove(param(req, 'id')));
});

export default router;
