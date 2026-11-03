import * as path from 'path';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import { createHash } from 'crypto';
import { WorkspaceService } from './workspace';
import { reserveIds, reservedSequence } from './idReservations';
import { parseMarkdown, stringifyMarkdown } from '../utils/markdown';
import { atomicWrite } from '../utils/atomicWrite';
import { fileInside, workspaceEntry, listFolderFiles, saveAttachment, safeFileName, topLevelName, FolderFile } from '../utils/files';
import { lock, unlock } from '../utils/fileLock';
import { correctionChain, doubtsDropped, fieldTexts, fieldValues, recordDiff, rootActionIdentity, type FieldChange } from './meetingCorrections';
import { fits, inFile, linkAt, locate, samePlace, setAt, valueAt, type ValueAt } from './meetingSuggestions';
import { moveFilesToTrash, moveToTrash, trashEntry, trashName } from './trash';
import { isAnalysisRunning } from './runState';
import { docxMarkdown, docxText, PICTURES } from '../utils/docx';
import { hashFile } from '../utils/fileHash';
import { decodeText, MAX_CONVERT_BYTES, parseWebVtt, sha256, transcriptMarkdown } from '../utils/transcript';
import { TaskService } from './taskService';
import { readManifest } from './scaffold';
import { heldMeetings, isMeetingId, meetingLinks, meetingTextToKeep, ownFiles } from './meetingLibrary';
import { folderFiles, folderOf, meetingFiles, meetingsRoot, moveMeetingText, trashFoldersOf } from './meetingFolder';
import { meetingTextKept } from './meetingTextSetting';
import type { Task } from '../types';
import { parseChange } from './transcriptChanges';
import { effectiveChanges, effectiveProblems, suggestionProblem, transcriptBase, transcriptReview, writerChange, type TranscriptReview } from './correctionTranscript';
import { readFolder } from './meetingFolder';
import { writeCorrectedVersion } from './meetingVersions';

const workspaceService = new WorkspaceService();
const taskService = new TaskService();

// Shared across service instances. Serializes this server's read-modify-write operations,
// including filename reservation; external agents/processes still need coordination.
const pendingUpdates = new Map<string, Promise<void>>();

/**
 * Context updates: raw material (transcripts, slides, images, spreadsheets) that may change the context.
 *
 *   context-updates/CU-YYYY-NNNN/
 *     update.md        record: frontmatter (status, proposals, decisions) + the user's notes as the body
 *     materials/       uploaded files, deleted when the update is done unless the user keeps them
 *     proposals/P-NN.md  the full proposed content of one target file, deleted when done
 *
 * The folder sits outside context/ on purpose: agents scan context/ for every task and must never
 * treat a raw transcript as distilled context.
 *
 * Status flow: ready -> analyzing -> in_review -> approved -> applying -> done.
 *
 * A proposal creates, updates or removes one file. Agents may not delete files, so the dashboard carries
 * out accepted removals itself: it moves the file (a context note with its whole folder) to the trash once
 * the update is done, or straight away when removals are all that was accepted.
 *
 * `meeting_records` hold what each meeting was (date, attendees, decisions, open questions, action items).
 * The analysis drafts them; the user confirms or rejects each one apart from the proposals, and a
 * confirmed record keeps the update out of the System cleanup. The materials stay unreviewed evidence.
 *
 * `origin` says who opened the update. Only the server sets it (the weekly memory review writes
 * `system-cleanup`, the meeting digest `meetings`, a Kaizen note `kaizen`); an import from the dashboard has none.
 *
 * A Kaizen (`kind: kaizen`) improves how the workspace works after a task needed rework. It carries the root cause
 * analysis as its own fields, and its proposals may also change the agent instruction files and the output
 * templates (see proposalTarget). It never removes files.
 * The agent commands (/gtd-context-analyze, /gtd-context-apply) move analyzing/in_review and applying/done;
 * the dashboard moves everything else.
 */

export const UPDATE_STATUSES = ['ready', 'analyzing', 'in_review', 'approved', 'applying', 'done'] as const;
export type UpdateStatus = (typeof UPDATE_STATUSES)[number];

const CONTEXT_CATEGORIES = ['company', 'organization', 'strategy', 'programs', 'decisions', 'risks', 'glossary', 'situation'];
const STAKEHOLDER_FOLDERS = ['people', 'groups', 'org-charts'];

const ID_PATTERN = /^CU-\d{4}-\d{4}$/;
const TASK_ID_PATTERN = /^TASK-\d{4}-\d{4}$/;

export const KAIZEN_ORIGIN = 'kaizen';
export const KAIZEN_KIND = 'kaizen';
/**
 * The agent instruction files a Kaizen may change: one per supported agent. `.claude/` stays out: agents may not
 * edit it.
 */
const KAIZEN_INSTRUCTION_FILES = ['CLAUDE.md', 'AGENTS.md', '.github/copilot-instructions.md'];
const PROPOSAL_ID_PATTERN = /^P-\d{2,3}$/;
const RECORD_ID_PATTERN = /^M-\d{2,3}$/;
/** A stakeholder id, or `me` for the workspace owner. */
const PERSON_REF_PATTERN = /^(STK-\d{4}|me)$/;
const TASK_REF_PATTERN = /^TASK-\d{4}-\d{4}$/;
const MAX_PROPOSALS = 50;
// Limits on what can be confirmed. A record over a limit is shown in full with a problem, never shortened.
const MAX_RECORDS = 20;
const MAX_RECORD_ITEMS = 30;
const MAX_RECORD_TEXT = 1000;
const MAX_NOTE = 2000;
const MAX_TEXT = 200_000;
/** Larger files are not shown as a diff; the dashboard offers to open them instead. */
const MAX_DIFF_BYTES = 512 * 1024;

export interface UpdateMaterial {
  name: string; size: number; type: string;
  /** The meetings this file belongs to, saved by the dashboard when the update is done (see meetingLinks). Never set by an agent. */
  meetings: string[];
}

/**
 * A readable copy the dashboard made from a WebVTT transcript or a Word document, recorded by the dashboard only.
 * This list, not a file's name or first line, says which file is a copy: an uploaded file can claim anything.
 */
export interface UpdateTranscript {
  /** The copy and the original it was made from, both in materials/. */
  file: string;
  source: string;
  source_sha256: string;
  /** The copy as written; a copy changed since is kept when its original is removed. */
  sha256: string;
  /**
   * The copy holds everything: every cue of a transcript, or a Word document that is plain paragraphs. When false,
   * the copy says what is missing and the original must be read too.
   */
  complete: boolean;
  /** What it was made from: `webvtt`, `docx`, or `audio` (a recording transcribed on this computer). */
  kind: 'webvtt' | 'docx' | 'audio';
  /** The source was left out on purpose (a recording not kept). It counts only with a matching entry in `digest_meetings`. */
  source_removed?: boolean;
  /**
   * Detail only: both files still have the recorded SHA-256. When false, the source or the copy was edited
   * (or is gone) after the copy was made, so the copy no longer stands for the source.
   */
  current?: boolean;
}

/** A transcript copy prepared in memory, before anything is written. */
interface PreparedTranscript { content: string; complete: boolean; kind: 'webvtt' | 'docx'; missing?: string[] }

export interface UpdateProposal {
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
}

/**
 * Someone named in a meeting record: a stakeholder (or `me`) when the agent linked one, and the name as written.
 * The link is the agent's claim; `ref_found` (detail only) says whether that stakeholder file exists.
 */
export interface MeetingPerson { ref: string | null; name: string; ref_found?: boolean }

/**
 * `task_ref` is the task the user created from this item in the dashboard, so it is not created twice. It is
 * not part of what was confirmed. `task_found` (detail only) says whether that task still exists.
 */
/**
 * `slot` is set only in a corrected record: the server-issued id of the original item this one is (see the update's
 * `correction`), never inferred from its position or text.
 */
export interface MeetingActionItem { description: string; owner: MeetingPerson | null; due_date: string; task_ref: string | null; task_found?: boolean; slot?: string | null }

/** A version of a meeting record: its update, its id there, and the content a confirmation was given for. */
export interface RecordVersion { update_id: string; record_id: string; revision: string }

/**
 * What a `meeting-correction` update corrects, written by the dashboard only: the meeting, its original record (the
 * root), the version corrected (the base, the current one when the correction was made), and one server-issued slot
 * per action item of the base, naming the root item it stands for.
 */
export interface CorrectionEnvelope {
  meeting: string;
  root: { update_id: string; record_id: string };
  base: RecordVersion;
  slots: { slot: string; root_key: string; root_index: number }[];
  /**
   * The meeting's readable files the analysis may use, pinned when the correction was made: paths from the workspace
   * root (in the original update) and their SHA-256. The agent reads only these, and only while the bytes match.
   */
  sources: { path: string; name: string; kind: 'transcript' | 'notes'; sha256: string }[];
}

/** One word change as the writer applies it to a version of the meeting's text. */
export interface TranscriptWordChange { file: string; turn: number; before: string; after: string }

/** What finishing a correction writes: its changes, on the version it pinned, for the record as it was confirmed. */
export interface CorrectionFinish { receipt: string; from_version: string; revision: string; changes: TranscriptWordChange[] }

export const CORRECTION_KIND = 'meeting-correction';
/** An ordinary update, opened from a finished correction, to find context and stakeholder notes that still use the old values. */
export const FOLLOW_UP_KIND = 'correction-follow-up';
const SLOT_ID = /^A-\d{2,3}$/;
const REVISION = /^[0-9a-f]{16}$/;
const UPDATE_ID_PATTERN = /^CU-\d{4}-\d{4}$/;

/**
 * Who a voice in a transcript may be: the agent's proposal, with why. `label` belongs to the recording `source`, not to
 * a person, and `person` stays the agent's claim until the user confirms the record. Null: unknown, and it stays unknown.
 */
export interface MeetingSpeaker { label: string; person: MeetingPerson | null; reason: string; source: string }

/**
 * What one meeting was: drafted by the analysis, confirmed or rejected by the user on its own, apart from
 * the context proposals. A confirmed record is the reviewed account of the meeting; the transcript stays
 * unreviewed material. Confirming means the user checked the record, not that every attendee agreed to it.
 */
/** A field of a record the analysis could be wrong about. */
export const DOUBT_FIELDS = ['title', 'meeting_date', 'attendees', 'speakers', 'decisions', 'open_questions', 'action_items'] as const;
/** One change a correction made, as the analysis explains it. `sure: false` keeps the old value; it only suggests. */
export interface RecordChange {
  field: typeof DOUBT_FIELDS[number]; before: string; after: string; reason: string; sure: boolean;
  /** A change marked not sure that the executive used in the dashboard. Set by the dashboard only. */
  taken?: true;
}

export interface RecordDoubt { field: typeof DOUBT_FIELDS[number]; value: string; reason: string; suggestion: string }

/**
 * A correction of a transcript's words, as the analysis explains it: in `file` (a readable copy the correction pinned),
 * turn `turn`, `before` becomes `after`. `sure: false` only suggests; `taken`: the executive used the suggestion.
 */
export interface RecordTranscriptChange { file: string; turn: number; before: string; after: string; reason: string; sure: boolean; taken?: true }

export interface MeetingRecord {
  id: string;
  title: string;
  /** YYYY-MM-DD, or empty when the material does not say. */
  meeting_date: string;
  attendees: MeetingPerson[];
  speakers: MeetingSpeaker[];
  decisions: string[];
  open_questions: string[];
  action_items: MeetingActionItem[];
  /** Where it comes from, e.g. the material file. */
  source: string;
  /** In a meeting digest: the queued meeting it is about (`queued_as` in materials/meetings.md). Null when not given. */
  meeting: string | null;
  /** In a `meeting-correction` update only: the version this record corrects. Null everywhere else. */
  amends: RecordVersion | null;
  /**
   * In a `meeting-correction` update only: the analysis's explanation of each change. What actually changed is worked
   * out by comparing with the version corrected; an explanation never stands in for that.
   */
  corrections: RecordChange[];
  /** In a `meeting-correction` update only: corrections of the transcript's words (see RecordTranscriptChange). */
  transcript_changes: RecordTranscriptChange[];
  /**
   * What the analysis is not sure of, for the user to check before confirming: a field, the exact text it is about,
   * why, and what it may be instead. Never a reason to change the record by itself.
   */
  unsure: RecordDoubt[];
  /**
   * The meeting this record is about, saved by the dashboard when the update is done: an MQ id in a digest, else
   * `CU-…-M-nn`. Never set by an agent, and not part of what the user confirms, so saving it keeps a confirmation.
   */
  meeting_id: string | null;
  /**
   * Set by the user in the dashboard, never by an agent. `confirmed` only counts while the record still has
   * the content the user confirmed (`confirmed_hash` in the file); otherwise it reads as null.
   */
  confirmation: 'confirmed' | 'rejected' | null;
  confirmed_at: string | null;
  /** Hash of the record's content. A confirmation must name it, so it applies to exactly what was shown. */
  revision: string;
  /** Why this record cannot be confirmed as it is (malformed, too long, duplicate id). Empty when fine. */
  problems: string[];
  /** It was confirmed, then its content changed: it needs a new review. */
  changed_since_confirmed: boolean;
}

export interface ContextUpdate {
  id: string;
  title: string;
  status: UpdateStatus;
  source_date: string;
  created_at: string;
  updated_at: string;
  analyzed_at: string | null;
  approved_at: string | null;
  applied_at: string | null;
  summary: string;
  notes: string;
  materials: UpdateMaterial[];
  /** Readable copies the dashboard made from transcripts in materials/. */
  transcripts: UpdateTranscript[];
  /** Transcripts in materials/ the dashboard could not make a copy of, with the reason. */
  transcript_problems: { source: string; reason: string }[];
  /** The user's choice: materials/ stays after the update is done, until they release it. Never set by an agent. */
  keep_materials: boolean;
  /**
   * Set by the dashboard when the update is approved or closed while the user keeps meeting text: once done, only the
   * text of its meetings stays in materials/ (see meetingLibrary). Never set by an agent.
   */
  keep_meeting_text: boolean;
  /**
   * Set by the dashboard with keep_meeting_text from this version on: once done, the kept text of each meeting moves to
   * its own folder under meetings/ (see meetingFolder). Absent on updates kept before, whose text stays in materials/.
   */
  meeting_folders: boolean;
  /**
   * Set by the dashboard on a digest made with Keep recordings on: its recordings and their meetings' text are kept
   * after review, in each meeting's folder (see meetingFolder). Digests before this set keep_materials instead.
   */
  keep_recordings: boolean;
  /** When the dashboard saved which meeting each record and file belongs to (see meetingLinks). Null before. */
  meetings_linked_at: string | null;
  /** Who opened this update: 'system-cleanup' for the memory review, null for an import by the user. */
  origin: string | null;
  /** What the analysis is about: 'memory-review' reviews the existing memory; 'daily-digest' is meetings from the queue. */
  kind: string | null;
  /** A `meeting-correction` only: what it corrects (see CorrectionEnvelope). Null otherwise, or when not valid. */
  correction: CorrectionEnvelope | null;
  /**
   * A correction only, while it is being finished: the new version of the meeting's text it is writing, and the receipt
   * that version carries. Written by the dashboard before the version, removed once the correction is done; while it
   * is there, approving again finishes exactly this and nothing else may change the correction. Null otherwise.
   */
  finishing: CorrectionFinish | null;
  /** Whether a finish is under way at all, also when what it keeps cannot be read (then `finishing` is null). */
  finish_pending: boolean;
  /** A finished correction that changed transcript words: the version of the meeting's text it made. Dashboard only. */
  transcript_version: { from: string; to: string; changes: TranscriptWordChange[] } | null;
  /** A `correction-follow-up` only: the correction it follows up. Written by the dashboard; null otherwise. */
  follows: string | null;
  /** For a meeting digest: which queued meeting each file came from. Written by the dashboard only; kept after the materials go. */
  digest_meetings: DigestMeeting[];
  /** For a Kaizen: the root cause analysis. Null for every other kind. */
  kaizen: KaizenAnalysis | null;
  proposals: UpdateProposal[];
  meeting_records: MeetingRecord[];
  skipped: { topic: string; reason: string }[];
  unread: { name: string; reason: string }[];
  /** Meetings (queue id or record id) the user keeps: System cleanup never removes their text. Dashboard only. */
  kept_meetings: string[];
  /** Meetings whose text the user or System cleanup deleted: in the trash until restored or deleted for good. Dashboard only. */
  deleted_meetings: DeletedMeeting[];
}

/** A meeting's text moved out of an update: `trash` is the trash entry holding `files`, null once deleted for good. */
/** `folder`: its whole folder under meetings/ went to the trash (text and recordings), not files of the update. */
export interface DeletedMeeting { meeting: string; at: string; files: string[]; trash: string | null; by: 'user' | 'system-cleanup'; folder?: true }

/** One meeting a digest was made from, as it was queued, and the files it brought. */
export interface DigestMeeting {
  id: string;
  title: string;
  meeting_date: string;
  files: { source: string; file: string; sha256: string }[];
  /** Which transcript came from which recording, also for a recording that is not in the digest. */
  recordings?: DigestRecording[];
}

export interface DigestRecording {
  /** The recording's name in the queue, and its hash. */
  source: string;
  source_sha256: string;
  /** Its transcript in this digest's materials, and that file's hash. */
  transcript: string;
  transcript_sha256: string;
  complete: boolean;
  /** The recording's name in the materials; null when it was not kept. */
  file: string | null;
  /** Who its speakers are, as the user named them after the meeting. */
  speaker_names?: { label: string; name: string; ref?: string }[];
}

/**
 * Why a Kaizen was opened: the task whose rework showed the problem, what went wrong there, and the root cause in
 * the instructions. Copied by the dashboard from the agent's note in kaizen/, which stays as material.
 */
export interface KaizenAnalysis {
  /** The kaizen/ file it came from. */
  note: string;
  /** The task whose feedback triggered it; empty when the note did not name a valid one. */
  task_ref: string;
  /** What went wrong in the task, as the executive saw it. */
  symptom: string;
  /** What instruction or signal was missing: the cause, not the symptom. */
  root_cause: string;
  /** Optional grouping, e.g. instructions, templates. */
  area: string;
}

export interface ProposalDetail extends UpdateProposal {
  /** Current content of the target, or null when it does not exist. */
  current: string | null;
  /** Content the agent proposes, or null when the draft is missing or too large. */
  proposed: string | null;
  target_exists: boolean;
  /** The target changed (or was created) after the analysis, so the diff is against newer content. */
  stale: boolean;
  /** Why this proposal cannot be shown or applied (bad target path, missing draft). */
  problem: string | null;
  /**
   * The target is a file the app installed. Once changed it is the user's: `gtd upgrade` then writes later app
   * versions of it next to it as <file>.new instead of replacing it.
   */
  app_provided: boolean;
}

/** A suggestion of a correction (a change marked not sure) as the review offers it: used, or why it cannot be used. */
export interface SuggestionState { index: number; used: boolean; blocked: string | null; unlinks: boolean }

export interface ContextUpdateDetail extends ContextUpdate {
  proposals: ProposalDetail[];
  material_files: FolderFile[];
  /**
   * A `meeting-correction` only: the version it corrects (null when that is gone or changed), whether that is still the
   * meeting's current record (`stale` when another correction finished first), why approving would be refused now
   * (`blocked`, empty once done), and what the record changes in it.
   */
  correction_review?: { base: MeetingRecord | null; stale: boolean; blocked: string[]; changes: FieldChange[]; doubts_dropped: RecordDoubt[]; current: boolean; suggestions: SuggestionState[]; transcript: TranscriptReview | null; finishing: boolean };
  /** A `correction-follow-up` only, while not done: why its material no longer describes the current record (null when it does). */
  follow_up_problem?: string | null;
}

function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode: status });
}

const VERSION_ID = /^v\d{1,4}$/;

function wordChanges(value: unknown): TranscriptWordChange[] | null {
  if (!Array.isArray(value) || !value.length) return null;
  const out: TranscriptWordChange[] = [];
  for (const raw of value) {
    const c = parseChange(raw);
    if (typeof c === 'string') return null;
    out.push(c);
  }
  return out;
}

/** A correction's finish under way, as the dashboard wrote it; null when absent or not whole. */
function normalizeFinish(value: unknown): CorrectionFinish | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;
  const changes = wordChanges(o['changes']);
  if (typeof o['receipt'] !== 'string' || !/^[0-9a-f]{64}$/.test(o['receipt'])) return null;
  if (typeof o['from_version'] !== 'string' || !VERSION_ID.test(o['from_version'])) return null;
  if (typeof o['revision'] !== 'string' || !REVISION.test(o['revision']) || !changes) return null;
  return { receipt: o['receipt'], from_version: o['from_version'], revision: o['revision'], changes };
}

function normalizeTranscriptVersion(value: unknown): ContextUpdate['transcript_version'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;
  const changes = wordChanges(o['changes']);
  if (typeof o['from'] !== 'string' || !VERSION_ID.test(o['from']) || typeof o['to'] !== 'string' || !VERSION_ID.test(o['to']) || !changes) return null;
  return { from: o['from'], to: o['to'], changes };
}

/** What a correction's finish is bound to: the correction, the record confirmed, the version it corrects and the changes, in order. */
export function finishReceipt(id: string, revision: string, fromVersion: string, changes: TranscriptWordChange[]): string {
  return createHash('sha256').update(JSON.stringify([id, revision, fromVersion, changes.map((c) => [c.file, c.turn, c.before, c.after])])).digest('hex');
}

/** YAML turns unquoted dates into Date objects; everything shown in the dashboard is a string. */
function str(value: unknown, dateOnly = false): string {
  if (value instanceof Date) return dateOnly ? value.toISOString().slice(0, 10) : value.toISOString();
  if (value === null || value === undefined) return '';
  return String(value);
}

function nullableStr(value: unknown): string | null {
  const s = str(value);
  return s ? s : null;
}

function isDateOnly(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** An update id from a request. Strict, because it becomes a folder name. */
export function updateId(value: unknown): string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) throw httpError(400, 'Invalid context update id');
  return topLevelName(value);
}

/**
 * A proposal target from the agent's frontmatter, as a workspace-relative POSIX path. Only Markdown files
 * under context/<category>/ and stakeholders/{people,groups,org-charts}/ can be proposed. A Kaizen may also
 * change the agent instruction files (CLAUDE.md, AGENTS.md, .github/copilot-instructions.md) and the output
 * templates under outputs/templates/.
 * Returns null when the path is outside those folders or is not a plain relative path.
 */
export function proposalTarget(value: unknown, kind: string | null = null): string | null {
  if (typeof value !== 'string' || !value || value.length > 300) return null;
  if (kind === KAIZEN_KIND && KAIZEN_INSTRUCTION_FILES.includes(value)) return value;
  if (value.includes('\\') || value.includes('\0') || value.startsWith('/') || !value.endsWith('.md')) return null;
  const parts = value.split('/');
  if (parts.some((p) => !p || p === '.' || p === '..' || p.startsWith('.') || p.includes(':'))) return null;
  if (parts[0] === 'context') return parts.length >= 3 && CONTEXT_CATEGORIES.includes(parts[1]!) ? value : null;
  if (parts[0] === 'stakeholders') return parts.length >= 3 && STAKEHOLDER_FOLDERS.includes(parts[1]!) ? value : null;
  if (kind !== KAIZEN_KIND) return null;
  return parts[0] === 'outputs' && parts[1] === 'templates' && parts.length >= 4 ? value : null;
}

/** The root cause fields of a Kaizen update, or null for any other kind. */
function normalizeKaizen(data: Record<string, unknown>): KaizenAnalysis | null {
  if (data['kind'] !== KAIZEN_KIND) return null;
  const task = str(data['task_ref']);
  return {
    note: str(data['kaizen_note']),
    task_ref: TASK_ID_PATTERN.test(task) ? task : '',
    symptom: str(data['symptom']),
    root_cause: str(data['root_cause']),
    area: str(data['area']),
  };
}

function normalizeProposal(raw: unknown, index: number): UpdateProposal {
  const p = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const decision = p['decision'] === 'accepted' || p['decision'] === 'rejected' ? p['decision'] : null;
  const confidence = ['high', 'medium', 'low'].includes(str(p['confidence'])) ? str(p['confidence']) as UpdateProposal['confidence'] : '';
  return {
    id: str(p['id']) || `P-${String(index + 1).padStart(2, '0')}`,
    action: p['action'] === 'create' ? 'create' : p['action'] === 'remove' ? 'remove' : 'update',
    target: str(p['target']),
    title: str(p['title']),
    category: str(p['category']),
    rationale: str(p['rationale']),
    evidence: str(p['evidence']),
    confidence,
    decision,
    reviewer_note: str(p['reviewer_note']),
    outcome: str(p['outcome']),
    outcome_note: str(p['outcome_note']),
  };
}

function normalizePairs<K extends string, V extends string>(raw: unknown, k: K, v: V): Record<K | V, string>[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    const o = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    return { [k]: str(o[k]), [v]: str(o[v]) } as Record<K | V, string>;
  });
}

/** A text field of a record. Non-text values and over-long text are reported, never converted or cut. */
function recordText(value: unknown, what: string, problems: string[]): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') { problems.push(`${what} is not text`); return ''; }
  if (value.length > MAX_RECORD_TEXT) problems.push(`${what} is longer than ${MAX_RECORD_TEXT} characters`);
  return value.trim();
}

function recordList(raw: unknown, what: string, problems: string[]): unknown[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) { problems.push(`${what} is not a list`); return []; }
  if (raw.length > MAX_RECORD_ITEMS) problems.push(`${what} has more than ${MAX_RECORD_ITEMS} entries`);
  return raw;
}

function recordDate(value: unknown, what: string, problems: string[]): string {
  if (value === undefined || value === null || value === '') return '';
  const date = str(value, true);
  if (!isDateOnly(date)) { problems.push(`${what} is not a date (YYYY-MM-DD)`); return ''; }
  return date;
}

/** A person from the agent's file: an object with `ref` and `name`, or just a name. Empty entries are left out. */
function recordPerson(raw: unknown, what: string, problems: string[]): MeetingPerson | null {
  if (typeof raw === 'string') return raw.trim() ? { ref: null, name: recordText(raw, what, problems) } : null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { problems.push(`${what} is not a person`); return null; }
  const o = raw as Record<string, unknown>;
  const name = recordText(o['name'], `${what} name`, problems);
  let ref: string | null = null;
  if (o['ref'] !== undefined && o['ref'] !== null && o['ref'] !== '') {
    if (typeof o['ref'] === 'string' && PERSON_REF_PATTERN.test(o['ref'].trim())) ref = o['ref'].trim();
    else problems.push(`${what} has a ref that is not a stakeholder id or "me"`);
  }
  return ref || name ? { ref, name } : null;
}

/**
 * The action items a record shows, each with its position in the file. Entries with nothing in them are
 * left out; the position lets the dashboard write a task link to the right entry.
 */
function shownActionItems(list: unknown[], problems: string[]): { item: MeetingActionItem; index: number }[] {
  return list.map((entry, i) => {
    const a = (entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : null) as Record<string, unknown> | null;
    const item: MeetingActionItem = !a
      ? { description: recordText(entry, `action item ${i + 1}`, problems), owner: null, due_date: '', task_ref: null }
      : {
        description: recordText(a['description'], `action item ${i + 1}`, problems),
        owner: a['owner'] == null ? null : recordPerson(a['owner'], `action item ${i + 1} owner`, problems),
        due_date: recordDate(a['due_date'], `action item ${i + 1} due_date`, problems),
        task_ref: typeof a['task_ref'] === 'string' && TASK_REF_PATTERN.test(a['task_ref']) ? a['task_ref'] : null,
        ...(a['slot'] != null ? { slot: typeof a['slot'] === 'string' && SLOT_ID.test(a['slot']) ? a['slot'] : (problems.push(`action item ${i + 1} has a slot that is not like A-01`), null) } : {}),
      };
    return { item, index: i };
  }).filter((x) => x.item.description || x.item.owner || x.item.due_date);
}

/** A record version as written, or null when any part of it is not valid. */
function recordVersion(raw: unknown): RecordVersion | null {
  const o = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null) as Record<string, unknown> | null;
  if (!o) return null;
  const { update_id, record_id, revision } = o;
  return typeof update_id === 'string' && UPDATE_ID_PATTERN.test(update_id) && typeof record_id === 'string' && RECORD_ID_PATTERN.test(record_id)
    && typeof revision === 'string' && REVISION.test(revision) ? { update_id, record_id, revision } : null;
}

/** A `meeting-correction` update's envelope, or null when it is missing or any part of it is not valid. */
function normalizeCorrection(raw: unknown): CorrectionEnvelope | null {
  const o = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null) as Record<string, unknown> | null;
  if (!o || typeof o['meeting'] !== 'string' || !/^(MQ-\d{4}-\d{4}|CU-\d{4}-\d{4}-M-\d{2,3})$/.test(o['meeting'])) return null;
  const root = (o['root'] && typeof o['root'] === 'object' ? o['root'] : {}) as Record<string, unknown>;
  if (typeof root['update_id'] !== 'string' || !UPDATE_ID_PATTERN.test(root['update_id']) || typeof root['record_id'] !== 'string' || !RECORD_ID_PATTERN.test(root['record_id'])) return null;
  const base = recordVersion(o['base']);
  if (!base || !Array.isArray(o['slots']) || o['slots'].length > 30) return null;
  const slots: CorrectionEnvelope['slots'] = [];
  for (const entry of o['slots'] as unknown[]) {
    const x = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
    if (typeof x['slot'] !== 'string' || !SLOT_ID.test(x['slot']) || typeof x['root_key'] !== 'string' || !/^[0-9a-f]{12}$/.test(x['root_key'])
      || typeof x['root_index'] !== 'number' || !Number.isInteger(x['root_index']) || x['root_index'] < 0) return null;
    if (slots.some((y) => y.slot === x['slot'])) return null;
    slots.push({ slot: x['slot'], root_key: x['root_key'], root_index: x['root_index'] });
  }
  const sources: CorrectionEnvelope['sources'] = [];
  for (const entry of Array.isArray(o['sources']) ? (o['sources'] as unknown[]).slice(0, 50) : []) {
    const x = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
    const p = x['path'];
    // A path from the workspace root, POSIX, inside context-updates/ or meetings/: never anything else.
    if (typeof p !== 'string' || !/^(context-updates|meetings)\/[^\\]+$/.test(p) || p.split('/').some((part) => part === '' || part === '.' || part === '..')
      || [...p].some((c) => c.charCodeAt(0) < 0x20 || c === '`')) return null;
    // Only the meeting's own files: in the original update's materials, or a version of the meeting's own folder once
    // its text moved there. Never another update's material, nor another meeting's folder.
    const inUpdate = p.startsWith(`context-updates/${root['update_id'] as string}/materials/`);
    const inFolder = new RegExp(`^meetings/${o['meeting']}/v\\d{1,4}/[^/]+$`).test(p);
    if (!inUpdate && !inFolder) return null;
    if (typeof x['name'] !== 'string' || (x['kind'] !== 'transcript' && x['kind'] !== 'notes') || typeof x['sha256'] !== 'string' || !/^[0-9a-f]{64}$/.test(x['sha256'])) return null;
    sources.push({ path: p, name: x['name'], kind: x['kind'], sha256: x['sha256'] });
  }
  return { meeting: o['meeting'], root: { update_id: root['update_id'], record_id: root['record_id'] }, base, slots, sources };
}

/**
 * A correction update holds exactly one record, the corrected one: it says it amends the envelope's base, keeps the
 * base's id, and has one action item per slot, in the slots' order. Anything else is a problem on its records, so
 * none can be confirmed. A record outside a correction never says it amends anything.
 */
/**
 * Why a follow-up's material no longer describes the meeting's current record: the correction it follows is gone, not
 * finished, or no longer the head of an intact chain (a newer correction finished, or the versions do not hold). Null
 * while it is current.
 */
export function followUpProblem(update: Pick<ContextUpdate, 'follows'>, all: ContextUpdate[]): string | null {
  const correction = update.follows ? all.find((u) => u.id === update.follows) : null;
  if (!correction?.correction || correction.status !== 'done') return `The correction this follows up (${update.follows ?? 'none'}) is no longer there. Close or delete this follow-up`;
  const chain = correctionChain(correction.correction.meeting, correction.correction.root, all);
  if (chain.state !== 'corrected' || chain.head?.update_id !== correction.id) {
    return `${correction.id} is no longer the meeting's current version${chain.state === 'conflict' || chain.state === 'broken' ? ` (its versions are ${chain.state})` : ''}, so this follow-up may spread an outdated value. Close or delete it, and follow up the current correction`;
  }
  return null;
}

/**
 * Where a suggestion points: its old value's one place in the version corrected, or null when that value is not there
 * exactly once. Fixed for the life of the correction, so using, taking back and checking a suggestion all mean the same
 * entry, whatever order suggestions are used in.
 */
export function suggestionPlace(base: MeetingRecord, c: RecordChange): ValueAt | null {
  const at = locate(base as unknown as Record<string, unknown>, c.field, c.before);
  return at.length === 1 ? at[0]! : null;
}

/**
 * Why a correction's suggestion (a change marked not sure, at `index`) cannot be used now, or taken back when it is
 * used; null when it can. It needs a correction that is still current, its old value once in the version corrected,
 * that place still holding the old value (or, to take it back, the new one), no other choice in use for it, and a new
 * value that fits there.
 */
export function suggestionBlock(record: MeetingRecord, base: MeetingRecord | null, stale: boolean, index: number): string | null {
  const c = record.corrections[index];
  if (!c || c.sure) return 'Only a change marked not sure can be used';
  if (stale || !base) return 'This correction is no longer current: close it, and start again from the meeting';
  const place = suggestionPlace(base, c);
  if (!place) {
    return locate(base as unknown as Record<string, unknown>, c.field, c.before).length
      ? 'This value appears more than once in the record, so it is not clear which one is meant. Analyze again with a note'
      : 'This value is not in the version corrected';
  }
  const now = valueAt(record as unknown as Record<string, unknown>, place);
  if (c.taken) return now === c.after ? null : 'This value changed again after you used it, so it cannot be taken back here. Analyze again';
  if (!c.after || c.after === c.before) return 'This suggestion has no new value to use';
  if (record.corrections.some((o, i) => i !== index && !o.sure && o.taken && o.field === c.field && (() => { const p = suggestionPlace(base, o); return p !== null && samePlace(p, place); })())) {
    return 'Another choice for this value is used';
  }
  if (now !== c.before) return 'This value is no longer what the version corrected said';
  if (!fits(place, c.after)) return place.field === 'meeting_date' || place.prop === 'due_date' ? 'The suggested value is not a date (YYYY-MM-DD)' : 'This suggestion has no new value to use';
  return null;
}

/**
 * The pins of a correction that are not its meeting's own files, as its original update holds them: in the update's
 * materials, or in the meeting's own folder once its text moved there.
 */
async function foreignPins(env: CorrectionEnvelope, all: ContextUpdate[]): Promise<string[]> {
  const root = all.find((u) => u.id === env.root.update_id);
  const meeting = root ? heldMeetings(root).find((m) => m.id === env.meeting) : undefined;
  const own = new Set<string>();
  if (root && meeting) {
    const where = await meetingFiles(workspaceService.getWorkspacePath(), root, meeting, new Set());
    for (const f of meeting.files) own.add(`context-updates/${root.id}/materials/${f}`).add(where.relative(f));
  }
  return env.sources.map((s) => s.path).filter((p) => !own.has(p));
}

function checkCorrectionRecords(update: Pick<ContextUpdate, 'kind' | 'correction' | 'meeting_records'>): void {
  const flag = (r: MeetingRecord, problem: string) => {
    r.problems.push(problem);
    if (r.confirmation === 'confirmed') { r.confirmation = null; r.confirmed_at = null; r.changed_since_confirmed = true; }
  };
  if (update.kind === FOLLOW_UP_KIND) {
    // A follow-up looks for the old values in the context; a meeting's record is never its business.
    for (const r of update.meeting_records) flag(r, 'a follow-up of a correction holds no meeting records');
    return;
  }
  if (update.kind !== CORRECTION_KIND) {
    for (const r of update.meeting_records) if (r.amends || r.corrections.length || r.transcript_changes.length || r.action_items.some((a) => a.slot != null)) flag(r, 'only a correction says what a record amends');
    return;
  }
  const env = update.correction;
  for (const r of update.meeting_records) {
    if (!env) { flag(r, 'the correction does not say what it corrects'); continue; }
    if (update.meeting_records.length !== 1) flag(r, 'a correction holds exactly one record');
    const a = r.amends;
    if (!a || a.update_id !== env.base.update_id || a.record_id !== env.base.record_id || a.revision !== env.base.revision) flag(r, 'the record does not amend the version this correction is for');
    if (r.id !== env.base.record_id) flag(r, `a corrected record keeps the id ${env.base.record_id}`);
    const slots = r.action_items.map((x) => x.slot ?? null);
    if (slots.length !== env.slots.length || slots.some((sl, i) => sl !== env.slots[i]!.slot)) flag(r, 'the action items are not the original ones, one each, in order');
  }
}

/** The content a confirmation is bound to, in a fixed order. */
function recordRevision(r: Omit<MeetingRecord, 'confirmation' | 'confirmed_at' | 'revision' | 'problems' | 'changed_since_confirmed'>, binding?: string): string {
  const content = [r.id, r.title, r.meeting_date, r.attendees.map((p) => [p.ref, p.name]), r.decisions, r.open_questions,
    r.action_items.map((a) => [a.description, a.owner ? [a.owner.ref, a.owner.name] : null, a.due_date]), r.source,
    // Only when given: records confirmed before meetings were named stay confirmed.
    ...(r.meeting ? [['meeting', r.meeting]] : []),
    // Only when there are any: a record confirmed before speakers existed stays confirmed.
    ...(r.speakers.length ? [r.speakers.map((s) => [s.label, s.source, s.person ? [s.person.ref, s.person.name] : null, s.reason])] : []),
    // The same for doubts: confirming covers what the user was told the analysis was not sure of.
    ...(r.unsure.length ? [['unsure', r.unsure.map((d) => [d.field, d.value, d.reason, d.suggestion])]] : []),
    // A correction's link to what it corrects, and which original item each action is: part of what is confirmed, so
    // neither can change unnoticed afterwards. Absent from every other record, whose versions stay as they were.
    ...(r.amends ? [['amends', r.amends.update_id, r.amends.record_id, r.amends.revision]] : []),
    ...(r.action_items.some((a) => a.slot != null) ? [['slots', r.action_items.map((a) => a.slot ?? null)]] : []),
    // A correction's explanations, as the user read them when confirming.
    ...(r.corrections.length ? [['corrections', r.corrections.map((c) => [c.field, c.before, c.after, c.reason, c.sure])]] : []),
    // Corrections of the transcript's words, and which the executive used: only when there are any.
    ...(r.transcript_changes.length ? [['transcript_changes', r.transcript_changes.map((c) => [c.file, c.turn, c.before, c.after, c.reason, c.sure, c.taken === true])]] : []),
    // Which suggestions the executive used: only when any is, so records confirmed before this keep their versions.
    ...(r.corrections.some((c) => c.taken) ? [['taken', r.corrections.flatMap((c, i) => (c.taken ? [i] : []))]] : []),
    // In a correction, what the dashboard wrote about it (meeting, original, version corrected, which original item each
    // slot is): an edit to it after confirming takes the confirmation away too.
    ...(binding ? [['correction', binding]] : [])];
  return createHash('sha256').update(JSON.stringify(content)).digest('hex').slice(0, 16);
}

/** What the analysis is not sure of. A doubt that cannot be shown faithfully is a problem, like any other field. */
/** A correction's explanations of its changes. One that cannot be shown faithfully is a problem. */
function recordChanges(raw: unknown[], problems: string[]): RecordChange[] {
  return raw.map((entry, i) => {
    const what = `correction ${i + 1}`;
    const o = (entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : {}) as Record<string, unknown>;
    if (o !== entry) problems.push(`${what} is not an object`);
    const field = typeof o['field'] === 'string' && (DOUBT_FIELDS as readonly string[]).includes(o['field']) ? o['field'] as RecordChange['field'] : null;
    if (!field) problems.push(`${what} names no field of the record (${DOUBT_FIELDS.join(', ')})`);
    const before = o['before'] == null ? '' : recordText(o['before'], `${what} before`, problems);
    const after = o['after'] == null ? '' : recordText(o['after'], `${what} after`, problems);
    const reason = recordText(o['reason'], `${what} reason`, problems);
    if (!reason) problems.push(`${what} does not say why`);
    if (typeof o['sure'] !== 'boolean') problems.push(`${what} does not say whether it is sure (true or false)`);
    // Used by the executive: only ever on a change marked not sure, and only ever `true`.
    if (o['taken'] !== undefined && o['taken'] !== true) problems.push(`${what} says it was used in a way the dashboard never writes`);
    if (o['taken'] === true && o['sure'] === true) problems.push(`${what} is marked sure and used at once`);
    return { field: field ?? 'title', before, after, reason, sure: o['sure'] === true, ...(o['taken'] === true ? { taken: true as const } : {}) };
  });
}

/**
 * A correction's changes to the transcript's words. The words are kept exactly as written (never trimmed): `before`
 * must match the transcript. Part 1's own check of a change (`parseChange`) decides what a change may be.
 */
function recordTranscriptChanges(raw: unknown[], problems: string[]): RecordTranscriptChange[] {
  return raw.map((entry, i) => {
    const what = `transcript change ${i + 1}`;
    const o = (entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : {}) as Record<string, unknown>;
    const change = parseChange(o);
    if (typeof change === 'string') problems.push(`${what}: ${change}`);
    const reason = recordText(o['reason'], `${what} reason`, problems);
    if (!reason) problems.push(`${what} does not say why`);
    if (typeof o['sure'] !== 'boolean') problems.push(`${what} does not say whether it is sure (true or false)`);
    if (o['taken'] !== undefined && o['taken'] !== true) problems.push(`${what} says it was used in a way the dashboard never writes`);
    if (o['taken'] === true && o['sure'] === true) problems.push(`${what} is marked sure and used at once`);
    const ok = typeof change === 'string' ? { file: '', turn: 0, before: '', after: '' } : change;
    return { ...ok, reason, sure: o['sure'] === true, ...(o['taken'] === true ? { taken: true as const } : {}) };
  });
}

function recordDoubts(raw: unknown[], problems: string[]): RecordDoubt[] {
  return raw.map((entry, i) => {
    const what = `doubt ${i + 1}`;
    const o = (entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : {}) as Record<string, unknown>;
    if (o !== entry) problems.push(`${what} is not an object`);
    const field = typeof o['field'] === 'string' && (DOUBT_FIELDS as readonly string[]).includes(o['field']) ? o['field'] as RecordDoubt['field'] : null;
    if (!field) problems.push(`${what} names no field of the record (${DOUBT_FIELDS.join(', ')})`);
    const value = recordText(o['value'], `${what} value`, problems);
    if (!value) problems.push(`${what} does not say which text it is about`);
    const reason = recordText(o['reason'], `${what} reason`, problems);
    if (!reason) problems.push(`${what} does not say why`);
    const suggestion = o['suggestion'] == null ? '' : recordText(o['suggestion'], `${what} suggestion`, problems);
    return { field: field ?? 'title', value, reason, suggestion };
  });
}

/** The speakers of a record. A label is `Speaker 2` and is there once per recording; anything else cannot be confirmed. */
function recordSpeakers(raw: unknown[], problems: string[]): MeetingSpeaker[] {
  const seen = new Set<string>();
  return raw.map((entry, i) => {
    const what = `speaker ${i + 1}`;
    const o = (entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : {}) as Record<string, unknown>;
    const label = recordText(o['label'], `${what} label`, problems);
    const source = recordText(o['source'], `${what} source`, problems);
    if (!/^Speaker \d{1,3}$/.test(label)) problems.push(`${what} has no label like Speaker 2`);
    if (!source) problems.push(`${what} does not say which transcript it is from`);
    if (seen.has(`${source}/${label}`)) problems.push(`${label} is listed twice for ${source || 'one recording'}`);
    seen.add(`${source}/${label}`);
    return { label, source, person: o['person'] == null ? null : recordPerson(o['person'], `${what} person`, problems), reason: recordText(o['reason'], `${what} reason`, problems) };
  });
}

/**
 * Reads the agent's records without changing what they say: nothing is shortened, renamed or invented. What
 * cannot be shown faithfully, or has no unique id, gets a problem and cannot be confirmed until it is fixed.
 */
/** A correction's envelope as the confirmation of its record covers it. */
function correctionBinding(env: CorrectionEnvelope): string {
  return JSON.stringify([env.meeting, env.root.update_id, env.root.record_id, env.base.update_id, env.base.record_id, env.base.revision,
    env.slots.map((x) => [x.slot, x.root_key, x.root_index]),
    // Only when there are any: corrections written before sources were pinned keep their versions.
    ...(env.sources.length ? [env.sources.map((x) => [x.path, x.sha256])] : [])]);
}

function normalizeRecords(raw: unknown, binding?: string): MeetingRecord[] {
  if (!Array.isArray(raw)) return [];
  const records = raw.map((entry) => {
    const problems: string[] = [];
    const r = (entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : {}) as Record<string, unknown>;
    if (r !== entry) problems.push('the record is not an object');
    const id = typeof r['id'] === 'string' ? r['id'].trim() : '';
    if (!RECORD_ID_PATTERN.test(id)) problems.push('the record has no valid id (M-01, M-02...)');
    const people = (list: unknown[], what: string) => list.map((p, i) => recordPerson(p, `${what} ${i + 1}`, problems)).filter((p): p is MeetingPerson => p !== null);
    const texts = (list: unknown[], what: string) => list.map((t, i) => recordText(t, `${what} ${i + 1}`, problems)).filter(Boolean);
    const content = {
      id,
      title: recordText(r['title'], 'title', problems),
      meeting_date: recordDate(r['meeting_date'], 'meeting_date', problems),
      attendees: people(recordList(r['attendees'], 'attendees', problems), 'attendee'),
      speakers: recordSpeakers(recordList(r['speakers'], 'speakers', problems), problems),
      decisions: texts(recordList(r['decisions'], 'decisions', problems), 'decision'),
      open_questions: texts(recordList(r['open_questions'], 'open_questions', problems), 'open question'),
      action_items: shownActionItems(recordList(r['action_items'], 'action_items', problems), problems).map((x) => x.item),
      source: recordText(r['source'], 'source', problems),
      meeting: typeof r['meeting'] === 'string' && /^MQ-\d{4}-\d{4}$/.test(r['meeting'].trim()) ? r['meeting'].trim() : null,
      unsure: r['unsure'] == null ? [] : recordDoubts(recordList(r['unsure'], 'unsure', problems), problems),
      meeting_id: isMeetingId(r['meeting_id']) ? r['meeting_id'] : null,
      amends: r['amends'] == null ? null : recordVersion(r['amends']) ?? (problems.push('amends is not a record version (update_id, record_id, revision)'), null),
      corrections: r['corrections'] == null ? [] : recordChanges(recordList(r['corrections'], 'corrections', problems), problems),
      transcript_changes: r['transcript_changes'] == null ? [] : recordTranscriptChanges(recordList(r['transcript_changes'], 'transcript_changes', problems), problems),
    };
    const revision = recordRevision(content, binding);
    const hash = typeof r['confirmed_hash'] === 'string' ? r['confirmed_hash'] : '';
    // A confirmation counts only for the content it was given for. One written without that hash (by hand
    // or by an agent) is not the user's confirmation.
    // Nor while the record has a problem: what cannot be shown faithfully (a malformed doubt added after confirming,
    // which reads as nothing) was never what the user confirmed.
    const confirmedNow = r['confirmation'] === 'confirmed' && hash === revision && problems.length === 0;
    const confirmedAt = typeof r['confirmed_at'] === 'string' && !Number.isNaN(Date.parse(r['confirmed_at'])) ? r['confirmed_at'] : null;
    return {
      ...content,
      confirmation: confirmedNow ? 'confirmed' as const : r['confirmation'] === 'rejected' ? 'rejected' as const : null,
      confirmed_at: confirmedNow ? confirmedAt : null,
      revision,
      problems,
      changed_since_confirmed: r['confirmation'] === 'confirmed' && hash !== '' && (hash !== revision || problems.length > 0),
    };
  });
  const counts = new Map<string, number>();
  for (const r of records) if (r.id) counts.set(r.id, (counts.get(r.id) ?? 0) + 1);
  for (const r of records) {
    if (r.id && counts.get(r.id)! > 1) r.problems.push(`another record has the same id ${r.id}`);
    if (records.length > MAX_RECORDS) r.problems.push(`more than ${MAX_RECORDS} meeting records in one update`);
    // A problem found across the records (a copied id) takes a confirmation away too, as one inside a record does.
    if (r.problems.length && r.confirmation === 'confirmed') {
      r.confirmation = null;
      r.confirmed_at = null;
      r.changed_since_confirmed = true;
    }
  }
  return records;
}

/** What identifies an action item for its task: its content, so the same item always maps to the same task. */
/** How long starting or finishing a correction waits for another dashboard doing the same. */
const CORRECTIONS_LOCK_WAIT_MS = 10_000;

/**
 * One correction transition at a time, across every dashboard: starting one (is another open?) and finishing one (is
 * its base still the current version?) read every update and must not interleave. Held for those short steps only,
 * never during an analysis. Taken outside any update's queue.
 */
export async function withCorrectionsLock<T>(operation: () => Promise<T>): Promise<T> {
  const ws = workspaceService.getWorkspacePath();
  const dir = await workspaceEntry(ws, path.join(ws, '.situation-board', 'locks'), true);
  await fsp.mkdir(dir, { recursive: true });
  await workspaceEntry(ws, dir);
  const held = await lock(path.join(dir, 'meeting-corrections.lock'), CORRECTIONS_LOCK_WAIT_MS, () => httpError(409, 'A correction is being started or finished elsewhere; try again in a moment'));
  try {
    return await operation();
  } finally {
    await unlock(held);
  }
}

/** How long a task from an action item waits for another dashboard making the same one. */
const ACTION_LOCK_WAIT_MS = 10_000;

/**
 * One task per action item, across every dashboard: find-by-identity, create and link run under a lock named after
 * the item's identity. Taken inside an update's queue, never the other way round.
 */
async function withActionLock<T>(identity: string, operation: () => Promise<T>): Promise<T> {
  const ws = workspaceService.getWorkspacePath();
  const dir = await workspaceEntry(ws, path.join(ws, '.situation-board', 'locks'), true);
  await fsp.mkdir(dir, { recursive: true });
  await workspaceEntry(ws, dir);
  const name = `action-${createHash('sha256').update(identity).digest('hex').slice(0, 32)}.lock`;
  const held = await lock(path.join(dir, name), ACTION_LOCK_WAIT_MS, () => httpError(409, 'A task is being made from this action item elsewhere; try again in a moment'));
  try {
    return await operation();
  } finally {
    await unlock(held);
  }
}

export function actionItemKey(a: MeetingActionItem): string {
  const content = [a.description, a.owner ? [a.owner.ref, a.owner.name] : null, a.due_date];
  return createHash('sha256').update(JSON.stringify(content)).digest('hex').slice(0, 12);
}

async function taskExists(tasksDir: string, taskId: string): Promise<boolean> {
  for (const folder of ['active', 'archive']) {
    if (await fileInside(path.join(tasksDir, folder), `${taskId}/task.md`).then(() => true, () => false)) return true;
  }
  return false;
}

/** Whether a finished update holds a meeting record the user confirmed. Reads the raw frontmatter value. */
export function hasConfirmedRecord(meetingRecords: unknown): boolean {
  return normalizeRecords(meetingRecords).some((r) => r.confirmation === 'confirmed');
}

function normalize(data: Record<string, unknown>, body: string, folderId: string): ContextUpdate {
  const status = UPDATE_STATUSES.includes(data['status'] as UpdateStatus) ? data['status'] as UpdateStatus : 'ready';
  const materials = Array.isArray(data['materials'])
    ? (data['materials'] as unknown[]).map((m) => {
      const o = (m && typeof m === 'object' ? m : {}) as Record<string, unknown>;
      const meetings = Array.isArray(o['meetings']) ? (o['meetings'] as unknown[]).filter(isMeetingId).slice(0, 50) : [];
      return { name: str(o['name']), size: Number(o['size']) || 0, type: str(o['type']), meetings };
    })
    : [];
  const correction = data['kind'] === CORRECTION_KIND ? normalizeCorrection(data['correction']) : null;
  const update: ContextUpdate = {
    // The folder name is the id: a file edited to say otherwise must not point the dashboard elsewhere.
    id: folderId,
    title: str(data['title']) || folderId,
    status,
    source_date: str(data['source_date'], true),
    created_at: str(data['created_at']),
    updated_at: str(data['updated_at']),
    analyzed_at: nullableStr(data['analyzed_at']),
    approved_at: nullableStr(data['approved_at']),
    applied_at: nullableStr(data['applied_at']),
    summary: str(data['summary']),
    notes: body,
    materials,
    transcripts: Array.isArray(data['transcripts']) ? (data['transcripts'] as unknown[]).flatMap((entry) => {
      const t = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
      const ok = typeof t['file'] === 'string' && typeof t['source'] === 'string' && typeof t['sha256'] === 'string';
      const kind = t['kind'] === 'docx' ? 'docx' as const : t['kind'] === 'audio' ? 'audio' as const : 'webvtt' as const;
      return ok ? [{ file: t['file'] as string, source: t['source'] as string, source_sha256: str(t['source_sha256']), sha256: t['sha256'] as string, complete: t['complete'] === true, kind, ...(t['source_removed'] === true ? { source_removed: true } : {}) }] : [];
    }) : [],
    transcript_problems: normalizePairs(data['transcript_problems'], 'source', 'reason'),
    keep_materials: data['keep_materials'] === true,
    keep_meeting_text: data['keep_meeting_text'] === true,
    meeting_folders: data['meeting_folders'] === true,
    keep_recordings: data['keep_recordings'] === true,
    meetings_linked_at: nullableStr(data['meetings_linked_at']),
    origin: nullableStr(data['origin']),
    kind: nullableStr(data['kind']),
    digest_meetings: normalizeDigestMeetings(data['digest_meetings']),
    kaizen: normalizeKaizen(data),
    proposals: Array.isArray(data['proposals']) ? (data['proposals'] as unknown[]).slice(0, MAX_PROPOSALS).map(normalizeProposal) : [],
    meeting_records: normalizeRecords(data['meeting_records'], correction ? correctionBinding(correction) : undefined),
    correction,
    finishing: correction ? normalizeFinish(data['finishing']) : null,
    finish_pending: correction !== null && data['finishing'] != null,
    transcript_version: correction ? normalizeTranscriptVersion(data['transcript_version']) : null,
    follows: data['kind'] === FOLLOW_UP_KIND && typeof data['follows'] === 'string' && UPDATE_ID_PATTERN.test(data['follows']) ? data['follows'] : null,
    skipped: normalizePairs(data['skipped'], 'topic', 'reason'),
    unread: normalizePairs(data['unread'], 'name', 'reason'),
    kept_meetings: Array.isArray(data['kept_meetings']) ? (data['kept_meetings'] as unknown[]).filter((k): k is string => typeof k === 'string' && MEETING_KEY.test(k)).slice(0, 50) : [],
    deleted_meetings: normalizeDeletedMeetings(data['deleted_meetings']),
  };
  checkCorrectionRecords(update);
  return update;
}

/** A meeting inside an update: its queue id in a digest, else its record id. */
const MEETING_KEY = /^(MQ-\d{4}-\d{4}|M-\d{2,3})$/;

function normalizeDeletedMeetings(value: unknown): DeletedMeeting[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 50).flatMap((entry) => {
    const o = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
    if (typeof o['meeting'] !== 'string' || !MEETING_KEY.test(o['meeting'])) return [];
    const files = Array.isArray(o['files']) ? (o['files'] as unknown[]).filter((f): f is string => typeof f === 'string' && path.basename(f) === f && f !== '..' && f !== '.') : [];
    // Only a trash entry's own name: a hand-edited value never points restore elsewhere.
    const trash = typeof o['trash'] === 'string' && path.basename(o['trash']) === o['trash'] ? o['trash'] : null;
    return [{ meeting: o['meeting'], at: str(o['at']), files, trash, by: o['by'] === 'system-cleanup' ? 'system-cleanup' as const : 'user' as const, ...(o['folder'] === true ? { folder: true as const } : {}) }];
  });
}

function normalizeDigestMeetings(value: unknown): DigestMeeting[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 50).flatMap((entry) => {
    const m = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
    if (typeof m['id'] !== 'string') return [];
    const files = Array.isArray(m['files']) ? (m['files'] as unknown[]).flatMap((f) => {
      const o = (f && typeof f === 'object' ? f : {}) as Record<string, unknown>;
      return typeof o['file'] === 'string' ? [{ source: str(o['source']), file: o['file'] as string, sha256: str(o['sha256']) }] : [];
    }) : [];
    const recordings = Array.isArray(m['recordings']) ? (m['recordings'] as unknown[]).flatMap((r) => {
      const o = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>;
      return typeof o['source'] === 'string' && typeof o['transcript'] === 'string'
        ? [{ source: o['source'], source_sha256: str(o['source_sha256']), transcript: o['transcript'], transcript_sha256: str(o['transcript_sha256']), complete: o['complete'] === true, file: typeof o['file'] === 'string' ? o['file'] : null }]
        : [];
    }) : [];
    return [{ id: m['id'] as string, title: str(m['title']), meeting_date: str(m['meeting_date'], true), files, ...(recordings.length ? { recordings } : {}) }];
  });
}

/**
 * The readable copy of a transcript, prepared in memory. Null when the file is not a transcript; a problem
 * when it looks like one but cannot be converted (the original is then saved alone).
 */
function prepareTranscript(name: string, buffer: Buffer): PreparedTranscript | { problem: string } | null {
  const ext = path.extname(name).toLowerCase();
  if (ext === '.docx') {
    if (buffer.length > MAX_CONVERT_BYTES) return { problem: `The Word file is over ${MAX_CONVERT_BYTES / 1024 / 1024} MB, so no readable copy was made.` };
    const read = docxText(buffer);
    if (!read.ok) return { problem: read.problem };
    if (!read.text.paragraphs.some((p) => p.trim())) return { problem: 'The Word document has no text in its body, so no readable copy was made.' };
    return { content: docxMarkdown(name, sha256(buffer), read.text), complete: read.text.missing.length === 0, kind: 'docx', missing: read.text.missing };
  }
  if (!['.vtt', '.txt', '.md'].includes(ext)) return null;
  const text = decodeText(buffer.length > MAX_CONVERT_BYTES ? buffer.subarray(0, 64) : buffer);
  if (text === null) return ext === '.vtt' ? { problem: 'The file is not valid UTF-8 or UTF-16 text, so no readable copy was made.' } : null;
  if (buffer.length > MAX_CONVERT_BYTES) {
    return /^\uFEFF?WEBVTT/.test(text) ? { problem: `The transcript is over ${MAX_CONVERT_BYTES / 1024 / 1024} MB, so no readable copy was made.` } : null;
  }
  const parsed = parseWebVtt(text);
  if (!parsed) return ext === '.vtt' ? { problem: 'The file does not start with WEBVTT, so no readable copy was made.' } : null;
  if (parsed.cues.length === 0) return { problem: 'No cue could be read, so no readable copy was made.' };
  return { content: transcriptMarkdown(name, sha256(buffer), parsed), complete: parsed.problems.length === 0, kind: 'webvtt' };
}

/**
 * A file as text to read on screen: a transcript or Word document as its readable copy, plain text as it is. Null for
 * anything else (audio, images, decks) and for text that cannot be decoded or is too large to convert.
 */
export function readableText(name: string, buffer: Buffer): string | null {
  const prepared = prepareTranscript(name, buffer);
  if (prepared && 'content' in prepared) return prepared.content;
  if (prepared || !['.txt', '.md'].includes(path.extname(name).toLowerCase()) || buffer.length > MAX_CONVERT_BYTES) return null;
  return decodeText(buffer);
}

/**
 * What one image counts as, in characters. An agent looks at a scaled-down picture, so a photo of a whiteboard or
 * a slide costs about the same whatever its file size: at most about 1,600 tokens, roughly this much text.
 */
export const IMAGE_CHARACTERS = 6_000;
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.heic', '.heif']);
/** Recordings: an agent reads their transcript, never the audio, so they count as their transcript does. */
export const AUDIO_EXTENSIONS = new Set(['.wav', '.m4a', '.mp3', '.aac', '.flac', '.aiff', '.aif', '.caf', '.ogg', '.opus', '.webm', '.wma']);

/** readableSize for a file on disk, read only when it is small enough to be text; large files count by their size. */
export async function readableSizeOf(file: string, name: string): Promise<number> {
  const ext = path.extname(name).toLowerCase();
  if (AUDIO_EXTENSIONS.has(ext)) return 0;
  if (IMAGE_EXTENSIONS.has(ext)) return IMAGE_CHARACTERS;
  const { size } = await fsp.stat(file);
  if (size > MAX_CONVERT_BYTES) return size;
  return readableSize(name, await fsp.readFile(file));
}

/**
 * Roughly how much an agent reads for one file, in characters: a transcript by its readable copy, other text by
 * its length, an image as IMAGE_CHARACTERS, anything else by its size, so a deck or a PDF is counted high rather
 * than low. An incomplete copy sends the agent to the original as well, so both count, unless a Word copy lacks
 * only pictures: it still holds all the text.
 */
export function readableSize(name: string, buffer: Buffer): number {
  if (IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase())) return IMAGE_CHARACTERS;
  const prepared = prepareTranscript(name, buffer);
  if (prepared && 'content' in prepared) {
    const onlyPictures = prepared.kind === 'docx' && (prepared.missing ?? []).every((m) => m === PICTURES);
    if (prepared.complete || onlyPictures) return prepared.content.length;
    const source = buffer.length <= MAX_CONVERT_BYTES ? decodeText(buffer) : null;
    return prepared.content.length + (source !== null ? source.length : buffer.length);
  }
  const text = buffer.length <= MAX_CONVERT_BYTES ? decodeText(buffer) : null;
  return text !== null ? text.length : buffer.length;
}

/** The name of a file in `dir` with exactly these bytes, if any. Only files of the same size are read. */
async function sameFileIn(dir: string, buffer: Buffer): Promise<string | null> {
  const hash = sha256(buffer);
  for (const entry of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isFile()) continue;
    const full = path.join(dir, entry.name);
    const stat = await fsp.stat(full).catch(() => null);
    if (stat?.size !== buffer.length) continue;
    const content = await fsp.readFile(full).catch(() => null);
    if (content && sha256(content) === hash) return entry.name;
  }
  return null;
}

/** Sanitizes a name the way saveAttachment does, then adds -2, -3... so a second "notes.txt" never replaces the first. */
async function uniqueName(dir: string, originalName: string): Promise<string> {
  const safe = safeFileName(originalName) || 'file';
  const ext = path.extname(safe);
  const stem = safe.slice(0, safe.length - ext.length) || 'file';
  for (let n = 1; n < 1000; n++) {
    const candidate = n === 1 ? `${stem}${ext}` : `${stem}-${n}${ext}`;
    const taken = await fsp.lstat(path.join(dir, candidate)).then(() => true, () => false);
    if (!taken) return candidate;
  }
  throw httpError(409, 'Too many files with the same name');
}

export class ContextUpdateService {
  rootDir(): string {
    return path.join(workspaceService.getWorkspacePath(), 'context-updates');
  }

  private updateDir(id: string): string {
    return path.join(this.rootDir(), updateId(id));
  }

  private async serialized<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const key = this.updateDir(id);
    const previous = pendingUpdates.get(key) ?? Promise.resolve();
    const result = previous.then(operation);
    // A failed request must not prevent the next request from running.
    const settled = result.then(() => {}, () => {});
    pendingUpdates.set(key, settled);
    try {
      return await result;
    } finally {
      if (pendingUpdates.get(key) === settled) pendingUpdates.delete(key);
    }
  }

  private async read(id: string): Promise<{ update: ContextUpdate; data: Record<string, unknown>; file: string }> {
    const dir = this.updateDir(id);
    const file = path.join(dir, 'update.md');
    let raw: string;
    try {
      raw = await fsp.readFile(await fileInside(dir, 'update.md'), 'utf-8');
    } catch (err) {
      if ((err as Error).message?.includes('traversal')) throw err;
      throw httpError(404, `Context update not found: ${id}`);
    }
    const parsed = parseMarkdown(raw);
    const data = (parsed.data ?? {}) as Record<string, unknown>;
    return { update: normalize(data, parsed.content.trim(), path.basename(dir)), data, file };
  }

  /** Writes back the agent's frontmatter with only the given fields changed, so fields this service does not know survive. */
  private async write(file: string, data: Record<string, unknown>, body: string, patch: Record<string, unknown>): Promise<void> {
    const next: Record<string, unknown> = { ...data, ...patch, updated_at: new Date().toISOString() };
    for (const [k, v] of Object.entries(next)) if (v === undefined) delete next[k];
    await atomicWrite(file, stringifyMarkdown(body, next));
  }

  /**
   * Waits until every change to this update already under way has finished. The runner calls it after marking a
   * run, so no change that passed the run check before can still be writing when the run starts.
   */
  async settled(id: string): Promise<void> {
    await this.serialized(id, async () => {});
  }

  /** While an analysis started from the dashboard is writing to this update, the dashboard leaves it alone. */
  private async requireNoRun(id: string, action: string): Promise<void> {
    if (await isAnalysisRunning(workspaceService.getWorkspacePath(), updateId(id))) {
      throw httpError(409, `Cannot ${action} while an analysis is running for this update; stop it first`);
    }
    // A meeting digest whose meetings are still leaving the queue: the queue deletes them only once this
    // update holds their files, so nothing may change it until then (it takes a moment, or the next run).
    const batch = await fsp.readFile(path.join(workspaceService.getWorkspacePath(), '.situation-board', 'routines', 'meeting-digest-batch.json'), 'utf-8').catch(() => '');
    if (batch.includes(`"${updateId(id)}"`)) {
      throw httpError(409, `Cannot ${action} while the meeting digest is still moving its meetings into this update; try again in a moment`);
    }
  }

  private requireStatus(update: ContextUpdate, allowed: UpdateStatus[], action: string): void {
    if (!allowed.includes(update.status)) {
      throw httpError(409, `Cannot ${action} while the update is "${update.status}"`);
    }
  }

  async list(): Promise<ContextUpdate[]> {
    const entries = await fsp.readdir(this.rootDir(), { withFileTypes: true }).catch(() => []);
    const updates: ContextUpdate[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !ID_PATTERN.test(entry.name)) continue;
      try {
        updates.push((await this.read(entry.name)).update);
      } catch {
        // A folder without a readable update.md is not an update.
      }
    }
    return updates.sort((a, b) => b.id.localeCompare(a.id));
  }

  async get(id: string): Promise<ContextUpdateDetail> {
    return this.serialized(id, async () => {
      const { update, data, file } = await this.read(id);
      const dir = this.updateDir(id);
      // The apply command deletes these itself, but an agent may lack permission to remove folders.
      // A done update never needs them again, so the dashboard finishes the cleanup.
      if (update.status === 'done') {
        await this.cleanup(update, update.keep_materials);
        await this.finishRemovals(id);
        // The apply command set it done: its meeting links are saved here, the first time it is opened.
        if (!update.meetings_linked_at) {
          const links = this.linkPatch(update, data, Array.isArray(data['meeting_records']) ? this.rawRecords(data) : undefined);
          if (Object.keys(links).length) await this.write(file, data, update.notes, links);
        }
      }
      const { update: current } = await this.read(id);
      // The manifest is written with the system's separator; targets use "/".
      const appFiles = new Set((readManifest(workspaceService.getWorkspacePath())?.files ?? []).map((f) => f.path.replace(/\\/g, '/')));
      const proposals = await Promise.all(current.proposals.map((p) => this.proposalDetail(dir, current, p, appFiles)));
      await this.markLinkedPeople(current.meeting_records);
      const material_files = await listFolderFiles(path.join(dir, 'materials'));
      const hashOf = async (name: string) => {
        const full = await fileInside(path.join(dir, 'materials'), name).catch(() => null);
        const content = full ? await fsp.readFile(full).catch(() => null) : null;
        return content ? sha256(content) : null;
      };
      // A recording's transcript stands on the digest's own record, which also spares reading gigabytes of audio here.
      const recorded = (t: UpdateTranscript) => t.kind === 'audio' && current.digest_meetings.some((m) => (m.recordings ?? []).some((r) => (
        r.transcript === t.file && r.transcript_sha256 === t.sha256 && r.source_sha256 === t.source_sha256 && r.complete === t.complete
        && (r.file ?? r.source) === t.source && (r.file === null) === Boolean(t.source_removed)
      )));
      const transcripts = await Promise.all(current.transcripts.map(async (t) => ({
        ...t, current: (recorded(t) || (await hashOf(t.source)) === t.source_sha256) && (await hashOf(t.file)) === t.sha256,
      })));
      const correction_review = current.kind === CORRECTION_KIND && current.correction ? await this.correctionReview(current) : undefined;
      const follow_up_problem = current.kind === FOLLOW_UP_KIND && current.status !== 'done' ? followUpProblem(current, await this.list()) : undefined;
      return { ...current, proposals, material_files, transcripts, ...(correction_review ? { correction_review } : {}), ...(follow_up_problem !== undefined ? { follow_up_problem } : {}) };
    });
  }

  /**
   * Before a run the dashboard starts: a correction's pins must be its meeting's own files, so the analysis never reads
   * another meeting's transcript on the strength of an edited envelope; a follow-up, analyzed or applied, must still
   * follow the meeting's current version, so it never spreads a value a newer correction replaced.
   */
  async runPreflight(id: string, command: 'analyze' | 'apply' = 'analyze'): Promise<void> {
    const { update } = await this.read(id);
    if (update.kind === FOLLOW_UP_KIND) {
      const problem = followUpProblem(update, await this.list());
      if (problem) throw httpError(409, problem);
      return;
    }
    if (update.kind !== CORRECTION_KIND || command !== 'analyze') return;
    if (!update.correction) throw httpError(409, `${id} does not say what it corrects; delete it and start again from the meeting`);
    const foreign = await foreignPins(update.correction, await this.list());
    if (foreign.length) throw httpError(409, `${id} pins ${foreign[0]}, which is not one of this meeting's files; delete it and start again from the meeting`);
  }

  /** The version a correction corrects, as confirmed, what its record changes in it, and why it cannot finish. Read only. */
  private async correctionReview(update: ContextUpdate): Promise<NonNullable<ContextUpdateDetail['correction_review']>> {
    const ws = workspaceService.getWorkspacePath();
    const record = update.meeting_records.length === 1 ? update.meeting_records[0]! : null;
    const all = await this.list();
    // Once done, a correction is the current version itself (or a later one built on it): nothing left to check.
    if (update.status === 'done') {
      const env = update.correction!;
      const found = all.find((u) => u.id === env.base.update_id)?.meeting_records.find((r) => r.id === env.base.record_id);
      const base = found && found.revision === env.base.revision ? found : null;
      // Still the meeting's current version: only then can it be followed up.
      const chain = correctionChain(env.meeting, env.root, all);
      const current = chain.state === 'corrected' && chain.head?.update_id === update.id;
      const made = update.transcript_version ? { from: update.transcript_version.from, to: update.transcript_version.to } : null;
      const transcript = record && made ? await transcriptReview(ws, env, record, made, false) : null;
      return { base, stale: false, blocked: [], changes: base && record ? recordDiff(base, record) : [], doubts_dropped: base && record ? doubtsDropped(base, record) : [], current, suggestions: [], transcript, finishing: false };
    }
    if (!record) return { base: null, stale: false, blocked: [], changes: [], doubts_dropped: [], current: false, suggestions: [], transcript: null, finishing: update.finish_pending };
    // Being finished: approving again completes it without the checks (its own new version may be in use by now), so
    // none runs here either; the changes are shown as they were kept.
    if (update.finish_pending) {
      const env = update.correction!;
      const found = all.find((u) => u.id === env.base.update_id)?.meeting_records.find((r) => r.id === env.base.record_id);
      const base = found && found.revision === env.base.revision ? found : null;
      return { base, stale: false, blocked: [], changes: base ? recordDiff(base, record) : [], doubts_dropped: base ? doubtsDropped(base, record) : [], current: false, suggestions: [],
        transcript: await transcriptReview(ws, env, record, null, false, false), finishing: true };
    }
    const check = await this.correctionCheck(update, record, all);
    const base = check.base;
    return { base, stale: check.stale, blocked: check.blocked, changes: base ? recordDiff(base, record) : [], doubts_dropped: base ? doubtsDropped(base, record) : [], current: false,
      suggestions: update.status === 'in_review' ? record.corrections.flatMap((c, index) => {
        if (c.sure) return [];
        const place = base ? suggestionPlace(base, c) : null;
        return [{ index, used: Boolean(c.taken), blocked: suggestionBlock(record, base, check.stale, index), unlinks: !c.taken && place !== null && linkAt(record as unknown as Record<string, unknown>, place) !== null }];
      }) : [],
      transcript: await transcriptReview(ws, update.correction!, record, null, update.status === 'in_review'),
      finishing: false };
  }


  /**
   * Moves the target of every accepted removal to the trash, once. A context note goes with its folder,
   * so its attachments are not left behind. When another accepted change failed, removals are held back:
   * a merge that did not land would otherwise lose the text of the note being merged away.
   */
  private async finishRemovals(id: string): Promise<void> {
    const { update, data, file } = await this.read(id);
    if (update.status !== 'done') return;
    const pending = update.proposals.filter((p) => p.action === 'remove' && p.decision === 'accepted' && !p.outcome);
    if (pending.length === 0) return;
    const otherFailed = update.proposals.some((p) => p.action !== 'remove' && p.decision === 'accepted' && p.outcome !== 'applied' && p.outcome !== 'merged');
    const ws = workspaceService.getWorkspacePath();
    const results = new Map<string, { outcome: string; outcome_note: string }>();
    for (const p of pending) {
      if (otherFailed) {
        results.set(p.id, { outcome: 'skipped', outcome_note: 'Kept: another accepted change was not confirmed as applied, so removing this file could lose information.' });
        continue;
      }
      const target = proposalTarget(p.target);
      if (!target) { results.set(p.id, { outcome: 'failed', outcome_note: 'The target is not a context note or stakeholder file.' }); continue; }
      try {
        const full = await workspaceEntry(ws, path.join(ws, target));
        await fileInside(ws, target);
        const parts = target.split('/');
        // context/<category>/<slug>/note.md: the note is its folder.
        const isNoteFolder = parts[0] === 'context' && parts.length === 4 && parts[3] === 'note.md';
        const what = isNoteFolder ? path.dirname(full) : full;
        if (isNoteFolder && (await fsp.lstat(what)).isSymbolicLink()) throw new Error('traversal');
        const moved = await moveToTrash(ws, what);
        results.set(p.id, { outcome: 'applied', outcome_note: `Moved to ${moved}` });
      } catch (err) {
        const gone = (err as NodeJS.ErrnoException).code === 'ENOENT' || /not found|not a file/i.test((err as Error).message ?? '');
        results.set(p.id, gone
          ? { outcome: 'applied', outcome_note: 'The file was already gone.' }
          : { outcome: 'failed', outcome_note: `Could not move it to the trash: ${(err as Error).message}` });
      }
    }
    const proposals = this.rawProposals(data).map((raw, i) => {
      const r = results.get(normalizeProposal(raw, i).id);
      return r ? { ...(raw as Record<string, unknown>), ...r } : raw;
    });
    await this.write(file, data, update.notes, { proposals });
  }

  /** Says for every linked person whether that stakeholder exists: the link is only the agent's claim. */
  private async markLinkedPeople(records: MeetingRecord[]): Promise<void> {
    const people = path.join(workspaceService.getWorkspacePath(), 'stakeholders', 'people');
    const found = new Map<string, boolean>();
    const check = async (p: MeetingPerson | null) => {
      if (!p?.ref) return;
      if (p.ref === 'me') { p.ref_found = true; return; }
      if (!found.has(p.ref)) found.set(p.ref, await fileInside(people, `${p.ref.toLowerCase()}.md`).then(() => true, () => false));
      p.ref_found = found.get(p.ref)!;
    };
    const tasks = path.join(workspaceService.getWorkspacePath(), 'tasks');
    for (const r of records) {
      for (const p of r.attendees) await check(p);
      for (const s of r.speakers) await check(s.person);
      for (const a of r.action_items) {
        await check(a.owner);
        if (a.task_ref) a.task_found = await taskExists(tasks, a.task_ref);
      }
    }
  }

  /**
   * Creates a task from an action item of a confirmed meeting record and links the item to it, in one step
   * under this update's lock: `{ "item": 0, "revision": "<the record's revision>", "task": { ...New task fields } }`.
   * Only for a finished update, which cannot be reopened, so the link is never discarded by a new analysis.
   * Everything is checked before the task is created. When the item already has its task (a second tab, a
   * retry, or a crash after the task was written), that task is returned instead of creating another.
   */
  async createActionItemTask(id: string, recordId: string, input: unknown): Promise<{ update: ContextUpdate; task: Task; created: boolean }> {
    return this.serialized(id, async () => {
      const { update, data, file } = await this.read(id);
      this.requireStatus(update, ['done'], 'create a task from an action item');
      const body = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
      const matches = update.meeting_records.flatMap((r, i) => r.id === recordId ? [i] : []);
      if (matches.length !== 1) throw httpError(400, `Invalid meeting record id: ${recordId}`);
      const index = matches[0]!;
      const record = update.meeting_records[index]!;
      if (record.confirmation !== 'confirmed') throw httpError(409, `Meeting record ${recordId} is not confirmed, so its action items cannot become tasks`);
      if (body['revision'] !== record.revision) throw httpError(409, `Meeting record ${recordId} changed since you loaded it; review it again`);
      const item = body['item'];
      if (typeof item !== 'number' || !Number.isInteger(item) || item < 0 || item >= record.action_items.length) throw httpError(400, 'Invalid action item');
      const fields = body['task'];
      if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw httpError(400, 'Invalid task');

      const tasksDir = path.join(workspaceService.getWorkspacePath(), 'tasks');
      const action = record.action_items[item]!;
      // Recorded on the task, so a crash between writing the task and the link cannot lead to a second task. A corrected
      // item is its original: the same identity, found through its slot in a chain that holds, never its own.
      const { identity, root_index } = await this.actionIdentity(update, record, action, item);
      if (action.task_ref) {
        if (!(await taskExists(tasksDir, action.task_ref))) throw httpError(409, `This action item had a task, ${action.task_ref}, which no longer exists`);
        const linked = await taskService.getTask(action.task_ref).catch(() => ({ id: action.task_ref } as Task));
        // A link to a task made for another action item is never taken as this item's task. One made before tasks
        // recorded their item has no identity to compare, and is taken as it is.
        const theirs = (linked as unknown as Record<string, unknown>)['meeting_action'];
        if (typeof theirs === 'string' && theirs !== identity) throw httpError(409, `This action item's task link, ${action.task_ref}, belongs to another action item; fix the link in ${update.id}`);
        return { update, task: linked, created: false };
      }
      const raws = this.rawRecords(data);
      const raw = raws[index] as Record<string, unknown>;
      const rawItems = Array.isArray(raw['action_items']) ? [...raw['action_items']] : [];
      const rawIndex = shownActionItems(rawItems, [])[item]?.index;
      if (rawIndex === undefined) throw httpError(400, 'Invalid action item');

      return withActionLock(identity, async () => {
        const found = await taskService.findByMeetingAction(identity);
        // A new task records the exact version it was made from; one found again keeps what it recorded first.
        const task = found ?? await taskService.createTask(fields as Partial<Task>, {
          meeting_action: identity, source: { update_id: update.id, record_id: record.id, revision: record.revision, root_index },
        });
        const entry = rawItems[rawIndex];
        // A plain-text item becomes an object with the same text, so it can hold the link; what it says is unchanged.
        rawItems[rawIndex] = { ...(entry && typeof entry === 'object' && !Array.isArray(entry) ? entry as Record<string, unknown> : { description: entry }), task_ref: task.id };
        raws[index] = { ...raw, action_items: rawItems };
        await this.write(file, data, update.notes, { meeting_records: raws });
        return { update: (await this.read(id)).update, task, created: !found };
      });
    });
  }

  /**
   * The identity a task made from this action item carries. For a correction, the original item's: only while the chain
   * of versions holds and this record is its current one, so a task never rests on a version that does not count.
   */
  private async actionIdentity(update: ContextUpdate, record: MeetingRecord, action: MeetingActionItem, item: number): Promise<{ identity: string; root_index: number }> {
    if (update.kind !== CORRECTION_KIND) {
      // An original with corrections: only while its versions hold, never from a disputed one.
      const all = await this.list();
      const claim = all.find((u) => u.kind === CORRECTION_KIND && u.correction?.root.update_id === update.id && u.correction.root.record_id === record.id);
      const state = claim?.correction ? correctionChain(claim.correction.meeting, claim.correction.root, all).state : 'original';
      if (state !== 'original' && state !== 'corrected') throw httpError(409, `The versions of this meeting's record are ${state}, so its action items cannot become tasks`);
      return { identity: `${update.id}/${record.id}/${actionItemKey(action)}`, root_index: item };
    }
    const env = update.correction;
    if (!env) throw httpError(409, `${update.id} does not say what it corrects, so its action items cannot become tasks`);
    const chain = correctionChain(env.meeting, env.root, await this.list());
    if (chain.state !== 'corrected' || chain.head?.update_id !== update.id || chain.head.record_id !== record.id) {
      throw httpError(409, `This record is not the current version of the meeting's record (${chain.state}), so its action items cannot become tasks`);
    }
    const identity = action.slot ? rootActionIdentity(env, action.slot) : null;
    const slot = env.slots.find((s) => s.slot === action.slot);
    if (!identity || !slot) throw httpError(409, 'This action item does not say which original item it is');
    return { identity, root_index: slot.root_index };
  }

  /**
   * Before a correction is finished, under the corrections lock: it carries no proposals, its one record is confirmed,
   * and the check below finds nothing. The speakers' evidence is written onto the raw record here, so the finish
   * carries it. Returns what finishing writes to the meeting's text, or null when it changes no transcript words.
   */
  private async checkCorrection(update: ContextUpdate, data: Record<string, unknown>): Promise<CorrectionFinish | null> {
    if (!update.correction) throw httpError(409, `${update.id} does not say what it corrects`);
    if (this.rawProposals(data).length) throw httpError(409, 'A correction finishes without proposals: changes to the context go through an ordinary update');
    const record = update.meeting_records[0];
    if (update.meeting_records.length !== 1 || !record || record.confirmation !== 'confirmed' || record.problems.length) {
      throw httpError(409, 'Confirm the corrected record before finishing, or close this correction');
    }
    const check = await this.correctionCheck(update, record, await this.list());
    if (check.blocked.length) throw httpError(409, check.blocked[0]!);
    const raws = this.rawRecords(data);
    raws[0] = { ...(raws[0] as Record<string, unknown>), speakers_evidence: check.evidence };
    data['meeting_records'] = raws;
    const changes = effectiveChanges(record).map((c) => writerChange(c.change));
    const pinned = transcriptBase(update.correction);
    if (!changes.length || 'problem' in pinned) return null;
    return { receipt: finishReceipt(update.id, record.revision, pinned.version, changes), from_version: pinned.version, revision: record.revision, changes };
  }

  /**
   * Whether a correction's record can become the meeting's current version, checked against the versions themselves,
   * never against what the correction says about them. The same check the review shows and the finish enforces:
   * - the version it corrects is still the current one, and the versions hold (no other correction finished first);
   * - the record keeps that version's source and `meeting`, and its slots are the ones that version's items stand
   *   for (the head's own when it is a correction, else one per original item, in order);
   * - a change the analysis is not sure of is not already in the record;
   * - speakers: unchanged from that version, they keep its evidence as it is, also when the transcript is gone; a
   *   changed speaker needs its transcript pinned when the correction started, still there with those bytes.
   */
  private async correctionCheck(update: ContextUpdate, record: MeetingRecord, all: ContextUpdate[]): Promise<{ base: MeetingRecord | null; stale: boolean; blocked: string[]; evidence: Record<string, string> | undefined }> {
    const env = update.correction!;
    const blocked: string[] = [];
    const chain = correctionChain(env.meeting, env.root, all);
    const head = chain.head;
    const stale = (chain.state !== 'original' && chain.state !== 'corrected') || !head || head.update_id !== env.base.update_id || head.record_id !== env.base.record_id || head.revision !== env.base.revision;
    if (stale) blocked.push('Another correction of this meeting finished first, or its versions no longer hold. Close this one and start again from the current record');
    const baseUpdate = all.find((u) => u.id === env.base.update_id);
    const found = baseUpdate?.meeting_records.find((r) => r.id === env.base.record_id);
    const base = found && found.revision === env.base.revision && found.confirmation === 'confirmed' ? found : null;
    if (!base) return { base, stale, blocked: [...blocked, 'The version this corrects is gone or changed. Close this one and start again from the current record'], evidence: undefined };

    if (record.source !== base.source) blocked.push(`The corrected record must keep its source, ${base.source || '(none)'}`);
    // `meeting` is a queued meeting's id (a digest's record) or none (an import's): the version's own, kept.
    if (record.meeting !== base.meeting) blocked.push(`The corrected record must keep its meeting, ${base.meeting ?? '(none)'}`);
    const rootRecord = all.find((u) => u.id === env.root.update_id)?.meeting_records.find((r) => r.id === env.root.record_id);
    const expected = baseUpdate!.kind === CORRECTION_KIND && baseUpdate!.correction
      ? baseUpdate!.correction.slots
      : rootRecord ? rootRecord.action_items.map((item, i) => ({ slot: `A-${String(i + 1).padStart(2, '0')}`, root_key: actionItemKey(item), root_index: i })) : null;
    if (!expected || JSON.stringify(expected) !== JSON.stringify(env.slots)) blocked.push('The action items no longer say which original item each one is. Close this one and start again');

    // A field with a change marked not sure stays exactly as it was, apart from the suggestions the executive used, each
    // applied once to the version corrected: nothing else in it may change (an owner swapped between items, a longer
    // title, a deletion), so a suggestion is never applied in part. The old value must be quoted exactly.
    const unsure = record.corrections.filter((x) => !x.sure);
    for (const c of unsure) {
      if (!fieldTexts(base)[c.field].includes(c.before)) blocked.push(`A change marked not sure must quote a value of ${c.field} exactly: "${c.before}". Analyze again, or close this correction`);
    }
    for (const field of new Set(unsure.map((c) => c.field))) {
      // Each used suggestion at its own place in the version corrected: no two at one place, the order of use never matters.
      const used = unsure.filter((c) => c.field === field && c.taken);
      const places = used.map((c) => suggestionPlace(base, c));
      let expected: Record<string, unknown> | null = base as unknown as Record<string, unknown>;
      if (places.some((p, i) => !p || !fits(p, used[i]!.after) || places.some((q, k) => k !== i && q && samePlace(p, q)))) expected = null;
      else used.forEach((c, i) => { expected = setAt(expected!, places[i]!, c.after); });
      if (!expected || JSON.stringify(fieldValues(expected as unknown as MeetingRecord)[field]) !== JSON.stringify(fieldValues(record)[field])) {
        blocked.push(`${field} has a change marked not sure, so it must stay as it was apart from the suggestions you used, yet it changed. Analyze again, or close this correction`);
      }
    }

    // Transcript words: the changes that count, on the version of the meeting's text the correction pinned, which must
    // still be the one in use. Unused suggestions are never applied, so they never stop the finish.
    if (effectiveChanges(record).length) {
      const pinned = transcriptBase(env);
      if ('problem' in pinned) blocked.push(pinned.problem);
      else {
        const folder = await readFolder(workspaceService.getWorkspacePath(), env.meeting).catch(() => null);
        const current = folder?.state === 'ok' ? folder.manifest.current : null;
        if (current !== pinned.version) blocked.push(`This meeting's text changed since the correction started (${current ?? 'it cannot be read'} is in use now, not ${pinned.version}). Close this one and start again`);
        else for (const [i, p] of await effectiveProblems(workspaceService.getWorkspacePath(), env, record, pinned.version)) blocked.push(`Transcript change ${i + 1}: ${p}. Analyze again, or close this correction`);
      }
    }

    for (const pin of await foreignPins(env, all)) blocked.push(`The correction pins ${pin}, which is not one of this meeting's files. Close this one and start again`);

    const speakersOf = (r: MeetingRecord) => JSON.stringify(r.speakers.map((sp) => [sp.label, sp.source, sp.person ? [sp.person.ref, sp.person.name] : null]).sort());
    let evidence: Record<string, string> | undefined;
    if (speakersOf(record) === speakersOf(base)) {
      const baseRaw = this.rawRecords((await this.read(env.base.update_id)).data).find((r) => (r as Record<string, unknown>)?.['id'] === base.id) as Record<string, unknown> | undefined;
      const inherited = baseRaw?.['speakers_evidence'];
      evidence = record.speakers.length ? (inherited && typeof inherited === 'object' ? inherited as Record<string, string> : {}) : undefined;
    } else if (record.speakers.length) {
      evidence = {};
      // The original's transcripts, where they are kept now: the meeting's own folder, or the original update's materials.
      const root = all.find((u) => u.id === env.root.update_id);
      const held = root ? heldMeetings(root).find((m) => m.id === env.meeting) : undefined;
      const where = root && held ? await meetingFiles(workspaceService.getWorkspacePath(), root, held, new Set()) : null;
      for (const source of new Set(record.speakers.map((sp) => sp.source))) {
        const pin = where ? env.sources.find((x) => x.kind === 'transcript' && x.path === where.relative(source)) : undefined;
        const file = pin && where ? await where.path(source) : null;
        if (!pin || !file || (await hashFile(file)).sha256 !== pin.sha256) {
          blocked.push(`A speaker can be corrected only from a transcript this correction started with, kept unchanged: ${source} in ${env.root.update_id}`);
          continue;
        }
        evidence[source] = pin.sha256;
      }
    }
    return { base, stale, blocked, evidence };
  }

  /** The hash of each transcript a record's speakers come from. A transcript that is not among the materials is refused. */
  private async speakerEvidence(id: string, record: MeetingRecord): Promise<Record<string, string>> {
    const evidence: Record<string, string> = {};
    for (const source of new Set(record.speakers.map((s) => s.source))) {
      const file = await fileInside(path.join(this.updateDir(id), 'materials'), source).catch(() => null);
      if (!file) throw httpError(409, `Meeting record ${record.id} names speakers from ${source}, which is not among the materials`);
      evidence[source] = (await hashFile(file)).sha256;
    }
    return evidence;
  }

  /** A confirmed record's speakers still rest on the transcripts that were confirmed. */
  private async checkSpeakerEvidence(id: string, update: ContextUpdate, data: Record<string, unknown>): Promise<void> {
    const raws = this.rawRecords(data);
    for (const [i, record] of update.meeting_records.entries()) {
      if (record.confirmation !== 'confirmed' || !record.speakers.length) continue;
      const saved = JSON.stringify((raws[i] as Record<string, unknown>)['speakers_evidence'] ?? null);
      if (saved !== JSON.stringify(await this.speakerEvidence(id, record))) {
        throw httpError(409, `The transcript behind the speakers of meeting record ${record.id} changed after you confirmed it; review it again`);
      }
    }
  }

  /**
   * The user's word on one speaker: who it is, or null for unknown. Only while the update is in review, and only on
   * the record the user is looking at. It changes the record, so a confirmation given before it no longer counts.
   */
  async setSpeaker(id: string, recordId: string, input: unknown): Promise<ContextUpdate> {
    return this.changing(id, async () => {
      await this.requireNoRun(id, 'change a speaker');
      const { update, data, file } = await this.read(id);
      this.requireNotFinishing(data);
      this.requireStatus(update, ['in_review'], 'change a speaker');
      const body = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
      const matches = update.meeting_records.flatMap((r, i) => r.id === recordId ? [i] : []);
      if (matches.length !== 1) throw httpError(400, `Invalid meeting record id: ${recordId}`);
      const index = matches[0]!;
      if (body['revision'] !== update.meeting_records[index]!.revision) throw httpError(409, `Meeting record ${recordId} changed since you loaded it; review it again`);
      const problems: string[] = [];
      const person = body['person'] == null ? null : recordPerson(body['person'], 'The person', problems);
      if (problems.length) throw httpError(400, problems[0]!);
      const raws = this.rawRecords(data);
      const raw = raws[index] as Record<string, unknown>;
      const speakers = Array.isArray(raw['speakers']) ? [...raw['speakers'] as Record<string, unknown>[]] : [];
      const shown = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
      const at = speakers.findIndex((s) => s && shown(s['label']) === body['label'] && shown(s['source']) === body['source']);
      if (at < 0) throw httpError(400, 'Invalid speaker');
      speakers[at] = { ...speakers[at], person: person ? { ...(person.ref ? { ref: person.ref } : {}), name: person.name } : null, reason: 'Set by you' };
      raws[index] = { ...raw, speakers, confirmation: undefined, confirmed_at: undefined, confirmed_hash: undefined, speakers_evidence: undefined };
      await this.write(file, data, update.notes, { meeting_records: this.clean(raws) });
      return (await this.read(id)).update;
    });
  }

  /**
   * The hash of each transcript a confirmed record's speakers were confirmed on (`speakers_evidence`); null for a record
   * read whole that has none (confirmed before it was kept). Throws when the update or the record cannot be read, so a
   * caller never takes a failed read for a record without evidence.
   */
  async confirmedSpeakerEvidence(updateId: string, recordId: string): Promise<Record<string, string> | null> {
    const { data } = await this.read(updateId);
    const raw = this.rawRecords(data).find((r) => (r as Record<string, unknown>)?.['id'] === recordId) as Record<string, unknown> | undefined;
    if (!raw) throw httpError(404, `Meeting record ${recordId} is not in ${updateId}`);
    const ev = raw['speakers_evidence'];
    return ev && typeof ev === 'object' && !Array.isArray(ev) ? ev as Record<string, string> : null;
  }

  /**
   * Uses a correction's suggestion (a change marked not sure), or takes it back: the one value it names is replaced in
   * the record as the agent wrote it, nothing else, and the suggestion says it was used. Like changing a speaker: while
   * no run is going, for the record as the page showed it, and the record is confirmed again afterwards. Taking it back
   * puts the version corrected's value back, with its stakeholder link.
   */
  async useSuggestion(id: string, recordId: string, index: number, input: unknown): Promise<ContextUpdate> {
    return this.changing(id, async () => {
      await this.requireNoRun(id, 'use a suggestion');
      const { update, data, file } = await this.read(id);
      this.requireNotFinishing(data);
      this.requireStatus(update, ['in_review'], 'use a suggestion');
      const env = update.correction;
      if (update.kind !== CORRECTION_KIND || !env) throw httpError(400, `${id} is not a correction of a meeting record`);
      const body = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
      const record = update.meeting_records.length === 1 ? update.meeting_records[0]! : null;
      if (!record || record.id !== recordId) throw httpError(400, `Invalid meeting record id: ${recordId}`);
      if (body['revision'] !== record.revision) throw httpError(409, `Meeting record ${recordId} changed since you loaded it; review it again`);
      if (!Number.isInteger(index) || index < 0 || index >= record.corrections.length) throw httpError(400, 'Invalid suggestion');
      if (typeof body['use'] !== 'boolean') throw httpError(400, 'Say whether to use the suggestion or take it back (use: true or false)');
      if (record.problems.length) throw httpError(409, 'The record has problems; analyze it again before using a suggestion');
      const c = record.corrections[index]!;
      if (c.sure) throw httpError(409, 'Only a change marked not sure can be used');
      if (body['use'] && c.taken) throw httpError(409, 'This suggestion is already used');
      if (!body['use'] && !c.taken) throw httpError(409, 'This suggestion is not used');
      // The same check the review shows: a current correction, the suggestion's one place, what that place holds now.
      const check = await this.correctionCheck(update, record, await this.list());
      const why = suggestionBlock(record, check.base, check.stale, index);
      if (why) throw httpError(409, why);
      const place = suggestionPlace(check.base!, c)!;
      const raws = this.rawRecords(data);
      const raw = raws[0] as Record<string, unknown>;
      const at = inFile(raw, place);
      if (!at || valueAt(raw, at) !== (body['use'] ? c.before : c.after)) throw httpError(409, `Meeting record ${recordId} changed since you loaded it; review it again`);
      const rawChanges = Array.isArray(raw['corrections']) ? [...raw['corrections'] as unknown[]] : [];
      const entry = (rawChanges[index] && typeof rawChanges[index] === 'object' ? rawChanges[index] : {}) as Record<string, unknown>;
      let next: Record<string, unknown>;
      if (body['use']) {
        next = setAt(raw, at, c.after);
        rawChanges[index] = { ...entry, taken: true };
      } else {
        // The version corrected's own value at that place, with its link: what the record said before.
        next = setAt(raw, at, c.before, linkAt(check.base as unknown as Record<string, unknown>, place));
        const { taken: _taken, ...rest } = entry;
        rawChanges[index] = rest;
      }
      next = { ...next, corrections: rawChanges, confirmation: undefined, confirmed_at: undefined, confirmed_hash: undefined, speakers_evidence: undefined };
      // What is written must read as cleanly as what was there.
      const [written] = normalizeRecords([next], correctionBinding(env));
      if (!written || written.problems.length) throw httpError(409, `Using this suggestion would leave a problem in the record: ${written?.problems[0] ?? 'it cannot be read'}`);
      raws[0] = next;
      await this.write(file, data, update.notes, { meeting_records: this.clean(raws) });
      return (await this.read(id)).update;
    });
  }

  /**
   * Uses a correction's transcript suggestion (a word change marked not sure), or takes it back. Only the suggestion
   * says so (`taken`); the meeting's text is changed when the correction is finished, never here. Used only when it
   * still stands on the pinned text together with the changes that count. The record is confirmed again afterwards.
   */
  async useTranscriptSuggestion(id: string, recordId: string, index: number, input: unknown): Promise<ContextUpdate> {
    return this.changing(id, async () => {
      await this.requireNoRun(id, 'use a suggestion');
      const { update, data, file } = await this.read(id);
      this.requireNotFinishing(data);
      this.requireStatus(update, ['in_review'], 'use a suggestion');
      const env = update.correction;
      if (update.kind !== CORRECTION_KIND || !env) throw httpError(400, `${id} is not a correction of a meeting record`);
      const body = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
      const record = update.meeting_records.length === 1 ? update.meeting_records[0]! : null;
      if (!record || record.id !== recordId) throw httpError(400, `Invalid meeting record id: ${recordId}`);
      if (body['revision'] !== record.revision) throw httpError(409, `Meeting record ${recordId} changed since you loaded it; review it again`);
      if (!Number.isInteger(index) || index < 0 || index >= record.transcript_changes.length) throw httpError(400, 'Invalid suggestion');
      if (typeof body['use'] !== 'boolean') throw httpError(400, 'Say whether to use the suggestion or take it back (use: true or false)');
      if (record.problems.length) throw httpError(409, 'The record has problems; analyze it again before using a suggestion');
      const c = record.transcript_changes[index]!;
      if (c.sure) throw httpError(409, 'Only a change marked not sure can be used');
      if (body['use'] && c.taken) throw httpError(409, 'This suggestion is already used');
      if (!body['use'] && !c.taken) throw httpError(409, 'This suggestion is not used');
      if (body['use']) {
        const pinned = transcriptBase(env);
        if ('problem' in pinned) throw httpError(409, pinned.problem);
        const why = await suggestionProblem(workspaceService.getWorkspacePath(), env, record, pinned.version, index);
        if (why) throw httpError(409, why);
      }
      const raws = this.rawRecords(data);
      const raw = raws[0] as Record<string, unknown>;
      const list = Array.isArray(raw['transcript_changes']) ? [...raw['transcript_changes'] as unknown[]] : [];
      const entry = (list[index] && typeof list[index] === 'object' ? list[index] : {}) as Record<string, unknown>;
      const { taken: _taken, ...rest } = entry;
      list[index] = body['use'] ? { ...rest, taken: true } : rest;
      const next = { ...raw, transcript_changes: list, confirmation: undefined, confirmed_at: undefined, confirmed_hash: undefined, speakers_evidence: undefined };
      const [written] = normalizeRecords([next], correctionBinding(env));
      if (!written || written.problems.length) throw httpError(409, `Using this suggestion would leave a problem in the record: ${written?.problems[0] ?? 'it cannot be read'}`);
      raws[0] = next;
      await this.write(file, data, update.notes, { meeting_records: this.clean(raws) });
      return (await this.read(id)).update;
    });
  }

  private async proposalDetail(dir: string, update: ContextUpdate, p: UpdateProposal, appFiles: Set<string>): Promise<ProposalDetail> {
    const kaizen = update.kind === KAIZEN_KIND;
    const target = proposalTarget(p.target, update.kind);
    const detail: ProposalDetail = { ...p, current: null, proposed: null, target_exists: false, stale: false, problem: null, app_provided: !!target && appFiles.has(target) };
    if (!target) {
      return { ...detail, problem: kaizen
        ? 'A Kaizen can change context notes, stakeholder files, the agent instruction files and output templates only, so this cannot be applied.'
        : 'The target is not a context note or stakeholder file, so it cannot be applied.' };
    }
    if (kaizen && p.action === 'remove') return { ...detail, problem: 'A Kaizen improves files; it never removes one. Remove the file yourself if it should go.' };
    if (!PROPOSAL_ID_PATTERN.test(p.id)) return { ...detail, problem: 'The proposal id is not valid (expected P-01, P-02...).' };

    const ws = workspaceService.getWorkspacePath();
    try {
      const full = await fileInside(ws, target);
      const stat = await fsp.stat(full);
      detail.target_exists = true;
      detail.current = stat.size <= MAX_DIFF_BYTES ? await fsp.readFile(full, 'utf-8') : null;
      const analyzed = update.analyzed_at ? Date.parse(update.analyzed_at) : NaN;
      // A create whose file now exists, or an update whose file was edited after the analysis.
      detail.stale = p.action === 'create' || (!Number.isNaN(analyzed) && stat.mtimeMs > analyzed + 1000);
    } catch (err) {
      if ((err as Error).message?.includes('traversal')) return { ...detail, problem: 'The target points outside the workspace.' };
      if (p.action === 'update') detail.stale = true; // the file was removed since the analysis
    }

    if (p.action === 'remove') {
      // Nothing to draft: the "after" of a removal is no file. Shown as the current content going away.
      if (!detail.target_exists && update.status !== 'done') detail.problem = 'This file is already gone, so there is nothing to remove.';
      if (!['in_review', 'approved'].includes(update.status)) detail.stale = false;
      return detail;
    }

    // The draft only exists until the update is done; afterwards the record keeps the decision, not the text.
    if (update.status !== 'done') {
      try {
        const draft = await fileInside(path.join(dir, 'proposals'), `${p.id}.md`);
        const stat = await fsp.stat(draft);
        if (stat.size <= MAX_DIFF_BYTES) detail.proposed = await fsp.readFile(draft, 'utf-8');
        else detail.problem = 'The proposed content is too large to show here. Open the file in the workspace folder.';
      } catch {
        detail.problem = `The proposed content is missing (proposals/${p.id}.md).`;
      }
    }
    // Once applying starts the targets change on purpose; "stale" only matters while reviewing.
    if (!['in_review', 'approved'].includes(update.status)) detail.stale = false;
    return detail;
  }

  private async nextId(): Promise<string> {
    const year = new Date().getFullYear();
    const prefix = `CU-${year}-`;
    const entries = await fsp.readdir(this.rootDir()).catch(() => [] as string[]);
    let max = 0;
    for (const e of entries) {
      if (!e.startsWith(prefix)) continue;
      const n = parseInt(e.slice(prefix.length), 10);
      if (!Number.isNaN(n) && n > max) max = n;
    }
    // Ids of updates the cleanup job removed stay taken.
    max = Math.max(max, await reservedSequence(prefix));
    return `${prefix}${String(max + 1).padStart(4, '0')}`;
  }

  /**
   * `system` is for the server's own jobs, never for a request body: it tags the update with its origin
   * and kind, and names the saved text.
   */
  async create(
    input: { title?: unknown; source_date?: unknown; notes?: unknown; text?: unknown },
    system?: { origin: string; kind: string; textName: string; fields?: Record<string, string> },
  ): Promise<ContextUpdate> {
    const title = typeof input.title === 'string' ? input.title.trim().slice(0, 200) : '';
    const sourceDate = typeof input.source_date === 'string' && input.source_date ? input.source_date : new Date().toISOString().slice(0, 10);
    if (!isDateOnly(sourceDate)) throw httpError(400, 'Invalid source_date: use YYYY-MM-DD');
    const notes = typeof input.notes === 'string' ? input.notes.slice(0, MAX_NOTE * 5) : '';
    const text = typeof input.text === 'string' ? input.text : '';
    if (text.length > MAX_TEXT) throw httpError(413, 'Pasted text is too long; attach it as a file instead');

    await fsp.mkdir(this.rootDir(), { recursive: true });
    // Two saves at the same moment can pick the same number; the exclusive mkdir lets only one win.
    let id = '';
    let dir = '';
    for (let attempt = 0; attempt < 20; attempt++) {
      id = await this.nextId();
      dir = path.join(this.rootDir(), id);
      try { await fsp.mkdir(dir); break; } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        id = '';
      }
    }
    if (!id) throw httpError(409, 'Could not reserve a new context update id; try again');
    await fsp.mkdir(path.join(dir, 'materials'));

    const transcripts: UpdateTranscript[] = [];
    const problems: { source: string; reason: string }[] = [];
    if (text.trim()) {
      const buffer = Buffer.from(text, 'utf-8');
      // A pasted WebVTT export is kept as .vtt and gets a readable transcript next to it, like an upload.
      const pastedVtt = !system && parseWebVtt(text) !== null;
      const name = system?.textName ?? (pastedVtt ? 'pasted-text.vtt' : 'pasted-text.md');
      const prepared = pastedVtt ? prepareTranscript(name, buffer) : null;
      const saved = await saveAttachment(path.join(dir, 'materials'), name, buffer, 'update.md');
      if (prepared && 'content' in prepared) transcripts.push(await this.saveTranscript(path.join(dir, 'materials'), saved.name, buffer, prepared));
      if (prepared && 'problem' in prepared) problems.push({ source: saved.name, reason: prepared.problem });
    }

    const now = new Date().toISOString();
    const data: Record<string, unknown> = {
      schema_version: '1.0',
      id,
      type: 'context-update',
      title: title || `Update ${sourceDate}`,
      ...(system ? { origin: system.origin, kind: system.kind, ...system.fields } : {}),
      status: 'ready',
      source_date: sourceDate,
      created_at: now,
      materials: await this.materialList(dir),
      ...(transcripts.length ? { transcripts } : {}),
      ...(problems.length ? { transcript_problems: problems } : {}),
      proposals: [],
    };
    await this.write(path.join(dir, 'update.md'), data, notes, {});
    return (await this.read(id)).update;
  }

  /**
   * A correction of a meeting's record. Its generated materials are written first and update.md last, so it is never
   * seen half made. Only the dashboard calls this, with the envelope it computed under the corrections lock.
   */
  async createCorrection(input: { title: string; meeting_date: string; notes: string; correction: CorrectionEnvelope; materials: { name: string; content: string }[] }): Promise<ContextUpdate> {
    return this.createSystem(input, { kind: CORRECTION_KIND, correction: input.correction });
  }

  /** A follow-up of a finished correction: an ordinary update, made like a correction (materials first, update.md last). */
  async createFollowUp(input: { title: string; meeting_date: string; notes: string; follows: string; materials: { name: string; content: string }[] }): Promise<ContextUpdate> {
    return this.createSystem(input, { kind: FOLLOW_UP_KIND, follows: input.follows });
  }

  /**
   * An update the dashboard opens with its own materials: the folder reserved, the materials written, update.md last,
   * so until then the folder is no update and nothing can claim it.
   */
  private async createSystem(input: { title: string; meeting_date: string; notes: string; materials: { name: string; content: string }[] }, fields: Record<string, unknown>): Promise<ContextUpdate> {
    await fsp.mkdir(this.rootDir(), { recursive: true });
    await workspaceEntry(workspaceService.getWorkspacePath(), this.rootDir());
    let id = '';
    let dir = '';
    for (let attempt = 0; attempt < 20; attempt++) {
      id = await this.nextId();
      dir = path.join(this.rootDir(), id);
      try { await fsp.mkdir(dir); break; } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        id = '';
      }
    }
    if (!id) throw httpError(409, 'Could not reserve a new context update id; try again');
    await fsp.mkdir(path.join(dir, 'materials'));
    for (const m of input.materials) await saveAttachment(path.join(dir, 'materials'), m.name, Buffer.from(m.content, 'utf-8'), 'update.md');
    const data: Record<string, unknown> = {
      schema_version: '1.0', id, type: 'context-update', title: input.title.slice(0, 200),
      origin: 'meetings', ...fields,
      status: 'ready', source_date: isDateOnly(input.meeting_date) ? input.meeting_date : new Date().toISOString().slice(0, 10),
      created_at: new Date().toISOString(), materials: await this.materialList(dir), proposals: [],
    };
    await this.write(path.join(dir, 'update.md'), data, input.notes, {});
    return (await this.read(id)).update;
  }

  /**
   * A meeting digest, built where nothing can see it and published by writing update.md last: until then the
   * folder is no update (the list, the dashboard and the agent commands need update.md), so it cannot be analyzed,
   * edited or removed half-built. `onReserved` hears the id before anything is written, so a crash can be
   * cleaned up with discardUnpublished. Files are read one at a time from `from` and saved under `name`, which
   * the caller makes unique; transcripts get their readable copies as in an upload.
   */
  async createDigest(
    input: { title: string; source_date: string; notes: string; meetingsText: string; meetings: DigestMeeting[]; files: { name: string; from: string; sha256: string }[]; keep_recordings?: boolean },
    system: { origin: string; kind: string },
    onReserved: (id: string) => Promise<void>,
  ): Promise<ContextUpdate> {
    if (!isDateOnly(input.source_date)) throw httpError(400, 'Invalid source_date: use YYYY-MM-DD');
    await fsp.mkdir(this.rootDir(), { recursive: true });
    await workspaceEntry(workspaceService.getWorkspacePath(), this.rootDir());
    let id = '';
    let dir = '';
    for (let attempt = 0; attempt < 20; attempt++) {
      id = await this.nextId();
      dir = path.join(this.rootDir(), id);
      try { await fsp.mkdir(dir); break; } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        id = '';
      }
    }
    if (!id) throw httpError(409, 'Could not reserve a new context update id; try again');
    await onReserved(id);
    const materials = path.join(dir, 'materials');
    await fsp.mkdir(materials);
    const transcripts: UpdateTranscript[] = [];
    const problems: { source: string; reason: string }[] = [];
    await saveAttachment(materials, 'meetings.md', Buffer.from(input.meetingsText, 'utf-8'), 'update.md');
    // Every original first, then the readable copies: a copy takes a free name, so it can never replace an
    // original saved after it (a "talk.vtt" next to a "talk.transcript.md").
    // Copied as streams and checked afterwards: a recording can be gigabytes.
    for (const file of input.files) {
      if (file.name !== topLevelName(file.name) || file.name.toLowerCase() === 'update.md') throw new Error(`The file name ${file.name} cannot be used`);
      const target = path.join(materials, file.name);
      try {
        await fsp.copyFile(file.from, target, fs.constants.COPYFILE_EXCL);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`The file name ${file.name} is used twice`, { cause: err });
        throw err;
      }
      if ((await hashFile(target)).sha256 !== file.sha256) throw new Error(`${file.name} changed while the digest was being made`);
    }
    for (const file of input.files) {
      const target = path.join(materials, file.name);
      const ext = path.extname(file.name).toLowerCase();
      // A readable copy is made from transcripts and Word files only, and only up to the conversion limit.
      if (!['.vtt', '.txt', '.md', '.docx'].includes(ext)) continue;
      if ((await fsp.stat(target)).size > MAX_CONVERT_BYTES) {
        if (ext === '.vtt' || ext === '.docx') problems.push({ source: file.name, reason: `The file is over ${MAX_CONVERT_BYTES / 1024 / 1024} MB, so no readable copy was made.` });
        continue;
      }
      const buffer = await fsp.readFile(target);
      if (sha256(buffer) !== file.sha256) throw new Error(`${file.name} was not saved as queued`);
      const prepared = prepareTranscript(file.name, buffer);
      if (prepared && 'content' in prepared) transcripts.push(await this.saveTranscript(materials, file.name, buffer, prepared));
      if (prepared && 'problem' in prepared) problems.push({ source: file.name, reason: prepared.problem });
    }
    // A recording's transcript was made by the dashboard, as its readable copy; the digest's own record says so.
    for (const r of input.meetings.flatMap((m) => m.recordings ?? [])) {
      transcripts.push({
        file: r.transcript, source: r.file ?? r.source, source_sha256: r.source_sha256, sha256: r.transcript_sha256,
        complete: r.complete, kind: 'audio', ...(r.file ? {} : { source_removed: true }),
      });
    }
    const data: Record<string, unknown> = {
      schema_version: '1.0',
      id,
      type: 'context-update',
      title: input.title,
      origin: system.origin,
      kind: system.kind,
      status: 'ready',
      source_date: input.source_date,
      created_at: new Date().toISOString(),
      materials: await this.materialList(dir),
      ...(transcripts.length ? { transcripts } : {}),
      ...(problems.length ? { transcript_problems: problems } : {}),
      digest_meetings: input.meetings,
      proposals: [],
    };
    await this.write(path.join(dir, 'update.md'), data, input.notes, input.keep_recordings ? { keep_recordings: true } : {});
    return (await this.read(id)).update;
  }

  /** True while the update's folder exists, published or not. Only a missing folder means no. */
  async exists(id: string): Promise<boolean> {
    try {
      await fsp.lstat(await workspaceEntry(workspaceService.getWorkspacePath(), this.updateDir(id)));
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw err;
    }
  }

  /** True once a digest's update.md is written. Only a missing file means no; any other error is passed on. */
  async published(id: string): Promise<boolean> {
    try {
      const file = await workspaceEntry(workspaceService.getWorkspacePath(), path.join(this.updateDir(id), 'update.md'));
      if (!(await fsp.lstat(file)).isFile()) throw new Error(`${id}/update.md is not a regular file`);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw err;
    }
  }

  /**
   * Removes a digest that was never published: a folder this service reserved for it, without update.md.
   * A published update, or anything that is not a plain folder, is left alone.
   */
  async discardUnpublished(id: string): Promise<void> {
    let dir: string;
    try { dir = await workspaceEntry(workspaceService.getWorkspacePath(), this.updateDir(id)); } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    const st = await fsp.lstat(dir);
    if (!st.isDirectory() || await this.published(id)) throw new Error(`${id} is not an unfinished digest; it was left alone`);
    await fsp.rm(dir, { recursive: true });
  }

  private async materialList(dir: string): Promise<Omit<UpdateMaterial, 'meetings'>[]> {
    const files = await listFolderFiles(path.join(dir, 'materials'));
    return files.map((f) => ({ name: f.name, size: f.size, type: f.type }));
  }

  async edit(id: string, input: { title?: unknown; source_date?: unknown; notes?: unknown }): Promise<ContextUpdate> {
    return this.serialized(id, async () => {
      const { update, data, file } = await this.read(id);
      this.requireStatus(update, ['ready'], 'edit the details');
      await this.requireNoRun(id, 'edit the details');
      const patch: Record<string, unknown> = {};
      if (typeof input.title === 'string' && input.title.trim()) patch['title'] = input.title.trim().slice(0, 200);
      if (input.source_date !== undefined) {
        if (typeof input.source_date !== 'string' || !isDateOnly(input.source_date)) throw httpError(400, 'Invalid source_date: use YYYY-MM-DD');
        patch['source_date'] = input.source_date;
      }
      const body = typeof input.notes === 'string' ? input.notes.slice(0, MAX_NOTE * 5) : update.notes;
      await this.write(file, data, body, patch);
      return (await this.read(id)).update;
    });
  }

  /**
   * Saves one uploaded file. The same file twice in one update is refused: the analysis would read it twice.
   * A WebVTT transcript also gets a readable copy next to it, recorded in `transcripts`; the original is kept.
   * The copy is prepared before anything is written, and a failed write leaves nothing behind, so the same
   * upload can simply be tried again.
   */
  async addMaterial(id: string, originalName: string, buffer: Buffer): Promise<FolderFile & { transcript?: string; transcript_complete?: boolean; transcript_problem?: string }> {
    return this.serialized(id, async () => {
      const { update, data, file } = await this.read(id);
      this.requireStatus(update, ['ready'], 'add material');
      await this.requireNoRun(id, 'add material');
      const dir = path.join(this.updateDir(id), 'materials');
      await fsp.mkdir(dir, { recursive: true });
      const duplicate = await sameFileIn(dir, buffer);
      if (duplicate) throw httpError(409, `This file is already in the update, as ${duplicate}`);

      const name = await uniqueName(dir, originalName);
      const prepared = prepareTranscript(name, buffer);
      const written: string[] = [];
      try {
        const saved = await saveAttachment(dir, name, buffer, 'update.md');
        written.push(saved.name);
        let entry: UpdateTranscript | null = null;
        if (prepared && 'content' in prepared) {
          entry = await this.saveTranscript(dir, saved.name, buffer, prepared);
          written.push(entry.file);
        }
        const problem = prepared && 'problem' in prepared ? { source: saved.name, reason: prepared.problem } : null;
        await this.write(file, data, update.notes, {
          materials: await this.materialList(this.updateDir(id)),
          ...(entry ? { transcripts: [...update.transcripts, entry] } : {}),
          ...(problem ? { transcript_problems: [...update.transcript_problems, problem] } : {}),
        });
        if (entry) return { ...saved, transcript: entry.file, transcript_complete: entry.complete };
        return prepared && 'problem' in prepared ? { ...saved, transcript_problem: prepared.problem } : saved;
      } catch (err) {
        for (const n of written) await fsp.unlink(path.join(dir, n)).catch(() => {});
        throw err;
      }
    });
  }

  /**
   * Writes a prepared copy under a free name that keeps its ending (`.transcript.md` for a WebVTT transcript,
   * `.text.md` for a Word document), and returns its record.
   */
  private async saveTranscript(dir: string, sourceName: string, buffer: Buffer, prepared: PreparedTranscript): Promise<UpdateTranscript> {
    const stem = sourceName.replace(/\.[^.]+$/, '') || 'transcript';
    const ending = prepared.kind === 'docx' ? 'text.md' : 'transcript.md';
    let name = `${stem}.${ending}`;
    for (let n = 2; await fsp.lstat(path.join(dir, name)).then(() => true, () => false); n++) {
      if (n > 999) throw httpError(409, 'Too many files with the same name');
      name = `${stem}-${n}.${ending}`;
    }
    const content = Buffer.from(prepared.content, 'utf-8');
    await saveAttachment(dir, name, content, 'update.md');
    return { file: name, source: sourceName, source_sha256: sha256(buffer), sha256: sha256(content), complete: prepared.complete, kind: prepared.kind };
  }

  /**
   * Removes one file. Removing an original also removes the readable copy the dashboard recorded for it,
   * unless the copy was changed since; removing a copy keeps its original.
   */
  async removeMaterial(id: string, name: string): Promise<void> {
    return this.serialized(id, async () => {
      const { update, data, file } = await this.read(id);
      this.requireStatus(update, ['ready'], 'remove material');
      await this.requireNoRun(id, 'remove material');
      const dir = path.join(this.updateDir(id), 'materials');
      const removed = topLevelName(name);
      await fsp.unlink(await fileInside(dir, removed));
      for (const t of update.transcripts.filter((x) => x.source === removed)) {
        const copy = await fileInside(dir, t.file).catch(() => null);
        const content = copy ? await fsp.readFile(copy).catch(() => null) : null;
        if (copy && content && sha256(content) === t.sha256) await fsp.unlink(copy);
      }
      const transcripts = update.transcripts.filter((x) => x.source !== removed && x.file !== removed);
      const problems = update.transcript_problems.filter((x) => x.source !== removed);
      await this.write(file, data, update.notes, {
        materials: await this.materialList(this.updateDir(id)),
        transcripts: transcripts.length ? transcripts : undefined,
        transcript_problems: problems.length ? problems : undefined,
      });
    });
  }

  async materialPath(id: string, name: string): Promise<string> {
    await this.read(id);
    return fileInside(path.join(this.updateDir(id), 'materials'), name);
  }

  /** Saves the checkboxes and notes while the user reviews, so leaving the page loses nothing. */
  async saveDecisions(id: string, input: unknown): Promise<ContextUpdate> {
    return this.changing(id, async () => {
      const { update, data, file } = await this.read(id);
      this.requireNotFinishing(data);
      this.requireStatus(update, ['in_review'], 'change decisions');
      const decisions = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
      const known = new Set(update.proposals.map((p) => p.id));
      for (const key of Object.keys(decisions)) {
        if (!known.has(key)) throw httpError(400, `Invalid proposal id: ${key}`);
      }
      const proposals = this.rawProposals(data).map((raw, i) => {
        const p = normalizeProposal(raw, i);
        const change = decisions[p.id] as Record<string, unknown> | undefined;
        if (!change || typeof change !== 'object') return raw;
        const next = { ...(raw as Record<string, unknown>) };
        if ('decision' in change) {
          const d = change['decision'];
          if (d !== 'accepted' && d !== 'rejected' && d !== null) throw httpError(400, 'Invalid decision: use accepted, rejected or null');
          next['decision'] = d;
        }
        if ('reviewer_note' in change) {
          if (typeof change['reviewer_note'] !== 'string') throw httpError(400, 'Invalid reviewer_note');
          next['reviewer_note'] = change['reviewer_note'].slice(0, MAX_NOTE) || undefined;
        }
        return next;
      });
      await this.write(file, data, update.notes, { proposals: this.clean(proposals) });
      return (await this.read(id)).update;
    });
  }

  /**
   * Confirms or rejects meeting records while the user reviews, apart from the proposals:
   * `{ "M-01": { "confirmation": "confirmed" | "rejected" | null, "revision": "<the record's revision>" } }`.
   * The revision is the content the user saw: if the record changed since, the choice is refused (409).
   */
  async saveMeetingRecords(id: string, input: unknown): Promise<ContextUpdate> {
    return this.changing(id, async () => {
      await this.requireNoRun(id, 'confirm meeting records');
      const { update, data, file } = await this.read(id);
      this.requireNotFinishing(data);
      this.requireStatus(update, ['in_review'], 'confirm meeting records');
      const choices = (input && typeof input === 'object' && !Array.isArray(input) ? input : {}) as Record<string, unknown>;
      const byId = new Map(update.meeting_records.map((r) => [r.id, r] as const));
      const changes = new Map<string, MeetingRecord['confirmation']>();
      for (const [key, raw] of Object.entries(choices)) {
        const record = key ? byId.get(key) : undefined;
        if (!record) throw httpError(400, `Invalid meeting record id: ${key}`);
        if (update.meeting_records.filter((r) => r.id === key).length > 1) {
          throw httpError(400, `Meeting record ${key} cannot be chosen: another record has the same id`);
        }
        const choice = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
        const value = choice['confirmation'];
        if (value !== 'confirmed' && value !== 'rejected' && value !== null) throw httpError(400, 'Invalid confirmation: use confirmed, rejected or null');
        if (choice['revision'] !== record.revision) throw httpError(409, `Meeting record ${key} changed since you loaded it; review it again`);
        if (value === 'confirmed' && record.problems.length) throw httpError(400, `Meeting record ${key} cannot be confirmed: ${record.problems.join('; ')}`);
        changes.set(key, value);
      }
      const now = new Date().toISOString();
      const normalized = update.meeting_records;
      // Who a speaker is holds for one transcript: its hash stays with the confirmation, also after the materials go.
      const evidence = new Map<string, Record<string, string>>();
      // A correction's speakers rest on the original's transcripts, not on its own materials: settled when it is finished.
      for (const r of normalized) if (changes.get(r.id) === 'confirmed' && r.speakers.length && update.kind !== CORRECTION_KIND) evidence.set(r.id, await this.speakerEvidence(id, r));
      const records = this.rawRecords(data).map((raw, i) => {
        const r = normalized[i]!;
        if (!changes.has(r.id)) return raw;
        const value = changes.get(r.id)!;
        return {
          ...(raw as Record<string, unknown>),
          confirmation: value ?? undefined,
          confirmed_at: value === 'confirmed' ? now : undefined,
          confirmed_hash: value === 'confirmed' ? r.revision : undefined,
          speakers_evidence: evidence.get(r.id),
        };
      });
      await this.write(file, data, update.notes, { meeting_records: this.clean(records) });
      return (await this.read(id)).update;
    });
  }

  /** Every record as written, never cut to a limit: a save must not lose the ones the dashboard flags. */
  private rawRecords(data: Record<string, unknown>): unknown[] {
    return Array.isArray(data['meeting_records']) ? (data['meeting_records'] as unknown[]) : [];
  }

  /**
   * Saves which meeting each record and material file belongs to, as the update becomes done: its record ids are final
   * then, so the link becomes permanent (see meetingLinks). A record or file with no certain meeting has the field
   * removed, so a value an agent wrote never counts. Empty when the update holds no meeting.
   */
  private linkPatch(update: ContextUpdate, data: Record<string, unknown>, records: unknown[] | undefined): Record<string, unknown> {
    const { records: recordLinks, files } = meetingLinks(update);
    if (!recordLinks.size && !files.size) return {};
    const patch: Record<string, unknown> = { meetings_linked_at: new Date().toISOString() };
    if (records) {
      // Raw records line up with the normalized ones, as in frozenRecords.
      patch['meeting_records'] = records.map((raw, i) => {
        const { meeting_id: _old, ...rest } = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
        const id = recordLinks.get(update.meeting_records[i]?.id ?? '');
        return id ? { ...rest, meeting_id: id } : rest;
      });
    }
    if (Array.isArray(data['materials'])) {
      patch['materials'] = (data['materials'] as unknown[]).map((raw) => {
        const { meetings: _old, ...rest } = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
        const ids = files.get(String(rest['name'] ?? ''));
        return ids ? { ...rest, meetings: ids } : rest;
      });
    }
    return patch;
  }

  /**
   * At the end of the review a record nobody confirmed is rejected, like an unticked proposal. A record that
   * changed after the user confirmed it stops the review: the user must look at it again.
   */
  private frozenRecords(update: ContextUpdate, data: Record<string, unknown>): unknown[] | undefined {
    if (!Array.isArray(data['meeting_records'])) return undefined;
    const changed = update.meeting_records.filter((r) => r.changed_since_confirmed);
    if (changed.length) {
      throw httpError(409, `Meeting record ${changed.map((r) => r.id || '(no id)').join(', ')} changed after you confirmed it; review it again`);
    }
    return this.clean(this.rawRecords(data).map((raw, i) => update.meeting_records[i]!.confirmation === 'confirmed'
      ? raw
      : { ...(raw as Record<string, unknown>), confirmation: 'rejected', confirmed_at: undefined, confirmed_hash: undefined }));
  }

  private rawProposals(data: Record<string, unknown>): unknown[] {
    return Array.isArray(data['proposals']) ? (data['proposals'] as unknown[]).slice(0, MAX_PROPOSALS) : [];
  }

  private clean(proposals: unknown[]): unknown[] {
    return proposals.map((p) => {
      if (!p || typeof p !== 'object') return p;
      return Object.fromEntries(Object.entries(p as Record<string, unknown>).filter(([, v]) => v !== undefined));
    });
  }

  /**
   * Freezes the selection: everything not accepted is rejected, every meeting record not confirmed is
   * rejected, and the apply command may run.
   */
  async approve(id: string): Promise<ContextUpdate> {
    // A correction is finished under the corrections lock (outside this update's queue), so only one correction of a
    // version ever becomes the next one, whichever dashboard approves.
    const kind = (await this.read(id).catch(() => null))?.update.kind;
    // A follow-up is approved only while its correction is still the meeting's current version, checked under the same
    // lock a correction finishes under, so a newer one cannot finish in between.
    if (kind === FOLLOW_UP_KIND) {
      return withCorrectionsLock(async () => {
        const { update } = await this.read(id);
        const problem = update.status === 'in_review' ? followUpProblem(update, await this.list()) : null;
        if (problem) throw httpError(409, problem);
        return this.approveQueued(id);
      });
    }
    if (kind !== CORRECTION_KIND) return this.approveQueued(id);
    return withCorrectionsLock(async () => {
      // Approved before and stopped after it became current (a crash, a lost reply): finish it, never check it again.
      if ((await this.read(id)).update.status === 'done') return this.get(id);
      return this.approveQueued(id);
    });
  }

  private async approveQueued(id: string): Promise<ContextUpdate> {
    return this.serialized(id, async () => {
      const { update, data, file } = await this.read(id);
      this.requireStatus(update, ['in_review'], 'approve');
      await this.requireNoRun(id, 'approve');
      let made: Record<string, unknown> = {};
      // A record changed after it was confirmed stops the finish before anything is written.
      if (update.kind === CORRECTION_KIND) { this.frozenRecords(update, data); made = await this.finishCorrection(update, data, file); }
      else await this.checkSpeakerEvidence(id, update, data);
      const records = this.frozenRecords(update, data);
      const confirmed = update.meeting_records.some((r) => r.confirmation === 'confirmed');
      if (!update.proposals.some((p) => p.decision === 'accepted') && !confirmed) {
        throw httpError(400, 'Invalid approval: select at least one proposal or confirm a meeting record, or close the update without changes');
      }
      const proposals = this.rawProposals(data).map((raw, i) => {
        const p = normalizeProposal(raw, i);
        return p.decision === 'accepted' ? raw : { ...(raw as Record<string, unknown>), decision: 'rejected' };
      });
      const now = new Date().toISOString();
      // Removals are carried out here, not by the agent, and a meeting record needs no file. With no file
      // to write there is nothing for the apply command to run.
      const onlyRemovals = update.proposals.every((p) => p.decision !== 'accepted' || p.action === 'remove');
      if (onlyRemovals) {
        const closed = proposals.map((raw, i) => normalizeProposal(raw, i).decision === 'accepted' ? raw : { ...(raw as Record<string, unknown>), outcome: 'skipped' });
        const keepText = await this.keepMeetingText(update);
        await this.write(file, data, update.notes, { status: 'done', approved_at: now, applied_at: now, proposals: closed, meeting_records: records, keep_meeting_text: keepText || undefined, meeting_folders: keepText || undefined, ...this.linkPatch(update, data, records), ...made });
        await this.cleanup({ ...update, status: 'done', keep_meeting_text: keepText, meeting_folders: keepText }, update.keep_materials);
        await this.finishRemovals(id);
      } else {
        // Said before the apply command runs: it then leaves materials/ for the dashboard to keep the meeting text.
        const keepText = await this.keepMeetingText(update);
        await this.write(file, data, update.notes, { status: 'approved', approved_at: now, proposals: proposals, meeting_records: records, keep_meeting_text: keepText || undefined, meeting_folders: keepText || undefined });
      }
      return (await this.read(id)).update;
    });
  }

  /**
   * A correction's checks and, when it changes transcript words, the new version of the meeting's text, written once:
   * - first, what will be written is kept on the update (`finishing`), the update still in review;
   * - then the version is written with a receipt of exactly that;
   * - the caller then marks the correction done, with the version it made.
   * Stopped anywhere, approving again finishes what was kept, without checking again (the new version may be in use
   * by then, which the checks would refuse), and the receipt makes the writer return the version it already wrote.
   * Returns what the done update says about the version. Under the corrections lock and the update's queue.
   */
  private async finishCorrection(update: ContextUpdate, data: Record<string, unknown>, file: string): Promise<Record<string, unknown>> {
    const env = update.correction;
    if (!env) throw httpError(409, `${update.id} does not say what it corrects`);
    let finish = update.finishing;
    // Close works while it wrote nothing; a version it wrote from something else only comes from editing files by hand.
    const wayOut = 'close it and start again (if it already wrote a version of the meeting\'s text, that was changed by hand: restore it from a backup)';
    if (data['finishing'] != null && !finish) throw httpError(409, `${update.id} was being finished, but what it was writing cannot be read: ${wayOut}`);
    if (finish) {
      const record = update.meeting_records[0];
      if (!record || record.revision !== finish.revision || record.confirmation !== 'confirmed') throw httpError(409, `${update.id} changed while it was being finished: ${wayOut}`);
    } else {
      finish = await this.checkCorrection(update, data);
      if (!finish) return {};
      // Kept before anything is written, with the speakers' evidence just checked: a retry finishes exactly this.
      await this.write(file, data, update.notes, { meeting_records: this.clean(this.rawRecords(data)), finishing: finish });
    }
    let to: string;
    try {
      to = await writeCorrectedVersion(workspaceService.getWorkspacePath(), env.meeting, { from_version: finish.from_version, correction: update.id, changes: finish.changes, receipt: finish.receipt });
    } catch (err) {
      // Refused after the writer found no version of this correction (under the folder lock): the correction is in
      // review again. Any other failure (a lock not had, a damaged folder, a version written from something else)
      // proves nothing, so the finish is kept for the next approval.
      const refused = err as { statusCode?: number; written?: string; unwritten?: true };
      if (refused.unwritten) {
        const now = await this.read(update.id);
        await this.write(now.file, now.data, now.update.notes, { finishing: undefined });
      }
      if (refused.written) throw httpError(409, `${update.id} already wrote ${refused.written} from other changes than these, so it cannot be finished; its files were changed by hand: restore them from a backup`);
      throw err;
    }
    return { finishing: undefined, transcript_version: { from: finish.from_version, to, changes: finish.changes } };
  }

  /** Nothing changes a correction while it is being finished, apart from finishing it (or giving it up, below). */
  private requireNotFinishing(data: Record<string, unknown>): void {
    if (data['finishing'] != null) throw httpError(409, 'This correction was being finished when it stopped; approve it again to finish, or close it');
  }

  /**
   * A correction being finished may still be closed, reopened or deleted while it has written no version of the
   * meeting's text: a version it wrote is part of the meeting, so the correction can then only be finished. Under the
   * corrections lock, so no finish (the only writer of its version) runs meanwhile.
   */
  private async requireCanGiveUp(update: ContextUpdate, data: Record<string, unknown>): Promise<void> {
    if (data['finishing'] == null || !update.correction) return;
    const folder = await readFolder(workspaceService.getWorkspacePath(), update.correction.meeting).catch(() => null);
    if (folder?.state === 'none') return;
    if (folder?.state !== 'ok') throw httpError(409, "This correction was being finished, and the meeting's text cannot be read now to check what it wrote; try again later");
    const written = folder.manifest.versions.find((v) => v.made_from === 'correction' && v.correction === update.id);
    if (written) throw httpError(409, `This correction already wrote ${written.id} of the meeting's text: approve it to finish`);
  }

  /**
   * A change to a correction runs under the corrections lock, taken outside the update's queue like its finish, so the
   * two never interleave across dashboards. Other updates are only queued.
   */
  private async changing<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const kind = (await this.read(id).catch(() => null))?.update.kind;
    return kind === CORRECTION_KIND ? withCorrectionsLock(() => this.serialized(id, operation)) : this.serialized(id, operation);
  }

  /** Back from approved to review, before the apply command has started. */
  async backToReview(id: string): Promise<ContextUpdate> {
    return this.changing(id, async () => {
      const { update, data, file } = await this.read(id);
      this.requireNotFinishing(data);
      this.requireStatus(update, ['approved'], 'go back to review');
      await this.write(file, data, update.notes, { status: 'in_review', approved_at: null });
      return (await this.read(id)).update;
    });
  }

  /**
   * Back to "ready" so the user can add material, or because an analysis stopped half way.
   * The old proposals and meeting records are discarded, confirmed or not: the next analysis must see
   * all material at once, and a confirmation belongs to the record the user read.
   */
  async reopen(id: string): Promise<ContextUpdate> {
    return this.changing(id, async () => {
      const { update, data, file } = await this.read(id);
      await this.requireCanGiveUp(update, data);
      this.requireStatus(update, ['analyzing', 'in_review', 'approved'], 'reopen');
      await this.requireNoRun(id, 'reopen');
      await fsp.rm(path.join(this.updateDir(id), 'proposals'), { recursive: true, force: true });
      await this.write(file, data, update.notes, {
        status: 'ready', proposals: [], meeting_records: undefined, skipped: undefined, unread: undefined, summary: undefined,
        analyzed_at: undefined, approved_at: undefined, finishing: undefined,
      });
      return (await this.read(id)).update;
    });
  }

  /**
   * Done without changing any context file. Keeps the record, deletes the drafts, and the materials unless
   * they are kept. Confirmed meeting records stay confirmed: they change no context file.
   */
  async close(id: string): Promise<ContextUpdate> {
    return this.changing(id, async () => {
      const { update, data, file } = await this.read(id);
      await this.requireCanGiveUp(update, data);
      this.requireStatus(update, ['in_review', 'approved'], 'close');
      await this.requireNoRun(id, 'close');
      const proposals = this.rawProposals(data).map((raw) => ({ ...(raw as Record<string, unknown>), decision: 'rejected', outcome: 'skipped' }));
      // Before anything is deleted: a record changed after confirmation stops the close. A correction that is closed
      // is not taken: its record is rejected, so it never becomes the meeting's current version.
      const frozen = this.frozenRecords(update, data);
      const records = update.kind === CORRECTION_KIND && frozen
        ? this.clean(frozen.map((raw) => ({ ...(raw as Record<string, unknown>), confirmation: 'rejected', confirmed_at: undefined, confirmed_hash: undefined })))
        : frozen;
      const keepText = await this.keepMeetingText(update);
      // Done first, then cleaned up: a crash in between leaves a done update whose next read finishes the cleanup,
      // never one still in review whose meeting text already left for meetings/.
      await this.write(file, data, update.notes, { status: 'done', applied_at: new Date().toISOString(), proposals, meeting_records: records, keep_meeting_text: keepText || undefined, meeting_folders: keepText || undefined, finishing: undefined, ...this.linkPatch(update, data, records) });
      await this.cleanup({ ...update, status: 'done', keep_meeting_text: keepText, meeting_folders: keepText }, update.keep_materials);
      return (await this.read(id)).update;
    });
  }

  /**
   * Keeps the original material after the update is done, or releases it. A kept transcript costs disk
   * space, not agent context: agents never read context-updates/ as task input. Released material of a
   * done update is deleted at once; it cannot be kept again because it is gone.
   */
  async keepMaterials(id: string, keep: unknown): Promise<ContextUpdate> {
    if (typeof keep !== 'boolean') throw httpError(400, 'Invalid keep: use true or false');
    return this.changing(id, async () => {
      const { update, data, file } = await this.read(id);
      // While applying, the agent may be deleting the folder; the choice must be made before or after.
      if (keep) this.requireStatus(update, ['ready', 'analyzing', 'in_review', 'approved'], 'keep the materials');
      else this.requireStatus(update, ['ready', 'analyzing', 'in_review', 'approved', 'done'], 'release the materials');
      await this.write(file, data, update.notes, { keep_materials: keep || undefined });
      if (!keep && update.status === 'done') await this.cleanup(update, false);
      return (await this.read(id)).update;
    });
  }

  // ---- one meeting of an update: keep it, delete its text, restore it --------------------------------------------

  /** Keeps one meeting out of System cleanup's Meetings rule, or lets the rule remove it again. */
  async keepMeeting(id: string, key: string, keep: unknown): Promise<ContextUpdate> {
    if (typeof keep !== 'boolean') throw httpError(400, 'Invalid keep: use true or false');
    return this.changing(id, async () => {
      const { update, data, file } = await this.read(id);
      if (!key || !heldMeetings(update).some((m) => m.key === key)) throw httpError(404, `No such meeting in ${updateId(id)}`);
      const kept = new Set(update.kept_meetings);
      if (keep) kept.add(key); else kept.delete(key);
      await this.write(file, data, update.notes, { kept_meetings: kept.size ? [...kept] : undefined });
      return (await this.read(id)).update;
    });
  }

  /**
   * Moves one meeting's text out of a finished update into the trash, where it can be restored. Its confirmed record
   * stays in the update: the context was built from it. A file the meeting shares with another one stays.
   *
   * The note that it was deleted, naming its trash entry, is written before anything moves: a move that fails or stops
   * halfway always leaves a note that restore can follow. A move that fails is undone, and its note goes again.
   */
  async trashMeeting(id: string, key: string, by: DeletedMeeting['by'] = 'user', now = new Date()): Promise<ContextUpdate> {
    // Under the corrections lock, like finishing a correction: a meeting's folder never goes while one writes to it.
    return withCorrectionsLock(() => this.serialized(id, async () => {
      const { update, data, file } = await this.read(id);
      // Before the review is done, the analysis and the apply command still read these files.
      if (update.status !== 'done') throw httpError(409, 'This meeting is still being reviewed: finish its update first, or delete the whole update in Context > Updates');
      const held = heldMeetings(update).find((m) => m.key === key);
      if (!key || !held) throw httpError(404, `No such meeting in ${updateId(id)}`);
      const finishing = (await this.list()).find((u) => u.kind === CORRECTION_KIND && u.correction?.meeting === held.id && u.finish_pending);
      if (finishing) throw httpError(409, `${finishing.id}, a correction of this meeting, is being finished: approve or close it first`);
      if (update.deleted_meetings.some((d) => d.meeting === key)) throw httpError(409, 'This meeting was already deleted');
      const ws = workspaceService.getWorkspacePath();
      const { dir: materials, files, folder } = await this.meetingTextDir(update, key);
      if (!files.length) throw httpError(409, 'Nothing of this meeting is kept here, so there is nothing to delete');
      const label = folder ? path.basename(folder) : `${updateId(id)}-${key}`;
      const entry: DeletedMeeting = { meeting: key, at: now.toISOString(), files, trash: trashName(label, now), by, ...(folder ? { folder: true as const } : {}) };
      const kept = update.kept_meetings.filter((k) => k !== key);
      await this.write(file, data, update.notes, {
        deleted_meetings: [...update.deleted_meetings, entry],
        kept_meetings: kept.length ? kept : undefined,
      });
      try {
        // A meeting's own folder goes whole, its versions and recordings together; older text goes file by file.
        if (folder) await moveToTrash(ws, await workspaceEntry(ws, folder), now, entry.trash!);
        else await moveFilesToTrash(ws, materials, files, label, now, entry.trash!);
      } catch (err) {
        // Whatever moved comes back and the note goes. Should that fail too, the note stays for restore to finish.
        await this.read(id).then((fresh) => this.putBack(fresh.update, fresh.data, fresh.file, entry), () => {});
        throw err;
      }
      return (await this.read(id)).update;
    }));
  }

  /** Puts a deleted meeting's text back where it was. Refused when a file of the same name is there again. */
  async restoreMeeting(id: string, key: string): Promise<ContextUpdate> {
    // Under the corrections lock, like deleting it: a correction is never checked against a folder coming back.
    return withCorrectionsLock(() => this.serialized(id, async () => {
      const { update, data, file } = await this.read(id);
      const entry = update.deleted_meetings.find((d) => d.meeting === key);
      if (!entry?.trash) throw httpError(404, 'This meeting is not in the trash');
      await this.putBack(update, data, file, entry);
      return (await this.read(id)).update;
    }));
  }

  /**
   * Moves what of a deleted meeting is in its trash entry back, and removes the note that it was deleted. What never
   * reached the trash (a move that failed or stopped halfway) is already where it belongs and stays. Nothing moves when
   * something of the same name is both back in place and in the trash, or is in neither.
   */
  private async putBack(update: ContextUpdate, data: Record<string, unknown>, file: string, entry: DeletedMeeting): Promise<void> {
    const ws = workspaceService.getWorkspacePath();
    const from = entry.trash ? await trashEntry(ws, entry.trash) : null;
    const inTrash = from !== null && await fsp.lstat(from).then((st) => st.isDirectory(), () => false);
    const forget = async () => {
      const rest = update.deleted_meetings.filter((d) => d.meeting !== entry.meeting);
      await this.write(file, data, update.notes, { deleted_meetings: rest.length ? rest : undefined });
    };
    if (entry.folder) {
      // Its whole folder, back under meetings/: refused when a folder of that meeting is there again.
      const meeting = heldMeetings(update).find((m) => m.key === entry.meeting);
      if (!meeting || !isMeetingId(meeting.id)) throw httpError(404, `No such meeting in ${updateId(update.id)}`);
      const to = await workspaceEntry(ws, path.join(meetingsRoot(ws), meeting.id), true);
      const there = await fsp.lstat(to).then(() => true, () => false);
      if (inTrash && there) throw httpError(409, `A folder of ${meeting.id} is there again, so nothing was restored`);
      if (!inTrash) {
        // Never moved: only its own folder, still in place, makes this a restore.
        if ((await folderOf(ws, update, meeting))?.state !== 'ok') throw httpError(410, 'This meeting is no longer in the trash');
        return forget();
      }
      await fsp.mkdir(path.dirname(to), { recursive: true });
      await fsp.rename(from!, to);
      return forget();
    }
    // Back where it was taken from: its meeting's folder when it has one, else the update's materials.
    const materials = await workspaceEntry(ws, (await this.meetingTextDir(update, entry.meeting)).dir, true);
    const moving: string[] = [];
    for (const name of entry.files) {
      const back = await fsp.lstat(path.join(materials, name)).then(() => true, () => false);
      const trashed = inTrash && await fsp.lstat(path.join(from!, name)).then((st) => st.isFile(), () => false);
      if (back && trashed) throw httpError(409, `${name} is there again, so nothing was restored`);
      if (!back && !trashed) throw httpError(410, `${name} is no longer in the trash, so nothing was restored`);
      if (trashed) moving.push(name);
    }
    await fsp.mkdir(materials, { recursive: true });
    for (const name of moving) await fsp.rename(path.join(from!, name), path.join(materials, name));
    if (inTrash) await fsp.rm(from!, { recursive: true, force: true });
    return forget();
  }

  /**
   * Deletes a meeting's text from the trash for good. The note that it was deleted stays. A meeting whose text never
   * fully reached the trash (a move that failed or stopped halfway) is restored instead: nothing outside the trash is
   * deleted for good, and it can be deleted again.
   */
  async purgeMeeting(id: string, key: string): Promise<ContextUpdate> {
    return this.serialized(id, async () => {
      const { update, data, file } = await this.read(id);
      const entry = update.deleted_meetings.find((d) => d.meeting === key);
      if (!entry?.trash) throw httpError(404, 'This meeting is not in the trash');
      if (await this.stillInPlace(update, entry)) {
        await this.putBack(update, data, file, entry);
        return (await this.read(id)).update;
      }
      const from = await trashEntry(workspaceService.getWorkspacePath(), entry.trash);
      if (from) await fsp.rm(from, { recursive: true, force: true });
      const deleted = update.deleted_meetings.map((d) => (d.meeting === key ? { meeting: d.meeting, at: d.at, files: d.files, by: d.by } : d));
      await this.write(file, data, update.notes, { deleted_meetings: deleted });
      return (await this.read(id)).update;
    });
  }

  /** Whether some of a deleted meeting's text is still where it was taken from: its move to the trash did not finish. */
  private async stillInPlace(update: ContextUpdate, entry: DeletedMeeting): Promise<boolean> {
    const ws = workspaceService.getWorkspacePath();
    const from = entry.trash ? await trashEntry(ws, entry.trash) : null;
    const inTrash = from !== null && await fsp.lstat(from).then((st) => st.isDirectory(), () => false);
    if (entry.folder) {
      const meeting = heldMeetings(update).find((m) => m.key === entry.meeting);
      return !inTrash && meeting !== undefined && (await folderOf(ws, update, meeting))?.state === 'ok';
    }
    const { dir } = await this.meetingTextDir(update, entry.meeting);
    for (const name of entry.files) {
      const trashed = inTrash && await fsp.lstat(path.join(from!, name)).then((st) => st.isFile(), () => false);
      if (!trashed && await fsp.lstat(path.join(dir, name)).then((st) => st.isFile(), () => false)) return true;
    }
    return false;
  }

  /**
   * Where one meeting's text is kept now, and the plain files of it there: its own folder under meetings/ (every file
   * in it is its own), or, for a meeting kept before meeting folders, the update's materials (without the files it
   * shares with another meeting there).
   */
  private async meetingTextDir(update: ContextUpdate, key: string): Promise<{ dir: string; files: string[]; folder: string | null }> {
    const ws = workspaceService.getWorkspacePath();
    const meeting = heldMeetings(update).find((m) => m.key === key);
    const folder = meeting ? await folderOf(ws, update, meeting) : null;
    if (folder?.state === 'ok') return { dir: folder.versionDir, files: [...await folderFiles(folder)], folder: folder.dir };
    const dir = path.join(this.updateDir(update.id), 'materials');
    const gone = new Set(update.deleted_meetings.map((d) => d.meeting));
    const files: string[] = [];
    for (const name of ownFiles(update, key, gone)) {
      if (await fsp.lstat(path.join(dir, name)).then((st) => st.isFile(), () => false)) files.push(name);
    }
    return { dir, files, folder: null };
  }

  /** Whether this update keeps its meeting text when done: the user keeps meeting text, and it holds meetings. */
  private async keepMeetingText(update: ContextUpdate): Promise<boolean> {
    // Kept recordings keep their meetings' text too, as kept materials did: a recording is read through its transcript.
    if (update.keep_meeting_text || update.keep_recordings) return true;
    return heldMeetings(update).length > 0 && await meetingTextKept();
  }

  /**
   * What a done update no longer needs: its drafts, and its materials unless they are kept. With meeting text kept,
   * only the text of its meetings stays (not their audio, images or decks), until the user or System cleanup removes it.
   */
  private async cleanup(update: ContextUpdate, keepMaterials: boolean): Promise<void> {
    const dir = this.updateDir(update.id);
    if (!keepMaterials) {
      const materials = path.join(dir, 'materials');
      const gone = new Set(update.deleted_meetings.map((d) => d.meeting));
      const keep = update.keep_meeting_text ? meetingTextToKeep(update, gone) : new Set<string>();
      // With Keep recordings, the recordings of its meetings stay too, and go to their folders with the text.
      if (update.keep_recordings) for (const m of heldMeetings(update)) if (!gone.has(m.key)) for (const f of m.files) if (AUDIO_EXTENSIONS.has(path.extname(f).toLowerCase())) keep.add(f);
      if (keep.size && update.meeting_folders && update.status === 'done') {
        // Reviewed meeting text (and kept recordings) leave context-updates/ for each meeting's own folder. What did
        // not move stays here.
        const moved = await moveMeetingText(workspaceService.getWorkspacePath(), update, heldMeetings(update).filter((m) => !gone.has(m.key)), keep);
        for (const name of moved) keep.delete(name);
      }
      if (keep.size === 0) await fsp.rm(materials, { recursive: true, force: true });
      else {
        for (const entry of await fsp.readdir(materials, { withFileTypes: true }).catch(() => [])) {
          // A kept file is a plain file of a meeting; a folder or link with a kept name goes like everything else.
          if (entry.isFile() && keep.has(entry.name)) continue;
          await fsp.rm(path.join(materials, entry.name), { recursive: true, force: true });
        }
      }
    }
    await fsp.rm(path.join(dir, 'proposals'), { recursive: true, force: true });
  }

  /**
   * Moves the update's folder to the trash. Its materials can be the only copy of what was uploaded: a
   * digest's meetings leave the queue once it holds them, recordings and transcripts included. The id
   * stays taken, so digest receipts and run history that name it never point at a newer update.
   */
  async remove(id: string): Promise<void> {
    // Under the corrections lock (outside the update's queue), like starting and finishing a correction: a version
    // never goes while a correction is being checked against it.
    return withCorrectionsLock(() => this.serialized(id, async () => {
      const { update, data } = await this.read(id);
      await this.requireCanGiveUp(update, data);
      // Applying may have written some files already; deleting the record would hide what happened.
      this.requireStatus(update, ['ready', 'analyzing', 'in_review', 'approved', 'done'], 'delete');
      await this.requireNoRun(id, 'delete the update');
      const ws = workspaceService.getWorkspacePath();
      await reserveIds([id]);
      // Its meetings' folders go with it: no update would list them any more.
      await trashFoldersOf(ws, update, heldMeetings(update));
      await moveToTrash(ws, await workspaceEntry(ws, this.updateDir(id)));
    }));
  }
}
