import { tr } from '@/i18n/current';
import type { RunStep } from '@/types';

/** A step in words: the verb, the path to show as code (if any), and the rest of the sentence. */
export interface StepWords { verb: string; path: string | null; rest: string }

const VERBS = (): Record<RunStep['kind'], [now: string, past: string]> => ({
  read: [tr('runSteps.reading'), tr('runSteps.read')],
  search: [tr('runSteps.searching'), tr('runSteps.searched')],
  list: [tr('runSteps.listing'), tr('runSteps.listed')],
  write: [tr('runSteps.writing'), tr('runSteps.wrote')],
  edit: [tr('runSteps.editing'), tr('runSteps.edited')],
  command: [tr('runSteps.running'), tr('runSteps.ran')],
  skill: [tr('runSteps.using'), tr('runSteps.used')],
  other: [tr('runSteps.using'), tr('runSteps.used')],
});

/** What a step did, or is doing (`now`), e.g. "Reading context/…/note.md", "Ran a command", "Used the pdf skill". */
export function stepWords(step: RunStep, now = false): StepWords {
  const verb = VERBS()[step.kind]?.[now ? 0 : 1] ?? (now ? tr('runSteps.working') : tr('runSteps.worked'));
  if (step.kind === 'command') return { verb, path: null, rest: tr('runSteps.aCommand') };
  if (step.kind === 'skill') return { verb, path: null, rest: step.name ? tr('runSteps.theSkill', { name: step.name }) : tr('runSteps.aSkill') };
  if (step.kind === 'other') return { verb, path: null, rest: step.name ?? tr('runSteps.aTool') };
  if (step.outside) return { verb, path: null, rest: step.kind === 'search' || step.kind === 'list' ? tr('runSteps.outsideTheWorkspace') : tr('runSteps.aFileOutsideTheWorkspace') };
  if (step.path) return { verb, path: step.path, rest: '' };
  if (step.folder) return { verb: tr('runSteps.aFileIn', { verb }), path: step.folder, rest: '' };
  if (step.folder === '') return { verb, path: null, rest: tr('runSteps.aFileInTheWorkspace') };
  return { verb, path: null, rest: step.kind === 'search' ? tr('runSteps.theWorkspace') : step.kind === 'list' ? 'files' : tr('runSteps.aFile') };
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
  if (s < 3600) return tr('runSteps.minS', { floor: Math.floor(s / 60), value: s % 60 });
  return tr('runSteps.hMin', { floor: Math.floor(s / 3600), floor2: Math.floor((s % 3600) / 60) });
}
