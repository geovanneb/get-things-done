/** Sharing context notes as one Markdown file (#107): which notes can be chosen, and the preview the server returns. */
import type { ContextNote } from '@/types';

export interface ContextSharePreview {
  rows: Array<{ id: string; title: string; problem: string | null }>;
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
