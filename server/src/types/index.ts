export type TaskStatus = 'backlog' | 'ready' | 'in_progress' | 'blocked' | 'review' | 'done' | 'in_review' | 'approved' | 'archived';
export type Priority = 'critical' | 'high' | 'medium' | 'low';
export type InfluenceLevel = 'decision_maker' | 'influencer' | 'informed' | 'executor' | 'sponsor';
export type OutputFormat = 'pptx' | 'docx' | 'pdf' | 'md' | 'xlsx' | 'html' | 'txt';
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

export interface OrgChartMember {
  /** Stakeholder id, or a chart-local placeholder id `P-<n>` for someone who is not a stakeholder (yet). */
  ref: string;
  /** Placeholders only: who or what this is ("Head of Sales (vacant)"). */
  name?: string;
  /** Stakeholder id of this member's manager in the same chart. Absent at the top of the chart. */
  reports_to?: string;
  /** Title in this chart; overrides the stakeholder's role here (and only here). */
  title?: string;
  /** Id of the unit (department, team…) this member belongs to. Membership only: it says nothing about reporting. */
  unit?: string;
}

/** A department, team or other group inside one chart. Units nest through `parent`; people report to people, never to units. */
export interface OrgUnit {
  /** Chart-local id, `U-<n>`; stays the same when the unit is renamed or moved. */
  id: string;
  name: string;
  /** Id of the unit this one sits in; absent for a top-level unit. */
  parent?: string;
  /** Stakeholder id of the person who leads the unit; must be a member of the chart. */
  head?: string;
}

export interface OrgChart {
  id: string;
  name: string;
  organization?: string;
  description?: string;
  members: OrgChartMember[];
  /** Optional units; charts without units behave exactly as before. */
  units?: OrgUnit[];
  notes?: string;
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
    /** True when the task body explicitly @mentions this file. */
    mentioned?: boolean;
  }[];
  agent_ref?: string;
  skills: string[];
  permissions: string[];
  command: string;
  total_size_bytes: number;
  /** Office files in the package or its folders that agents cannot read: encrypted (e.g. by a sensitivity label) or not a valid package. */
  unreadable_files?: { path: string; check: 'encrypted' | 'unsupported_container' }[];
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
  /** `path` is relative to the workspace; `title` comes from frontmatter or the first heading. */
  recent_activity: { filename: string; path: string; title?: string; event: string; timestamp: string }[];
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

/** What happened to a task on one calendar day. */
export type InsightsCalendarEvent = 'created' | 'completed' | 'ran' | 'due';

/** One local calendar day in the activity calendar. */
export interface InsightsCalendarDay {
  /** Local date, `YYYY-MM-DD`. */
  date: string;
  created: number;
  completed: number;
  /** Agent runs (execution logs). */
  runs: number;
  /** Tasks due this day, finished or not. */
  due: number;
  /** Tasks due this day that are still open and already late. */
  overdue: number;
  /** created + completed + runs: the default "how busy was it" number. */
  activity: number;
  /** Distinct tasks with any event this day, due dates included. */
  task_count: number;
  /** Up to three tasks with the most events this day. */
  top_tasks: Array<{ id: string; title: string }>;
  /** Up to three stakeholders those tasks were for, most frequent first. */
  top_stakeholders: Array<{ ref: string; name: string }>;
  /** Activity per local hour (24 entries). Only sent for ranges of 31 days or less. */
  by_hour?: number[];
}

export interface InsightsCalendar {
  generated_at: string;
  /** The Insights filter window this covers. `null` means all time. */
  window_days: number | null;
  from: string;
  to: string;
  /** The server's local today, so the UI highlights the same day the counts use. */
  today: string;
  /** Every day in the range, oldest first, including empty ones. */
  days: InsightsCalendarDay[];
}

/** Everything the pinned day panel shows. */
export interface InsightsCalendarDayDetail {
  generated_at: string;
  date: string;
  totals: Pick<
    InsightsCalendarDay,
    'created' | 'completed' | 'runs' | 'due' | 'overdue' | 'activity'
  >;
  tasks: Array<{
    id: string;
    title: string;
    status: TaskStatus;
    priority: Priority;
    events: InsightsCalendarEvent[];
    /** Agent runs on this day. */
    runs: number;
    /** Due this day, still open and already late. */
    overdue: boolean;
    due_date?: string;
    /** Resolved stakeholder names. */
    stakeholders: string[];
  }>;
  stakeholders: Array<{ ref: string; name: string; count: number }>;
}
