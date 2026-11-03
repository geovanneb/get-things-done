import { actionItemKey, CORRECTION_KIND, DOUBT_FIELDS, type ContextUpdate, type MeetingPerson, type MeetingRecord, type RecordChange, type RecordVersion } from './contextUpdateService';
import { heldMeetings } from './meetingLibrary';

/**
 * The versions of a meeting's record. The original confirmed record (the root) can be corrected by `meeting-correction`
 * updates; a correction counts once its update is done and its one record is confirmed, and each one corrects the
 * version before it (its `base`). The current record is the end of that chain: the head.
 *
 * Nothing here guesses. Two corrections of the same version are a conflict, and a correction that cannot be reached from
 * the root (an earlier one is missing) leaves the chain broken. Either way the head stays at the last version reached
 * from the root, and the state says so, so nothing builds on a version that may not be the current one.
 *
 * Pure: the updates in, the chain out. Reading them is the caller's business.
 */

export type ChainState = 'original' | 'corrected' | 'conflict' | 'broken';

export interface ChainLink extends RecordVersion {
  /** When the correction was finished; null for the root. */
  at: string | null;
}

export interface CorrectionChain {
  state: ChainState;
  root: { update_id: string; record_id: string };
  /** The current version, reached from the root; null when the root itself is missing or not confirmed. */
  head: ChainLink | null;
  /** The head's record, as confirmed. */
  head_record: MeetingRecord | null;
  /** Every version from the root to the head, in order. */
  links: ChainLink[];
  /** The head is a correction that changed something in the version before it (so it can be followed up). */
  head_changed: boolean;
  /** Corrections of this meeting that are not done yet: one at a time may be open. */
  open: string[];
  /** Corrections that claim this meeting but do not count: not confirmed, malformed, or never reached from the root. */
  invalid: string[];
}

const sameVersion = (a: RecordVersion, b: RecordVersion) => a.update_id === b.update_id && a.record_id === b.record_id && a.revision === b.revision;

/** The one confirmed, problem-free record of a correction that says it amends exactly its base; null otherwise. */
function publishedRecord(u: ContextUpdate): MeetingRecord | null {
  if (u.kind !== CORRECTION_KIND || !u.correction || u.status !== 'done' || u.meeting_records.length !== 1) return null;
  const r = u.meeting_records[0]!;
  if (r.confirmation !== 'confirmed' || r.problems.length || !r.amends || !sameVersion(r.amends, u.correction.base)) return null;
  return r;
}

/**
 * The slots say which original item each corrected one is: one slot per item of the original record, each original item
 * once, with that item's own key. Checked against the original itself, never against the envelope alone.
 */
function slotsMatch(u: ContextUpdate, rootRecord: MeetingRecord): boolean {
  const slots = u.correction!.slots;
  if (slots.length !== rootRecord.action_items.length) return false;
  const seen = new Set<number>();
  return slots.every((s) => {
    const item = rootRecord.action_items[s.root_index];
    if (!item || seen.has(s.root_index)) return false;
    seen.add(s.root_index);
    return actionItemKey(item) === s.root_key;
  });
}

export function correctionChain(meeting: string, root: { update_id: string; record_id: string }, updates: ContextUpdate[]): CorrectionChain {
  const claims = updates.filter((u) => u.kind === CORRECTION_KIND && u.correction?.meeting === meeting
    && u.correction.root.update_id === root.update_id && u.correction.root.record_id === root.record_id);
  const open = claims.filter((u) => u.status !== 'done').map((u) => u.id);
  const published = claims.flatMap((u) => {
    const r = publishedRecord(u);
    return r ? [{ update: u, record: r }] : [];
  });
  const invalid = claims.filter((u) => u.status === 'done' && !publishedRecord(u)).map((u) => u.id);
  // Corrections that name this meeting with another original, or this original with another meeting: never part of the
  // chain, listed, not followed.
  for (const u of updates) {
    if (u.kind !== CORRECTION_KIND || !u.correction || claims.includes(u)) continue;
    const sameRoot = u.correction.root.update_id === root.update_id && u.correction.root.record_id === root.record_id;
    if (u.correction.meeting === meeting || sameRoot) invalid.push(u.id);
  }
  const rootUpdate = updates.find((u) => u.id === root.update_id);
  // The original must be this meeting's own record, as the history links them (the saved link once the update is done,
  // otherwise its digest or source): a correction that names another meeting's record is never a version of this one.
  const owned = Boolean(rootUpdate && heldMeetings(rootUpdate).some((m) => m.id === meeting && m.record?.id === root.record_id));
  const rootRecord = owned && rootUpdate?.status === 'done' ? rootUpdate.meeting_records.find((r) => r.id === root.record_id && r.confirmation === 'confirmed') : undefined;
  const base = { root, open, invalid };
  if (!rootRecord) {
    return { ...base, state: published.length ? 'broken' : 'original', head: null, head_record: null, links: [], head_changed: false };
  }

  let head: ChainLink = { update_id: root.update_id, record_id: rootRecord.id, revision: rootRecord.revision, at: null };
  let headRecord: MeetingRecord = rootRecord;
  const links: ChainLink[] = [head];
  const reached = new Set<string>();
  let state: ChainState = 'original';
  let headChanged = false;
  for (;;) {
    const next = published.filter((p) => sameVersion(p.update.correction!.base, head) && !reached.has(p.update.id) && slotsMatch(p.update, rootRecord));
    if (next.length === 0) break;
    if (next.length > 1) { state = 'conflict'; for (const p of next) reached.add(p.update.id); break; }
    const p = next[0]!;
    reached.add(p.update.id);
    head = { update_id: p.update.id, record_id: p.record.id, revision: p.record.revision, at: p.update.applied_at ?? p.update.updated_at ?? null };
    headChanged = recordDiff(headRecord, p.record).length > 0;
    headRecord = p.record;
    links.push(head);
    state = 'corrected';
  }
  // A finished correction the walk never reached: an earlier one is missing, or it corrects a version that never was.
  const unreached = published.filter((p) => !reached.has(p.update.id));
  if (unreached.length && state !== 'conflict') state = 'broken';
  invalid.push(...unreached.map((p) => p.update.id));
  return { ...base, state, head, head_record: headRecord, links, head_changed: state === 'corrected' && headChanged };
}

/**
 * The identity of the original action item a corrected item stands for, as the original's own conversion writes it
 * on a task (`<update>/<record>/<key>`): never inferred from the item's position or text.
 */
export function rootActionIdentity(correction: NonNullable<ContextUpdate['correction']>, slot: string): string | null {
  const s = correction.slots.find((x) => x.slot === slot);
  return s ? `${correction.root.update_id}/${correction.root.record_id}/${s.root_key}` : null;
}

/** One field of a record that a correction changed: how it read in the version corrected and how it reads now. */
export interface FieldChange { field: RecordChange['field']; before: string[]; after: string[] }

// Quoted, the link named apart: a name can never read as another name with a link, or the other way round.
const personText = (p: MeetingPerson | null) => (p ? `${JSON.stringify(p.name)}${p.ref ? ` (stakeholder ${p.ref})` : ''}` : '');

/** Each field of a record as the lines a reader sees. */
export function fieldLines(r: MeetingRecord): Record<RecordChange['field'], string[]> {
  return {
    title: [r.title],
    meeting_date: [r.meeting_date],
    attendees: r.attendees.map(personText),
    speakers: r.speakers.map((s) => `${s.label} in ${s.source}: ${personText(s.person) || 'unknown'}${s.reason ? ` (${s.reason})` : ''}`),
    decisions: r.decisions,
    open_questions: r.open_questions,
    // The description quoted, so text in it never reads as an owner or a date.
    action_items: r.action_items.map((a) => [JSON.stringify(a.description), `owner: ${personText(a.owner) || 'none'}`, `due: ${a.due_date || 'none'}`].join(' · ')),
  };
}

/**
 * What a correction actually changed, field by field, worked out from the two records. The agent's explanations
 * annotate this; they never stand in for it, so a change the agent did not explain still shows.
 */
export function recordDiff(before: MeetingRecord, after: MeetingRecord): FieldChange[] {
  const a = fieldLines(before);
  const b = fieldLines(after);
  const x = fieldValues(before);
  const y = fieldValues(after);
  // Whether a field changed is decided on its values, never on the lines shown: two different values can read alike.
  return DOUBT_FIELDS.filter((f) => JSON.stringify(x[f]) !== JSON.stringify(y[f])).map((field) => ({ field, before: a[field], after: b[field] }));
}

const personValue = (p: MeetingPerson | null) => (p ? [p.ref, p.name] : null);

/**
 * Each field of a record as the single values the analysis can quote: a title, a name, a decision, an item's
 * description, owner or date. What a change marked not sure is checked against.
 */
export function fieldTexts(r: MeetingRecord): Record<RecordChange['field'], string[]> {
  return {
    title: [r.title],
    meeting_date: [r.meeting_date],
    attendees: r.attendees.map((p) => p.name),
    speakers: r.speakers.flatMap((s) => (s.person ? [s.person.name] : [])),
    decisions: r.decisions,
    open_questions: r.open_questions,
    action_items: r.action_items.flatMap((i) => [i.description, ...(i.owner ? [i.owner.name] : []), ...(i.due_date ? [i.due_date] : [])]),
  };
}

/** Doubts of the version corrected that the corrected record no longer has: shown, never dropped silently. */
export function doubtsDropped(before: MeetingRecord, after: MeetingRecord): MeetingRecord['unsure'] {
  const key = (d: MeetingRecord['unsure'][number]) => JSON.stringify([d.field, d.value]);
  const kept = new Set(after.unsure.map(key));
  return before.unsure.filter((d) => !kept.has(key(d)));
}

/** Each field of a record as values: what decides whether a correction changed it. */
function fieldValues(r: MeetingRecord): Record<RecordChange['field'], unknown> {
  return {
    title: r.title,
    meeting_date: r.meeting_date,
    attendees: r.attendees.map(personValue),
    speakers: r.speakers.map((s) => [s.label, s.source, personValue(s.person), s.reason]),
    decisions: r.decisions,
    open_questions: r.open_questions,
    action_items: r.action_items.map((i) => [i.description, personValue(i.owner), i.due_date]),
  };
}
