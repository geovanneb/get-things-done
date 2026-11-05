import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { beginStart } from '../appActivity';
import { CATALOG, runnableModel, TranscriptionModelService } from '../transcriptionModels';
import type { TranscriptionEngine } from './engine';
import { readWavFormat, WavError } from './wav';

/**
 * Dictation: a short clip spoken into a text field, turned into text by the offline engine, on this computer.
 *
 * The page records the microphone at 16 kHz (as a meeting recording does) and sends the clip whole when the user
 * stops. It is transcribed with one of the downloaded models, in the language set in Settings > Transcription, and
 * never stored: the clip lives in a temporary folder only while the engine reads it.
 */

/** A dictated note, not a meeting: long enough for a few paragraphs, short enough to send in one request. */
export const MAX_DICTATION_SECONDS = 5 * 60;
const HEADER_ROOM = 1024;
/** 16 kHz, 16-bit mono, plus room for the header. The page records in this format. */
export const MAX_DICTATION_BYTES = MAX_DICTATION_SECONDS * 16_000 * 2 + HEADER_ROOM;

export interface DictationResult {
  text: string;
  /** The model that really ran: a GPU model not verified here runs as its CPU counterpart. */
  model: string;
  seconds: number;
}

function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode: status });
}

/** The model to use: the one asked for, or the one chosen in Settings. Checked against the catalog, never a path. */
async function pickModel(models: TranscriptionModelService, asked: unknown): Promise<string> {
  if (asked !== undefined && (typeof asked !== 'string' || !CATALOG.some((m) => m.id === asked))) throw httpError(400, 'Unknown model');
  return runnableModel(typeof asked === 'string' ? asked : (await models.readSettings()).model);
}

export async function dictate(engine: TranscriptionEngine, models: TranscriptionModelService, audio: unknown, model: unknown): Promise<DictationResult> {
  const release = beginStart('A dictation is being transcribed');
  try {
    return await transcribeClip(engine, models, audio, model);
  } finally {
    release();
  }
}

async function transcribeClip(engine: TranscriptionEngine, models: TranscriptionModelService, audio: unknown, model: unknown): Promise<DictationResult> {
  if (!Buffer.isBuffer(audio) || audio.length === 0) throw httpError(400, 'Send the recording as a WAV file (Content-Type audio/wav)');
  const id = await pickModel(models, model);
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-dictation-'));
  try {
    const file = path.join(dir, 'dictation.wav');
    await fsp.writeFile(file, audio, { mode: 0o600 });
    const format = await readWavFormat(file).catch((err: Error) => {
      throw err instanceof WavError ? httpError(400, err.message) : err;
    });
    // The size limit already bounds a 16 kHz clip; this also bounds one sent at a lower rate.
    if (format.duration > MAX_DICTATION_SECONDS) throw httpError(413, `Dictate at most ${MAX_DICTATION_SECONDS / 60} minutes at a time`);
    const result = await engine.transcribe(file, { model: id });
    // Segments are cut at pauses; joined with a space they read as the sentences that were spoken.
    const text = result.segments.map((s) => s.text.trim()).filter(Boolean).join(' ');
    return { text, model: id, seconds: result.seconds };
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}
