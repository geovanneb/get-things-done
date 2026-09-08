export type TaskStatus = 'backlog' | 'ready' | 'in_progress' | 'blocked' | 'review' | 'done' | 'in_review' | 'approved' | 'archived';
export type Priority = 'critical' | 'high' | 'medium' | 'low';
export type InfluenceLevel = 'decision_maker' | 'influencer' | 'informed' | 'executor';
export type OutputFormat = 'pptx' | 'docx' | 'pdf' | 'md' | 'xlsx' | 'html';
export type ContextCategory = 'company' | 'organization' | 'strategy' | 'programs' | 'decisions' | 'risks' | 'glossary' | 'situation';
export type AgentScope = 'workspace' | 'global';
export type ValidationLevel = 'error' | 'warning' | 'info';

export interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  priority: Priority;
  due_date?: string;
  start_date?: string;
  done_date?: string;
  tags: string[];
  stakeholder_refs: string[];
  template_ref?: string;
  agent_ref?: string;
  skills: string[];
  description?: string;
  objective?: string;
  deliverables: string[];
  dependencies: string[];
  created_at: string;
  updated_at: string;
  body?: string;
  path?: string;
  // Extra frontmatter fields passed through to the frontend
  [key: string]: unknown;
}

export interface Stakeholder {
  id: string;
  name: string;
  role?: string;
  organization?: string;
  email?: string;
  tags: string[];
  influence: InfluenceLevel;
  what_matters?: string;
  notes?: string;
  avatar_initials?: string;
  created_at: string;
  updated_at: string;
  path?: string;
}

export interface OutputTemplate {
  id: string;
  slug: string;
  name: string;
  format: OutputFormat;
  description?: string;
  required_sections: string[];
  style_guide?: string;
  tags: string[];
  created_at: string;
  updated_at: string;
  path?: string;
}

export interface Deliverable {
  id: string;
  task_id: string;
  name: string;
  status: 'pending' | 'in_progress' | 'done';
  due_date?: string;
  path?: string;
}

export interface ContextNote {
  id: string;
  category: ContextCategory;
  title: string;
  slug: string;
  tags: string[];
  relevance?: string;
  created_at: string;
  updated_at: string;
  expiry_date?: string;
  body?: string;
  content?: string;
  path?: string;
}

export interface Profile {
  name: string;
  role?: string;
  organization?: string;
  responsibilities?: string;
  communication_style?: string;
  decision_making?: string;
  language_preferences?: string;
  recurring_expectations?: string;
  principles?: string;
  updated_at: string;
}

export interface ClaudeAgent {
  name: string;
  description?: string;
  scope: AgentScope;
  model?: string;
  tools?: string[];
  allowed_tools?: string[];
  disallowed_tools?: string[];
  last_modified: string;
  validation_state: 'valid' | 'invalid' | 'unknown';
  raw_content?: string;
  path?: string;
}

export interface Skill {
  name: string;
  scope: AgentScope;
  version?: string;
  description?: string;
  file_count: number;
  validation_state: 'valid' | 'invalid' | 'unknown';
  raw_content?: string;
  path?: string;
}

export interface MarketplaceSkill {
  slug: string;
  name: string;
  description: string;
  license?: string;
  installed: boolean;
}

export interface ExecutionPackage {
  id: string;
  task_id: string;
  created_at: string;
  files: {
    path: string;
    type: string;
    size: number;
    hash: string;
  }[];
  agent_ref?: string;
  skills: string[];
  permissions: string[];
  command: string;
  total_size_bytes: number;
}

export interface ValidationResult {
  level: ValidationLevel;
  rule: string;
  message: string;
  path?: string;
}

export interface WorkspaceConfig {
  path: string;
  name: string;
  git_enabled: boolean;
  schema_versions: Record<string, string>;
}

export interface GitStatus {
  branch: string;
  modified: string[];
  staged: string[];
  untracked: string[];
  ahead: number;
  behind: number;
  is_clean: boolean;
  is_repo: boolean;
}

export interface GitDiff {
  files: string[];
  diff: string;
  stats: {
    insertions: number;
    deletions: number;
    files_changed: number;
  };
}

export interface FileWatchEvent {
  type: 'change' | 'add' | 'unlink';
  path: string;
  timestamp: string;
}

export interface SearchResult {
  id: string;
  type: string;
  title: string;
  excerpt: string;
  status?: string;
  path?: string;
  relevance: number;
}

export interface AttentionItem {
  id: string;
  title: string;
  status: TaskStatus;
  priority: Priority;
  due_date?: string;
  flag_type: 'overdue' | 'blocked' | 'due_soon' | 'high_priority';
}

export interface FocusItem {
  id: string;
  title: string;
  status: TaskStatus;
  due_date?: string;
  progress_estimate?: number;
}

export interface Commitment {
  id: string;
  title: string;
  due_date: string;
  priority: Priority;
  status: TaskStatus;
}

export interface SituationData {
  overdue_count: number;
  due_soon_count: number;
  blocked_count: number;
  in_progress_count: number;
  attention_queue: {
    id: string;
    title: string;
    slug: string;
    reason: 'overdue' | 'blocked' | 'due_soon' | 'high_priority';
    due_date?: string;
    stakeholders: string[];
    priority: Priority;
  }[];
  current_focus: {
    id: string;
    title: string;
    slug: string;
    priority: Priority;
    due_date?: string;
    stakeholders: string[];
    deliverables: { format: string }[];
    progress: number;
    created_at: string;
  }[];
  upcoming_commitments: {
    id: string;
    title: string;
    slug: string;
    due_date: string;
    stakeholders: string[];
    task_type: string;
  }[];
  workflow_snapshot: {
    by_status: Record<TaskStatus, number>;
    cycle_time_data: { title: string; days: number; priority?: Priority }[];
  };
  recent_activity: { filename: string; event: string; timestamp: string }[];
}

export interface InsightsData {
  cumulative_flow: {
    date: string;
    backlog: number;
    ready: number;
    in_progress: number;
    blocked: number;
    review: number;
    done: number;
  }[];
  cycle_time: {
    title: string;
    days: number;
    priority: Priority;
  }[];
  due_date_risk: {
    overdue: number;
    due_3d: number;
    due_7d: number;
    due_14d: number;
    safe: number;
  };
  throughput: {
    week: string;
    completed: number;
  }[];
  avg_cycle_time?: number;
  throughput_this_week?: number;
  completion_rate?: number;
  tasks_at_risk?: number;
}
