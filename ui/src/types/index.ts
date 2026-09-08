export interface Task {
  id: string;
  title: string;
  slug: string;
  status: 'backlog' | 'ready' | 'in_progress' | 'blocked' | 'review' | 'done' | 'in_review' | 'approved' | 'archived';
  priority: 'critical' | 'high' | 'medium' | 'low';
  task_type: string;
  created_at: string;
  updated_at: string;
  due_date?: string;
  review_date?: string;
  tags: string[];
  confidentiality: string;
  stakeholders: Array<{
    ref: string;
    role: string;
    key: boolean;
  }>;
  deliverables: Array<{
    id?: string;
    template_ref?: string;
    format?: string;
    status?: 'pending' | 'in_progress' | 'complete' | 'cancelled';
    file_path?: string;
  }>;
  contexts: string[];
  preferred_agent?: string;
  skills: string[];
  estimated_hours?: number;
  body?: string;
}

export interface Stakeholder {
  id: string;
  name: string;
  role: string;
  organization: string;
  email?: string;
  influence: 'decision_maker' | 'influencer' | 'informed' | 'executor';
  what_matters: string;
  tags: string[];
  notes?: string;
  avatar_initials?: string;
  task_count?: number;
}

export interface ContextNote {
  id: string;
  title: string;
  category: string;
  tags: string[];
  body?: string;
  relevance: string;
  created_at: string;
  updated_at: string;
  expiry_date?: string;
}

export interface OutputTemplate {
  id: string;
  slug: string;
  name: string;
  format: string;
  description: string;
  required_sections: string[];
  style_guide: string;
  tags: string[];
  updated_at?: string;
  created_at?: string;
}

export interface ClaudeAgent {
  name: string;
  description: string;
  scope: string;
  model?: string;
  tools: string[];
  last_modified: string;
  validation_state: 'valid' | 'warning' | 'error';
  raw_content?: string;
}

export interface Skill {
  name: string;
  scope: string;
  version: string;
  description: string;
  file_count: number;
  validation_state: 'valid' | 'warning' | 'error';
  raw_content?: string;
}

export interface MarketplaceSkill {
  slug: string;
  name: string;
  description: string;
  license?: string;
  installed: boolean;
}

export interface Profile {
  name: string;
  role: string;
  organization: string;
  responsibilities: string;
  communication_style: string;
  decision_making: string;
  language_preferences: string;
  recurring_expectations: string;
  principles: string;
  updated_at?: string;
}

export interface SituationData {
  overdue_count: number;
  due_soon_count: number;
  blocked_count: number;
  in_progress_count: number;
  attention_queue: Array<{
    id: string;
    title: string;
    slug: string;
    reason: 'overdue' | 'blocked' | 'due_soon';
    due_date?: string;
    stakeholders: string[];
    priority: string;
  }>;
  current_focus: Array<{
    id: string;
    title: string;
    slug: string;
    priority: string;
    due_date?: string;
    stakeholders: string[];
    deliverables: Array<{ format?: string }>;
    progress?: number;
    created_at: string;
  }>;
  upcoming_commitments: Array<{
    id: string;
    title: string;
    slug: string;
    due_date: string;
    stakeholders: string[];
    task_type: string;
  }>;
  workflow_snapshot: {
    by_status: Record<string, number>;
    cycle_time_data: Array<{ title: string; days: number; priority?: string }>;
  };
  recent_activity: Array<{
    filename: string;
    event: string;
    timestamp: string;
  }>;
}

export interface InsightsData {
  cumulative_flow: Array<{
    date: string;
    backlog: number;
    ready: number;
    in_progress: number;
    blocked: number;
    review: number;
    done: number;
  }>;
  /** Alias: cycle_time_data */
  cycle_time_data?: Array<{
    title: string;
    days: number;
    priority: string;
    completed_at: string;
  }>;
  /** Primary field used by InsightsView */
  cycle_time?: Array<{
    title: string;
    days: number;
    priority: string;
    completed_at: string;
  }>;
  due_date_risk: {
    overdue: number;
    due_3d: number;
    due_7d: number;
    due_14d: number;
    safe: number;
  };
  throughput: Array<{
    week: string;
    completed: number;
  }>;
  avg_cycle_time?: number;
  p50_cycle_time?: number;
  p90_cycle_time?: number;
  tasks_in_flight?: number;
  throughput_this_week?: number;
  completion_rate?: number;
  tasks_at_risk?: number;
}

export interface KaizenProposal {
  id: string;
  title: string;
  status: 'proposed' | 'applied' | 'rejected';
  area: string;
  root_cause: string;
  proposed_fix: string;
  files_affected: string[];
  created_at: string;
  applied_at: string | null;
  body: string;
}

export interface SearchResult {
  id: string;
  type: 'task' | 'stakeholder' | 'context' | 'output' | 'agent';
  title: string;
  excerpt: string;
  status?: string;
  path: string;
}

export interface GitStatus {
  branch: string;
  modified: string[];
  staged: string[];
  untracked: string[];
  ahead: number;
  behind: number;
  is_repo: boolean;
  recent_commits?: Array<{ hash: string; message: string; author: string; date: string }>;
}

export interface ValidationResult {
  level: 'error' | 'warning' | 'info';
  rule: string;
  message: string;
  path?: string;
}

export interface WorkspaceConfig {
  path: string;
  name: string;
  git_enabled: boolean;
}
