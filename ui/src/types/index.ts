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

/** Feedback from Request changes on a task in review (#79); `open` until the agent that reworks the task addresses it. */
export interface ChangeRequest { id: string; requested_at: string; feedback: string; status: 'open' | 'addressed'; addressed_at?: string }

export interface Task {
  /** Written by the server and agents only; a task save never changes it. */
  change_requests?: ChangeRequest[];
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
  /** The board column the task was dropped in, when columns share a status (see utils/boardColumns.ts). */
  board_column?: string;
  /** Set when a routine created the task. */
  routine_ref?: string;
  routine_occurrence?: string;
  /** The meeting action item this task was made from (set by the dashboard). */
  meeting_action?: string;
  /** The version of the meeting record it was made from, and the original item's place (set by the dashboard). */
  meeting_action_source?: { update_id: string; record_id: string; revision: string; root_index: number };
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

/** GET /api/app/update: this version, the newest one found, and how this install updates. */
export interface AppUpdateStatus {
  current: string;
  latest: string | null;
  /** Strictly newer than `current`. */
  newer: boolean;
  kind: 'desktop' | 'npm' | 'npm-local' | 'npx' | 'source';
  channel: string;
  /** `self`: the desktop app updates itself; `command`: run `commands`; `manual`: from the release page or the source. */
  how: 'self' | 'command' | 'manual';
  commands: string[];
  release_url: string;
  notes_url: string | null;
  auto_check: boolean;
  /** The version whose notice was put off with Later. */
  dismissed: string | null;
  checked_at: string | null;
  checking: boolean;
  error: string | null;
  /** Something important running now (a recording, a transcription, an AI tool run): no notice meanwhile. */
  busy: string | null;
  /** A global npm install: whether "Update" can install the version found from here now, and if not, why. */
  can_install: boolean;
  install_blocked: string | null;
  /** An update is going now, from this or another dashboard: the dashboard restarts on its own. */
  installing: boolean;
  /** Installed on disk, newer than the version running: restart to finish. */
  installed: string | null;
  /** Why the last update from the dashboard did not finish (the version that was running started again), or what is left to do. */
  install_error: string | null;
  /** The last update from the dashboard, to this version, finished. */
  updated: string | null;
}

export interface WorkspaceConfig {
  path: string;
  name: string;
  git_enabled: boolean;
  /** False when no git program is installed. Older servers leave it out. */
  git_installed?: boolean;
  /** Set when the workspace has a picture; changes with it. Older servers leave it out. */
  icon_version?: string | null;
  /** The running app's version, from its package.json. Older servers leave it out. */
  app_version?: string;
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
/** Who a voice in a transcript may be: the agent's proposal until the user confirms the record. */
export interface MeetingSpeaker { label: string; person: MeetingPerson | null; reason: string; source: string }

export interface MeetingRecord {
  id: string;
  title: string;
  meeting_date: string;
  attendees: MeetingPerson[];
  speakers: MeetingSpeaker[];
  decisions: string[];
  open_questions: string[];
  /** `task_ref`: the task created from the item in the dashboard; `task_found` (detail only): it still exists. */
  /** `slot` (corrections only): the dashboard's id for the original item this one stands for. */
  action_items: { description: string; owner: MeetingPerson | null; due_date: string; task_ref: string | null; task_found?: boolean; slot?: string | null }[];
  source: string;
  confirmation: 'confirmed' | 'rejected' | null;
  confirmed_at: string | null;
  /** The content a confirmation is for: sent back with every choice. */
  revision: string;
  /** Why it cannot be confirmed as it is. */
  problems: string[];
  changed_since_confirmed: boolean;
  /** In a meeting digest: the queued meeting the record is about, when the analysis named it. */
  meeting?: string | null;
  /** What the analysis is not sure of: shown for the user to check before confirming. */
  unsure?: RecordDoubt[];
  /** In a correction only: the version this record corrects. */
  amends?: RecordVersion | null;
  /** In a correction only: the agent's explanation of each change. `sure: false` only suggests; the record keeps the old value. */
  corrections?: RecordChange[];
  transcript_changes?: TranscriptChange[];
}

export interface RecordVersion { update_id: string; record_id: string; revision: string }

export interface RecordChange { field: RecordDoubt['field']; before: string; after: string; reason: string; sure: boolean; /** A change marked not sure that the executive used. */ taken?: true }

/** A correction's suggestion as the review offers it: used, or why it cannot be used. */
export interface SuggestionState { index: number; used: boolean; blocked: string | null; unlinks: boolean }
/** A word change in a correction's transcript: misheard words, never speakers or times. */
export interface TranscriptChange { file: string; turn: number; before: string; after: string; reason: string; sure: boolean; /** A change marked not sure that the executive used. */ taken?: true }
/** One transcript change as the review shows it, on the version of the text the correction pinned. */
export interface TranscriptChangeView {
  index: number; file: string; turn: number; time: string | null; speaker: string | null;
  /** The pinned turn's line holding the old text, and that line changed; null when the old text is not there. */
  line_before: string | null; line_after: string | null;
  before: string; after: string; reason: string; sure: boolean; used: boolean;
  /** A change that counts: why it cannot be applied. An unused suggestion: why it cannot be used. */
  problem: string | null;
}
export interface TranscriptReview { base: string | null; problem: string | null; changes: TranscriptChangeView[]; made: { from: string; to: string } | null }

/** A field a correction changed, worked out by the server from the two records. */
export interface FieldChange { field: RecordDoubt['field']; before: string[]; after: string[] }

/** A field of a meeting record the analysis could be wrong about, the exact text, why, and what it may be instead. */
export interface RecordDoubt {
  field: 'title' | 'meeting_date' | 'attendees' | 'speakers' | 'decisions' | 'open_questions' | 'action_items';
  value: string;
  reason: string;
  suggestion: string;
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
  /** While a run started from the dashboard is going: its last steps and how many there were (#246). */
  steps?: RunStep[];
  step_count?: number;
}

/** One step of a run: the kind of tool call and the workspace path it touched, never contents. */
export interface RunStep {
  kind: 'read' | 'search' | 'list' | 'write' | 'edit' | 'command' | 'skill' | 'other';
  path: string | null;
  /** A new file being written: the workspace folder it goes in ("" for the workspace itself), not its name. */
  folder?: string;
  outside?: boolean;
  name?: string;
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
  /** Set by the dashboard: once done, only the text of its meetings is kept. */
  keep_meeting_text?: boolean;
  /** Set by the dashboard: once done, its meetings' kept text (and recordings) live in their folders under meetings/. */
  meeting_folders?: boolean;
  /** Set by the dashboard on a digest made with Keep recordings on. */
  keep_recordings?: boolean;
  /** Who opened it: 'system-cleanup' for the weekly memory review, null for an import. */
  origin: string | null;
  kind: string | null;
  /** Meeting digest only: which queued meeting each file came from. */
  digest_meetings?: DigestMeeting[];
  /** For a Kaizen: the root cause analysis. Null for every other kind. */
  kaizen?: KaizenAnalysis | null;
  /** For a meeting correction: which meeting and which version of its record it corrects. Written by the dashboard. */
  correction?: { meeting: string; root: { update_id: string; record_id: string }; base: RecordVersion } | null;
  /** For a follow-up of a correction: the correction it follows. Written by the dashboard. */
  follows?: string | null;
  /** Detail of a follow-up not done yet: why its material no longer describes the meeting's current record, or null. */
  follow_up_problem?: string | null;
  /** Detail of a correction only: the version corrected, whether it is still current, and what changed in it. */
  correction_review?: { base: MeetingRecord | null; stale: boolean; blocked: string[]; changes: FieldChange[]; doubts_dropped: RecordDoubt[]; current: boolean; suggestions: SuggestionState[]; transcript?: TranscriptReview | null; finishing?: boolean };
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

export type CleanupRuleType = 'completed_tasks' | 'archived_tasks' | 'context_updates' | 'meetings' | 'kaizen' | 'trash';
export type CleanupAction = 'archive' | 'trash' | 'delete';

export interface CleanupRule { enabled: boolean; older_than_days: number; action: CleanupAction }

export interface CleanupSettings {
  enabled: boolean;
  schedule: RoutineSchedule;
  memory_review: { enabled: boolean; stale_after_days: number };
  rules: Record<CleanupRuleType, CleanupRule>;
  keep_tag: string;
  max_items_per_run: number;
  /** Meeting transcripts and notes stay after review (true) or go (false); null until the user chose. */
  meetings: { keep_text: boolean | null };
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
  transcript_sha256?: string;
  /** Seconds of audio. */
  seconds?: number;
  accepted?: boolean;
  /** Who the speakers are, as the user named them: only for the transcript with this hash. */
  speaker_names?: { transcript_sha256: string; names: SpeakerName[] };
  /** Where each speaker speaks alone (times only): a speaker with some can have their voice remembered. */
  speaker_voices?: { transcript_sha256: string; voices: { label: string; intervals: [number, number][]; seconds: number }[] };
  /** Remembered voices the speakers sound like: hints, never names. */
  speaker_suggestions?: { transcript_sha256: string; model_sha256: string; items: SpeakerSuggestion[] };
  error?: string;
}

/** "Sounds like": a remembered voice a speaker of a transcript resembles, and how closely (0 to 1). */
export interface SpeakerSuggestion { label: string; ref: string; score: number }

/** Where speakers were confirmed: a recording in the queue, or a Transcribe again version of a kept meeting. */
export type VoiceSource =
  | { kind: 'queue'; meeting: string; file: string; transcript_sha256: string }
  | { kind: 'folder'; meeting: string; version: string; transcript_sha256: string };

/** The speakers of a Transcribe again version, as its page names them. */
export interface VersionSpeakers {
  recording: string;
  transcript: string;
  transcript_sha256: string;
  labels: { label: string; seconds: number; can_remember: boolean }[];
  names: SpeakerName[];
  suggestions: SpeakerSuggestion[];
  model_sha256: string | null;
  audio_kept: boolean;
}

/** A voice remembered on this computer, as Settings and the stakeholder pages show it (never its samples). */
export interface RememberedVoice {
  ref: string;
  name: string;
  stakeholder: boolean;
  damaged: boolean;
  stale_model: boolean;
  old_consent: boolean;
  ready: boolean;
  seconds: number;
  samples: number;
  meetings: number;
  consent: { version: number; person: string; recorded_by: string; at: string } | null;
  updated_at: string | null;
}

/** One sample of a remembered voice: where it came from, never the voice itself. */
export interface VoiceSample {
  key: string;
  meeting: string;
  /** Null for a meeting that is no longer here. */
  title: string | null;
  meeting_date: string | null;
  kind: 'queue' | 'folder';
  version: string | null;
  label: string;
  seconds: number;
  at: string;
}

/** GET /api/voiceprints/:ref */
export interface VoiceDetail {
  enabled: boolean;
  voice: RememberedVoice | null;
  samples: VoiceSample[];
  consent_text: string;
  consent_version: number;
  min_seconds: number;
}

/** GET /api/voiceprints */
export interface Voiceprints {
  enabled: boolean;
  setting: boolean;
  speaker_model: boolean;
  consent_version: number;
  consent_text: string;
  min_seconds: number;
  prints: RememberedVoice[];
  moved: { key: string; workspace: string; prints: { ref: string; name: string }[] }[];
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
  /** Every transcription model's name, by id. */
  model_names: Record<string, string>;
  /** The model chosen in Settings now; null when unknown. */
  chosen_model: string | null;
  /** The model each model really runs as here (a GPU model not verified here runs as its CPU counterpart). */
  runnable_models?: Record<string, string>;
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

export interface SpeakerName { label: string; name: string; ref?: string }

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
  speed: { realtime_x: number; load_ms: number | null; measured_at: string; backend?: string } | null;
  /** A model for the GPU engine: its CPU counterpart. */
  gpu?: { cpu: string };
  /** A GPU model: Test speed showed it runs on the GPU here, so it can be chosen. */
  gpu_ready?: boolean;
}

export interface TranscriptionSettings { model: string; language: TranscriptionLanguage; keep_recordings: boolean; live_model: string | null; live_model_source?: 'unset' | 'user' | 'automatic'; speakers: boolean; recognize_voices?: boolean; updated_at: string | null }

export interface Transcription {
  models: TranscriptionModel[];
  /** The model transcriptions run with now: the chosen one, or the CPU one of a GPU model not verified here. */
  effective_model?: string;
  /** The optional speaker model, not one of the models to transcribe with. */
  speakers: Pick<TranscriptionModel, 'id' | 'name' | 'summary' | 'size' | 'installed' | 'partial' | 'download'>;
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

/* ---- Meetings history (GET /api/meetings/…) -------------------------------- */

/** A meeting held by a context update: a digest's meeting (MQ-…) or a record of an imported update (CU-…-M-01). */
export interface HistoryMeeting {
  /** A link only when `linkable`: a record-only meeting's id can change until its update is done. */
  id: string;
  linkable: boolean;
  review_state: 'waiting' | 'provisional' | 'final';
  record_state: 'linked' | 'ambiguous' | 'none';
  update_id: string;
  origin: 'digest' | 'update';
  title: string;
  meeting_date: string;
  people: string[];
  recorded: boolean;
  update: { id: string; title: string; status: ContextUpdateStatus; created_at: string; analyzed_at: string | null; applied_at: string | null; context_changed: boolean };
  record: { id: string; revision: string; confirmation: MeetingRecord['confirmation']; confirmed_at: string | null; link: 'explicit' | 'source' | 'only' | 'saved' | null } | null;
  unlinked_records: number;
  /** Whose record is shown: the original update's, or a correction's once one counts. The files stay the original's. */
  record_owner?: { update_id: string; record_id: string } | null;
  /** The versions of the record, once a correction exists; null while there is only the original. */
  correction?: { state: 'original' | 'corrected' | 'conflict' | 'broken'; head_at: string | null; original: { update_id: string; record_id: string }; open: string[]; head_changed?: boolean } | null;
  kept: boolean;
  deleted: { at: string; by: 'user' | 'system-cleanup'; in_trash: boolean } | null;
  retention_start: string;
  has_text: boolean;
}

export interface MeetingSource {
  file: string;
  name: string;
  kind: 'transcript' | 'recording' | 'notes' | 'file';
  present: boolean;
  state: 'present' | 'unavailable' | 'missing';
  sha256: string | null;
  readable: boolean;
  /** A recording whose audio is here to play, at /api/meetings/:id/audio/:file. False when only its transcript is kept. */
  playable: boolean;
  missing: string | null;
}

/** A meeting found by what was said in it (GET /api/meetings/search). `file` is the meeting file it is in. */
export interface MeetingSearchHit {
  id: string;
  places: number;
  snippets: { file: string; time: string | null; speaker: string | null; text: string }[];
}

export interface MeetingDetail {
  meeting: HistoryMeeting;
  record: MeetingRecord | null;
  update_records: { id: string; title: string; meeting_date: string; confirmation: MeetingRecord['confirmation'] }[];
  sources: MeetingSource[];
  /** The versions of its text, when it has a folder of its own: the reviewed one (`v1`) and any made by Transcribe again. */
  versions: { id: string; at: string; made_from: 'review' | 'transcription' | 'correction'; model: string | null; correction: string | null; current: boolean; speakers?: VersionSpeakers | null }[];
  /** Transcribe again: waiting, running or failed; null when none. */
  transcription: { file: string; model: string; status: 'pending' | 'running' | 'failed'; error: string | null; started_at: string | null } | null;
  /** How far it got, when this dashboard runs it. */
  transcription_progress?: { done: number; total: number } | null;
}

/** For a task made from a meeting action item: what the record says about it now, versus when the task was made. */
export interface ActionNotice {
  state: 'none' | 'current' | 'changed' | 'conflict' | 'broken' | 'unknown' | 'ambiguous' | 'gone';
  meeting: string | null;
  changes: { property: 'description' | 'owner' | 'due_date'; before: string; after: string }[];
  current: { update_id: string; record_id: string; at: string | null } | null;
  legacy: boolean;
}

/** What a task may read of a meeting it mentions, as pinned when the task was saved (server: meetingSources.ts). */
export interface PinnedMeeting {
  id: string;
  title: string;
  meeting_date: string;
  review: 'queued' | 'waiting' | 'provisional' | 'final';
  record: { id: string; update_id: string; revision: string; confirmation: 'confirmed' | 'rejected' | null } | null;
  sources: { path: string; name: string; kind: 'transcript' | 'notes'; sha256: string }[];
  unavailable: { name: string; reason: string }[];
}

/** A task's pinned meetings, checked against what is there now. */
export interface MeetingSourcesCheck {
  selection: { id: string; at: string; meetings: PinnedMeeting[]; problems: { id: string; reason: string }[] } | null;
  unpinned: string[];
  sources: { meeting: string; path: string; state: 'ok' | 'changed' | 'missing'; current_path?: string; older_version?: true }[];
  record_changed: string[];
  review_changes: { meeting: string; change: string }[];
}
