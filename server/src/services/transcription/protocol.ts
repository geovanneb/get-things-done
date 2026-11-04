/** Messages between the dashboard and the transcription worker (see worker.ts). */
import type { LanguageChange } from './languages';
import type { SpeakerTurn } from './parts';
import type { Interval } from './voices';

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
  /**
   * Who spoke when in a whole recording. A job of its own: if it fails, the transcript does not. `identify`: also the
   * mean embedding of each voice's clean speech, to compare with remembered voices (Recognize known voices).
   */
  | { type: 'speakers'; wav: string; segmentation: string; embedding: string; threads: number; identify?: boolean }
  /** One embedding per stretch of a recording, to remember a voice the user named. Light: no transcription model. */
  | { type: 'embed'; wav: string; embedding: string; threads: number; intervals: Interval[] }
  /**
   * Follows a recording as it is made: a 16 kHz mono 16-bit WAV that grows. The worker reads only audio the dashboard
   * says is saved (`committed`), then everything up to `end` once the recording is sealed.
   */
  | {
    type: 'follow'; model: EngineModel; wav: string; language: string;
    /**
     * A model that only tells the language of each part, for a live model that cannot while a language is set
     * (Whisper repeats the set one): SenseVoice, which reports what it hears.
     */
    detector?: EngineModel;
  };

/**
 * Sent to a job after its request. `helper-known`: its GPU engine was recorded (see `helper` below). The others go to a
 * follow job; byte counts are of audio, after the 44-byte header.
 */
/** A diarized voice's mean embedding, and each clean sample's own, to tell one person from two merged into one voice. */
export interface HeardVoiceReply { speaker: number; centroid: number[]; seconds: number; samples: { seconds: number; embedding: number[] }[] }

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
  /** A follow job's decoded part, with or without words: its own speech and the language it sounded like. */
  | { type: 'part'; start: number; end: number; detected: string | null }
  | { type: 'turns'; turns: SpeakerTurn[] }
  /** A `speakers` job with `identify`: per diarized voice (as in `turns`), the mean embedding of its clean speech. */
  | { type: 'voices'; voices: HeardVoiceReply[] }
  /** A transcription with turns: which diarized voice became which `Speaker N` of the transcript, as [voice, N]. */
  | { type: 'labels'; labels: [number, number][] }
  /** An `embed` job: one embedding per interval asked for, in order; null for one too short or silent to tell. */
  | { type: 'embeddings'; embeddings: (number[] | null)[] }
  /**
   * `bytes`: for a follow job, exactly how much audio it read, so the dashboard can tell it covered all of it.
   * `late_language`: a language change came after a part it applies to was already transcribed.
   */
  | { type: 'done'; seconds: number; segments: number; bytes?: number; late_language?: boolean }
  /** `failure`: from the GPU engine, what kind of failure it was (see HelperFailure). */
  | { type: 'error'; message: string; failure?: 'missing' | 'load' | 'gpu' | 'timeout' | 'protocol' };
