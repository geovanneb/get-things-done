import { Router, Request, Response } from 'express';
import { param } from '../utils/params';
import { MeetingTranscriptionService } from '../services/meetingTranscription';
import { dismissVersionSuggestion, nameVersionSpeakers } from '../services/meetingVersions';
import { WorkspaceService } from '../services/workspace';
import { namesFor } from '../services/meetingDigestService';
import { parseVoiceSource, VoiceprintService } from '../services/voiceprints/service';

/**
 * Recognize known voices (docs/voiceprints.md). Remembered voices never leave this computer and are never part of
 * the workspace: these routes only list them (without their samples), remember, forget and relink them, and act on
 * the "sounds like" suggestions they give.
 */
const router = Router();
const voiceprints = new VoiceprintService();
const transcription = new MeetingTranscriptionService();

const body = (req: Request): Record<string, unknown> =>
  (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;

// GET /api/voiceprints  the setting, the consent wording, and each remembered voice (never its samples)
router.get('/', async (_req: Request, res: Response) => {
  res.json(await voiceprints.view());
});

// POST /api/voiceprints  { source, label, consent? }  remembers the voice of a speaker named with a stakeholder
router.post('/', async (req: Request, res: Response) => {
  res.status(201).json(await voiceprints.remember(body(req)));
});

// POST /api/voiceprints/forget-all  forgets every voice remembered for this workspace
router.post('/forget-all', async (_req: Request, res: Response) => {
  res.json({ forgotten: await voiceprints.forgetAll() });
});

// POST /api/voiceprints/moved/:key/relink  uses a moved workspace's voices here
router.post('/moved/:key/relink', async (req: Request, res: Response) => {
  await voiceprints.relink(param(req, 'key'));
  res.status(204).send();
});

// DELETE /api/voiceprints/moved/:key  forgets a moved workspace's voices
router.delete('/moved/:key', async (req: Request, res: Response) => {
  await voiceprints.forgetMoved(param(req, 'key'));
  res.status(204).send();
});

/**
 * POST /api/voiceprints/suggestions/(use|dismiss)  { source, label, ref?, model_sha256? }
 * Use names the speaker as the suggested stakeholder, through the confirm path of where it is (the queue, or a kept
 * meeting's version), refused when the suggestion changed; Not them hides it, and records nothing about the voice.
 */
router.post('/suggestions/:action', async (req: Request, res: Response) => {
  const b = body(req);
  const source = parseVoiceSource(b['source']);
  const label = typeof b['label'] === 'string' ? b['label'] : '';
  const action = param(req, 'action');
  const ws = new WorkspaceService().getWorkspacePath();
  if (action === 'dismiss') {
    if (source.kind === 'queue') await transcription.dismissSuggestion(source.meeting, source.file, source.transcript_sha256, label);
    else await dismissVersionSuggestion(ws, source.meeting, { version: source.version, transcript_sha256: source.transcript_sha256 }, label);
    res.status(204).send();
    return;
  }
  if (action !== 'use') { res.status(404).json({ error: 'Not found', message: 'Use use or dismiss' }); return; }
  const ref = typeof b['ref'] === 'string' ? b['ref'] : '';
  const person = await voiceprints.suggestedPerson(ref, b['model_sha256']);
  const suggestion = { label, ref, model_sha256: b['model_sha256'] as string };
  let names;
  if (source.kind === 'queue') {
    const meeting = await transcription.nameSpeakers(source.meeting, source.file, { transcript_sha256: source.transcript_sha256, names: { [label]: person } }, suggestion);
    names = namesFor(meeting.files.find((f) => f.name === source.file)?.recording);
  } else {
    names = (await nameVersionSpeakers(ws, source.meeting, { version: source.version, transcript_sha256: source.transcript_sha256 }, { [label]: person }, suggestion)).after;
  }
  res.status(204).send();
  // A use is a confirmation like any other: a remembered voice learns from it, after the response.
  void voiceprints.afterNaming(source, [label], names);
});

// DELETE /api/voiceprints/:ref  forgets one person's voice
router.delete('/:ref', async (req: Request, res: Response) => {
  await voiceprints.forget(param(req, 'ref'));
  res.status(204).send();
});

export default router;
