import type { RunStep } from '@/types';

/** A step in words: the verb, the path to show as code (if any), and the rest of the sentence. */
export interface StepWords { verb: string; path: string | null; rest: string }

const VERBS: Record<RunStep['kind'], [now: string, past: string]> = {
  read: ['Reading', 'Read'],
  search: ['Searching', 'Searched'],
  list: ['Listing', 'Listed'],
  write: ['Writing', 'Wrote'],
  edit: ['Editing', 'Edited'],
  command: ['Running', 'Ran'],
  skill: ['Using', 'Used'],
  other: ['Using', 'Used'],
};

/** What a step did, or is doing (`now`), e.g. "Reading context/…/note.md", "Ran a command", "Used the pdf skill". */
export function stepWords(step: RunStep, now = false): StepWords {
  const verb = VERBS[step.kind]?.[now ? 0 : 1] ?? (now ? 'Working' : 'Worked');
  if (step.kind === 'command') return { verb, path: null, rest: 'a command' };
  if (step.kind === 'skill') return { verb, path: null, rest: step.name ? `the ${step.name} skill` : 'a skill' };
  if (step.kind === 'other') return { verb, path: null, rest: step.name ?? 'a tool' };
  if (step.outside) return { verb, path: null, rest: step.kind === 'search' || step.kind === 'list' ? 'outside the workspace' : 'a file outside the workspace' };
  if (step.path) return { verb, path: step.path, rest: '' };
  if (step.folder) return { verb: `${verb} a file in`, path: step.folder, rest: '' };
  if (step.folder === '') return { verb, path: null, rest: 'a file in the workspace folder' };
  return { verb, path: null, rest: step.kind === 'search' ? 'the workspace' : step.kind === 'list' ? 'files' : 'a file' };
}

/** The step as one plain sentence, for a screen reader or a title. */
export function stepText(step: RunStep, now = false): string {
  const w = stepWords(step, now);
  return [w.verb, w.path ?? w.rest].join(' ');
}

/** "45 s", "2 min 14 s", "1 h 3 min". */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min ${s % 60} s`;
  return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
}
