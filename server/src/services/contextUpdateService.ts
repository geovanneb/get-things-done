import * as path from 'path';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import { createHash } from 'crypto';
import { WorkspaceService } from './workspace';
import { reservedSequence } from './idReservations';
import { parseMarkdown, stringifyMarkdown } from '../utils/markdown';
import { atomicWrite } from '../utils/atomicWrite';
import { fileInside, workspaceEntry, listFolderFiles, saveAttachment, topLevelName, FolderFile } from '../utils/files';
import { moveToTrash } from './trash';
import { isAnalysisRunning } from './runState';
import { docxMarkdown, docxText, PICTURES } from '../utils/docx';
import { hashFile } from '../utils/fileHash';
import { decodeText, MAX_CONVERT_BYTES, parseWebVtt, sha256, transcriptMarkdown } from '../utils/transcript';
import { TaskService } from './taskService';
import { readManifest } from './scaffold';
import type { Task } from '../types';

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

export interface UpdateMaterial { name: string; size: number; type: string }

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
export interface MeetingActionItem { description: string; owner: MeetingPerson | null; due_date: string; task_ref: string | null; task_found?: boolean }

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
  /** Who opened this update: 'system-cleanup' for the memory review, null for an import by the user. */
  origin: string | null;
  /** What the analysis is about: 'memory-review' reviews the existing memory; 'daily-digest' is meetings from the queue. */
  kind: string | null;
  /** For a meeting digest: which queued meeting each file came from. Written by the dashboard only; kept after the materials go. */
  digest_meetings: DigestMeeting[];
  /** For a Kaizen: the root cause analysis. Null for every other kind. */
  kaizen: KaizenAnalysis | null;
  proposals: UpdateProposal[];
  meeting_records: MeetingRecord[];
  skipped: { topic: string; reason: string }[];
  unread: { name: string; reason: string }[];
}

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

export interface ContextUpdateDetail extends ContextUpdate {
  proposals: ProposalDetail[];
  material_files: FolderFile[];
}

function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode: status });
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
      };
    return { item, index: i };
  }).filter((x) => x.item.description || x.item.owner || x.item.due_date);
}

/** The content a confirmation is bound to, in a fixed order. */
function recordRevision(r: Omit<MeetingRecord, 'confirmation' | 'confirmed_at' | 'revision' | 'problems' | 'changed_since_confirmed'>): string {
  const content = [r.id, r.title, r.meeting_date, r.attendees.map((p) => [p.ref, p.name]), r.decisions, r.open_questions,
    r.action_items.map((a) => [a.description, a.owner ? [a.owner.ref, a.owner.name] : null, a.due_date]), r.source,
    // Only when there are any: a record confirmed before speakers existed stays confirmed.
    ...(r.speakers.length ? [r.speakers.map((s) => [s.label, s.source, s.person ? [s.person.ref, s.person.name] : null, s.reason])] : [])];
  return createHash('sha256').update(JSON.stringify(content)).digest('hex').slice(0, 16);
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
function normalizeRecords(raw: unknown): MeetingRecord[] {
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
    };
    const revision = recordRevision(content);
    const hash = typeof r['confirmed_hash'] === 'string' ? r['confirmed_hash'] : '';
    // A confirmation counts only for the content it was given for. One written without that hash (by hand
    // or by an agent) is not the user's confirmation.
    const confirmedNow = r['confirmation'] === 'confirmed' && hash === revision;
    const confirmedAt = typeof r['confirmed_at'] === 'string' && !Number.isNaN(Date.parse(r['confirmed_at'])) ? r['confirmed_at'] : null;
    return {
      ...content,
      confirmation: confirmedNow ? 'confirmed' as const : r['confirmation'] === 'rejected' ? 'rejected' as const : null,
      confirmed_at: confirmedNow ? confirmedAt : null,
      revision,
      problems,
      changed_since_confirmed: r['confirmation'] === 'confirmed' && hash !== '' && hash !== revision,
    };
  });
  const counts = new Map<string, number>();
  for (const r of records) if (r.id) counts.set(r.id, (counts.get(r.id) ?? 0) + 1);
  for (const r of records) {
    if (r.id && counts.get(r.id)! > 1) r.problems.push(`another record has the same id ${r.id}`);
    if (records.length > MAX_RECORDS) r.problems.push(`more than ${MAX_RECORDS} meeting records in one update`);
  }
  return records;
}

/** What identifies an action item for its task: its content, so the same item always maps to the same task. */
function actionItemKey(a: MeetingActionItem): string {
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
      return { name: str(o['name']), size: Number(o['size']) || 0, type: str(o['type']) };
    })
    : [];
  return {
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
    origin: nullableStr(data['origin']),
    kind: nullableStr(data['kind']),
    digest_meetings: normalizeDigestMeetings(data['digest_meetings']),
    kaizen: normalizeKaizen(data),
    proposals: Array.isArray(data['proposals']) ? (data['proposals'] as unknown[]).slice(0, MAX_PROPOSALS).map(normalizeProposal) : [],
    meeting_records: normalizeRecords(data['meeting_records']),
    skipped: normalizePairs(data['skipped'], 'topic', 'reason'),
    unread: normalizePairs(data['unread'], 'name', 'reason'),
  };
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
  const safe = path.basename(originalName).replace(/[^\w.-]/g, '_') || 'file';
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
      const { update } = await this.read(id);
      const dir = this.updateDir(id);
      // The apply command deletes these itself, but an agent may lack permission to remove folders.
      // A done update never needs them again, so the dashboard finishes the cleanup.
      if (update.status === 'done') {
        await this.cleanup(id, update.keep_materials);
        await this.finishRemovals(id);
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
      return { ...current, proposals, material_files, transcripts };
    });
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
      if (action.task_ref) {
        if (!(await taskExists(tasksDir, action.task_ref))) throw httpError(409, `This action item had a task, ${action.task_ref}, which no longer exists`);
        return { update, task: await taskService.getTask(action.task_ref).catch(() => ({ id: action.task_ref } as Task)), created: false };
      }
      const raws = this.rawRecords(data);
      const raw = raws[index] as Record<string, unknown>;
      const rawItems = Array.isArray(raw['action_items']) ? [...raw['action_items']] : [];
      const rawIndex = shownActionItems(rawItems, [])[item]?.index;
      if (rawIndex === undefined) throw httpError(400, 'Invalid action item');

      // Recorded on the task, so a crash between writing the task and the link cannot lead to a second task.
      const identity = `${update.id}/${record.id}/${actionItemKey(action)}`;
      const found = await taskService.findByMeetingAction(identity);
      const task = found ?? await taskService.createTask(fields as Partial<Task>, { meeting_action: identity });
      const entry = rawItems[rawIndex];
      // A plain-text item becomes an object with the same text, so it can hold the link; what it says is unchanged.
      rawItems[rawIndex] = { ...(entry && typeof entry === 'object' && !Array.isArray(entry) ? entry as Record<string, unknown> : { description: entry }), task_ref: task.id };
      raws[index] = { ...raw, action_items: rawItems };
      await this.write(file, data, update.notes, { meeting_records: raws });
      return { update: (await this.read(id)).update, task, created: !found };
    });
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
    return this.serialized(id, async () => {
      await this.requireNoRun(id, 'change a speaker');
      const { update, data, file } = await this.read(id);
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
   * A meeting digest, built where nothing can see it and published by writing update.md last: until then the
   * folder is no update (the list, the dashboard and the agent commands need update.md), so it cannot be analyzed,
   * edited or removed half-built. `onReserved` hears the id before anything is written, so a crash can be
   * cleaned up with discardUnpublished. Files are read one at a time from `from` and saved under `name`, which
   * the caller makes unique; transcripts get their readable copies as in an upload.
   */
  async createDigest(
    input: { title: string; source_date: string; notes: string; meetingsText: string; meetings: DigestMeeting[]; files: { name: string; from: string; sha256: string }[]; keep_materials?: boolean },
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
    await this.write(path.join(dir, 'update.md'), data, input.notes, input.keep_materials ? { keep_materials: true } : {});
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

  private async materialList(dir: string): Promise<UpdateMaterial[]> {
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
    return this.serialized(id, async () => {
      const { update, data, file } = await this.read(id);
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
    return this.serialized(id, async () => {
      await this.requireNoRun(id, 'confirm meeting records');
      const { update, data, file } = await this.read(id);
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
      for (const r of normalized) if (changes.get(r.id) === 'confirmed' && r.speakers.length) evidence.set(r.id, await this.speakerEvidence(id, r));
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
    return this.serialized(id, async () => {
      const { update, data, file } = await this.read(id);
      this.requireStatus(update, ['in_review'], 'approve');
      await this.requireNoRun(id, 'approve');
      await this.checkSpeakerEvidence(id, update, data);
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
        await this.write(file, data, update.notes, { status: 'done', approved_at: now, applied_at: now, proposals: closed, meeting_records: records });
        await this.cleanup(id, update.keep_materials);
        await this.finishRemovals(id);
      } else {
        await this.write(file, data, update.notes, { status: 'approved', approved_at: now, proposals: proposals, meeting_records: records });
      }
      return (await this.read(id)).update;
    });
  }

  /** Back from approved to review, before the apply command has started. */
  async backToReview(id: string): Promise<ContextUpdate> {
    return this.serialized(id, async () => {
      const { update, data, file } = await this.read(id);
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
    return this.serialized(id, async () => {
      const { update, data, file } = await this.read(id);
      this.requireStatus(update, ['analyzing', 'in_review', 'approved'], 'reopen');
      await this.requireNoRun(id, 'reopen');
      await fsp.rm(path.join(this.updateDir(id), 'proposals'), { recursive: true, force: true });
      await this.write(file, data, update.notes, {
        status: 'ready', proposals: [], meeting_records: undefined, skipped: undefined, unread: undefined, summary: undefined,
        analyzed_at: undefined, approved_at: undefined,
      });
      return (await this.read(id)).update;
    });
  }

  /**
   * Done without changing any context file. Keeps the record, deletes the drafts, and the materials unless
   * they are kept. Confirmed meeting records stay confirmed: they change no context file.
   */
  async close(id: string): Promise<ContextUpdate> {
    return this.serialized(id, async () => {
      const { update, data, file } = await this.read(id);
      this.requireStatus(update, ['in_review', 'approved'], 'close');
      await this.requireNoRun(id, 'close');
      const proposals = this.rawProposals(data).map((raw) => ({ ...(raw as Record<string, unknown>), decision: 'rejected', outcome: 'skipped' }));
      // Before anything is deleted: a record changed after confirmation stops the close.
      const records = this.frozenRecords(update, data);
      await this.cleanup(id, update.keep_materials);
      await this.write(file, data, update.notes, { status: 'done', applied_at: new Date().toISOString(), proposals, meeting_records: records });
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
    return this.serialized(id, async () => {
      const { update, data, file } = await this.read(id);
      // While applying, the agent may be deleting the folder; the choice must be made before or after.
      if (keep) this.requireStatus(update, ['ready', 'analyzing', 'in_review', 'approved'], 'keep the materials');
      else this.requireStatus(update, ['ready', 'analyzing', 'in_review', 'approved', 'done'], 'release the materials');
      await this.write(file, data, update.notes, { keep_materials: keep || undefined });
      if (!keep && update.status === 'done') await this.cleanup(id, false);
      return (await this.read(id)).update;
    });
  }

  private async cleanup(id: string, keepMaterials: boolean): Promise<void> {
    const dir = this.updateDir(id);
    if (!keepMaterials) await fsp.rm(path.join(dir, 'materials'), { recursive: true, force: true });
    await fsp.rm(path.join(dir, 'proposals'), { recursive: true, force: true });
  }

  async remove(id: string): Promise<void> {
    return this.serialized(id, async () => {
      const { update } = await this.read(id);
      // Applying may have written some files already; deleting the record would hide what happened.
      this.requireStatus(update, ['ready', 'analyzing', 'in_review', 'approved', 'done'], 'delete');
      await this.requireNoRun(id, 'delete the update');
      await fsp.rm(this.updateDir(id), { recursive: true, force: true });
    });
  }
}
