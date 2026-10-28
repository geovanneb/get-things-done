import type { ClaudeAgent, NewTaskDraft, OutputTemplate, Stakeholder } from '@/types';

export const MEETING_BRIEF_TEMPLATE = 'meeting-brief';
export const MEETING_PREP_AGENT = 'meeting-prep';

/**
 * The New task form's starting values for preparing a meeting with `stakeholder`.
 * The output template and agent are only filled in when this workspace has them, so the task never
 * points at something that does not exist. The user adds the other attendees and dates.
 */
export function meetingPrepDraft(
  stakeholder: Stakeholder,
  templates: Pick<OutputTemplate, 'id' | 'slug' | 'format'>[],
  agents: Pick<ClaudeAgent, 'name'>[],
): NewTaskDraft {
  const template = templates.find((t) => t.slug === MEETING_BRIEF_TEMPLATE);
  return {
    title: `Prepare: meeting with ${stakeholder.name}`,
    objective: `Prepare me for the meeting with ${stakeholder.name} on [meeting date].\n\nGoal: [what I want out of the meeting]`,
    stakeholders: [stakeholder],
    deliverables: template ? [{ template_ref: template.id, format: template.format }] : [],
    preferred_agent: agents.some((a) => a.name === MEETING_PREP_AGENT) ? MEETING_PREP_AGENT : undefined,
  };
}
