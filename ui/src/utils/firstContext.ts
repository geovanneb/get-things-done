/**
 * The get-started interview of a new workspace: what it asks, which steps the executive answered and what it sends.
 * The screen is views/GetStartedView.tsx; the server keeps the draft (services/firstContext.ts).
 */
import type { ContextUpdate } from '@/types';

export interface FirstContextPerson { name: string; role: string; organization: string; relationship: string; notes: string }
export interface FirstContextOrganization { name: string; relationship: string; notes: string }

export interface FirstContextAnswers {
  work: { responsibilities: string; priorities: string; communication_style: string; language_preferences: string };
  organization: { overview: string; structure: string; strategy: string };
  people: FirstContextPerson[];
  organizations: FirstContextOrganization[];
  current: { programs: string; decisions: string; risks: string; glossary: string };
  notes: string;
}

export type FirstContextStatus = 'not_started' | 'in_progress' | 'skipped' | 'submitted';

export interface FirstContextState {
  status: FirstContextStatus;
  answers: FirstContextAnswers;
  update: ContextUpdate | null;
  suggested: boolean;
  memory_empty: boolean;
}

/** The material the server writes the interview to: not one of the executive's files. */
export const INTERVIEW_FILE = 'first-context-interview.md';

export const PERSON_RELATIONSHIPS = ['manager', 'direct-report', 'peer', 'team', 'executive', 'board', 'client', 'partner', 'other'] as const;
export const ORGANIZATION_RELATIONSHIPS = ['client', 'partner', 'supplier', 'investor', 'regulator', 'competitor', 'parent', 'other'] as const;

/** The steps in order. `intro` and `review` ask nothing. */
export const STEPS = ['intro', 'work', 'organization', 'people', 'organizations', 'current', 'files', 'review'] as const;
export type Step = (typeof STEPS)[number];
/** The steps the progress counts: everything after the intro. */
export const COUNTED_STEPS: readonly Step[] = STEPS.filter((step) => step !== 'intro');

export function emptyAnswers(): FirstContextAnswers {
  return {
    work: { responsibilities: '', priorities: '', communication_style: '', language_preferences: '' },
    organization: { overview: '', structure: '', strategy: '' },
    people: [],
    organizations: [],
    current: { programs: '', decisions: '', risks: '', glossary: '' },
    notes: '',
  };
}

export const emptyPerson = (): FirstContextPerson => ({ name: '', role: '', organization: '', relationship: '', notes: '' });
export const emptyOrganization = (): FirstContextOrganization => ({ name: '', relationship: '', notes: '' });

const filled = (...values: string[]) => values.some((value) => value.trim() !== '');

/** The executive's own files in the update, without the interview the dashboard wrote. */
export function ownFiles(update: Pick<ContextUpdate, 'materials'> | null): ContextUpdate['materials'] {
  return (update?.materials ?? []).filter((m) => m.name !== INTERVIEW_FILE);
}

/** Whether a step has anything in it, so the review can say honestly which ones were skipped. */
export function stepAnswered(step: Step, answers: FirstContextAnswers, fileCount: number): boolean {
  switch (step) {
    case 'work': return filled(...Object.values(answers.work));
    case 'organization': return filled(...Object.values(answers.organization));
    case 'people': return answers.people.some((p) => filled(p.name));
    case 'organizations': return answers.organizations.some((o) => filled(o.name));
    case 'current': return filled(...Object.values(answers.current), answers.notes);
    case 'files': return fileCount > 0;
    default: return false;
  }
}

/** There is something for the assistant to organize: an answer or a file. */
export function canSend(answers: FirstContextAnswers, fileCount: number): boolean {
  return COUNTED_STEPS.some((step) => stepAnswered(step, answers, fileCount));
}

/** A row the executive started but left without a name: the review points it out, the agent would drop it. */
export function unnamedRows(answers: FirstContextAnswers): number {
  return answers.people.filter((p) => !p.name.trim() && filled(p.role, p.organization, p.notes)).length
    + answers.organizations.filter((o) => !o.name.trim() && filled(o.notes)).length;
}

/** Rows with nothing typed in them are not worth keeping once the executive moves on. */
export function withoutEmptyRows(answers: FirstContextAnswers): FirstContextAnswers {
  return {
    ...answers,
    people: answers.people.filter((p) => filled(p.name, p.role, p.organization, p.notes)),
    organizations: answers.organizations.filter((o) => filled(o.name, o.notes)),
  };
}

/** "Step 3 of 7": the place of a step among the counted ones, 0 for the intro. */
export function stepNumber(step: Step): number {
  return COUNTED_STEPS.indexOf(step) + 1;
}

export function nextStep(step: Step): Step {
  return STEPS[Math.min(STEPS.indexOf(step) + 1, STEPS.length - 1)]!;
}

export function previousStep(step: Step): Step {
  return STEPS[Math.max(STEPS.indexOf(step) - 1, 0)]!;
}
