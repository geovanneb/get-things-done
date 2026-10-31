/** Messages between the dashboard and the transcription worker (see worker.ts). */
import type { LanguageChange } from './languages';
import type { SpeakerTurn } from './parts';

/** A model as the worker needs it: which engine, and the full paths of its files and of the VAD model. */
export interface EngineModel {
  /** `whisper-cpp`: Whisper on the GPU through gtd-whisper (see whisperHelper.ts), its GGML file as `files.model`. */
  kind: 'whisper' | 'sensevoice' | 'whisper-cpp';
  files: Record<string, string>;
  /** For `whisper-cpp`: the gtd-whisper program. */
  helper?: string;
  vad: string;
  threads: number;
  /** See `noArena` in the catalog. */
  noArena?: boolean;
}

export type WorkerRequest =
  | { type: 'version' }
  | { type: 'check'; model: EngineModel }
  | { type: 'transcribe'; model: EngineModel; wav: string; language: string; changes?: LanguageChange[]; turns?: SpeakerTurn[] }
  /** Who spoke when in a whole recording. A job of its own: if it fails, the transcript does not. */
  | { type: 'speakers'; wav: string; segmentation: string; embedding: string; threads: number }
  /**
   * Follows a recording as it is made: a 16 kHz mono 16-bit WAV that grows. The worker reads only audio the dashboard
   * says is saved (`committed`), then everything up to `end` once the recording is sealed.
   */
  | { type: 'follow'; model: EngineModel; wav: string; language: string };

/**
 * Sent to a job after its request. `helper-known`: its GPU engine was recorded (see `helper` below). The others go to a
 * follow job; byte counts are of audio, after the 44-byte header.
 */
export type WorkerControl = { type: 'helper-known' } | { type: 'committed'; bytes: number } | { type: 'end'; bytes: number } | ({ type: 'language' } & LanguageChange);

export type WorkerReply =
  | { type: 'version'; version: string }
  /** `backend`: for the GPU engine, the device it really uses (e.g. "MTL0"), as it said at load. */
  | { type: 'loaded'; ms: number; backend?: string }
  /**
   * The GPU engine's process was started. The dashboard records it and answers `helper-known`; only then does it load
   * a model, and the dashboard makes sure it is gone before the job's slot and model are free.
   */
  | { type: 'helper'; pid: number }
  | { type: 'progress'; done: number; total: number }
  | { type: 'segment'; start: number; end: number; text: string; speaker?: number }
  | { type: 'turns'; turns: SpeakerTurn[] }
  /**
   * `bytes`: for a follow job, exactly how much audio it read, so the dashboard can tell it covered all of it.
   * `late_language`: a language change came after a part it applies to was already transcribed.
   */
  | { type: 'done'; seconds: number; segments: number; bytes?: number; late_language?: boolean }
  /** `failure`: from the GPU engine, what kind of failure it was (see HelperFailure). */
  | { type: 'error'; message: string; failure?: 'missing' | 'load' | 'gpu' | 'timeout' | 'protocol' };
