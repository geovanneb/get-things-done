/** Messages between the dashboard and the transcription worker (see worker.ts). */

/** A model as the worker needs it: which engine, and the full paths of its files and of the VAD model. */
export interface EngineModel {
  kind: 'whisper' | 'sensevoice';
  files: Record<string, string>;
  vad: string;
  threads: number;
}

export type WorkerRequest =
  | { type: 'version' }
  | { type: 'check'; model: EngineModel }
  | { type: 'transcribe'; model: EngineModel; wav: string; language: string };

export type WorkerReply =
  | { type: 'version'; version: string }
  | { type: 'loaded'; ms: number }
  | { type: 'progress'; done: number; total: number }
  | { type: 'segment'; start: number; end: number; text: string }
  | { type: 'done'; seconds: number; segments: number }
  | { type: 'error'; message: string };
