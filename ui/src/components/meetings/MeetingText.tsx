import React from 'react';
import Button from '@/components/common/Button';
import Notice from '@/components/common/Notice';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import { SearchInput } from '@/components/common/Input';
import { copyText } from '@/components/context-updates/shared';
import { clockLine, transcriptTurns, type TranscriptPart } from '@/utils/transcriptReading';

/** `00:12:30` in seconds. */
const secondsOf = (time: string) => time.split(':').reduce((total, part) => total * 60 + Number(part), 0);

/**
 * One transcript or set of notes of a meeting, read in place: the turns of a transcript with their time and speaker,
 * or the text as it is. Give it a `key` per file, so what is shown is always of that file. Read-only.
 *
 * With `audio` (the recording the transcript was made from, while it is kept), a player is shown above the text, each
 * time plays the recording from there, and the turn being heard is marked.
 */
export function MeetingText({ url, names = {}, audio }: { url: string; names?: Record<string, string>; audio?: { url: string; label: string } }) {
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

  const player = React.useRef<HTMLAudioElement>(null);
  const [heard, setHeard] = React.useState<TranscriptPart | null>(null);
  const [audioError, setAudioError] = React.useState(false);
  const starts = React.useMemo(() => (loaded?.turns ?? []).map((t) => secondsOf(t.time)), [loaded]);
  const follow = () => {
    const now = player.current?.currentTime ?? 0;
    let at = -1;
    for (let i = 0; i < starts.length && starts[i]! <= now; i++) at = i;
    const turn = at >= 0 ? loaded!.turns![at]! : null;
    if (turn !== heard) setHeard(turn);
  };
  const playFrom = (time: string) => {
    const el = player.current;
    if (!el) return;
    el.currentTime = secondsOf(time);
    // Autoplay rules may refuse play(); the player then stays at that time for the user to start.
    void el.play().catch(() => {});
  };
  const playing = Boolean(audio && !audioError);

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
      {audio && (
        <div className="gtd-stack" style={{ gap: 'var(--space-2)' }}>
          <audio ref={player} controls preload="metadata" src={audio.url} aria-label={audio.label} style={{ width: '100%' }}
            onTimeUpdate={follow} onSeeked={follow} onError={() => setAudioError(true)} />
          {audioError && <Notice tone="warning" title="The recording could not be played here.">Open it from the Files tab to play it in another app. The transcript is still here.</Notice>}
        </div>
      )}
      {error && <Notice tone="critical" title="Could not read this file." action={<Button size="sm" variant="secondary" onClick={() => setAttempt((n) => n + 1)}>Try again</Button>}>{error}</Notice>}
      {!loaded && !error && <LoadingSpinner text="Reading the transcript…" />}
      {loaded && (
        <div aria-label="Transcript text" tabIndex={0} className="gtd-reading-box">
          {!loaded.turns && <pre style={{ margin: 0, whiteSpace: 'pre-wrap', font: 'inherit' }}>{loaded.text}</pre>}
          {loaded.turns?.length === 0 && <span style={{ color: 'var(--color-text-muted)' }}>No speech was found.</span>}
          {shown && shown.length === 0 && loaded.turns!.length > 0 && <span style={{ color: 'var(--color-text-muted)' }}>Nothing matches "{find}".</span>}
          {shown?.map((p, i) => (
            <p key={i} className={playing && p === heard ? 'gtd-reading-box__heard' : undefined} aria-current={playing && p === heard ? 'time' : undefined}>
              {playing
                ? <Button size="sm" variant="ghost" className="gtd-reading-box__time" aria-label={`Play from ${clockLine(p.time)}`} onClick={() => playFrom(p.time)}>{clockLine(p.time)}</Button>
                : <span className="mono" style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', marginRight: 'var(--space-2)' }}>{clockLine(p.time)}</span>}
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
