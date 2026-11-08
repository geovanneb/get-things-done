/** Sharing context notes as one Markdown file (#107): which notes can be chosen, and the preview the server returns. */
import type { ContextNote } from '@/types';

export type ShareProblem = 'gone' | 'unreadable' | 'duplicate_id' | 'not_shareable' | 'invalid_label' | 'too_large_total'
  | 'too_complex' | 'unknown_part' | 'took_too_long';

export interface ContextSharePreview {
  rows: Array<{ id: string; title: string; problem: string | null; code: ShareProblem | null }>;
  /** The exact text of the file; null while any chosen note cannot be shared. */
  text: string | null;
  token: string | null;
  file_name: string;
}

/** Notes labelled shareable (matching the search), and how many other notes are not offered. */
export function shareableNotes(notes: ContextNote[], query: string): { shareable: ContextNote[]; others: number } {
  const q = query.trim().toLowerCase();
  const shareable = notes.filter((n) => n.sensitivity === 'shareable');
  return {
    shareable: shareable.filter((n) => !q || n.title.toLowerCase().includes(q)).sort((a, b) => a.title.localeCompare(b.title)),
    others: notes.length - shareable.length,
  };
}

/** The chosen notes still offered (a note relabelled or removed meanwhile drops out), in the order they were chosen. */
export function stillChosen(chosen: string[], notes: ContextNote[]): string[] {
  const offered = new Set(notes.filter((n) => n.sensitivity === 'shareable').map((n) => n.id));
  return chosen.filter((id) => offered.has(id));
}

/** Today in the user's own time zone, which names the file. */
export function localDay(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
