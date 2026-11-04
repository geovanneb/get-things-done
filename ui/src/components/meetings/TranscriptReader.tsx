import React from 'react';
import Card from '@/components/common/Card';
import IconButton, { icons } from '@/components/common/IconButton';
import Notice from '@/components/common/Notice';
import { apiPut } from '@/utils/api';
import { SpeakerNaming } from './SpeakerNaming';
import { clockLine, transcriptParts, type Readable, type TranscriptPart } from '@/utils/transcriptReading';
import type { MeetingParticipant, SpeakerName } from '@/types';

/** A meeting's transcript, read here on the page. Give each transcript its own `key`: what is shown is always of this one. */
export function TranscriptReader({ meetingId, title, transcript, onClose, canName, onNamed, participants = [] }: {
  meetingId: string; title: string; transcript: Readable; onClose: () => void;
  /** Who was expected at the meeting: offered first when naming a speaker. */
  participants?: MeetingParticipant[];
  /** The speakers can be named: a final transcript of a meeting no digest holds yet. */
  canName: boolean;
  onNamed: () => void;
}) {
  const url = `/api/meeting-queue/${meetingId}/transcripts/${encodeURIComponent(transcript.name)}`;
  const [loaded, setLoaded] = React.useState<{ text: string; parts: TranscriptPart[] | null; matches: boolean } | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    const abort = new AbortController();
    fetch(url, { signal: abort.signal })
      .then((res) => { if (!res.ok) throw new Error(`The transcript could not be read (${res.status}).`); return res.text(); })
      .then(async (text) => {
        // Names are saved for the transcript with this hash: only the text that has it may be named.
        const bytes = new TextEncoder().encode(text);
        const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
        if (!abort.signal.aborted) setLoaded({ text, parts: transcriptParts(text), matches: hash === transcript.sha256 });
      })
      .catch((err: Error) => { if (!abort.signal.aborted) setError(err.message); });
    return () => abort.abort();
  }, [url, transcript.sha256]);

  // The stakeholders to choose from: once for the whole transcript, and only when names can be given.
  const naming = canName && Boolean(loaded?.matches);
  const labels = [...new Set((loaded?.parts ?? []).map((p) => p.speaker).filter((s): s is string => Boolean(s)))];
  const nameOf = (label: string) => transcript.names.find((n) => n.label === label);
  // Errors show in the naming row, next to the speaker.
  const name = async (label: string, person: Omit<SpeakerName, 'label'> | null) => {
    await apiPut(`/api/meeting-queue/${meetingId}/recordings/${encodeURIComponent(transcript.file)}/speakers`, { transcript_sha256: transcript.sha256, names: { [label]: person } });
  };

  return (
    <Card
      title={title}
      description={<span role="status">{transcript.file}: {transcript.final ? 'transcript' : 'live transcript, shown until the more accurate one is ready'}</span>}
      actions={<>
        <a href={url} target="_blank" rel="noreferrer" className="gtd-btn gtd-btn--ghost gtd-btn--sm">Open as a file</a>
        <IconButton label="Close the transcript" icon={icons.close} onClick={onClose} />
      </>}
    >
      <div className="gtd-stack" style={{ gap: 'var(--space-3)' }}>
        {labels.length > 0 && transcript.final && (
          <div className="gtd-stack" style={{ gap: 'var(--space-2)', fontSize: 'var(--text-sm)' }}>
            <span style={{ color: 'var(--color-text-secondary)' }}>{canName ? 'Who spoke? Name them here, or leave them for the analysis to propose:' : 'Speakers:'}</span>
            <SpeakerNaming source={{ kind: 'queue', meeting: meetingId, file: transcript.file, transcript_sha256: transcript.sha256 }}
              labels={labels} names={transcript.names} suggestions={transcript.suggestions ?? []} rememberable={transcript.rememberable ?? []}
              modelSha={transcript.modelSha ?? null} participants={participants} editable={naming} onName={name} onChanged={onNamed} />
          </div>
        )}
        {error && <Notice tone="critical">{error}</Notice>}
        <div aria-label="Transcript" tabIndex={0} className="gtd-reading-box">
          {!loaded && !error && <span style={{ color: 'var(--color-text-muted)' }}>Reading the transcript…</span>}
          {loaded?.parts?.length === 0 && <span style={{ color: 'var(--color-text-muted)' }}>No speech was found.</span>}
          {loaded && !loaded.parts && <pre style={{ margin: 0, whiteSpace: 'pre-wrap', font: 'inherit' }}>{loaded.text}</pre>}
          {loaded?.parts?.map((p, i) => (
            <p key={i}>
              <span className="mono" style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', marginRight: 'var(--space-2)' }}>{clockLine(p.time)}</span>
              {p.speaker && (
                <span style={{ fontWeight: 600, marginRight: 6 }}>
                  {nameOf(p.speaker)?.name ?? p.speaker}{nameOf(p.speaker) && <span style={{ fontWeight: 400, color: 'var(--color-text-muted)' }}> ({p.speaker})</span>}:
                </span>
              )}
              {p.text}
            </p>
          ))}
        </div>
      </div>
    </Card>
  );
}
