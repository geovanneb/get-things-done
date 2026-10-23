export type TaskStatus =
  | 'backlog'
  | 'ready'
  | 'in_progress'
  | 'blocked'
  | 'review'
  | 'done'
  | 'in_review'
  | 'approved'
  | 'archived';

export type Priority = 'critical' | 'high' | 'medium' | 'low';

export interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  priority: Priority;
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
  influence: 'decision_maker' | 'influencer' | 'informed' | 'executor' | 'sponsor';
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
    path: string;
    title?: string;
    event: string;
    timestamp: string;
  }>;
}

/** One row in a ranked horizontal-bar panel. */
export interface InsightsBar {
  /** Stable key — a stakeholder id, template id, task id or bucket label. */
  key: string;
  label: string;
  /** Secondary line under the label (role, organization, format). */
  sublabel?: string;
  value: number;
  /** Where clicking the row should go, when the row maps to a page. */
  href?: string;
}

/** A task that wants the user's attention, and why. */
export interface InsightsAttentionItem {
  id: string;
  title: string;
  status: TaskStatus;
  priority: Priority;
  due_date?: string;
  /** Why this is on the list, most urgent reason first. */
  reason: 'review' | 'overdue' | 'due_soon' | 'stalled';
  /** Days since the task last moved. Drives the "waiting 3d" label. */
  waiting_days: number;
  /** Days until due; negative means overdue. Absent when there is no due date. */
  days_to_due?: number;
  /** Resolved stakeholder names, so the row reads without a second lookup. */
  stakeholders: string[];
}

export interface InsightsData {
  generated_at: string;
  /** Window the payload was computed over. `null` means all time. */
  window_days: number | null;

  summary: {
    /** Tasks parked in Needs Review, waiting on the user. */
    awaiting_review: number;
    /** Days the oldest of those has been waiting. */
    awaiting_review_oldest_days: number;
    /** Tasks finished inside the window. */
    completed: number;
    /** Tasks still open (not done, not archived). */
    open: number;
    /** Open tasks already past their due date. */
    overdue: number;
    /** Hours from task creation to completion. Median and p90, never a mean —
     *  the distribution is far too skewed for an average to mean anything. */
    median_turnaround_hours: number | null;
    p90_turnaround_hours: number | null;
    /** Share of completed tasks an agent got right in a single run. */
    first_pass_rate: number | null;
    first_pass_of: number;
    /** Share of completed tasks that met their due date. */
    on_time_rate: number | null;
    on_time_of: number;
    /** Median hours finished work waited in Needs Review before sign-off. */
    median_review_hours: number | null;
    review_of: number;
  };

  /** What is waiting on the user, most urgent first. */
  attention: InsightsAttentionItem[];

  /** Task count per stakeholder, descending. */
  by_stakeholder: InsightsBar[];
  /** Task count per output template, descending. */
  by_output: InsightsBar[];
  /** Tasks that needed more than one agent run, descending by run count. */
  rework: InsightsBar[];
  /** Kaizen entries grouped by area. */
  kaizen: InsightsBar[];

  /** Tasks created vs completed, per week, oldest first. */
  weekly: Array<{ week: string; created: number; completed: number }>;

  /** Turnaround histogram over ordered buckets. */
  turnaround_buckets: Array<{ label: string; count: number }>;
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

export interface OrgChartMember {
  /** Stakeholder id, or `P-<n>` for a chart-local placeholder. */
  ref: string;
  /** Placeholders only: who or what this is. */
  name?: string;
  /** Manager's stakeholder id within the same chart; absent at the top. */
  reports_to?: string;
  /** Title in this chart; overrides the stakeholder's role here only. */
  title?: string;
  /** Unit (department, team…) id; membership only, not reporting. */
  unit?: string;
}

/** A department or team inside one chart; units nest through `parent`. */
export interface OrgUnit {
  id: string;
  name: string;
  parent?: string;
  /** Stakeholder id of the person who leads it (a chart member). */
  head?: string;
}

export interface OrgChart {
  id: string;
  name: string;
  organization?: string;
  description?: string;
  members: OrgChartMember[];
  units?: OrgUnit[];
  notes?: string;
  created_at: string;
  updated_at: string;
}

export interface OrgPersonSummary {
  id: string;
  name: string;
  role?: string;
  /** A chart placeholder, not a stakeholder. */
  placeholder?: boolean;
}

export interface OrgPosition {
  chart: { id: string; name: string; organization?: string };
  /** Title in this chart, when one is set. */
  title?: string;
  /** Their unit, with the unit names from the top down. */
  unit?: { id: string; name: string; path: string[]; head: OrgPersonSummary | null };
  /** Units they lead. */
  head_of?: Array<{ id: string; name: string }>;
  manager: OrgPersonSummary | null;
  direct_reports: OrgPersonSummary[];
  peers: OrgPersonSummary[];
}
