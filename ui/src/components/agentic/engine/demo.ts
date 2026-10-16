import { ActivityTask, AgentActivitySnapshot } from './activityTypes';

/**
 * A synthetic workspace used by the Agent Floor's Demo switch.
 *
 * It exists so the room can be understood when nothing is actually in flight —
 * an empty backlog is the normal state most of the time. Demo data is never
 * mixed with real data: the view swaps the whole snapshot and labels the stage.
 */
const DEMO_TASKS: Array<Partial<ActivityTask> & { id: string; title: string; pile: ActivityTask['pile'] }> = [
  {
    id: 'DEMO-0001',
    title: 'Quarterly business review deck',
    pile: 'active',
    status: 'in_progress',
    priority: 'critical',
    agent: 'executive-report-writer',
    context_count: 3,
    stakeholder_count: 2,
    deliverables: [{ id: 'DEL-01', format: 'pptx', status: 'pending' }],
  },
  {
    id: 'DEMO-0002',
    title: 'Vendor risk summary for the steering committee',
    pile: 'active',
    status: 'in_progress',
    priority: 'high',
    agent: 'risk-analyst',
    context_count: 2,
    stakeholder_count: 1,
    deliverables: [{ id: 'DEL-01', format: 'pdf', status: 'pending' }],
  },
  {
    id: 'DEMO-0003',
    title: 'Headcount plan revision',
    pile: 'active',
    status: 'in_progress',
    priority: 'medium',
    agent: 'workforce-planner',
    context_count: 1,
    stakeholder_count: 3,
    deliverables: [{ id: 'DEL-01', format: 'xlsx', status: 'pending' }],
  },
  {
    id: 'DEMO-0004',
    title: 'Board pre-read one-pager',
    pile: 'active',
    status: 'in_progress',
    priority: 'high',
    agent: 'executive-report-writer',
    context_count: 2,
    stakeholder_count: 2,
    deliverables: [{ id: 'DEL-01', format: 'md', status: 'pending' }],
  },
];

function fill(partial: (typeof DEMO_TASKS)[number]): ActivityTask {
  const nowIso = new Date().toISOString();
  return {
    id: partial.id,
    title: partial.title,
    pile: partial.pile,
    status: partial.status ?? 'in_progress',
    priority: partial.priority ?? 'medium',
    updated_at: nowIso,
    created_at: nowIso,
    context_count: partial.context_count ?? 0,
    stakeholder_count: partial.stakeholder_count ?? 0,
    deliverables: partial.deliverables ?? [],
    execution_count: 0,
    ...(partial.agent ? { agent: partial.agent } : {}),
  };
}

export function demoSnapshot(backlog = 9, review = 2, done = 5): AgentActivitySnapshot {
  const tasks = DEMO_TASKS.map(fill);
  return {
    generated_at: new Date().toISOString(),
    counts: { backlog, active: tasks.length, review, done },
    tasks,
    recent_executions: [],
  };
}

/** Paths the demo replays so live-event steering is visible without a real agent. */
export const DEMO_EVENT_PATHS = [
  'workspace/context/strategy/CTX-fy2026-q3-strategy.md',
  'workspace/stakeholders/people/STK-0002.md',
  'workspace/tasks/active/DEMO-0001/deliverables/DEL-01.pptx',
  'workspace/tasks/active/DEMO-0002/task.md',
  'workspace/tasks/active/DEMO-0003/executions/2026-09-10T10-00-00.md',
];
