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
  /** Set when a routine created the task. */
  routine_ref?: string;
  routine_occurrence?: string;
  /** The meeting action item this task was made from (set by the dashboard). */
  meeting_action?: string;
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

/** Starting values for the New task form, e.g. from "Prepare meeting". Everything stays editable. */
export interface NewTaskDraft {
  title?: string;
  objective?: string;
  stakeholders?: Stakeholder[];
  deliverables?: Array<{ template_ref?: string; format?: string }>;
  preferred_agent?: string;
  due_date?: string;
  /** The meeting action item this task is created from: the new task is linked back to it once saved. */
  meeting_action?: { update_id: string; record_id: string; item: number; revision: string };
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

/** What happened to a task on one calendar day. Mirrors the server type. */
export type InsightsCalendarEvent = 'created' | 'completed' | 'ran' | 'due';

/** One local day in the activity calendar. */
export interface InsightsCalendarDay {
  /** Local date, `YYYY-MM-DD`. */
  date: string;
  created: number;
  completed: number;
  runs: number;
  due: number;
  /** Due this day, still open, already late. */
  overdue: number;
  /** created + completed + runs. */
  activity: number;
  task_count: number;
  top_tasks: Array<{ id: string; title: string }>;
  top_stakeholders: Array<{ ref: string; name: string }>;
  /** 24 hourly activity counts; only for ranges of 31 days or less. */
  by_hour?: number[];
}

export interface InsightsCalendar {
  generated_at: string;
  /** The Insights filter window this covers. `null` means all time. */
  window_days: number | null;
  from: string;
  to: string;
  today: string;
  days: InsightsCalendarDay[];
}

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
    runs: number;
    /** Due this day, still open and already late. */
    overdue: boolean;
    due_date?: string;
    stakeholders: string[];
  }>;
  stakeholders: Array<{ ref: string; name: string; count: number }>;
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
  /** False when no git program is installed. Older servers leave it out. */
  git_installed?: boolean;
  recent_commits?: Array<{ hash: string; message: string; author: string; date: string }>;
}

/**
 * Set by the server on a listed file when an Office file is encrypted (e.g. by a sensitivity label) or not a valid
 * package, so agents cannot read it. Absent means not checked or nothing found, never "readable".
 */
export type OfficeCheck = 'encrypted' | 'unsupported_container';

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
  /** False when no git program is installed. Older servers leave it out. */
  git_installed?: boolean;
  /** Set when the workspace has a picture; changes with it. Older servers leave it out. */
  icon_version?: string | null;
}

/** A workspace opened on this machine before, as listed by `GET /api/workspace/recent`. */
export interface RecentWorkspace {
  path: string;
  name: string;
  current: boolean;
  available: boolean;
  last_opened: string | null;
  icon_version?: string | null;
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

// ---------------------------------------------------------------------------
// Context updates (context-updates/CU-YYYY-NNNN/update.md)
// ---------------------------------------------------------------------------

export type ContextUpdateStatus = 'ready' | 'analyzing' | 'in_review' | 'approved' | 'applying' | 'done';

export interface ContextUpdateProposal {
  id: string;
  action: 'create' | 'update' | 'remove';
  target: string;
  title: string;
  category: string;
  rationale: string;
  evidence: string;
  confidence: 'high' | 'medium' | 'low' | '';
  decision: 'accepted' | 'rejected' | null;
  reviewer_note: string;
  outcome: string;
  outcome_note: string;
  /** Detail only. */
  current?: string | null;
  proposed?: string | null;
  target_exists?: boolean;
  stale?: boolean;
  problem?: string | null;
  /** The target is a file the app installed: once changed, later app versions of it arrive as <file>.new. */
  app_provided?: boolean;
}

/** Why a Kaizen was opened. Copied by the dashboard from the agent's note in kaizen/. */
export interface KaizenAnalysis {
  note: string;
  task_ref: string;
  symptom: string;
  root_cause: string;
  area: string;
}

/** `ref` is the agent's link to a stakeholder; `ref_found` (detail only) says whether that stakeholder exists. */
export interface MeetingPerson { ref: string | null; name: string; ref_found?: boolean }

/** One meeting in the material, confirmed or rejected apart from the proposals. */
export interface MeetingRecord {
  id: string;
  title: string;
  meeting_date: string;
  attendees: MeetingPerson[];
  decisions: string[];
  open_questions: string[];
  /** `task_ref`: the task created from the item in the dashboard; `task_found` (detail only): it still exists. */
  action_items: { description: string; owner: MeetingPerson | null; due_date: string; task_ref: string | null; task_found?: boolean }[];
  source: string;
  confirmation: 'confirmed' | 'rejected' | null;
  confirmed_at: string | null;
  /** The content a confirmation is for: sent back with every choice. */
  revision: string;
  /** Why it cannot be confirmed as it is. */
  problems: string[];
  changed_since_confirmed: boolean;
}

/** The AI tool that runs workspace commands for the dashboard (GET /api/runner). */
export interface RunnerStatus {
  id: string;
  label: string;
  installed: boolean;
  logged_in: boolean | null;
  /** Whether Claude Code trusts the workspace folder; null when that could not be verified. */
  trusted: boolean | null;
  problems: { code: string; message: string }[];
}

/** A run of a workspace command (analyze or apply) started from the dashboard. */
export interface AgentRun {
  update_id: string;
  command: 'analyze' | 'apply';
  runner: string;
  status: 'running' | 'succeeded' | 'failed' | 'cancelled';
  started_at: string;
  ended_at: string | null;
  message: string;
  refused: number;
  turns: number | null;
  usage_usd: number | null;
}

export interface ContextUpdate {
  id: string;
  title: string;
  status: ContextUpdateStatus;
  source_date: string;
  created_at: string;
  updated_at: string;
  analyzed_at: string | null;
  approved_at: string | null;
  applied_at: string | null;
  summary: string;
  notes: string;
  materials: { name: string; size: number; type: string }[];
  /** Readable copies the dashboard made from WebVTT transcripts (`.transcript.md`) and Word documents (`.text.md`). */
  /** `current` (detail only): both files still match the recorded hashes. */
  transcripts: { file: string; source: string; complete: boolean; kind?: 'webvtt' | 'docx'; current?: boolean }[];
  /** Transcripts the dashboard could not make a readable copy of, with the reason. */
  transcript_problems: { source: string; reason: string }[];
  /** The user keeps materials/ after the update is done, until they release it. */
  keep_materials: boolean;
  /** Who opened it: 'system-cleanup' for the weekly memory review, null for an import. */
  origin: string | null;
  kind: string | null;
  /** Meeting digest only: which queued meeting each file came from. */
  digest_meetings?: DigestMeeting[];
  /** For a Kaizen: the root cause analysis. Null for every other kind. */
  kaizen?: KaizenAnalysis | null;
  proposals: ContextUpdateProposal[];
  meeting_records: MeetingRecord[];
  skipped: { topic: string; reason: string }[];
  unread: { name: string; reason: string }[];
  /** Detail only: the files still in materials/. */
  material_files?: { name: string; size: number; modified: string; type: string; officeCheck?: OfficeCheck }[];
}

/* ---- Routines ------------------------------------------------------------ */

export type RoutineWeekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

export interface RoutineSchedule {
  frequency: 'daily' | 'weekly' | 'monthly';
  interval: number;
  weekdays: RoutineWeekday[];
  month_day: number | null;
  month_week: number | null;
  month_weekday: RoutineWeekday | null;
  time: string;
  starts_on: string;
  ends_on: string | null;
}

export interface RoutineTaskTemplate {
  title: string;
  status: 'backlog' | 'ready';
  priority: 'critical' | 'high' | 'medium' | 'low';
  tags: string[];
  stakeholders: { ref: string; role: string; key: boolean }[];
  deliverables: { id: string; format?: string; template_ref?: string; status: 'pending' }[];
  due_offset_days: number | null;
  task_type: string;
  contexts: { ref: string; relevance?: string }[];
  preferred_agent: string | null;
  confidentiality: string | null;
  body: string;
}

export interface Routine {
  id: string;
  title: string;
  enabled: boolean;
  schedule: RoutineSchedule;
  catch_up: 'latest' | 'all' | 'skip';
  paused_until: string | null;
  task: RoutineTaskTemplate;
  created_at: string;
  updated_at: string;
  summary: string;
  next_run_at: string | null;
  state: {
    checked_at?: string;
    last_run_at?: string;
    last_status?: 'ok' | 'error';
    last_message?: string;
    last_task_id?: string;
  };
  problem?: string;
}

export interface RoutineRun {
  routine_id: string;
  routine_title: string;
  trigger: 'startup' | 'timer' | 'cli' | 'scheduler' | 'manual';
  at: string;
  status: 'ok' | 'error';
  occurrences: string[];
  skipped: string[];
  caught_up?: string[];
  created: string[];
  message: string;
  /** System cleanup: the memory review it opened. */
  context_update?: string;
  /** System cleanup: what it archived, trashed or deleted. */
  cleaned?: { type: CleanupRuleType; id: string; action: CleanupAction }[];
}

/* ---- System cleanup (the built-in routine) -------------------------------- */

export type CleanupRuleType = 'completed_tasks' | 'archived_tasks' | 'context_updates' | 'kaizen' | 'trash';
export type CleanupAction = 'archive' | 'trash' | 'delete';

export interface CleanupRule { enabled: boolean; older_than_days: number; action: CleanupAction }

export interface CleanupSettings {
  enabled: boolean;
  schedule: RoutineSchedule;
  memory_review: { enabled: boolean; stale_after_days: number };
  rules: Record<CleanupRuleType, CleanupRule>;
  keep_tag: string;
  max_items_per_run: number;
  updated_at: string | null;
}

export interface SystemCleanup {
  id: 'SYSTEM-CLEANUP';
  title: string;
  settings: CleanupSettings;
  defaults: CleanupSettings;
  summary: string;
  next_run_at: string | null;
  state: { checked_at?: string; last_run_at?: string; last_status?: 'ok' | 'error'; last_message?: string; last_context_update?: string };
  open_review: string | null;
}

export interface DigestMeeting {
  id: string;
  title: string;
  meeting_date: string;
  files: { source: string; file: string; sha256: string }[];
}

/** Where a recording's transcription stands; `partial` waits for "Use this transcript" or "Try again". */
export interface RecordingState {
  status: 'pending' | 'running' | 'done' | 'partial' | 'failed' | 'stopped';
  /** The job running it, so Stop acts only on the one the page saw. */
  generation?: string;
  /** The live transcript, readable while the chosen model transcribes it again; never a digest's input. */
  draft?: { transcript: string; transcript_sha256: string; model: string; language: string; seconds: number };
  /** The model and language it is transcribed with, fixed when the recording was finished. */
  target?: { model: string; language: string };
  /** The live transcript was chosen instead of waiting for the accurate one. */
  accepted_live?: boolean;
  started_at?: string;
  model?: string;
  language?: string;
  /** The transcript made from it, a file of the same meeting. */
  transcript?: string;
  /** Seconds of audio. */
  seconds?: number;
  accepted?: boolean;
  error?: string;
}

/** The transcription this dashboard is running; `done` and `total` are seconds of audio. */
export interface TranscriptionProgress { meeting: string; file: string; done: number; total: number; started_at: string }

/** Someone expected at a meeting: a stakeholder (`ref`) or just a name. */
export interface MeetingParticipant { name: string; ref?: string }

export interface QueuedMeeting {
  id: string;
  title: string;
  meeting_date: string;
  status: 'draft' | 'queued';
  created_at: string;
  updated_at: string;
  queued_at: string | null;
  /** `recording` is set for a recording: the meeting waits for its transcript before a digest can take it. */
  /** `capture`: set on a recording made in the dashboard, not on an upload. */
  files: { name: string; size: number; sha256: string; recording?: RecordingState; capture?: string }[];
  /** Why it waits instead of going into the next digest; queue it again to clear. */
  held: string | null;
  in_digest: boolean;
  /** A recording in progress or interrupted: finish or discard it. */
  participants?: MeetingParticipant[];
  live?: { generation: string; state: 'recording' | 'finalizing' | 'damaged'; started_at: string; saved_bytes: number; last_block_at: string | null };
}

export interface MeetingDigestSettings {
  enabled: boolean;
  schedule: RoutineSchedule;
  max_meetings: number;
  /** Readable text per digest, in characters; a meeting averages about 30,000 an hour. */
  max_characters: number;
  /** Start the analysis of each new digest with the dashboard runner. Off by default. */
  auto_analyze: boolean;
  /** Also make a digest as soon as a meeting is queued and no digest waits for review. Off by default. */
  after_each_meeting: boolean;
  updated_at: string | null;
}

export interface MeetingDigest {
  id: 'MEETING-DIGEST';
  title: string;
  settings: MeetingDigestSettings;
  defaults: MeetingDigestSettings;
  summary: string;
  next_run_at: string | null;
  state: {
    checked_at?: string; last_run_at?: string; last_status?: 'ok' | 'error'; last_message?: string; last_context_update?: string;
    analysis?: { update_id: string; status: 'started' | 'waiting' | 'not_started'; message: string; at: string };
  };
  open_digest: string | null;
  queue: QueuedMeeting[];
  transcription: TranscriptionProgress | null;
  /** Downloaded transcription models; null when unknown. */
  installed_models: string[] | null;
  /** Seconds of speech per second of work on this computer, for the tested models. */
  model_speeds: Record<string, number>;
  queue_problems: { id: string; reason: string }[];
  max_meetings_limit: number;
}

export interface CleanupItem { type: CleanupRuleType; id: string; title: string; path: string; age_days: number; action: CleanupAction }

export interface CleanupPreview {
  plan: { items: CleanupItem[]; counts: Record<CleanupRuleType, number>; deferred: number };
  memory: {
    notes: number;
    stakeholders: number;
    duplicates: { reason: string; paths: string[] }[];
    stale: { path: string; title: string; updated_at: string; age_days: number }[];
    thin: { path: string; title: string }[];
    unreadable: { path: string; reason: string }[];
  } | null;
  open_review: string | null;
}

export interface RoutinePreview {
  summary: string;
  next_runs: { at: string; due_date: string | null }[];
}

export type TranscriptionLanguage = string;

export interface SpokenLanguage { id: string; label: string; common?: boolean }

export interface TranscriptionModel {
  id: string;
  name: string;
  summary: string;
  languages: string;
  language_options?: SpokenLanguage[];
  pros: string[];
  cons: string[];
  memory_gb: number;
  size: number;
  installed: boolean;
  /** Bytes on disk from an interrupted download; the next download continues from there. */
  partial: number;
  download: { model: string; status: 'queued' | 'downloading' | 'verifying' | 'failed' | 'cancelled'; received: number; total: number; file: string; message?: string } | null;
  /** How fast it transcribed on this computer, when tested: seconds of speech per second of work. */
  speed: { realtime_x: number; load_ms: number | null; measured_at: string } | null;
}

export interface TranscriptionSettings { model: string; language: TranscriptionLanguage; keep_recordings: boolean; live_model: string | null; updated_at: string | null }

export interface Transcription {
  models: TranscriptionModel[];
  settings: TranscriptionSettings;
  defaults: TranscriptionSettings;
  vad_installed: boolean;
  vad_size: number;
  /** Another dashboard on this computer is downloading; its progress shows there. */
  downloading_elsewhere: boolean;
  models_dir: string;
  total_memory_gb: number;
  memory_hint: string | null;
}
