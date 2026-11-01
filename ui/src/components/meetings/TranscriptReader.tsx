import React from 'react';
import Button from '@/components/common/Button';
import Card from '@/components/common/Card';
import IconButton, { icons } from '@/components/common/IconButton';
import Notice from '@/components/common/Notice';
import { useApi } from '@/hooks/useApi';
import { useDataVersion } from '@/store';
import { apiPut } from '@/utils/api';
import { speakerChoices, type SpeakerChoice } from '@/utils/speakerChoices';
import { clockLine, transcriptParts, type Readable, type TranscriptPart } from '@/utils/transcriptReading';
import type { MeetingParticipant, SpeakerName, Stakeholder } from '@/types';

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
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-2)', fontSize: 'var(--text-sm)' }}>
            <span style={{ color: 'var(--color-text-secondary)' }}>{canName ? 'Who spoke? Name them here, or leave them for the analysis to propose:' : 'Speakers:'}</span>
            {naming
              ? <SpeakerEditors labels={labels} nameOf={nameOf} participants={participants} onName={(label, person) => void name(label, person)} />
              : labels.map((label) => <SpeakerNamer key={label} label={label} named={nameOf(label)} editable={false} choices={[]} onName={() => {}} />)}
          </div>
        )}
        {nameError && <Notice tone="critical" title="The name was not saved.">{nameError}</Notice>}
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
  const list = `speaker-people-${label.replace(/\s/g, '-')}`;
  if (editing) {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-1)' }}>
        {label}:
        <input aria-label={`Who is ${label}`} list={list} value={value} autoFocus placeholder="Stakeholder or a name" onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') close(); }}
          className="gtd-control gtd-control--sm" style={{ width: 200 }} />
        <datalist id={list}>{choices.map((c) => <option key={c.option} value={c.option} />)}</datalist>
        <Button size="sm" variant="ghost" onClick={close}>Cancel</Button>
        <Button size="sm" variant="primary" onClick={save}>Save</Button>
      </span>
    );
  }
  return (
    <span className="gtd-chip">
      {label}{named ? `: ${named.name}` : ''}
      {editable && <button ref={button} type="button" className="gtd-chip__action" aria-label={`${named ? 'Change' : 'Name'} ${label}`} onClick={() => { setValue(''); setEditing(true); }}>{named ? 'Change' : 'Name'}</button>}
      {editable && named && <button type="button" className="gtd-chip__action" aria-label={`Remove the name of ${label}`} onClick={() => onName(null)}>Remove</button>}
    </span>
  );
}
