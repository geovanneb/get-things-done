import { MeetingHistoryService, type HistoryMeeting } from './meetingHistoryService';
import { StakeholderService } from './stakeholderService';

/**
 * The latest meeting involving a stakeholder (a first slice of #111): derived from confirmed meeting records, never
 * stored. It counts a meeting only when its review is final, its record is linked and confirmed as shown now (the
 * correction's, once one counts), its versions hold (no conflict or broken chain), and the record lists the person by
 * `ref`. Expected participants, speaker names, a name that merely matches, queued or provisional meetings never count.
 * A record lists who took part, not that the user was there: hence "involving them", not "last met".
 */
export interface LastMeeting {
  /** The latest eligible meeting with a known date up to today, or null. */
  last: { id: string; title: string; meeting_date: string } | null;
  /** Eligible meetings exist but none has a known past date: say "date unknown" rather than "no meeting". */
  undated: boolean;
}

const REF = /^(STK|GRP)-\d{4}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

function today(): string {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
}

/** Whether a history row is a confirmed meeting that involved the person. */
export function involves(row: HistoryMeeting, ref: string): boolean {
  return row.review_state === 'final'
    && row.linkable
    && row.record_state === 'linked'
    && row.record?.confirmation === 'confirmed'
    && !(row.correction && (row.correction.state === 'conflict' || row.correction.state === 'broken'))
    && row.attendee_refs.includes(ref);
}

export async function lastMeetingInvolving(ref: string): Promise<LastMeeting> {
  if (!REF.test(ref)) throw Object.assign(new Error('Invalid stakeholder id'), { statusCode: 400 });
  await new StakeholderService().getStakeholder(ref).catch(() => { throw Object.assign(new Error(`Stakeholder not found: ${ref}`), { statusCode: 404 }); });
  const eligible = (await new MeetingHistoryService().list()).filter((row) => involves(row, ref));
  const now = today();
  // A date after today cannot be a meeting that took place; it is treated as not known.
  const dated = eligible.filter((row) => DAY.test(row.record_date) && row.record_date <= now)
    .sort((a, b) => b.record_date.localeCompare(a.record_date) || b.id.localeCompare(a.id));
  const top = dated[0];
  return {
    last: top ? { id: top.id, title: top.title, meeting_date: top.record_date } : null,
    undated: !top && eligible.length > 0,
  };
}
