import React from 'react';
import Button from '@/components/common/Button';
import Notice from '@/components/common/Notice';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import { SearchInput } from '@/components/common/Input';
import { copyText } from '@/components/context-updates/shared';
import { clockLine, transcriptTurns, type TranscriptPart } from '@/utils/transcriptReading';

/**
 * One transcript or set of notes of a meeting, read in place: the turns of a transcript with their time and speaker,
 * or the text as it is. Give it a `key` per file, so what is shown is always of that file. Read-only.
 */
export function MeetingText({ url, names = {} }: { url: string; names?: Record<string, string> }) {
  const [loaded, setLoaded] = React.useState<{ text: string; turns: TranscriptPart[] | null } | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [find, setFind] = React.useState('');
  const [copied, setCopied] = React.useState(false);
  const [attempt, setAttempt] = React.useState(0);
  React.useEffect(() => {
    const abort = new AbortController();
    setLoaded(null);
    setError(null);
    fetch(url, { signal: abort.signal })
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => null) as { message?: string } | null;
          throw new Error(body?.message ?? `The text could not be read (${res.status}). Try again.`);
        }
        return res.text();
      })
      .then((text) => { if (!abort.signal.aborted) setLoaded({ text, turns: transcriptTurns(text) }); })
      .catch((err: Error) => { if (!abort.signal.aborted) setError(err.message); });
    return () => abort.abort();
  }, [url, attempt]);

  const words = find.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = loaded?.turns?.filter((t) => words.every((w) => `${t.speaker ?? ''} ${t.text}`.toLowerCase().includes(w))) ?? null;

  return (
    <div className="gtd-stack" style={{ gap: 'var(--space-3)', minHeight: 0 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-2)' }}>
        {loaded?.turns && <SearchInput value={find} onChange={setFind} placeholder="Find in the transcript" size="sm" width={260} />}
        <span style={{ flex: 1 }} />
        <Button size="sm" variant="secondary" disabled={!loaded}
          onClick={async () => { if (loaded && await copyText(loaded.text)) { setCopied(true); setTimeout(() => setCopied(false), 2000); } }}>
          {copied ? 'Copied' : 'Copy text'}
        </Button>
        <a href={url} target="_blank" rel="noreferrer" className="gtd-btn gtd-btn--ghost gtd-btn--sm">Open as a file</a>
      </div>
      {error && <Notice tone="critical" title="Could not read this file." action={<Button size="sm" variant="secondary" onClick={() => setAttempt((n) => n + 1)}>Try again</Button>}>{error}</Notice>}
      {!loaded && !error && <LoadingSpinner text="Reading the transcript…" />}
      {loaded && (
        <div aria-label="Transcript text" tabIndex={0} className="gtd-reading-box">
          {!loaded.turns && <pre style={{ margin: 0, whiteSpace: 'pre-wrap', font: 'inherit' }}>{loaded.text}</pre>}
          {loaded.turns?.length === 0 && <span style={{ color: 'var(--color-text-muted)' }}>No speech was found.</span>}
          {shown && shown.length === 0 && loaded.turns!.length > 0 && <span style={{ color: 'var(--color-text-muted)' }}>Nothing matches "{find}".</span>}
          {shown?.map((p, i) => (
            <p key={i}>
              <span className="mono" style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', marginRight: 'var(--space-2)' }}>{clockLine(p.time)}</span>
              {p.speaker && (
                <span style={{ fontWeight: 600, marginRight: 'var(--space-1)' }}>
                  {names[p.speaker] ?? p.speaker}{names[p.speaker] && <span style={{ fontWeight: 400, color: 'var(--color-text-muted)' }}> ({p.speaker})</span>}:
                </span>
              )}
              {p.text}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
