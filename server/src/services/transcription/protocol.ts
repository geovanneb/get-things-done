/** Messages between the dashboard and the transcription worker (see worker.ts). */
import type { LanguageChange } from './languages';

/** A model as the worker needs it: which engine, and the full paths of its files and of the VAD model. */
export interface EngineModel {
  kind: 'whisper' | 'sensevoice';
  files: Record<string, string>;
  vad: string;
  threads: number;
  /** See `noArena` in the catalog. */
  noArena?: boolean;
}

export type WorkerRequest =
  | { type: 'version' }
  | { type: 'check'; model: EngineModel }
  | { type: 'transcribe'; model: EngineModel; wav: string; language: string; changes?: LanguageChange[] }
  /**
   * Follows a recording as it is made: a 16 kHz mono 16-bit WAV that grows. The worker reads only audio the dashboard
   * says is saved (`committed`), then everything up to `end` once the recording is sealed.
   */
  | { type: 'follow'; model: EngineModel; wav: string; language: string };

/** Sent to a follow job after its request. Byte counts are of audio, after the 44-byte header. */
export type WorkerControl = { type: 'committed'; bytes: number } | { type: 'end'; bytes: number } | ({ type: 'language' } & LanguageChange);

export type WorkerReply =
  | { type: 'version'; version: string }
  | { type: 'loaded'; ms: number }
  | { type: 'progress'; done: number; total: number }
  | { type: 'segment'; start: number; end: number; text: string }
  /**
   * `bytes`: for a follow job, exactly how much audio it read, so the dashboard can tell it covered all of it.
   * `late_language`: a language change came after a part it applies to was already transcribed.
   */
  | { type: 'done'; seconds: number; segments: number; bytes?: number; late_language?: boolean }
  | { type: 'error'; message: string };
