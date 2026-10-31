import React from 'react';
import Button from '@/components/common/Button';
import { clockLine, transcriptParts, type Readable, type TranscriptPart } from '@/utils/transcriptReading';

const textStyle: React.CSSProperties = { fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', margin: 0 };

/** A meeting's transcript, read here on the page. Give each transcript its own `key`: what is shown is always of this one. */
export function TranscriptReader({ meetingId, title, transcript, onClose }: { meetingId: string; title: string; transcript: Readable; onClose: () => void }) {
  const url = `/api/meeting-queue/${meetingId}/transcripts/${encodeURIComponent(transcript.name)}`;
  const [loaded, setLoaded] = React.useState<{ text: string; parts: TranscriptPart[] | null } | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    const abort = new AbortController();
    fetch(url, { signal: abort.signal })
      .then((res) => { if (!res.ok) throw new Error(`The transcript could not be read (${res.status}).`); return res.text(); })
      .then((text) => { if (!abort.signal.aborted) setLoaded({ text, parts: transcriptParts(text) }); })
      .catch((err: Error) => { if (!abort.signal.aborted) setError(err.message); });
    return () => abort.abort();
  }, [url]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <p role="status" style={{ ...textStyle, flex: 1 }}>{title}: {transcript.final ? 'transcript' : 'live transcript, shown until the more accurate one is ready'}</p>
        <a href={url} target="_blank" rel="noreferrer" style={{ fontSize: 'var(--text-xs)', color: 'var(--color-accent)' }}>Open as a file</a>
        <Button size="sm" variant="ghost" onClick={onClose}>Close</Button>
      </div>
      {error && <p role="alert" style={{ margin: 0, color: 'var(--color-critical)', fontSize: 'var(--text-sm)' }}>{error}</p>}
      <div aria-label="Transcript" tabIndex={0} style={{ maxHeight: 480, minHeight: 120, overflowY: 'auto', padding: 12, borderRadius: 'var(--radius-sm)', background: 'var(--color-surface-hover)', fontSize: 'var(--text-sm)' }}>
        {!loaded && !error && <span style={{ color: 'var(--color-text-muted)' }}>Reading the transcript…</span>}
        {loaded?.parts?.length === 0 && <span style={{ color: 'var(--color-text-muted)' }}>No speech was found.</span>}
        {loaded && !loaded.parts && <pre style={{ margin: 0, whiteSpace: 'pre-wrap', font: 'inherit' }}>{loaded.text}</pre>}
        {loaded?.parts?.map((p, i) => (
          <p key={i} style={{ margin: '0 0 6px' }}>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', marginRight: 8 }}>{clockLine(p.time)}</span>
            {p.text}
          </p>
        ))}
      </div>
    </div>
  );
}
