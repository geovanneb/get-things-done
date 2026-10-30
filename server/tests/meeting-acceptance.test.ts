import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ContextUpdateService } from '../src/services/contextUpdateService';
import { MeetingDigestService } from '../src/services/meetingDigestService';
import { MeetingLiveTranscriptService } from '../src/services/meetingLiveTranscript';
import { MeetingRecordingService } from '../src/services/meetingRecording';
import { MeetingTranscriptionService } from '../src/services/meetingTranscription';
import { TranscriptionModelService } from '../src/services/transcriptionModels';

// The whole way on this computer, with a real model and no AI: the CI job "Transcription (real model)" provides both.
const realModels = process.env['STT_TEST_MODELS'];
const realAudio = process.env['STT_TEST_AUDIO'];
const MODEL = 'sensevoice-2024-07-17';
const BLOCK = 64_000;
// What each step may take: the live transcript's own limit at Stop, then the queue's job. The test allows both.
const LIVE_MS = 120_000;
const QUEUE_MS = 300_000;

/** The speech of a 16 kHz mono sample, as the page sends it. */
async function speech(file: string): Promise<Buffer> {
  const wav = await fsp.readFile(file);
  for (let at = 12; at + 8 <= wav.length; at += 8 + wav.readUInt32LE(at + 4)) {
    if (wav.toString('latin1', at, at + 4) === 'data') return wav.subarray(at + 8, at + 8 + wav.readUInt32LE(at + 4));
  }
  throw new Error('No audio in the sample');
}

async function record(recording: MeetingRecordingService, id: string, token: string, audio: Buffer): Promise<void> {
  await recording.start(id, token);
  for (let offset = 0; offset < audio.length; offset += BLOCK) await recording.append(id, token, offset, audio.subarray(offset, offset + BLOCK));
  await recording.finish(id, { token, offset: audio.length, queue: true });
}

test('real model: meetings recorded offline, one with a live transcript and one after it, become one digest', { skip: !realModels || !realAudio ? 'set STT_TEST_MODELS and STT_TEST_AUDIO to run' : false, timeout: LIVE_MS + QUEUE_MS + 60_000 }, async (t) => {
  const ws = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-accept-'));
  const settingsFile = path.join(realModels!, 'settings.json');
  const settings = await fsp.readFile(settingsFile, 'utf-8').catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  const before = { ws: process.env.ESB_WORKSPACE_PATH, models: process.env.ESB_MODELS_PATH };
  process.env.ESB_WORKSPACE_PATH = ws;
  process.env.ESB_MODELS_PATH = realModels;
  const queue = new MeetingDigestService();
  const models = new TranscriptionModelService();
  const recording = new MeetingRecordingService(queue);
  const transcription = new MeetingTranscriptionService(queue);
  let recorded: Promise<void> = Promise.resolve();
  let queued: { meeting: string; file: string } | null = null;
  // Also after a failure part way: nothing may still run or write once the settings go back and the workspace goes.
  t.after(async () => {
    try {
      await MeetingLiveTranscriptService.closeAll();
      await recorded.catch(() => {});
      if (queued) await transcription.stop(queued.meeting, queued.file).catch(() => {});
      await MeetingTranscriptionService.settled();
    } finally {
      try {
        if (settings === null) await fsp.rm(settingsFile, { force: true }); else await fsp.writeFile(settingsFile, settings);
      } finally {
        for (const [key, value] of [['ESB_WORKSPACE_PATH', before.ws], ['ESB_MODELS_PATH', before.models]] as const) {
          if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
        await fsp.rm(ws, { recursive: true, force: true });
      }
    }
  });
  for (const d of ['tasks/active', 'context-updates', '.situation-board/routines']) await fsp.mkdir(path.join(ws, d), { recursive: true });

  const participants = [{ name: 'Jane Doe', ref: 'STK-0001' }, { name: 'Kim Park' }];

  await models.updateSettings({ model: MODEL, language: 'auto', live_model: MODEL, keep_recordings: false });
  const live = await queue.createMeeting({ title: 'Fictional live sync', meeting_date: '2026-10-29', participants });
  recorded = record(recording, live.id, 'fictional-acceptance-token-live', await speech(path.join(realAudio!, 'en.wav')));
  await recorded;
  const atStop = (await queue.loadMeeting(live.id)).files.find((f) => f.recording)!.recording!;
  assert.equal(atStop.status, 'done', 'with the live model chosen, the transcript is ready at Stop');

  await models.updateSettings({ model: MODEL, language: 'auto', live_model: null, keep_recordings: false });
  const after = await queue.createMeeting({ title: 'Fictional sync without live text', meeting_date: '2026-10-30' });
  recorded = record(recording, after.id, 'fictional-acceptance-token-after', await speech(path.join(realAudio!, 'ja.wav')));
  await recorded;
  const file = () => queue.loadMeeting(after.id).then((m) => m.files.find((f) => f.recording)!);
  const state = async () => (await file()).recording!;
  assert.equal((await state()).status, 'pending');
  queued = { meeting: after.id, file: (await file()).name };
  // Ticking again is safe, and picks the job up if the engine was still being given back.
  const waitUntil = Date.now() + QUEUE_MS;
  while (['pending', 'running'].includes((await state()).status) && Date.now() < waitUntil) {
    await transcription.tick();
    await new Promise((r) => setTimeout(r, 250));
  }
  const transcribed = await state();
  assert.equal(transcribed.status, 'done', transcribed.error ?? 'the queue transcribes it after the meeting');

  const result = await queue.runNow(new Date('2026-10-30T18:00:00'));
  assert.equal(result.status, 'ok', result.message);
  const update = await new ContextUpdateService().get(result.context_update!);
  assert.equal(update.status, 'ready');
  assert.equal(update.digest_meetings.length, 2, 'one digest with both');
  const materials = path.join(ws, 'context-updates', update.id, 'materials');
  const names = await fsp.readdir(materials);
  assert.equal(names.filter((n) => n.endsWith('.wav')).length, 0, 'the audio is removed once its transcript is safe');
  const texts = await Promise.all(names.filter((n) => n.endsWith('.transcript.md')).map((n) => fsp.readFile(path.join(materials, n), 'utf-8')));
  assert.equal(texts.length, 2);
  assert.ok(texts.some((s) => /tribal chieftain/i.test(s)) && texts.some((s) => /中学/.test(s)), 'each holds what was said');
  assert.match(await fsp.readFile(path.join(materials, 'meetings.md'), 'utf-8'), /expected_participants: \["Jane Doe \(STK-0001\)", "Kim Park"\]/);
  assert.deepEqual((await queue.readQueue()).meetings, [], 'the queue is empty');
});
