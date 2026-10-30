import { Router, Request, Response } from 'express';
import { param } from '../utils/params';
import { TranscriptionModelService } from '../services/transcriptionModels';

const router = Router();
const service = new TranscriptionModelService();

// GET /api/transcription  the models on offer, which are installed, download progress, and the settings
router.get('/', async (_req: Request, res: Response) => {
  res.json(await service.view());
});

// PUT /api/transcription/settings  { model?, language? }  the model and language used to transcribe
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

// DELETE /api/transcription/models/:id  removes the model's files
router.delete('/models/:id', async (req: Request, res: Response) => {
  res.json(await service.remove(param(req, 'id')));
});

export default router;
