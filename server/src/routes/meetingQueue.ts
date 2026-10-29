import { Router, Request, Response } from 'express';
import multer from 'multer';
import { param } from '../utils/params';
import { MeetingDigestService, queueId } from '../services/meetingDigestService';

const router = Router();
const service = new MeetingDigestService();
// One file per request, like context update materials, so memory stays bounded.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024, files: 1 } });

const body = (req: Request): Record<string, unknown> =>
  (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;

// GET /api/meeting-queue  every queued or draft meeting, oldest first
router.get('/', async (_req: Request, res: Response) => {
  res.json(await service.readQueue());
});

// POST /api/meeting-queue  { title?, meeting_date? }  a draft meeting; add files, then queue it
router.post('/', async (req: Request, res: Response) => {
  res.status(201).json(await service.createMeeting(body(req)));
});

// POST /api/meeting-queue/:id/files  (multipart, one "file")
router.post('/:id/files', upload.single('file'), async (req: Request, res: Response) => {
  if (!req.file) { res.status(400).json({ error: 'Bad Request', message: 'No file uploaded (field "file")' }); return; }
  res.status(201).json(await service.addFile(queueId(param(req, 'id')), req.file.originalname, req.file.buffer));
});

// POST /api/meeting-queue/:id/queue  the draft is complete: the next digest can take it
router.post('/:id/queue', async (req: Request, res: Response) => {
  res.json(await service.queue(queueId(param(req, 'id'))));
});

// DELETE /api/meeting-queue/:id  remove a meeting and its files from the queue
router.delete('/:id', async (req: Request, res: Response) => {
  await service.removeMeeting(queueId(param(req, 'id')));
  res.status(204).send();
});

export default router;
