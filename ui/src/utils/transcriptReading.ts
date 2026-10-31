import type { QueuedMeeting } from '@/types';

/** `speaker`: `Speaker 2`, a label for one recording, when the part is clearly one voice. */
export interface TranscriptPart { time: string; speaker?: string; text: string }

/** The transcript to read of a recording: the final one when there is one, else the live draft. */
export interface Readable { name: string; final: boolean }

/** What can be read of a meeting: of `file`, or of its first recording with something to read. */
export function readableTranscript(meeting: QueuedMeeting, file?: string): Readable | null {
  for (const f of meeting.files) {
    if (!f.recording || (file && f.name !== file)) continue;
    const { transcript, draft } = f.recording;
    if (transcript) return { name: transcript, final: true };
    if (draft) return { name: draft.transcript, final: false };
  }
  return null;
}

/** Whether a transcript of this meeting is still being made or waits its turn. */
export function transcriptOnItsWay(meeting: QueuedMeeting): boolean {
  return meeting.files.some((f) => f.recording?.status === 'pending' || f.recording?.status === 'running');
}

/** `00:12:30` as the live transcript shows it, without the hours of a short meeting: `12:30`. */
export const clockLine = (time: string) => time.replace(/^00:/, '');

/**
 * The parts of a transcript file (see `audioTranscriptMarkdown` on the server): a fence around `[start → end]` lines,
 * each followed by its text. Null when the file is not in that form: an empty list means no speech, and that must be true.
 */
export function transcriptParts(markdown: string): TranscriptPart[] | null {
  const lines = markdown.split('\n');
  const open = lines.findIndex((line) => /^`{3,}text$/.test(line));
  if (open < 0) return null;
  const fence = lines[open]!.slice(0, -'text'.length);
  const close = lines.indexOf(fence, open + 1);
  if (close < 0) return null;
  const parts: TranscriptPart[] = [];
  for (const line of lines.slice(open + 1, close)) {
    const time = /^\[(\d\d:\d\d:\d\d) → \d\d:\d\d:\d\d\]( Speaker \d{1,3})?$/.exec(line);
    const last = parts[parts.length - 1];
    if (time) parts.push({ time: time[1]!, ...(time[2] ? { speaker: time[2].trim() } : {}), text: '' });
    else if (line.startsWith('  ') && last) last.text += (last.text ? ' ' : '') + line.trim();
    else if (line.trim()) return null;
  }
  return parts;
}
