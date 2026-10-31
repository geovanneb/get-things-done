import type { QueuedMeeting } from '@/types';

/** How many meetings the queue shows before "Show more". */
export const SHOWN_MEETINGS = 5;

/** When a recording made in the dashboard started, from its file name, which the dashboard gives it. Null for anything else. */
function recordingStart(m: QueuedMeeting): { minutes: number; seconds?: number } | null {
  for (const f of m.files) {
    // Made in the dashboard: an upload with a name like this is no proof of when it was.
    if (!f.capture || !f.recording) continue;
    const name = /^recording-(\d{4})(\d\d)(\d\d)-(\d\d)(\d\d)(-\d+)?\.wav$/.exec(f.name);
    if (!name || Number(name[4]) > 23 || Number(name[5]) > 59) continue;
    // Recorded on another day than the meeting's date says: a time beside that date would mislead.
    if (`${name[1]}-${name[2]}-${name[3]}` !== m.meeting_date) continue;
    return { minutes: Number(name[4]) * 60 + Number(name[5]), seconds: f.recording.seconds };
  }
  return null;
}

/** When a recorded meeting ran, as `14:58–15:01`: from its start to the length of its transcript. Null when not known. */
export function meetingPeriod(m: QueuedMeeting): string | null {
  const start = recordingStart(m);
  if (!start) return null;
  const two = (n: number) => String(n).padStart(2, '0');
  const at = (minutes: number) => `${two(Math.floor(minutes / 60) % 24)}:${two(minutes % 60)}`;
  return start.seconds ? `${at(start.minutes)}–${at(start.minutes + Math.max(1, Math.round(start.seconds / 60)))}` : at(start.minutes);
}

/**
 * Something about this meeting waits for the user: it is always shown, however old. `installed` are the downloaded
 * models, when known: a recording waiting for one that is not waits for the user.
 */
export function needsYou(m: QueuedMeeting, installed: string[] | null = null): boolean {
  return Boolean(m.live || m.held || m.files.some((f) => {
    const r = f.recording;
    if (!r) return false;
    const missingModel = r.status === 'pending' && installed !== null && Boolean(r.target) && !installed.includes(r.target!.model);
    return missingModel || r.status === 'failed' || r.status === 'stopped' || (r.status === 'partial' && !r.accepted);
  }));
}

/** Newest first, by day, then start time, then when it was added. */
export function newestFirst(meetings: QueuedMeeting[]): QueuedMeeting[] {
  const start = (m: QueuedMeeting) => String(recordingStart(m)?.minutes ?? -1).padStart(4, '0');
  const key = (m: QueuedMeeting) => `${m.meeting_date} ${start(m)} ${m.created_at}`;
  return [...meetings].sort((a, b) => key(b).localeCompare(key(a)));
}

/** What the list shows: what needs you first, then the newest others, at most `limit` of them unless searching. */
export function visibleMeetings(meetings: QueuedMeeting[], query: string, all: boolean, installed: string[] | null = null, limit = SHOWN_MEETINGS): { shown: QueuedMeeting[]; hidden: number } {
  const found = matching(newestFirst(meetings), query);
  if (query.trim() || all) return { shown: found, hidden: 0 };
  const urgent = found.filter((m) => needsYou(m, installed));
  const others = found.filter((m) => !needsYou(m, installed));
  return { shown: [...urgent, ...others.slice(0, limit)], hidden: Math.max(0, others.length - limit) };
}

/** Meetings whose title, date or expected people hold every word of `query`. */
export function matching(meetings: QueuedMeeting[], query: string): QueuedMeeting[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return meetings;
  return meetings.filter((m) => {
    const text = [m.title, m.meeting_date, ...(m.participants ?? []).map((p) => p.name)].join(' ').toLowerCase();
    return words.every((w) => text.includes(w));
  });
}
