import React from 'react';
import Button from '@/components/common/Button';
import { useApi } from '@/hooks/useApi';
import { useDataVersion } from '@/store';
import { apiPut } from '@/utils/api';
import { speakerChoices, type SpeakerChoice } from '@/utils/speakerChoices';
import { clockLine, transcriptParts, type Readable, type TranscriptPart } from '@/utils/transcriptReading';
import type { MeetingParticipant, SpeakerName, Stakeholder } from '@/types';

const textStyle: React.CSSProperties = { fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', margin: 0 };

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
  const [nameError, setNameError] = React.useState<string | null>(null);
  const name = async (label: string, person: Omit<SpeakerName, 'label'> | null) => {
    setNameError(null);
    try {
      await apiPut(`/api/meeting-queue/${meetingId}/recordings/${encodeURIComponent(transcript.file)}/speakers`, { transcript_sha256: transcript.sha256, names: { [label]: person } });
      onNamed();
    } catch (err) {
      setNameError((err as Error).message);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <p role="status" style={{ ...textStyle, flex: 1 }}>{title}: {transcript.final ? 'transcript' : 'live transcript, shown until the more accurate one is ready'}</p>
        <a href={url} target="_blank" rel="noreferrer" style={{ fontSize: 'var(--text-xs)', color: 'var(--color-accent)' }}>Open as a file</a>
        <Button size="sm" variant="ghost" onClick={onClose}>Close</Button>
      </div>
      {labels.length > 0 && transcript.final && (
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, fontSize: 'var(--text-xs)' }}>
          <span style={{ color: 'var(--color-text-muted)' }}>{canName ? 'Who spoke? Name them here, or leave them for the analysis to propose:' : 'Speakers:'}</span>
          {naming
            ? <SpeakerEditors labels={labels} nameOf={nameOf} participants={participants} onName={(label, person) => void name(label, person)} />
            : labels.map((label) => <SpeakerNamer key={label} label={label} named={nameOf(label)} editable={false} choices={[]} onName={() => {}} />)}
        </div>
      )}
      {nameError && <p role="alert" style={{ margin: 0, color: 'var(--color-critical)', fontSize: 'var(--text-xs)' }}>{nameError}</p>}
      {error && <p role="alert" style={{ margin: 0, color: 'var(--color-critical)', fontSize: 'var(--text-sm)' }}>{error}</p>}
      <div aria-label="Transcript" tabIndex={0} style={{ maxHeight: 480, minHeight: 120, overflowY: 'auto', padding: 12, borderRadius: 'var(--radius-sm)', background: 'var(--color-surface-hover)', fontSize: 'var(--text-sm)' }}>
        {!loaded && !error && <span style={{ color: 'var(--color-text-muted)' }}>Reading the transcript…</span>}
        {loaded?.parts?.length === 0 && <span style={{ color: 'var(--color-text-muted)' }}>No speech was found.</span>}
        {loaded && !loaded.parts && <pre style={{ margin: 0, whiteSpace: 'pre-wrap', font: 'inherit' }}>{loaded.text}</pre>}
        {loaded?.parts?.map((p, i) => (
          <p key={i} style={{ margin: '0 0 6px' }}>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', marginRight: 8 }}>{clockLine(p.time)}</span>
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
  );
}

/** The speakers with their names, to change. The stakeholders to choose from are loaded once, here. */
function SpeakerEditors({ labels, nameOf, participants, onName }: {
  labels: string[]; nameOf: (label: string) => SpeakerName | undefined; participants: MeetingParticipant[];
  onName: (label: string, person: Omit<SpeakerName, 'label'> | null) => void;
}) {
  const version = useDataVersion('stakeholders');
  const { data: people } = useApi<Stakeholder[]>('/api/stakeholders', [version]);
  const choices = speakerChoices(participants, people ?? []);
  return <>{labels.map((label) => <SpeakerNamer key={label} label={label} named={nameOf(label)} editable choices={choices} onName={(person) => onName(label, person)} />)}</>;
}


/** One speaker label and its name: pick a stakeholder or type a name, or take the name back. */
function SpeakerNamer({ label, named, editable, choices, onName }: {
  label: string; named: SpeakerName | undefined; editable: boolean; choices: SpeakerChoice[]; onName: (person: Omit<SpeakerName, 'label'> | null) => void;
}) {
  const [editing, setEditing] = React.useState(false);
  const [value, setValue] = React.useState('');
  const button = React.useRef<HTMLButtonElement>(null);
  const close = () => { setEditing(false); setTimeout(() => button.current?.focus(), 0); };
  const save = () => {
    // Only what was picked from the list is a stakeholder; a name typed by hand stays a name.
    const known = choices.find((c) => c.option === value.trim());
    if (value.trim()) onName(known ? known.person : { name: value.trim() });
    close();
  };
  const link = { padding: '0 4px', border: 'none', background: 'transparent', color: 'var(--color-accent)', cursor: 'pointer', fontSize: 'var(--text-xs)' } as const;
  const list = `speaker-people-${label.replace(/\s/g, '-')}`;
  if (editing) {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        {label}:
        <input aria-label={`Who is ${label}`} list={list} value={value} autoFocus placeholder="Stakeholder or a name" onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') close(); }}
          style={{ padding: '2px 6px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--color-border)', background: 'var(--color-surface)', color: 'var(--color-text)', fontSize: 'var(--text-xs)' }} />
        <datalist id={list}>{choices.map((c) => <option key={c.option} value={c.option} />)}</datalist>
        <button type="button" style={link} onClick={save}>Save</button>
        <button type="button" style={link} onClick={close}>Cancel</button>
      </span>
    );
  }
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2, padding: '1px 6px', borderRadius: 'var(--radius-sm)', background: 'var(--color-surface-hover)' }}>
      {label}{named ? `: ${named.name}` : ''}
      {editable && <button ref={button} type="button" style={link} aria-label={`${named ? 'Change' : 'Name'} ${label}`} onClick={() => { setValue(''); setEditing(true); }}>{named ? 'Change' : 'Name'}</button>}
      {editable && named && <button type="button" style={link} aria-label={`Remove the name of ${label}`} onClick={() => onName(null)}>Remove</button>}
    </span>
  );
}
