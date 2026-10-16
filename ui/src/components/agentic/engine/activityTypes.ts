/**
 * Mirror of the `/api/agent-activity` payload. Kept beside the engine because
 * the simulation is the only consumer.
 */

export type Pile = 'backlog' | 'active' | 'review' | 'done';

export interface ActivityDeliverable {
  id?: string;
  format?: string;
  status?: string;
  file_path?: string;
}

export interface ActivityTask {
  id: string;
  title: string;
  pile: Pile;
  status: string;
  priority: string;
  agent?: string;
  task_type?: string;
  updated_at: string;
  created_at: string;
  due_date?: string;
  context_count: number;
  stakeholder_count: number;
  deliverables: ActivityDeliverable[];
  last_execution_at?: string;
  execution_count: number;
}

export interface AgentActivitySnapshot {
  generated_at: string;
  counts: Record<Pile, number>;
  tasks: ActivityTask[];
  recent_executions: Array<{
    task_id: string;
    task_title: string;
    timestamp: string;
    summary: string;
  }>;
}
