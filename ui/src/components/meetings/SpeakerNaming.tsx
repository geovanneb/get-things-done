import React from 'react';
import Badge from '@/components/common/Badge';
import Button from '@/components/common/Button';
import Modal, { FormActions } from '@/components/common/Modal';
import Notice from '@/components/common/Notice';
import { useApi } from '@/hooks/useApi';
import { useDataVersion } from '@/store';
import { apiPost } from '@/utils/api';
import { speakerChoices, type SpeakerChoice } from '@/utils/speakerChoices';
import { consentFor, speakerRows, type SpeakerRow } from '@/utils/voiceprints';
import type { MeetingParticipant, SpeakerName, SpeakerSuggestion, Stakeholder, VoiceSource, Voiceprints } from '@/types';

type Person = Omit<SpeakerName, 'label'>;

/**
 * The speakers of one transcript: their names, "sounds like" suggestions from remembered voices (Use, or Not them),
 * and Remember voice for a speaker named with a stakeholder, which asks for that person's consent first. Used for a
 * recording in the queue and for a Transcribe again version of a kept meeting; `source` says which.
 */
export function SpeakerNaming({ source, labels, names, suggestions = [], rememberable = [], modelSha = null, participants = [], editable, onName, onChanged }: {
  source: VoiceSource;
  labels: string[];
  names: SpeakerName[];
  suggestions?: SpeakerSuggestion[];
  /** Labels with speech of their own, whose voice can be remembered. */
  rememberable?: string[];
  /** The speaker model the suggestions were made with, sent back with Use. */
  modelSha?: string | null;
  /** Who was expected at the meeting: offered first when naming a speaker. */
  participants?: MeetingParticipant[];
  editable: boolean;
  onName: (label: string, person: Person | null) => Promise<void>;
  onChanged: () => void;
}) {
  const peopleVersion = useDataVersion('stakeholders');
  const voicesVersion = useDataVersion('voiceprints');
  const settingsVersion = useDataVersion('transcription');
  const { data: people } = useApi<Stakeholder[]>('/api/stakeholders?type=people', [peopleVersion]);
  const { data: voices, refetch: refetchVoices } = useApi<Voiceprints>('/api/voiceprints', [voicesVersion, settingsVersion]);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [asking, setAsking] = React.useState<SpeakerRow | null>(null);

  const rows = speakerRows({ labels, names, suggestions, rememberable, people: people ?? [], prints: voices?.prints ?? [], enabled: Boolean(voices?.enabled) && editable });
  const choices = speakerChoices(participants, people ?? []);

  const run = async (what: () => Promise<unknown>) => {
    setError(null);
    setBusy(true);
    try {
      await what();
      onChanged();
      refetchVoices();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const use = (row: SpeakerRow) => run(() => apiPost('/api/voiceprints/suggestions/use', { source, label: row.label, ref: row.suggestion!.ref, model_sha256: modelSha }));
  const dismiss = (row: SpeakerRow) => run(() => apiPost('/api/voiceprints/suggestions/dismiss', { source, label: row.label }));
  const remember = (row: SpeakerRow, consent: boolean) => run(async () => {
    await apiPost('/api/voiceprints', { source, label: row.label, consent });
    setAsking(null);
  });

  return (
    <div className="gtd-stack" style={{ gap: 'var(--space-2)' }}>
      <ul aria-label="Speakers" style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
        {rows.map((row) => (
          <li key={row.label} style={{ display: 'inline-flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-1)' }}>
            <SpeakerNamer label={row.label} named={row.named} editable={editable} choices={choices} onName={(person) => void run(() => onName(row.label, person))} />
            {row.remembered && <Badge variant="accent-subtle" size="sm">Voice remembered</Badge>}
            {row.canRemember && (
              <Button size="sm" variant="ghost" disabled={busy} aria-label={`Remember the voice of ${row.named!.name}`} onClick={() => setAsking(row)}>Remember voice</Button>
            )}
            {row.suggestion && (
              <span className="gtd-chip" style={{ borderStyle: 'dashed' }}>
                Sounds like {row.suggestion.name}
                {/* design-exception: the gtd-chip__action pattern (docs/design-system.md), a styled native button inside a chip */}
                {editable && <button type="button" className="gtd-chip__action" disabled={busy} aria-label={`Name ${row.label} ${row.suggestion.name}`} onClick={() => void use(row)}>Use</button>}
                {/* design-exception: the gtd-chip__action pattern (docs/design-system.md), a styled native button inside a chip */}
                {editable && <button type="button" className="gtd-chip__action" disabled={busy} aria-label={`${row.label} is not ${row.suggestion.name}`} onClick={() => void dismiss(row)}>Not them</button>}
              </span>
            )}
          </li>
        ))}
      </ul>
      {error && <Notice tone="critical" title="That did not work.">{error}</Notice>}
      {asking && voices && (
        <RememberVoiceDialog row={asking} consentText={voices.consent_text} busy={busy} minSeconds={voices.min_seconds}
          onCancel={() => setAsking(null)} onConfirm={() => void remember(asking, true)} />
      )}
    </div>
  );
}

/** Asks for the person's consent before their voice is first remembered. Nothing is saved until it is given. */
function RememberVoiceDialog({ row, consentText, busy, minSeconds, onCancel, onConfirm }: {
  row: SpeakerRow; consentText: string; busy: boolean; minSeconds: number; onCancel: () => void; onConfirm: () => void;
}) {
  const [agreed, setAgreed] = React.useState(false);
  const me = row.named!.ref === 'me';
  return (
    <Modal isOpen onClose={onCancel} size="sm" title={me ? 'Remember your voice?' : `Remember ${row.named!.name}'s voice?`}
      description="Then the app can suggest this name when it hears the voice again. It never names anyone by itself."
      footer={<FormActions>
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button variant="primary" disabled={!agreed || busy} loading={busy} onClick={onConfirm}>Remember voice</Button>
      </FormActions>}>
      <div className="gtd-stack" style={{ gap: 'var(--space-3)', fontSize: 'var(--text-sm)' }}>
        <p style={{ margin: 0 }}>
          A voice is biometric data. Remember it only with the person&apos;s consent. Only {row.label}&apos;s clear speech in this
          recording is used, never parts where others talk at the same time. Suggestions start once there are {minSeconds} seconds of it.
        </p>
        <label style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--space-2)' }}>
          <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} style={{ marginTop: 3 }} />
          <span>{me ? 'I agree that my voice is remembered on this computer, to suggest my name in transcripts. It stays on this computer and can be forgotten at any time.' : consentFor(consentText, row.named!.name)}</span>
        </label>
        <p style={{ margin: 0, color: 'var(--color-text-secondary)' }}>
          It stays on this computer, outside the workspace, and is never shared or given to AI tools. Forget it at any time in
          Settings &gt; Transcription{me ? '' : ` or on ${row.named!.name}'s page`}.
        </p>
      </div>
    </Modal>
  );
}

/** One speaker label and its name: pick a stakeholder or type a name, or take the name back. */
export function SpeakerNamer({ label, named, editable, choices, onName }: {
  label: string; named: SpeakerName | undefined; editable: boolean; choices: SpeakerChoice[]; onName: (person: Person | null) => void;
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
      {/* design-exception: the gtd-chip__action pattern (docs/design-system.md), a styled native button inside a chip */}
      {editable && <button ref={button} type="button" className="gtd-chip__action" aria-label={`${named ? 'Change' : 'Name'} ${label}`} onClick={() => { setValue(''); setEditing(true); }}>{named ? 'Change' : 'Name'}</button>}
      {/* design-exception: the gtd-chip__action pattern (docs/design-system.md), a styled native button inside a chip */}
      {editable && named && <button type="button" className="gtd-chip__action" aria-label={`Remove the name of ${label}`} onClick={() => onName(null)}>Remove</button>}
    </span>
  );
}
