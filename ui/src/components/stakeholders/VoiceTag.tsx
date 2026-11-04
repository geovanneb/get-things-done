import React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import Badge from '@/components/common/Badge';
import Button from '@/components/common/Button';
import Card from '@/components/common/Card';
import EmptyState from '@/components/common/EmptyState';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import Notice from '@/components/common/Notice';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { useApi } from '@/hooks/useApi';
import { useDataVersion } from '@/store';
import { apiDelete } from '@/utils/api';
import { consentFor, speechLength, voiceTag } from '@/utils/voiceprints';
import type { RememberedVoice, VoiceDetail, VoiceSample, Voiceprints } from '@/types';

/** The voices remembered on this computer, by stakeholder id; refreshed when they change. */
export function useRememberedVoices(): { voices: Map<string, RememberedVoice>; refetch: () => void } {
  const version = useDataVersion('voiceprints');
  const { data, refetch } = useApi<Voiceprints>('/api/voiceprints', [version]);
  const voices = React.useMemo(() => new Map((data?.prints ?? []).map((p) => [p.ref, p] as const)), [data]);
  return { voices, refetch };
}

/** The tag a stakeholder with a remembered voice gets. */
export function VoiceBadge({ voice }: { voice: RememberedVoice | undefined }) {
  if (!voice) return null;
  const tag = voiceTag(voice);
  return <Badge variant={tag.warning ? 'warning' : 'accent-subtle'} size="sm">{tag.text}</Badge>;
}

/** In a stakeholder's header: the tag only. Their page's Voice section manages it. */
export function StakeholderVoice({ id }: { id: string }) {
  const { voices } = useRememberedVoices();
  return <VoiceBadge voice={voices.get(id)} />;
}

const day = (iso: string) => new Date(iso).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
const textStyle: React.CSSProperties = { margin: 0, fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)' };

/**
 * A stakeholder's voice, on their page: the one place to see and manage it. How it stands, the consent they gave,
 * each sample with the meeting it came from (remove one), and Forget voice. Never the voice data itself.
 */
export function StakeholderVoiceCard({ id, name, headingLevel }: { id: string; name: string; headingLevel: 2 | 3 }) {
  const confirm = useConfirm();
  const navigate = useNavigate();
  const version = useDataVersion('voiceprints');
  const settingsVersion = useDataVersion('transcription');
  const { data, error, refetch } = useApi<VoiceDetail>(`/api/voiceprints/${encodeURIComponent(id)}`, [version, settingsVersion]);
  const [busy, setBusy] = React.useState(false);
  const [failed, setFailed] = React.useState<string | null>(null);

  const act = async (what: () => Promise<unknown>) => {
    setFailed(null);
    setBusy(true);
    try { await what(); refetch(); } catch (err) { setFailed((err as Error).message); } finally { setBusy(false); }
  };
  const forget = async () => {
    if (!(await confirm({ title: `Forget ${name}'s voice?`, message: 'Every sample and the consent are removed. The app stops suggesting this name; names already given in transcripts stay. Copies in backups of this computer are not removed.', confirmLabel: 'Forget voice', tone: 'danger' }))) return;
    await act(() => apiDelete(`/api/voiceprints/${encodeURIComponent(id)}`));
  };
  const remove = async (s: VoiceSample, last: boolean) => {
    const where = `${s.title ?? 'a meeting that is no longer here'}, ${s.label}`;
    const ok = await confirm({
      title: last ? `Remove the last sample of ${name}'s voice?` : 'Remove this sample?',
      message: last
        ? `It is the only one, so ${name}'s voice is forgotten with it, consent and all. Remembering it again asks for consent again.`
        : `The speech from ${where} is no longer part of ${name}'s voice. The speaker's name in that transcript stays.`,
      confirmLabel: last ? 'Forget voice' : 'Remove sample', tone: 'danger',
    });
    if (ok) await act(() => apiDelete(`/api/voiceprints/${encodeURIComponent(id)}/samples/${s.key}`));
  };

  const voice = data?.voice ?? null;
  const tag = voice ? voiceTag(voice) : null;
  return (
    <Card headingLevel={headingLevel} title="Voice"
      badge={tag ? <Badge variant={tag.warning ? 'warning' : 'accent-subtle'} size="sm">{tag.text}</Badge> : undefined}
      actions={voice ? <Button size="sm" variant="danger" disabled={busy} onClick={() => void forget()}>Forget voice</Button> : undefined}>
      <div className="gtd-stack" style={{ gap: 'var(--space-3)' }}>
        {failed && <Notice tone="critical" title="That did not work.">{failed}</Notice>}
        {error ? <Notice tone="critical" title="The voice could not be read.">{error}</Notice>
          : !data ? <LoadingSpinner inline text="Loading…" />
            : !voice ? (
              data.enabled
                ? <EmptyState size="compact" title="No voice remembered"
                  description={`To remember ${name}'s voice, name them as a speaker in a meeting's transcript and choose Remember voice. Their consent is asked first.`}
                  action={{ label: 'Open meetings', onClick: () => navigate('/meetings') }} />
                : <EmptyState size="compact" title="No voice remembered"
                  description="Recognize known voices is off. Turn it on in Settings > Transcription to remember a voice, with the person's consent, and get their name suggested in transcripts."
                  action={{ label: 'Open settings', onClick: () => navigate('/settings') }} />
            ) : voice.damaged ? (
              <Notice tone="warning" title="This voice's file cannot be read.">It is never used. Forget it, then remember the voice again.</Notice>
            ) : (
              <>
                <p style={textStyle}>
                  {speechLength(voice.seconds)} of clear speech from {voice.meetings} {voice.meetings === 1 ? 'meeting' : 'meetings'}.{' '}
                  {voice.stale_model ? 'It was made with an older speaker model, so it is not used: forget it and remember the voice again.'
                    : !voice.stakeholder ? 'They are no longer a stakeholder, so it is never used.'
                      : !data.enabled ? 'Recognize known voices is off, so no name is suggested.'
                        : voice.ready ? 'The app suggests their name when a transcript has a voice that clearly sounds like them.'
                          : `Suggestions start once there are ${data.min_seconds} seconds of it.`}
                </p>
                {voice.consent && (
                  <div className="gtd-stack" style={{ gap: 'var(--space-1)', fontSize: 'var(--text-sm)' }}>
                    <span style={{ fontWeight: 600 }}>Consent</span>
                    <span style={{ color: 'var(--color-text-secondary)' }}>
                      &ldquo;{consentFor(data.consent_text, voice.consent.person)}&rdquo;
                    </span>
                    <span style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-xs)' }}>
                      Recorded by {voice.consent.recorded_by} on {day(voice.consent.at)}
                      {voice.old_consent ? `, under an earlier wording (version ${voice.consent.version}, now ${data.consent_version})` : ''}.
                    </span>
                  </div>
                )}
                <div className="gtd-stack" style={{ gap: 'var(--space-1)' }}>
                  <span style={{ fontWeight: 600, fontSize: 'var(--text-sm)' }}>Where it was heard</span>
                  <ul aria-label={`Samples of ${name}'s voice`} style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
                    {data.samples.map((s) => (
                      <li key={s.key} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-2)', padding: 'var(--space-2) var(--space-3)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', fontSize: 'var(--text-sm)' }}>
                        <span style={{ flex: '1 1 240px', display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                          {s.title
                            ? <Link to={`/meetings/${encodeURIComponent(s.meeting)}`} className="gtd-link">{s.title}</Link>
                            : <span style={{ color: 'var(--color-text-muted)' }}>A meeting that is no longer here</span>}
                          <span style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-xs)' }}>
                            {s.label}{s.version ? ` of ${s.version}` : ''} · {speechLength(s.seconds)} of speech · added {day(s.at)}
                          </span>
                        </span>
                        <Button size="sm" variant="ghost" disabled={busy} aria-label={`Remove the sample from ${s.title ?? 'a meeting that is gone'}, ${s.label}`}
                          onClick={() => void remove(s, data.samples.length === 1)}>Remove</Button>
                      </li>
                    ))}
                  </ul>
                </div>
                <p style={{ ...textStyle, fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
                  Kept only on this computer, outside the workspace, and never given to AI tools.
                </p>
              </>
            )}
      </div>
    </Card>
  );
}
