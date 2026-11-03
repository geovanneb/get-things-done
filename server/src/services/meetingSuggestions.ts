import type { RecordChange } from './contextUpdateService';

/**
 * Where one whole value of a meeting record sits: a title or date, an entry of a list, a person's name, or an action
 * item's description, owner or due date. Works on a record as the agent wrote it and on one as the dashboard reads it,
 * so a suggestion is found and used the same way in both. Pure: records in, records out.
 */
export interface ValueAt { field: RecordChange['field']; index: number | null; prop: 'value' | 'name' | 'description' | 'owner' | 'due_date' }

type Rec = Record<string, unknown>;
const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const date = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : text(v));
const obj = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? v as Rec : null);
const nameOf = (p: unknown) => (typeof p === 'string' ? p.trim() : text(obj(p)?.['name']));
const list = (r: Rec, key: string) => (Array.isArray(r[key]) ? r[key] as unknown[] : []);

/** Every place the field holds exactly `value` (whole, trimmed, case as written). An empty value is never found. */
export function locate(r: Rec, field: RecordChange['field'], value: string): ValueAt[] {
  if (!value) return [];
  const at = (index: number | null, prop: ValueAt['prop']): ValueAt => ({ field, index, prop });
  switch (field) {
    case 'title': return text(r['title']) === value ? [at(null, 'value')] : [];
    case 'meeting_date': return date(r['meeting_date']) === value ? [at(null, 'value')] : [];
    case 'decisions':
    case 'open_questions': return list(r, field).flatMap((t, i) => (text(t) === value ? [at(i, 'value')] : []));
    case 'attendees': return list(r, field).flatMap((p, i) => (nameOf(p) === value ? [at(i, 'name')] : []));
    case 'speakers': return list(r, field).flatMap((s, i) => (nameOf(obj(s)?.['person']) === value ? [at(i, 'name')] : []));
    case 'action_items': return list(r, field).flatMap((a, i) => {
      const o = obj(a);
      const found: ValueAt[] = [];
      if ((o ? text(o['description']) : text(a)) === value) found.push(at(i, 'description'));
      if (o && nameOf(o['owner']) === value) found.push(at(i, 'owner'));
      if (o && date(o['due_date']) === value) found.push(at(i, 'due_date'));
      return found;
    });
  }
}

/** The stakeholder link of the person at a place, or null (not a person, or not linked). */
export function linkAt(r: Rec, v: ValueAt): string | null {
  const entry = v.index === null ? null : list(r, v.field)[v.index];
  const person = v.field === 'speakers' ? obj(entry)?.['person'] : v.prop === 'owner' ? obj(entry)?.['owner'] : v.prop === 'name' ? entry : null;
  const ref = obj(person)?.['ref'];
  return typeof ref === 'string' && ref.trim() ? ref.trim() : null;
}

/** A person with a new name: its link goes with the old name, unless one is given to put back. Other keys stay. */
function renamed(p: unknown, name: string, ref: string | null): unknown {
  const o = obj(p);
  if (!o) return ref ? { ref, name } : name;
  const { ref: _old, ...rest } = o;
  return { ...rest, ...(ref ? { ref } : {}), name };
}

/** The record with the value at `v` replaced, nothing else changed. A copy: the record given is never touched. */
export function setAt(r: Rec, v: ValueAt, value: string, ref: string | null = null): Rec {
  if (v.index === null) return { ...r, [v.field]: value };
  const entries = [...list(r, v.field)];
  const entry = entries[v.index];
  const o = obj(entry);
  if (v.field === 'attendees') entries[v.index] = renamed(entry, value, ref);
  else if (v.field === 'speakers') entries[v.index] = { ...o, person: renamed(o?.['person'], value, ref) };
  else if (v.field === 'action_items') {
    if (v.prop === 'description') entries[v.index] = o ? { ...o, description: value } : value;
    else if (v.prop === 'owner') entries[v.index] = { ...o, owner: renamed(o?.['owner'], value, ref) };
    else entries[v.index] = { ...o, due_date: value };
  } else entries[v.index] = value;
  return { ...r, [v.field]: entries };
}

/** Whether a value can stand where `v` is: dates are YYYY-MM-DD, everything else is text that is not empty. */
export function fits(v: ValueAt, value: string): boolean {
  if (v.field === 'meeting_date' || v.prop === 'due_date') return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
  return value.trim().length > 0;
}

/** The value at a place, as `locate` reads it: '' when the place holds nothing (or is not there). */
export function valueAt(r: Rec, v: ValueAt): string {
  if (v.index === null) return v.field === 'meeting_date' ? date(r[v.field]) : text(r[v.field]);
  const entry = list(r, v.field)[v.index];
  const o = obj(entry);
  if (v.field === 'attendees') return nameOf(entry);
  if (v.field === 'speakers') return nameOf(o?.['person']);
  if (v.field === 'action_items') return v.prop === 'description' ? (o ? text(o['description']) : text(entry)) : v.prop === 'owner' ? nameOf(o?.['owner']) : date(o?.['due_date']);
  return text(entry);
}

/**
 * For a record as the agent wrote it: the position in the file of each entry the dashboard shows, in order. Entries
 * with nothing in them are not shown (as when the record is read), so the n-th shown entry is not always the n-th in
 * the file. Speakers are all shown.
 */
export function shownPositions(r: Rec, field: RecordChange['field']): number[] {
  const entries = list(r, field);
  const shown = (e: unknown) => {
    const o = obj(e);
    switch (field) {
      case 'attendees': return Boolean(nameOf(e) || (o && text(o['ref'])));
      case 'speakers': return true;
      case 'action_items': return o ? Boolean(text(o['description']) || nameOf(o['owner']) || text(obj(o['owner'])?.['ref']) || date(o['due_date'])) : Boolean(text(e));
      default: return Boolean(text(e));
    }
  };
  return entries.flatMap((e, i) => (shown(e) ? [i] : []));
}

/** The same place in a record as the agent wrote it, or null when that entry is not there. */
export function inFile(r: Rec, v: ValueAt): ValueAt | null {
  if (v.index === null) return v;
  const at = shownPositions(r, v.field)[v.index];
  return at === undefined ? null : { ...v, index: at };
}

export const samePlace = (a: ValueAt, b: ValueAt) => a.field === b.field && a.index === b.index && a.prop === b.prop;
