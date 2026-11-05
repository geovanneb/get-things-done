import type { Transcription } from '../types';

/**
 * Dictation into a text field: the microphone recorded at 16 kHz, sent as one WAV clip to
 * `POST /api/transcription/dictation` and transcribed offline with a downloaded model. These are the parts without the
 * browser, so they can be tested; DictateButton does the recording.
 */

export const DICTATION_RATE = 16_000;
/** The server refuses longer clips; recording stops here by itself. */
export const MAX_DICTATION_SECONDS = 5 * 60;
const MODEL_KEY = 'gtd.dictation.model';

export interface DictationModel { id: string; name: string }

/**
 * The models a dictation can use: the downloaded ones. A GPU model only once Test speed showed it runs on the GPU
 * here; until then the server would run its CPU counterpart, which is listed on its own.
 */
export function dictationModels(overview: Pick<Transcription, 'models'> | null): DictationModel[] {
  return (overview?.models ?? [])
    .filter((m) => m.installed && (!m.gpu || m.gpu_ready))
    .map((m) => ({ id: m.id, name: m.name }));
}

/** The one this browser used last, else the one transcriptions run with (Settings), else the first downloaded one. */
export function pickDictationModel(models: DictationModel[], overview: Pick<Transcription, 'effective_model' | 'settings'> | null, saved: string | null): string | null {
  const ids = models.map((m) => m.id);
  for (const id of [saved, overview?.effective_model, overview?.settings.model]) if (id && ids.includes(id)) return id;
  return ids[0] ?? null;
}

export function savedDictationModel(): string | null {
  try { return localStorage.getItem(MODEL_KEY); } catch { return null; }
}

export function saveDictationModel(id: string): void {
  try { localStorage.setItem(MODEL_KEY, id); } catch { /* private mode: chosen again next time */ }
}

/** Cap by samples: browser timers and the final worklet flush can arrive after the five-minute limit. */
export function wavFile(blocks: readonly Uint8Array[], rate = DICTATION_RATE): Uint8Array<ArrayBuffer> {
  const length = Math.min(blocks.reduce((n, b) => n + b.length, 0), MAX_DICTATION_SECONDS * rate * 2);
  const out = new Uint8Array(44 + length);
  const view = new DataView(out.buffer);
  const ascii = (at: number, text: string) => { for (let i = 0; i < text.length; i++) out[at + i] = text.charCodeAt(i); };
  ascii(0, 'RIFF'); view.setUint32(4, 36 + length, true); ascii(8, 'WAVE');
  ascii(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  ascii(36, 'data'); view.setUint32(40, length, true);
  let at = 44;
  for (const block of blocks) {
    const kept = block.subarray(0, out.length - at);
    out.set(kept, at);
    at += kept.length;
    if (at === out.length) break;
  }
  return out;
}

/** The field's text with the dictated text added at the end, a space or line apart from what was there. */
export function withDictation(current: string, text: string): string {
  const spoken = text.trim();
  if (!spoken) return current;
  if (!current.trim()) return spoken;
  return /\s$/.test(current) ? current + spoken : `${current} ${spoken}`;
}
