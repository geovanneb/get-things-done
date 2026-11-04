import { Router, Request, Response } from 'express';
import { param } from '../utils/params';
import { MeetingHistoryService } from '../services/meetingHistoryService';
import { isMeetingId } from '../services/meetingLibrary';
import { sendFile } from '../utils/files';
import { startCorrection } from '../services/meetingCorrectionService';
import { MeetingTranscriptionService } from '../services/meetingTranscription';
import { nameVersionSpeakers } from '../services/meetingVersions';
import { VoiceprintService } from '../services/voiceprints/service';
import { WorkspaceService } from '../services/workspace';

const router = Router();
const service = new MeetingHistoryService();
const transcription = new MeetingTranscriptionService();
const voiceprints = new VoiceprintService();

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

// GET /api/meetings/search?q=words  meetings whose transcripts and notes hold every word, with where
router.get('/search', async (req: Request, res: Response) => {
  res.json(await service.search(req.query['q']));
});

// GET /api/meetings/:id  one meeting held by an update: its record, its files and where it stands
router.get('/:id', async (req: Request, res: Response) => {
  const id = meetingId(req);
  const detail = await service.detail(id);
  // How far a Transcribe again of this meeting got, when this dashboard runs it.
  const progress = transcription.folderProgress(id);
  res.json({ ...detail, transcription_progress: detail.transcription?.status === 'running' ? progress : null });
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

// GET /api/meetings/:id/files/:file  a file of the meeting as it is, to open or (?download=1) save, wherever it is kept
router.get('/:id/files/:file', async (req: Request, res: Response) => {
  sendFile(res, await service.file(meetingId(req), param(req, 'file')), req.query['download'] === '1');
});

// POST /api/meetings/:id/transcriptions  { file, model }  transcribes a kept recording again; the result is a new version
router.post('/:id/transcriptions', async (req: Request, res: Response) => {
  const id = meetingId(req);
  await service.transcribeAgain(id, req.body);
  void transcription.tick().catch(() => {});
  res.status(202).json(await service.detail(id));
});

// DELETE /api/meetings/:id/transcriptions  stops a transcription that waits or runs, or clears one that failed
router.delete('/:id/transcriptions', async (req: Request, res: Response) => {
  const id = meetingId(req);
  await service.detail(id);
  await transcription.stopFolder(id);
  res.status(204).send();
});

// PUT /api/meetings/:id/version  { version }  makes a version of its text the current one
router.put('/:id/version', async (req: Request, res: Response) => {
  const id = meetingId(req);
  await service.chooseVersion(id, (req.body as { version?: unknown } | undefined)?.version);
  res.json(await service.detail(id));
});

// PUT /api/meetings/:id/versions/:version/speakers  { transcript_sha256, names: { "Speaker 2": { name, ref } | null } }
// names the speakers of a Transcribe again version: the confirm path of a kept meeting, apart from its reviewed record
router.put('/:id/versions/:version/speakers', async (req: Request, res: Response) => {
  const id = meetingId(req);
  await service.detail(id);
  const b = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
  const asked = (b['names'] && typeof b['names'] === 'object' && !Array.isArray(b['names']) ? b['names'] : {}) as Record<string, unknown>;
  const version = param(req, 'version');
  const named = await nameVersionSpeakers(new WorkspaceService().getWorkspacePath(), id, { version, transcript_sha256: b['transcript_sha256'] }, asked);
  res.json(await service.detail(id));
  // A changed name drops the voice samples it added; a person whose voice is remembered learns from this one.
  if (named.version.speakers) {
    void voiceprints.afterNaming({ kind: 'folder', meeting: id, version, transcript_sha256: named.version.speakers.transcript_sha256 }, Object.keys(asked), named.after);
  }
});

// POST /api/meetings/:id/corrections  starts a correction of the meeting's reviewed record: a context update to analyze
router.post('/:id/corrections', async (req: Request, res: Response) => {
  res.status(201).json(await startCorrection(meetingId(req)));
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
