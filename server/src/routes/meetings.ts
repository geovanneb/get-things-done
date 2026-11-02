import { Router, Request, Response } from 'express';
import { param } from '../utils/params';
import { MeetingHistoryService } from '../services/meetingHistoryService';
import { isMeetingId } from '../services/meetingLibrary';
import { sendFile } from '../utils/files';

const router = Router();
const service = new MeetingHistoryService();

/** A meeting id from the path, checked before it reaches a service: MQ-…, CU-… or CU-…-M-01. */
function meetingId(req: Request): string {
  const id = param(req, 'id');
  if (!isMeetingId(id)) throw Object.assign(new Error('Invalid meeting id'), { statusCode: 400 });
  return id;
}

// GET /api/meetings/history  every meeting a context update holds (digests and imports), newest first
router.get('/history', async (_req: Request, res: Response) => {
  res.json(await service.list());
});

// GET /api/meetings/:id  one meeting held by an update: its record, its files and where it stands
router.get('/:id', async (req: Request, res: Response) => {
  res.json(await service.detail(meetingId(req)));
});

// GET /api/meetings/:id/text/:file  a transcript or notes of the meeting, as text to read
router.get('/:id/text/:file', async (req: Request, res: Response) => {
  const text = await service.text(meetingId(req), param(req, 'file'));
  // Text someone said or wrote, never something a browser should run.
  res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.type('text/plain; charset=utf-8').send(text);
});

// GET /api/meetings/:id/audio/:file  a recording of the meeting, to play; Range requests work, so seeking does
router.get('/:id/audio/:file', async (req: Request, res: Response) => {
  // The sender every attachment uses: sandboxed, never sniffed.
  sendFile(res, await service.audio(meetingId(req), param(req, 'file')), false);
});

// PUT /api/meetings/:id/keep  { keep: boolean }  System cleanup never removes a kept meeting
router.put('/:id/keep', async (req: Request, res: Response) => {
  res.json(await service.keep(meetingId(req), (req.body as { keep?: unknown } | undefined)?.keep));
});

// DELETE /api/meetings/:id  moves the meeting's text to the trash; its confirmed record stays in its update
router.delete('/:id', async (req: Request, res: Response) => {
  await service.remove(meetingId(req));
  res.status(204).send();
});

// POST /api/meetings/:id/restore  puts a deleted meeting's text back
router.post('/:id/restore', async (req: Request, res: Response) => {
  await service.restore(meetingId(req));
  res.status(204).send();
});

// DELETE /api/meetings/:id/trash  deletes a meeting's text from the trash for good
router.delete('/:id/trash', async (req: Request, res: Response) => {
  await service.purge(meetingId(req));
  res.status(204).send();
});

export default router;
