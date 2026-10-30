import React from 'react';
import { useDataVersion } from '@/store';
import { clockOf, emptyLive, mergeLive, type LivePiece, type LiveState } from '@/utils/liveTranscript';

interface LiveAnswer { generation: string | null; status: string; reason: string | null; next: number; segments: LivePiece[] }

/** How often it looks anyway: a notice can be missed, and the server only says there is more. */
const POLL_MS = 5000;

/**
 * The transcript of the recording being made, as it arrives. It reads on from its last number whenever the server
 * says there is more, so a reload or a lost connection only costs a moment. Follows the end unless the reader scrolled up.
 */
export function LiveTranscript({ meetingId }: { meetingId: string }) {
  const [live, setLive] = React.useState<LiveState>(emptyLive);
  const [status, setStatus] = React.useState<{ status: string; reason: string | null } | null>(null);
  const [following, setFollowing] = React.useState(true);
  const box = React.useRef<HTMLDivElement>(null);
  const cursor = React.useRef(0);
  const version = useDataVersion('live-transcript');

  React.useEffect(() => { cursor.current = 0; setLive(emptyLive); setStatus(null); }, [meetingId]);

  // One read at a time, however many notices arrive; the poll waits for the read before it, and leaving aborts it.
  const readNow = React.useRef<(() => void) | null>(null);
  React.useEffect(() => {
    const abort = new AbortController();
    let stopped = false;
    let reading = false;
    let again = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      if (reading) { again = true; return; }
      reading = true;
      try {
        // More than one page may wait after a reload.
        for (let page = 0; page < 20 && !stopped; page++) {
          // Any failure, the body too, just waits for the next poll.
          const answer = await fetch(`/api/meeting-queue/${meetingId}/recording/transcript?from=${cursor.current}`, { signal: abort.signal })
            .then((res) => (res.ok ? res.json() as Promise<LiveAnswer> : null))
            .catch(() => null);
          if (!answer || stopped) return;
          setStatus({ status: answer.status, reason: answer.reason });
          setLive((s) => mergeLive(s, answer.generation, answer.segments, answer.next));
          cursor.current = Math.max(cursor.current, answer.next);
          if (answer.segments.length === 0) return;
        }
      } finally {
        reading = false;
        if (again && !stopped) { again = false; void read(); }
      }
    };
    readNow.current = () => void read();
    const poll = async () => {
      await read();
      if (!stopped) timer = setTimeout(() => void poll(), POLL_MS);
    };
    void poll();
    return () => { stopped = true; readNow.current = null; abort.abort(); if (timer) clearTimeout(timer); };
  }, [meetingId]);

  // A notice only says there is more.
  React.useEffect(() => { readNow.current?.(); }, [version]);

  React.useEffect(() => {
    if (following && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [live.pieces, following]);

  const onScroll = () => {
    const el = box.current;
    if (el) setFollowing(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
  };

  const note = status?.status === 'loading' ? 'Loading the model…'
    : status?.status === 'unavailable' || status?.status === 'stopped' ? (status.reason ?? 'No live transcript for this recording; it is transcribed after the meeting.')
      : status?.status === 'finishing' ? 'Finishing the transcript…' : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {note && <p role="status" style={{ margin: 0, fontSize: 'var(--text-xs)', color: status?.status === 'stopped' ? 'var(--color-warning)' : 'var(--color-text-muted)' }}>{note}</p>}
      <div ref={box} onScroll={onScroll} aria-label="Live transcript" aria-live="off" tabIndex={0}
        style={{ maxHeight: 360, minHeight: 120, overflowY: 'auto', padding: 12, borderRadius: 'var(--radius-sm)', background: 'var(--color-surface-hover)', fontSize: 'var(--text-sm)', lineHeight: 1.5 }}>
        {live.pieces.length === 0
          ? <span style={{ color: 'var(--color-text-muted)' }}>The text appears here as people speak.</span>
          : live.pieces.map((p) => (
            <p key={p.i} style={{ margin: '0 0 6px' }}>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', marginRight: 8 }}>{clockOf(p.start)}</span>
              {p.text}
            </p>
          ))}
      </div>
      {!following && (
        <button type="button" onClick={() => setFollowing(true)}
          style={{ alignSelf: 'flex-start', border: 'none', background: 'transparent', color: 'var(--color-accent)', cursor: 'pointer', padding: 0, fontSize: 'var(--text-xs)' }}>Jump to the latest</button>
      )}
    </div>
  );
}
