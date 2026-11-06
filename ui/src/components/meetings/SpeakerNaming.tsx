import { useLanguage } from '@/i18n/LanguageProvider';
import { rich } from '@/i18n/rich';
import React from 'react';
import Badge from '@/components/common/Badge';
import Button from '@/components/common/Button';
import Input, { Select } from '@/components/common/Input';
import Modal, { FormActions } from '@/components/common/Modal';
import Notice from '@/components/common/Notice';
import { useApi } from '@/hooks/useApi';
import { useDataVersion } from '@/store';
import { apiPost } from '@/utils/api';
import { speakerChoices } from '@/utils/speakerChoices';
import { transcriptParts } from '@/utils/transcriptReading';
import {
  consentFor, NOT_NAMED, personOf, personOptions, personValue, secondsOfTime, SOMEONE_ELSE, speakerEvidence, speakerRows, speakersSummary,
  type SpeakerEvidence, type SpeakerRow,
} from '@/utils/voiceprints';
import type { MeetingParticipant, SpeakerName, SpeakerSuggestion, Stakeholder, VoiceSource, Voiceprints } from '@/types';

type Person = Omit<SpeakerName, 'label'>;

/** How long Listen plays of a speaker, from the start of the first thing they said. */
const CLIP_SECONDS = 8;

/**
 * The speakers of one transcript, one row each: who it is (a picker, expected people first), what they first said and
 * a short clip to listen to, a "Sounds like" suggestion from remembered voices with Use and Not them, and Remember
 * voice, which asks for that person's consent first. Everything about a speaker stays in its own row, so with many
 * people it is always clear which suggestion or action belongs to whom. Used for a recording in the queue and for a
 * Transcribe again version of a kept meeting; `source` says which.
 */
export function SpeakerNaming({ source, labels, names, suggestions = [], rememberable = [], modelSha = null, participants = [], editable, transcriptUrl, audioUrl, hint, onName, onChanged }: {
  source: VoiceSource;
  labels: string[];
  names: SpeakerName[];
  suggestions?: SpeakerSuggestion[];
  /** Labels with speech of their own, whose voice can be remembered. */
  rememberable?: string[];
  /** The speaker model the suggestions were made with, sent back with Use. */
  modelSha?: string | null;
  /** Who was expected at the meeting: offered first. */
  participants?: MeetingParticipant[];
  editable: boolean;
  /** The transcript as text: each speaker's first words and how often they speak. */
  transcriptUrl?: string;
  /** The recording, for Listen. */
  audioUrl?: string;
  /** A line under the header: what naming does here. */
  hint?: React.ReactNode;
  onName: (label: string, person: Person | null) => Promise<void>;
  onChanged: () => void;
}) {
  const { t } = useLanguage();
  const peopleVersion = useDataVersion('stakeholders');
  const voicesVersion = useDataVersion('voiceprints');
  const settingsVersion = useDataVersion('transcription');
  const { data: people } = useApi<Stakeholder[]>('/api/stakeholders?type=people', [peopleVersion]);
  const { data: voices, refetch: refetchVoices } = useApi<Voiceprints>('/api/voiceprints', [voicesVersion, settingsVersion]);
  const evidence = useEvidence(transcriptUrl);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [asking, setAsking] = React.useState<SpeakerRow | null>(null);
  const [open, setOpen] = React.useState<boolean | null>(null);
  const clip = useClip(audioUrl);

  const rows = speakerRows({ labels, names, suggestions, rememberable, people: people ?? [], prints: voices?.prints ?? [], enabled: Boolean(voices?.enabled) && editable });
  const choices = speakerChoices(participants, people ?? []);
  const expected = new Set(participants.map((p) => p.ref ?? `name:${p.name.toLowerCase()}`));
  const pending = rows.filter((r) => !r.named && r.suggestion);
  // Folded once everyone is named and nothing waits: the transcript is what is left to read.
  const expanded = open ?? (rows.some((r) => !r.named) || pending.length > 0);

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
  const use = (row: SpeakerRow) => apiPost('/api/voiceprints/suggestions/use', { source, label: row.label, ref: row.suggestion!.ref, model_sha256: modelSha });
  const acceptAll = () => run(async () => { for (const row of pending) await use(row); });

  return (
    <section aria-label={t('updateDetail.speakers2')} className="gtd-stack" style={{ gap: 'var(--space-2)' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-2)' }}>
        <span style={{ fontWeight: 600, fontSize: 'var(--text-sm)' }}>{t('updateDetail.speakers2')}</span>
        <span role="status" style={{ flex: '1 1 200px', fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)' }}>{speakersSummary(rows)}</span>
        {editable && expanded && pending.length > 1 && (
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => void acceptAll()}>{rich(t, 'speakerNaming.useAllSuggestions', { length: pending.length })}</Button>
        )}
        <Button size="sm" variant="ghost" aria-expanded={expanded} onClick={() => setOpen(!expanded)}>{expanded ? t('speakerNaming.hideSpeakers') : editable ? t('speakerNaming.editSpeakers') : t('speakerNaming.showSpeakers')}</Button>
      </div>
      {hint && expanded && <p style={{ margin: 0, fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>{hint}</p>}
      {error && <Notice tone="critical" title={t('speakerNaming.thatDidNotWork')}>{error}</Notice>}
      {expanded && (
        <ul className="gtd-list" aria-label={t('speakerNaming.speakersOfThisTranscript')} style={{ border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)' }}>
          {rows.map((row) => (
            <SpeakerRowView key={row.label} row={row} evidence={evidence.get(row.label)} editable={editable} busy={busy}
              options={personOptions({ label: row.label, choices, expected, names })}
              listening={clip.playing === row.label} canListen={Boolean(audioUrl)}
              onListen={(at) => clip.toggle(row.label, at)}
              onPick={(person) => void run(() => onName(row.label, person))}
              onPickValue={(value) => personOf(value, choices, names)}
              onUse={() => void run(() => use(row))}
              onDismiss={() => void run(() => apiPost('/api/voiceprints/suggestions/dismiss', { source, label: row.label }))}
              onRemember={() => { setError(null); setAsking(row); }} />
          ))}
        </ul>
      )}
      {asking && voices && (
        <RememberVoiceDialog error={error} row={asking} evidence={evidence.get(asking.label)} consentText={voices.consent_text} busy={busy} minSeconds={voices.min_seconds}
          onCancel={() => setAsking(null)}
          onConfirm={() => void run(async () => { await apiPost('/api/voiceprints', { source, label: asking.label, consent: true, consent_ref: asking.named!.ref }); setAsking(null); })} />
      )}
    </section>
  );
}

/** One speaker: who they are and what helps tell (left), then what can be done (right). Wraps on a phone. */
function SpeakerRowView({ row, evidence, editable, busy, options, listening, canListen, onListen, onPick, onPickValue, onUse, onDismiss, onRemember }: {
  row: SpeakerRow; evidence: SpeakerEvidence | undefined; editable: boolean; busy: boolean;
  options: { value: string; label: string; group?: string }[];
  listening: boolean; canListen: boolean; onListen: (at: number) => void;
  onPick: (person: Person | null) => void; onPickValue: (value: string) => Person | null;
  onUse: () => void; onDismiss: () => void; onRemember: () => void;
}) {
  const { t } = useLanguage();
  const [typing, setTyping] = React.useState(false);
  const [typed, setTyped] = React.useState('');
  const at = evidence ? secondsOfTime(evidence.first.time) : null;
  const pick = (value: string) => {
    if (value === SOMEONE_ELSE) { setTyped(''); setTyping(true); return; }
    setTyping(false);
    onPick(value === NOT_NAMED ? null : onPickValue(value));
  };
  const saveTyped = () => { if (typed.trim()) { onPick({ name: typed.trim() }); setTyping(false); } };
  const name = row.named?.ref === 'me' ? t('updateDetail.you2') : row.named?.name;
  return (
    <li className="gtd-list__row" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', gap: 'var(--space-3)' }}>
      <div style={{ flex: '1 1 260px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-2)' }}>
          <span className="gtd-chip">{row.label}</span>
          <span style={{ fontWeight: 600, fontSize: 'var(--text-sm)', color: name ? 'var(--color-text)' : 'var(--color-text-muted)' }}>{name ?? t('speakerNaming.notNamedYet')}</span>
          {row.remembered && <Badge variant="accent-subtle" size="sm">{t('speakerNaming.voiceRemembered')}</Badge>}
        </div>
        {evidence && (
          <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-2)' }}>
            <span className="truncate" title={evidence.first.text} style={{ flex: '1 1 200px', minWidth: 0 }}>&ldquo;{evidence.first.text}&rdquo;</span>
            <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
              {rich(t, 'speakerNaming.firstAtParts', { count: evidence.count, replace: evidence.first.time.replace(/^00:/, '') })}
            </span>
            {canListen && at !== null && (
              <Button size="sm" variant="ghost" aria-label={listening ? t('speakerNaming.stopListeningTo', { label: row.label }) : t('speakerNaming.listenTo', { label: row.label })} aria-pressed={listening} onClick={() => onListen(at)}>
                {listening ? t('meetingVersions.stop') : t('speakerNaming.listen')}
              </Button>
            )}
          </p>
        )}
      </div>
      <div style={{ flex: '0 1 300px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
        {editable && row.suggestion && (
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-2)', padding: 'var(--space-2) var(--space-3)', borderRadius: 'var(--radius-md)', background: 'var(--color-accent-subtle)', fontSize: 'var(--text-sm)' }}>
            <span style={{ flex: '1 1 140px' }}>{rich(t, 'speakerNaming.soundsLike', { strong: <strong>{row.suggestion.name}</strong> })}</span>
            <Button size="sm" variant="secondary" disabled={busy} aria-label={t('speakerNaming.name', { label: row.label, name: row.suggestion.name })} onClick={onUse}>{t('speakerNaming.use')}</Button>
            <Button size="sm" variant="ghost" disabled={busy} aria-label={t('speakerNaming.isNot', { label: row.label, name: row.suggestion.name })} onClick={onDismiss}>{t('speakerNaming.notThem')}</Button>
          </div>
        )}
        {editable && (typing ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 'var(--space-2)' }}>
            <Input size="sm" label={t('speakerNaming.nameOf', { label: row.label })} value={typed} autoFocus placeholder={t('speakerNaming.aNameNotAStakeholder')} onChange={setTyped}
              onKeyDown={(e) => { if (e.key === 'Enter') saveTyped(); if (e.key === 'Escape') setTyping(false); }} style={{ flex: '1 1 160px' }} />
            <Button size="sm" variant="ghost" onClick={() => setTyping(false)}>{t('cancel')}</Button>
            <Button size="sm" variant="secondary" disabled={!typed.trim() || busy} onClick={saveTyped}>{t('speakerNaming.saveName')}</Button>
          </div>
        ) : (
          <Select size="sm" aria-label={t('speakerNaming.whoIs', { label: row.label })} value={personValue(row.named)} options={options} disabled={busy} onChange={pick} />
        ))}
        {row.canRemember && (
          <Button size="sm" variant="ghost" disabled={busy} aria-label={t('speakerNaming.rememberTheVoiceOf', { name: row.named!.name })} onClick={onRemember} style={{ alignSelf: 'flex-start' }}>
            {t('speakerNaming.rememberVoice')}
          </Button>
        )}
      </div>
    </li>
  );
}

/** Each speaker's first words, from the transcript; empty while it loads or when it cannot be read. */
function useEvidence(url: string | undefined): Map<string, SpeakerEvidence> {
  const [evidence, setEvidence] = React.useState<Map<string, SpeakerEvidence>>(new Map());
  React.useEffect(() => {
    if (!url) return undefined;
    const abort = new AbortController();
    fetch(url, { signal: abort.signal })
      .then((res) => (res.ok ? res.text() : ''))
      .then((text) => { if (!abort.signal.aborted) setEvidence(speakerEvidence(transcriptParts(text) ?? [])); })
      .catch(() => {});
    return () => abort.abort();
  }, [url]);
  return evidence;
}

/** One short clip at a time from the recording: a speaker's first words, to recognise the voice. */
function useClip(url: string | undefined): { playing: string | null; toggle: (label: string, at: number) => void } {
  const audio = React.useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = React.useState<string | null>(null);
  React.useEffect(() => () => { audio.current?.pause(); }, []);
  const toggle = (label: string, at: number) => {
    audio.current?.pause();
    if (playing === label || !url) { setPlaying(null); return; }
    const a = new Audio(`${url}#t=${at},${at + CLIP_SECONDS}`);
    a.onpause = () => setPlaying((p) => (p === label ? null : p));
    a.onended = a.onpause;
    audio.current = a;
    setPlaying(label);
    a.play().catch(() => setPlaying(null));
  };
  return { playing, toggle };
}

/** Asks for the person's consent before their voice is first remembered. Nothing is saved until it is given. */
function RememberVoiceDialog({ row, evidence, consentText, busy, minSeconds, onCancel, onConfirm, error }: {
  row: SpeakerRow; evidence: SpeakerEvidence | undefined; consentText: string; busy: boolean; minSeconds: number; error: string | null; onCancel: () => void; onConfirm: () => void;
}) {
  const { t } = useLanguage();
  const [agreed, setAgreed] = React.useState(false);
  const me = row.named!.ref === 'me';
  return (
    <Modal isOpen onClose={onCancel} size="sm" title={me ? t('speakerNaming.rememberYourVoice') : t('speakerNaming.rememberSVoice', { name: row.named!.name })}
      description={t('speakerNaming.thenTheAppCanSuggest')}
      footer={<FormActions>
        <Button variant="ghost" onClick={onCancel}>{t('cancel')}</Button>
        <Button variant="primary" disabled={!agreed || busy} loading={busy} onClick={onConfirm}>{t('speakerNaming.rememberVoice')}</Button>
      </FormActions>}>
      <div className="gtd-stack" style={{ gap: 'var(--space-3)', fontSize: 'var(--text-sm)' }}>
        {error && <Notice tone="critical" title={t('speakerNaming.theVoiceCouldNotBe')}>{error}</Notice>}
        <p style={{ margin: 0 }}>
          From <strong>{row.label}</strong>{evidence ? <>, who first said &ldquo;{evidence.first.text.slice(0, 80)}{evidence.first.text.length > 80 ? '…' : ''}&rdquo;</> : ''}.
          Check this is {me ? 'you' : row.named!.name} before you go on.
        </p>
        <p style={{ margin: 0 }}>
          {rich(t, 'speakerNaming.aVoiceIsBiometricData', { label: row.label, minSeconds: minSeconds })}
        </p>
        <label style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--space-2)' }}>
          <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} style={{ marginTop: 3 }} />
          <span>{me ? t('speakerNaming.iAgreeThatMyVoice') : consentFor(consentText, row.named!.name)}</span>
        </label>
        <p style={{ margin: 0, color: 'var(--color-text-secondary)' }}>
          {rich(t, 'speakerNaming.itStaysOnThisComputer', { value: me ? t('speakerNaming.inSettingsTranscription') : t('speakerNaming.onSPage', { name: row.named!.name }) })}
        </p>
      </div>
    </Modal>
  );
}
