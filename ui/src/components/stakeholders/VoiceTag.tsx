import { useLanguage } from '@/i18n/LanguageProvider';
import { rich } from '@/i18n/rich';
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
  const { t } = useLanguage();
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
    if (!(await confirm({ title: t('rememberedVoices.forgetSVoice', { name }), message: t('voiceTag.everySampleAndTheConsent'), confirmLabel: t('rememberedVoices.forgetVoice'), tone: 'danger' }))) return;
    await act(() => apiDelete(`/api/voiceprints/${encodeURIComponent(id)}`));
  };
  const remove = async (s: VoiceSample, last: boolean) => {
    const where = `${s.title ?? t('voiceTag.aMeetingThatIsNo')}, ${s.label}`;
    const ok = await confirm({
      title: last ? t('voiceTag.removeTheLastSampleOf', { name }) : t('voiceTag.removeThisSample'),
      message: last
        ? t('voiceTag.itIsTheOnlyOne', { name })
        : t('voiceTag.theSpeechFromIsNo', { where, name }),
      confirmLabel: last ? t('rememberedVoices.forgetVoice') : t('voiceTag.removeSample'), tone: 'danger',
    });
    if (ok) await act(() => apiDelete(`/api/voiceprints/${encodeURIComponent(id)}/samples/${s.key}`));
  };

  const voice = data?.voice ?? null;
  const tag = voice ? voiceTag(voice) : null;
  return (
    <Card headingLevel={headingLevel} title={t('voiceTag.voice')}
      badge={tag ? <Badge variant={tag.warning ? 'warning' : 'accent-subtle'} size="sm">{tag.text}</Badge> : undefined}
      actions={voice ? <Button size="sm" variant="danger" disabled={busy} onClick={() => void forget()}>{t('rememberedVoices.forgetVoice')}</Button> : undefined}>
      <div className="gtd-stack" style={{ gap: 'var(--space-3)' }}>
        {failed && <Notice tone="critical" title={t('speakerNaming.thatDidNotWork')}>{failed}</Notice>}
        {error ? <Notice tone="critical" title={t('voiceTag.theVoiceCouldNotBe')}>{error}</Notice>
          : !data ? <LoadingSpinner inline text={t('loading')} />
            : !voice ? (
              data.enabled
                ? <EmptyState size="compact" title={t('voiceTag.noVoiceRemembered')}
                  description={t('voiceTag.toRememberSVoiceName', { name })}
                  action={{ label: t('voiceTag.openMeetings'), onClick: () => navigate('/meetings') }} />
                : <EmptyState size="compact" title={t('voiceTag.noVoiceRemembered')}
                  description={t('voiceTag.recognizeKnownVoicesIsOff')}
                  action={{ label: t('voiceTag.openSettings'), onClick: () => navigate('/settings') }} />
            ) : voice.damaged ? (
              <Notice tone="warning" title={t('voiceTag.thisVoiceSFileCannot')}>{t('voiceTag.itIsNeverUsedForget')}</Notice>
            ) : (
              <>
                <p style={textStyle}>
                  {rich(t, 'voiceTag.ofClearSpeechFromMeetings', { count: voice.meetings, seconds: speechLength(voice.seconds), value: voice.stale_model ? t('voiceTag.itWasMadeWithAn')
                    : !voice.stakeholder ? t('voiceTag.theyAreNoLongerA')
                      : !data.enabled ? t('voiceTag.recognizeKnownVoicesIsOff2')
                        : voice.ready ? t('voiceTag.theAppSuggestsTheirName')
                          : t('voiceTag.suggestionsStartOnceThereAre', { min_seconds: data.min_seconds }) })}
                </p>
                {voice.consent && (
                  <div className="gtd-stack" style={{ gap: 'var(--space-1)', fontSize: 'var(--text-sm)' }}>
                    <span style={{ fontWeight: 600 }}>{t('voiceTag.consent')}</span>
                    <span style={{ color: 'var(--color-text-secondary)' }}>
                      &ldquo;{consentFor(data.consent_text, voice.consent.person)}&rdquo;
                    </span>
                    <span style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-xs)' }}>
                      {rich(t, 'voiceTag.recordedByOn', { recorded_by: voice.consent.recorded_by, day: day(voice.consent.at), value: voice.old_consent ? t('voiceTag.underAnEarlierWordingVersion', { version: voice.consent.version, consent_version: data.consent_version }) : '' })}
                    </span>
                  </div>
                )}
                <div className="gtd-stack" style={{ gap: 'var(--space-1)' }}>
                  <span style={{ fontWeight: 600, fontSize: 'var(--text-sm)' }}>{t('voiceTag.whereItWasHeard')}</span>
                  <ul aria-label={t('voiceTag.samplesOfSVoice', { name })} style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
                    {data.samples.map((s) => (
                      <li key={s.key} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-2)', padding: 'var(--space-2) var(--space-3)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', fontSize: 'var(--text-sm)' }}>
                        <span style={{ flex: '1 1 240px', display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                          {s.title
                            ? <Link to={`/meetings/${encodeURIComponent(s.meeting)}`} className="gtd-link">{s.title}</Link>
                            : <span style={{ color: 'var(--color-text-muted)' }}>{t('voiceTag.aMeetingThatIsNo2')}</span>}
                          <span style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-xs)' }}>
                            {rich(t, 'voiceTag.ofSpeechAdded', { label: s.label, value: s.version ? t('voiceTag.of', { version: s.version }) : '', seconds: speechLength(s.seconds), day: day(s.at) })}
                          </span>
                        </span>
                        <Button size="sm" variant="ghost" disabled={busy} aria-label={t('voiceTag.removeTheSampleFrom', { title: s.title ?? t('voiceTag.aMeetingThatIsGone'), label: s.label })}
                          onClick={() => void remove(s, data.samples.length === 1)}>{t('remove')}</Button>
                      </li>
                    ))}
                  </ul>
                </div>
                <p style={{ ...textStyle, fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
                  {t('voiceTag.keptOnlyOnThisComputer')}
                </p>
              </>
            )}
      </div>
    </Card>
  );
}
