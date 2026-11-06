import { currentLocale } from '@/i18n/current';
import { useLanguage } from '@/i18n/LanguageProvider';
import { rich } from '@/i18n/rich';
import React from 'react';
import { Link } from 'react-router-dom';
import Badge from '@/components/common/Badge';
import Button from '@/components/common/Button';
import Notice from '@/components/common/Notice';
import Toggle from '@/components/common/Toggle';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { useApi } from '@/hooks/useApi';
import { useDataVersion } from '@/store';
import { apiDelete, apiPost } from '@/utils/api';
import { speechLength, voiceTag } from '@/utils/voiceprints';
import type { Voiceprints } from '@/types';

const hintStyle: React.CSSProperties = { margin: 0, maxWidth: 560, fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)' };

/**
 * Settings > Transcription, Recognize known voices: the switch (off by default), the voices remembered on this
 * computer with their consent, Forget and Forget all, and voices of a workspace that was moved.
 */
export function RememberedVoices({ on, speakersOn, saving, onToggle }: { on: boolean; speakersOn: boolean; saving: boolean; onToggle: (on: boolean) => void }) {
  const { t } = useLanguage();
  const confirm = useConfirm();
  // Also when the transcription settings change: whether it is on, and whether the speaker model is here.
  const version = useDataVersion('voiceprints');
  const settingsVersion = useDataVersion('transcription');
  const { data, error, refetch } = useApi<Voiceprints>('/api/voiceprints', [version, settingsVersion]);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const act = async (what: () => Promise<unknown>) => {
    setNotice(null);
    setBusy(true);
    try { await what(); refetch(); } catch (err) { setNotice((err as Error).message); } finally { setBusy(false); }
  };
  const forget = async (ref: string, name: string) => {
    if (!(await confirm({ title: t('rememberedVoices.forgetSVoice', { name }), message: t('rememberedVoices.theAppStopsSuggestingThis'), confirmLabel: t('rememberedVoices.forgetVoice'), tone: 'danger' }))) return;
    await act(() => apiDelete(`/api/voiceprints/${encodeURIComponent(ref)}`));
  };
  const forgetAll = async () => {
    if (!(await confirm({ title: t('rememberedVoices.forgetEveryRememberedVoice'), message: t('rememberedVoices.theAppStopsSuggestingNames'), confirmLabel: t('rememberedVoices.forgetAll'), tone: 'danger' }))) return;
    await act(() => apiPost('/api/voiceprints/forget-all'));
  };

  const forgetMoved = async (key: string, workspace: string) => {
    if (!(await confirm({ title: t('rememberedVoices.forgetTheseMovedVoices'), message: t('rememberedVoices.everyRememberedVoiceAndIts', { workspace }), confirmLabel: t('rememberedVoices.forgetVoices'), tone: 'danger' }))) return;
    await act(() => apiDelete(`/api/voiceprints/moved/${key}`));
  };

  if (error) return <p role="alert" style={{ ...hintStyle, color: 'var(--color-critical)' }}>{error}</p>;
  if (!data) return null;
  const blocked = !data.speaker_model ? t('rememberedVoices.downloadTheSpeakerModelAbove') : !speakersOn ? t('rememberedVoices.turnOnTellSpeakersApart') : null;

  return (
    <section aria-labelledby="remembered-voices" className="gtd-stack" style={{ gap: 'var(--space-2)', fontSize: 'var(--text-sm)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
        <Toggle id="recognize-voices" label={t('rememberedVoices.recognizeKnownVoices')} checked={on} disabled={saving || (Boolean(blocked) && !on)} onChange={onToggle} />
        <span id="remembered-voices" style={{ fontWeight: 600 }}>{t('rememberedVoices.recognizeKnownVoices')}</span>
      </div>
      <p style={hintStyle}>
        {t('rememberedVoices.suggestsASpeakerSName')}
      </p>
      {blocked && <p role="note" style={hintStyle}>{blocked}</p>}
      {notice && <Notice tone="critical" title={t('speakerNaming.thatDidNotWork')}>{notice}</Notice>}
      {data.moved.map((m) => (
        <Notice key={m.key} tone="info" title={t('rememberedVoices.voicesOfAWorkspaceThat')}
          action={<span style={{ display: 'inline-flex', gap: 'var(--space-2)' }}>
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => void act(() => apiPost(`/api/voiceprints/moved/${m.key}/relink`))}>{t('rememberedVoices.useThemHere')}</Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void forgetMoved(m.key, m.workspace)}>{t('rememberedVoices.forgetThem')}</Button>
          </span>}>
          {rich(t, 'rememberedVoices.voicesWereRememberedForWhich', { count: m.prints.length, code: <code style={{ overflowWrap: 'anywhere' }}>{m.workspace}</code> })}
        </Notice>
      ))}
      {data.prints.length === 0
        ? <p style={{ ...hintStyle, color: 'var(--color-text-muted)' }}>{t('rememberedVoices.noVoiceIsRememberedAfter')}</p>
        : (
          <ul aria-label={t('rememberedVoices.rememberedVoices')} style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 'var(--space-2)', maxWidth: 640 }}>
            {data.prints.map((p) => {
              const tag = voiceTag(p);
              return (
                <li key={p.ref} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-2)', padding: 'var(--space-2) var(--space-3)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)' }}>
                  <span style={{ flex: '1 1 260px', display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <span style={{ fontWeight: 600 }}>
                      {/* A stakeholder's voice is managed on their page; yours here. */}
                      {p.ref !== 'me' && p.stakeholder ? <Link to={`/stakeholders/${p.ref}`} className="gtd-link">{p.name}</Link> : p.name}
                      {' '}<span style={{ fontWeight: 400, color: 'var(--color-text-muted)' }}>{p.ref === 'me' ? '' : p.ref}</span>
                    </span>
                    <span style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--text-xs)' }}>
                      {p.damaged ? t('rememberedVoices.thisFileCannotBeRead') : t('rememberedVoices.ofSpeechFromMeetings', { count: p.meetings, seconds: speechLength(p.seconds) })}
                      {p.consent && t('rememberedVoices.consentRecordedByOn', { recorded_by: p.consent.recorded_by, toLocaleDateString: new Date(p.consent.at).toLocaleDateString(currentLocale()), value: p.old_consent ? t('rememberedVoices.underAnEarlierWording') : '' })}
                    </span>
                  </span>
                  <Badge variant={tag.warning ? 'warning' : 'accent-subtle'} size="sm">{tag.text}</Badge>
                  <Button size="sm" variant="ghost" disabled={busy} aria-label={t('rememberedVoices.forgetSVoice2', { name: p.name })} onClick={() => void forget(p.ref, p.name)}>{t('rememberedVoices.forget')}</Button>
                </li>
              );
            })}
          </ul>
        )}
      {data.prints.length > 1 && <div><Button size="sm" variant="danger" disabled={busy} onClick={() => void forgetAll()}>{t('rememberedVoices.forgetAllVoices')}</Button></div>}
      <p style={hintStyle}>
        {rich(t, 'rememberedVoices.keptInReadableOnlyBy', { code: <code>~/.gtd/voiceprints</code> })}
      </p>
    </section>
  );
}
