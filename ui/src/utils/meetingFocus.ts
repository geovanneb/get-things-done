import type { ContextUpdateProposal, HeldMeetingView, MeetingRecord } from '@/types';

/**
 * Opening a context update's review at one of its meetings (`/context/updates/<id>?meeting=<meeting id>`). Navigation
 * only: nothing here changes what is chosen, counted or approved. Pure, so the page and its tests share it.
 */

/** The link that opens an update's review at one meeting. Other pages (a meeting's dialog, the Meetings list) use it. */
export function meetingReviewHref(updateId: string, meetingId: string): string {
  return `/context/updates/${encodeURIComponent(updateId)}?${new URLSearchParams({ meeting: meetingId })}`;
}

/**
 * The meeting a link asks for, by its place in the update's own order; null for a missing, malformed or unknown id, and
 * for a meeting whose id is not final (`linkable: false`: a record-only meeting while its update is in review, whose
 * record id a new analysis may give to another meeting). Those links open the whole review instead.
 */
export function focusIndex(meetings: readonly HeldMeetingView[], asked: string | null): number | null {
  const id = (asked ?? '').trim();
  if (!id) return null;
  const index = meetings.findIndex((m) => m.id === id);
  return index >= 0 && meetings[index]!.linkable ? index : null;
}

/** "Meeting 2 of 6": where the focused meeting stands, and the meetings before and after it (null at either end). */
export function focusScope(meetings: readonly HeldMeetingView[], index: number): { position: number; total: number; previous: HeldMeetingView | null; next: HeldMeetingView | null } {
  return { position: index + 1, total: meetings.length, previous: meetings[index - 1] ?? null, next: meetings[index + 1] ?? null };
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Characters a file name or id is made of: a name next to one of these is part of a longer name. */
const NAME_CHAR = 'A-Za-z0-9_-';

/**
 * Where `name` (a file name or a record id) stands in `text` exactly, not inside a longer one: `notes.md` is not named
 * by `notes.md.backup` or `old-notes.md`. A full stop right after it ends a sentence only when no name character
 * follows. Each place as [start, end).
 */
function placesOf(text: string, name: string): [number, number][] {
  if (name === '') return [];
  const pattern = new RegExp(`(?<![.${NAME_CHAR}])${escape(name)}(?![${NAME_CHAR}])(?!\\.[${NAME_CHAR}])`, 'gi');
  return [...text.matchAll(pattern)].map((m) => [m.index!, m.index! + m[0].length]);
}

/**
 * The known file names `text` names. A file name may hold a space ("weekly notes.md"), so a shorter known name can
 * stand inside a longer one ("notes.md"): at each place the longest known name wins, and the shorter one does not
 * count there.
 */
function namedFiles(text: string, files: readonly string[]): Set<string> {
  const places = [...new Set(files)].flatMap((name) => placesOf(text, name).map(([start, end]) => ({ name, start, end })));
  const inside = (a: typeof places[number], b: typeof places[number]) => b.end - b.start > a.end - a.start && b.start <= a.start && a.end <= b.end;
  return new Set(places.filter((a) => !places.some((b) => inside(a, b))).map((a) => a.name));
}

/**
 * The meeting id stands in `text`, alone or as the start of a file name: a digest saves each meeting's files as
 * "<meeting id>-<name>" ("MQ-2026-0012-transcript.md"). Never inside a longer id ("MQ-2026-00121").
 */
function namesMeeting(text: string, id: string): boolean {
  return id !== '' && new RegExp(`(^|[^.${NAME_CHAR}])${escape(id)}(?![A-Za-z0-9_])`, 'i').test(text);
}

/**
 * The meetings a proposal cites. Proposals have no field for their meeting: the analysis writes where a fact appears in
 * `evidence` ("MQ-2026-0012-transcript.md, around 00:14:20"). A meeting is cited when its evidence names the meeting's
 * id, one of its files, or the id of its record (M-01). Only `evidence` is read, never the rationale or the diff.
 */
export function proposalMeetings(proposal: Pick<ContextUpdateProposal, 'evidence'>, meetings: readonly HeldMeetingView[], records: readonly Pick<MeetingRecord, 'id'>[]): string[] {
  const text = proposal.evidence ?? '';
  if (!text.trim()) return [];
  const files = namedFiles(text, meetings.flatMap((m) => m.files));
  return meetings.filter((m) => {
    const recordId = m.record_index !== null ? records[m.record_index]?.id ?? '' : '';
    return namesMeeting(text, m.id) || m.files.some((f) => files.has(f)) || placesOf(text, recordId).length > 0;
  }).map((m) => m.id);
}

/** For each meeting, the ids of the proposals that cite it, in the update's order. A proposal citing two meetings is under both. */
export function proposalsByMeeting(proposals: readonly Pick<ContextUpdateProposal, 'id' | 'evidence'>[], meetings: readonly HeldMeetingView[], records: readonly Pick<MeetingRecord, 'id'>[]): { byMeeting: Map<string, string[]>; cited: Map<string, string[]>; uncited: string[] } {
  const byMeeting = new Map<string, string[]>(meetings.map((m) => [m.id, []]));
  const cited = new Map<string, string[]>();
  const uncited: string[] = [];
  for (const p of proposals) {
    const ids = proposalMeetings(p, meetings, records);
    cited.set(p.id, ids);
    if (!ids.length) uncited.push(p.id);
    for (const id of ids) byMeeting.get(id)!.push(p.id);
  }
  return { byMeeting, cited, uncited };
}

/**
 * What is still open across the whole update, whatever meeting is focused: records neither confirmed nor rejected, and
 * proposals ticked. Each record and proposal counts once, also a proposal shown under several meetings.
 */
export function openAcrossUpdate(
  records: readonly MeetingRecord[], choice: (r: MeetingRecord) => MeetingRecord['confirmation'],
  proposals: readonly Pick<ContextUpdateProposal, 'id'>[], accepted: (id: string) => boolean,
): { recordsOpen: number; records: number; selected: number; proposals: number } {
  const ids = new Set(proposals.map((p) => p.id));
  return {
    recordsOpen: records.filter((r) => choice(r) === null).length, records: records.length,
    selected: [...ids].filter(accepted).length, proposals: ids.size,
  };
}

/**
 * Approving decides every meeting of the update: a record left without a choice is rejected, and so is a proposal left
 * unticked. At one meeting some of them are folded away. Before the first Approve there, the review shows them: what to
 * bring into view (the first record still without a choice, else the proposals), or null when nothing is folded away
 * and Approve goes ahead as on the whole page.
 */
export function approveNeedsWholeView(
  focusRecordIndex: number | null, records: readonly MeetingRecord[], choice: (r: MeetingRecord) => MeetingRecord['confirmation'],
  proposals: readonly Pick<ContextUpdateProposal, 'id'>[], shown: ReadonlySet<string>,
): { records: number; proposals: number; first: { record: number } | 'proposals' } | null {
  const open = records.map((r, i) => ({ r, i })).filter(({ r, i }) => i !== focusRecordIndex && choice(r) === null);
  // With no certain record for the meeting, every record is on the page already.
  const hiddenRecords = focusRecordIndex === null ? [] : open;
  const hiddenProposals = proposals.filter((p) => !shown.has(p.id)).length;
  if (!hiddenRecords.length && !hiddenProposals) return null;
  return { records: hiddenRecords.length, proposals: hiddenProposals, first: hiddenRecords.length ? { record: hiddenRecords[0]!.i } : 'proposals' };
}
