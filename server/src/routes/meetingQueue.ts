import express, { Router, Request, Response } from 'express';
import * as fsp from 'fs/promises';
import multer from 'multer';
import { param } from '../utils/params';
import { MAX_RECORDING_BYTES, MeetingDigestService, queueId, type Upload } from '../services/meetingDigestService';
import { MeetingTranscriptionService } from '../services/meetingTranscription';
import { MeetingRecordingService } from '../services/meetingRecording';
import { MeetingLiveTranscriptService } from '../services/meetingLiveTranscript';
import { fileInside, sendFile, topLevelName } from '../utils/files';
import { utf8FileNames } from '../utils/uploadNames';

const router = Router();
const service = new MeetingDigestService();
const transcription = new MeetingTranscriptionService();
const recording = new MeetingRecordingService(service);
const liveTranscript = new MeetingLiveTranscriptService(service);

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
const upload = multer({ storage: streamToMeeting, ...utf8FileNames, limits: { fileSize: MAX_RECORDING_BYTES, files: 1 } });

const body = (req: Request): Record<string, unknown> =>
  (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;

// GET /api/meeting-queue  every queued or draft meeting, oldest first
router.get('/', async (_req: Request, res: Response) => {
  res.json(await service.readQueue());
});

// POST /api/meeting-queue  { title?, meeting_date?, participants? }  a draft meeting; add files, then queue it
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

// POST /api/meeting-queue/:id/recording  { token }  starts recording into a draft meeting
router.post('/:id/recording', async (req: Request, res: Response) => {
  res.status(201).json(await recording.start(queueId(param(req, 'id')), (req.body as { token?: string }).token as string));
});

// PUT /api/meeting-queue/:id/recording?offset=N  a block of audio, with the writer token in X-Recording-Token
router.put('/:id/recording', express.raw({ type: 'application/octet-stream', limit: '1mb', inflate: false }), async (req: Request, res: Response) => {
  const offset = typeof req.query['offset'] === 'string' && /^\d+$/.test(req.query['offset']) ? Number(req.query['offset']) : -1;
  res.json(await recording.append(queueId(param(req, 'id')), req.get('x-recording-token') ?? '', offset, req.body as Buffer));
});

// PUT /api/meeting-queue/:id/recording/language  { token, language }  the language being spoken from now on
router.put('/:id/recording/language', async (req: Request, res: Response) => {
  const { token, language } = req.body as { token?: string; language?: unknown };
  res.json(await recording.setLanguage(queueId(param(req, 'id')), token as string, language));
});

// GET /api/meeting-queue/:id/recording/transcript?from=N  the live transcript of the recording being made, from segment N
router.get('/:id/recording/transcript', async (req: Request, res: Response) => {
  const from = typeof req.query['from'] === 'string' && /^\d{1,9}$/.test(req.query['from']) ? Number(req.query['from']) : 0;
  res.json(await liveTranscript.read(queueId(param(req, 'id')), from));
});

// GET /api/meeting-queue/:id/transcripts/:file  a recording's transcript or live draft, as text to read
router.get('/:id/transcripts/:file', async (req: Request, res: Response) => {
  const id = queueId(param(req, 'id'));
  const name = topLevelName(param(req, 'file'));
  const meeting = await service.loadMeeting(id);
  // Only a transcript of a recording: this is not a way to read any file of the meeting.
  const known = meeting.files.some((f) => f.recording?.transcript === name || f.recording?.draft?.transcript === name);
  if (!known) { res.status(404).json({ error: 'Not found', message: 'No such transcript in this meeting' }); return; }
  // The sender every attachment uses: a transcript is text someone said, never something a browser should run.
  res.type('text/plain; charset=utf-8');
  sendFile(res, await fileInside(await service.meetingFolder(id), name), false);
});

// POST /api/meeting-queue/:id/recording/finish  { token, offset, generation, queue } or { recover: true, generation, queue }
router.post('/:id/recording/finish', async (req: Request, res: Response) => {
  const { token, offset, recover, generation, queue } = req.body as { token?: string; offset?: number; recover?: boolean; generation?: string; queue?: boolean };
  res.json(await recording.finish(queueId(param(req, 'id')), { token, offset, recover: recover === true, generation, queue: queue === true }));
  if (queue === true) void transcription.tick().catch(() => {});
});

// POST /api/meeting-queue/:id/queue  the draft is complete: the next digest can take it
router.post('/:id/queue', async (req: Request, res: Response) => {
  res.json(await service.queue(queueId(param(req, 'id'))));
  // A recording in it starts transcribing now rather than at the next check.
  void transcription.tick().catch(() => {});
});

// POST /api/meeting-queue/:id/recordings/:file/(stop|retry|accept)  a recording's transcription: stop it, try it
// again, or use a partial transcript as it is
router.post('/:id/recordings/:file/:action', async (req: Request, res: Response) => {
  const id = queueId(param(req, 'id'));
  const file = topLevelName(param(req, 'file'));
  const action = param(req, 'action');
  const body = (req.body ?? {}) as { generation?: unknown; draft_sha256?: unknown };
  if (action === 'stop') res.json(await transcription.stop(id, file, typeof body.generation === 'string' ? body.generation : undefined));
  else if (action === 'retry') res.json(await transcription.retry(id, file));
  else if (action === 'accept') res.json(await transcription.accept(id, file));
  else if (action === 'use-live') {
    if (typeof body.draft_sha256 !== 'string') { res.status(400).json({ error: 'Bad Request', message: 'draft_sha256 is required' }); return; }
    res.json(await transcription.useLive(id, file, body.draft_sha256));
  } else res.status(404).json({ error: 'Not found', message: 'Use stop, retry, accept or use-live' });
});

// PUT /api/meeting-queue/:id/recordings/:file/speakers  { transcript_sha256, names: { "Speaker 2": { name, ref } | null } }
router.put('/:id/recordings/:file/speakers', async (req: Request, res: Response) => {
  res.json(await transcription.nameSpeakers(queueId(param(req, 'id')), topLevelName(param(req, 'file')), req.body));
});

// DELETE /api/meeting-queue/:id  remove a meeting and its files from the queue
router.delete('/:id', async (req: Request, res: Response) => {
  const id = queueId(param(req, 'id'));
  await service.removeMeeting(id);
  transcription.forget(id);
  liveTranscript.forget(id);
  res.status(204).send();
});

export default router;
