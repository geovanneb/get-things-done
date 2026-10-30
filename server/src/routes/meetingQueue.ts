import { Router, Request, Response } from 'express';
import * as fsp from 'fs/promises';
import multer from 'multer';
import { param } from '../utils/params';
import { MAX_RECORDING_BYTES, MeetingDigestService, queueId, type Upload } from '../services/meetingDigestService';

const router = Router();
const service = new MeetingDigestService();

/**
 * One file per request, streamed straight into its meeting's folder (recordings can be gigabytes): writeUpload checks
 * the meeting, the type, the size as it arrives and the free disk space; the handler then commits it.
 */
const streamToMeeting: multer.StorageEngine = {
  _handleFile(req, file, callback) {
    let id: string;
    try { id = queueId(param(req as Request, 'id')); } catch (err) { callback(err as Error); return; }
    service.writeUpload(id, file.originalname, file.stream, Number(req.headers['content-length']) || 0)
      .then((saved) => callback(null, { path: saved.path, size: saved.size, sha256: saved.sha256 } as Partial<Express.Multer.File>), (err: Error) => callback(err));
  },
  _removeFile(_req, file, callback) {
    fsp.rm(file.path, { force: true }).then(() => callback(null), (err: Error) => callback(err));
  },
};
const upload = multer({ storage: streamToMeeting, limits: { fileSize: MAX_RECORDING_BYTES, files: 1 } });

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

// POST /api/meeting-queue/:id/files  (multipart, one "file": a recording up to 4 GB, anything else up to 50 MB)
router.post('/:id/files', upload.single('file'), async (req: Request, res: Response) => {
  if (!req.file) { res.status(400).json({ error: 'Bad Request', message: 'No file uploaded (field "file")' }); return; }
  const saved = req.file as Express.Multer.File & Upload;
  try {
    res.status(201).json(await service.commitUpload(queueId(param(req, 'id')), req.file.originalname, { path: saved.path, size: saved.size, sha256: saved.sha256 }));
  } finally {
    // Renamed into place when committed; otherwise the upload is not kept.
    await fsp.rm(saved.path, { force: true });
  }
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
