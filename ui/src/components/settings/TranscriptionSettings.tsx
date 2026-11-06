import { languageName, serverText } from '@/i18n/serverText';
import { useLanguage } from '@/i18n/LanguageProvider';
import { rich } from '@/i18n/rich';
import { describeSpeed, GPU_LIVE_X, gpuLiveOffer, recommendModel } from '@/utils/transcriptionSpeed';
import { useConfirm } from '@/components/common/ConfirmDialog';
import React from 'react';
import Button from '@/components/common/Button';
import Badge from '@/components/common/Badge';
import { apiDelete, apiPost, apiPut } from '@/utils/api';
import { useApi } from '@/hooks/useApi';
import { useAppState } from '@/store';
import type { Transcription, TranscriptionLanguage, TranscriptionModel } from '@/types';
import { RememberedVoices } from './RememberedVoices';

const hintStyle: React.CSSProperties = { fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', margin: '4px 0 0' };

/** Decimal units, as file managers show them and as the pluses and minuses say. */
function size(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`;
}

function ModelCard({ model, chosen, busy, saving, elsewhere, vadMissing, vadSize, onChoose, onAction, onTested }: {
  model: TranscriptionModel;
  chosen: boolean;
  /** A download or a save runs, so nothing else may touch the model files. */
  busy: boolean;
  saving: boolean;
  /** Another dashboard downloads: a download here has to wait for it. */
  elsewhere: boolean;
  /** The model is here but the voice-activity model every transcription needs is not. */
  vadMissing: boolean;
  vadSize: number;
  onChoose: () => void;
  onAction: (action: 'download' | 'cancel' | 'delete') => void;
  onTested: () => void;
}) {
  const { t } = useLanguage();
  const [speedTest, setSpeedTest] = React.useState<{ running: boolean; error?: string }>({ running: false });
  const runSpeedTest = async () => {
    setSpeedTest({ running: true });
    try {
      const res = await fetch(`/api/transcription/models/${model.id}/speed-test`, { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { message?: string };
        throw new Error(body.message || t('transcriptionSettings.theSpeedTestFailed', { status: res.status }));
      }
      setSpeedTest({ running: false });
      onTested();
    } catch (err) {
      setSpeedTest({ running: false, error: (err as Error).message });
    }
  };
  const [check, setCheck] = React.useState<{ running: boolean; ok?: boolean; message?: string }>({ running: false });
  const runCheck = async () => {
    setCheck({ running: true });
    try {
      const result = await apiPost<{ ok: boolean; message: string }>(`/api/transcription/models/${model.id}/check`);
      setCheck({ running: false, ok: result.ok, message: result.message });
    } catch (err) {
      setCheck({ running: false, ok: false, message: (err as Error).message });
    }
  };
  const d = model.download;
  const running = d?.status === 'downloading' || d?.status === 'verifying';
  const queued = d?.status === 'queued';
  const percent = d && d.total ? Math.floor((d.received / d.total) * 100) : 0;
  // The graphics-chip model can be chosen only after a speed test shows it runs there: said at the top, never only in a tooltip.
  const blocked = Boolean(model.gpu) && !model.gpu_ready && !chosen;
  const blockedWhy = !blocked ? null
    : !model.installed ? t('transcriptionSettings.downloadItThenPressTest')
      : model.speed ? t('transcriptionSettings.theTestRanButNot')
        : vadMissing ? t('transcriptionSettings.downloadTheVoiceActivityModel')
          : t('transcriptionSettings.pressTestSpeedBelowFirst');
  const whyId = `model-${model.id}-why`;
  return (
    <div style={{
      border: `1px solid ${chosen ? 'var(--color-accent)' : 'var(--color-border)'}`, borderRadius: 'var(--radius-md)', padding: 14,
      background: chosen ? 'var(--color-accent-subtle)' : 'transparent', display: 'flex', flexDirection: 'column', gap: 8,
    }}>
      <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, cursor: blocked ? 'not-allowed' : 'pointer' }}>
        <input type="radio" name="transcription-model" checked={chosen} onChange={onChoose} disabled={saving || blocked} style={{ marginTop: 4, ...(blocked ? { opacity: 0.45 } : {}) }}
          {...(blockedWhy ? { 'aria-describedby': whyId } : {})} />
        <span style={{ flex: 1 }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <strong style={{ fontSize: 'var(--text-sm)' }}>{model.name}</strong>
            {model.installed ? <Badge size="sm" variant="success">{t('transcriptionSettings.downloaded')}</Badge> : null}
            {chosen ? <Badge size="sm" variant="info">{t('transcriptionSettings.usedForTranscription')}</Badge> : null}
            {blocked && model.installed ? <Badge size="sm" variant="warning">{model.speed ? t('transcriptionSettings.notAvailableOnThisMac') : t('transcriptionSettings.testSpeedToUseIt')}</Badge> : null}
          </span>
          <span style={{ display: 'block', fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)', marginTop: 2 }}>{serverText(model.summary)}</span>
          {blockedWhy && <span id={whyId} style={{ display: 'block', fontSize: 'var(--text-sm)', color: 'var(--color-warning)', marginTop: 4 }}>{blockedWhy}</span>}
        </span>
      </label>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 8, fontSize: 'var(--text-xs)' }}>
        <ul aria-label={t('transcriptionSettings.pluses', { name: model.name })} style={{ margin: 0, paddingLeft: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 2 }}>
          {model.pros.map((p) => <li key={p}><span aria-hidden style={{ color: 'var(--color-success)', fontWeight: 700 }}>+ </span>{serverText(p)}</li>)}
        </ul>
        <ul aria-label={t('transcriptionSettings.minuses', { name: model.name })} style={{ margin: 0, paddingLeft: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 2 }}>
          {model.cons.map((c) => <li key={c}><span aria-hidden style={{ color: 'var(--color-warning)', fontWeight: 700 }}>− </span>{serverText(c)}</li>)}
        </ul>
      </div>
      {running && d && (
        <div aria-live="polite">
          <div role="progressbar" aria-label={t('transcriptionSettings.downloading', { name: model.name })} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}
            style={{ height: 6, borderRadius: 3, background: 'var(--color-border)', overflow: 'hidden' }}>
            <div style={{ width: `${percent}%`, height: '100%', background: 'var(--color-accent)', transition: 'width 0.3s' }} />
          </div>
          <p style={hintStyle}>
            {d.status === 'verifying' ? t('transcriptionSettings.checkingTheFiles') : t('transcriptionSettings.of', { percent, received: size(d.received), total: size(d.total) })}
          </p>
        </div>
      )}
      {queued && <p role="status" style={hintStyle}>{t('transcriptionSettings.waitingForTheDownloadBefore')}</p>}
      {!running && d?.message && (
        <p role="alert" style={{ ...hintStyle, color: d.status === 'failed' ? 'var(--color-critical)' : 'var(--color-text-muted)' }}>{d.message}</p>
      )}
      {model.speed && !speedTest.running && (
        <p role="status" style={hintStyle}>
          {model.gpu
            ? t('transcriptionSettings.aboutRealTimeHereAn', { realtime_x: model.speed.realtime_x, max: Math.max(1, Math.round(60 / model.speed.realtime_x)) })
            : describeSpeed(model.speed.realtime_x).line}
        </p>
      )}
      {model.gpu && model.gpu_ready && !speedTest.running && (
        <p role="status" style={{ ...hintStyle, color: 'var(--color-success)' }}>
          {t('transcriptionSettings.runsOnThisMacS')}
        </p>
      )}
      {speedTest.running && <p role="status" style={hintStyle}>{rich(t, 'transcriptionSettings.testingOnAMinuteOf', { value: model.memory_gb > 2 ? t('transcriptionSettings.thisOneCanTakeA') : '' })}</p>}
      {speedTest.error && <p role="alert" style={{ ...hintStyle, color: 'var(--color-critical)' }}>{speedTest.error}</p>}
      {check.message && (
        <p role={check.ok ? 'status' : 'alert'} style={{ ...hintStyle, color: check.ok ? 'var(--color-success)' : 'var(--color-critical)' }}>{check.message}</p>
      )}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {running || queued
          ? <Button size="sm" variant="secondary" onClick={() => onAction('cancel')}>{t('cancel')}</Button>
          : model.installed
            ? <>
              {model.gpu && model.gpu_ready && !chosen && <Button size="sm" variant="primary" disabled={saving} onClick={onChoose}>{t('transcriptionSettings.useItForTranscription')}</Button>}
              {vadMissing && <Button size="sm" variant={blocked ? 'primary' : 'secondary'} disabled={busy} onClick={() => onAction('download')}>{rich(t, 'transcriptionSettings.downloadTheMissingVoiceActivity', { vadSize: size(vadSize) })}</Button>}
              {!vadMissing && <Button size="sm" variant="secondary" disabled={busy || check.running || speedTest.running} loading={check.running} onClick={() => void runCheck()}>{t('transcriptionSettings.check')}</Button>}
              {!vadMissing && <Button size="sm" variant={blocked && !model.speed ? 'primary' : 'secondary'} disabled={busy || check.running || speedTest.running} loading={speedTest.running} onClick={() => void runSpeedTest()}>{model.speed ? t('transcriptionSettings.testSpeedAgain') : t('transcriptionSettings.testSpeed')}</Button>}
              <Button size="sm" variant="ghost" disabled={busy || check.running || speedTest.running} onClick={() => onAction('delete')}
                title={busy || check.running || speedTest.running ? t('transcriptionSettings.notWhileADownloadCheck') : undefined}>{t('updateDetail.delete')}</Button>
            </>
            : <Button size="sm" variant="secondary" disabled={saving || elsewhere} onClick={() => onAction('download')}>
              {model.partial > 0 ? t('transcriptionSettings.continueDownloadOf', { partial: size(model.partial), size: size(model.size) }) : t('transcriptionSettings.download', { size: size(model.size) })}
            </Button>}
      </div>
    </div>
  );
}

/** The optional model that tells speakers apart: download it, turn it off, or remove it. */
function SpeakerDetection({ speakers, enabled, saving, downloading, onToggle, onAction }: {
  speakers: Transcription['speakers']; enabled: boolean; saving: boolean; downloading: boolean;
  onToggle: (on: boolean) => void; onAction: (action: 'download' | 'cancel' | 'delete') => void;
}) {
  const { t } = useLanguage();
  const d = speakers.download;
  const running = d?.status === 'downloading' || d?.status === 'verifying' || d?.status === 'queued';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 'var(--text-sm)' }}>
      {speakers.installed
        ? (
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600 }}>
            <input type="checkbox" checked={enabled} disabled={saving} onChange={(e) => onToggle(e.target.checked)} />
            {t('transcriptionSettings.tellSpeakersApart')}
          </label>
        )
        : <span style={{ fontWeight: 600 }}>{t('transcriptionSettings.tellSpeakersApart')}</span>}
      <span style={hintStyle}>
        {t('transcriptionSettings.marksWhoSpokeWhenAs')}
      </span>
      {d?.message && !running && <p role="alert" style={{ ...hintStyle, color: 'var(--color-critical)' }}>{d.message}</p>}
      {running && (
        <p role="status" style={hintStyle}>
          {d.status === 'queued' ? t('transcriptionSettings.waitingForTheDownloadBefore2') : d.status === 'verifying' ? t('transcriptionSettings.checkingTheFiles') : t('transcriptionSettings.of2', { value: d.total ? Math.floor((d.received / d.total) * 100) : 0, received: size(d.received), total: size(d.total) })}
        </p>
      )}
      <div>
        {running
          ? <Button size="sm" variant="secondary" onClick={() => onAction('cancel')}>{t('cancel')}</Button>
          : speakers.installed
            ? <Button size="sm" variant="ghost" disabled={downloading} onClick={() => onAction('delete')} title={downloading ? t('transcriptionSettings.notWhileADownloadIs') : undefined}>{t('updateDetail.delete')}</Button>
            : <Button size="sm" variant="secondary" disabled={saving} onClick={() => onAction('download')}>{rich(t, 'transcriptionSettings.download', { size: size(speakers.size) })}</Button>}
      </div>
    </div>
  );
}

/**
 * Settings > Transcription: the offline speech-to-text models, their pluses and minuses, downloads, and the
 * language. Models stay on this computer, outside the workspace.
 */
export default function TranscriptionSettings() {
  const { t } = useLanguage();
  const confirm = useConfirm();
  const { dataVersions } = useAppState();
  const { data, error, refetch } = useApi<Transcription>('/api/transcription', [dataVersions.transcription]);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  // A download in another dashboard sends its notices there: look again every few seconds until it ends.
  const elsewhere = data?.downloading_elsewhere ?? false;
  React.useEffect(() => {
    if (!elsewhere) return;
    const timer = setInterval(refetch, 5000);
    return () => clearInterval(timer);
  }, [elsewhere, refetch]);

  if (error) return <p role="alert" style={{ color: 'var(--color-critical)', fontSize: 'var(--text-sm)' }}>{error}</p>;
  if (!data) return null;

  const downloading = data.downloading_elsewhere || [...data.models, data.speakers].some((m) => m.download?.status === 'downloading' || m.download?.status === 'verifying');
  const save = async (patch: Partial<Transcription['settings']>) => {
    setSaving(true);
    setNotice(null);
    try { await apiPut('/api/transcription/settings', patch); refetch(); } catch (err) { setNotice((err as Error).message); } finally { setSaving(false); }
  };
  const act = async (model: Pick<TranscriptionModel, 'id' | 'name' | 'size'>, action: 'download' | 'cancel' | 'delete') => {
    setNotice(null);
    if (action === 'delete' && !(await confirm({ title: t('transcriptionSettings.delete', { name: model.name }), message: t('transcriptionSettings.isFreedOnThisComputer', { size: size(model.size) }), confirmLabel: t('transcriptionSettings.deleteModel'), tone: 'danger' }))) return;
    try {
      if (action === 'download') await apiPost(`/api/transcription/models/${model.id}/download`);
      if (action === 'cancel') await apiPost(`/api/transcription/models/${model.id}/cancel`);
      if (action === 'delete') await apiDelete(`/api/transcription/models/${model.id}`);
      refetch();
    } catch (err) {
      setNotice((err as Error).message);
    }
  };
  const chosen = data.models.find((m) => m.id === data.settings.model);
  const liveModel = data.models.find((m) => m.id === data.settings.live_model);
  const liveLanguageMissing = liveModel && data.settings.language !== 'auto' && !liveModel.language_options?.some((l) => l.id === data.settings.language);
  // A language the chosen model does not know is read as Auto, and speech in it can come out empty: say so, and keep
  // it in the list rather than showing Auto as if it had been chosen.
  const languageMissing = chosen && data.settings.language !== 'auto' && !chosen.language_options?.some((l) => l.id === data.settings.language);
  const languageLabel = data.models.flatMap((m) => m.language_options ?? []).find((l) => l.id === data.settings.language)?.label ?? data.settings.language;
  const languageShown = languageName(data.settings.language, languageLabel);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)' }}>
        {rich(t, 'transcriptionSettings.meetingRecordingsWillBeTranscribed', { strong: <strong>{data.defaults.model === data.settings.model ? t('transcriptionSettings.theDefault') : ''}{chosen?.name ?? t('transcriptionSettings.theChosenModel')}</strong>, value: chosen && chosen.memory_gb > 2 ? t('transcriptionSettings.isAccurateButTakesLonger') : t('transcriptionSettings.isFastAndLight') })}
      </p>
      {data.downloading_elsewhere && (
        <p role="status" style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)' }}>
          {t('transcriptionSettings.anotherDashboardOnThisComputer')}
        </p>
      )}
      {data.memory_hint && (
        <p role="note" style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--color-warning)' }}>{serverText(data.memory_hint)}</p>
      )}
      {(() => {
        const pick = recommendModel(data.models);
        if (!pick) return <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)' }}>{rich(t, 'transcriptionSettings.notSureWhichToUse', { strong: <strong>{t('transcriptionSettings.testSpeed')}</strong> })}</p>;
        return (
          <p role="note" style={{ margin: 0, fontSize: 'var(--text-sm)' }}>
            {t('transcriptionSettings.recommendedForThisComputer')} <strong>{pick.name}</strong>, {pick.reason}.
            {pick.id !== data.settings.model && <> <Button size="sm" variant="ghost" disabled={saving} onClick={() => void save({ model: pick.id })}>{t('transcriptionSettings.useIt')}</Button></>}
          </p>
        );
      })()}
      <div role="radiogroup" aria-label={t('transcriptionSettings.transcriptionModel')} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {data.models.map((m) => (
          <ModelCard key={m.id} model={m} chosen={m.id === data.settings.model} busy={saving || (downloading && m.download?.status !== 'downloading')} saving={saving} elsewhere={data.downloading_elsewhere}
            vadMissing={!data.vad_installed} vadSize={data.vad_size}
            onChoose={() => void save({ model: m.id })} onAction={(a) => void act(m, a)} onTested={refetch} />
        ))}
      </div>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 'var(--text-sm)' }}>
        <span style={{ fontWeight: 600 }}>{t('language')}</span>
        <select aria-label={t('transcriptionSettings.transcriptionLanguage')} value={data.settings.language} disabled={saving}
          onChange={(e) => void save({ language: e.target.value as TranscriptionLanguage })}
          style={{ maxWidth: 420, padding: '6px 8px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--color-border)', background: 'var(--color-surface)', color: 'var(--color-text)' }}>
          <option value="auto">{t('transcriptionSettings.autoEachPartOfThe')}</option>
          {languageMissing && <option value={data.settings.language}>{rich(t, 'transcriptionSettings.notIn', { languageLabel: languageShown, name: chosen.name })}</option>}
          {chosen?.language_options?.filter((l) => l.common).map((l) => <option key={l.id} value={l.id}>{languageName(l.id, l.label)}</option>)}
          {chosen?.language_options?.some((l) => !l.common) && (
            <optgroup label={t('recordMeetingModal.otherLanguages')}>
              {chosen.language_options.filter((l) => !l.common).map((l) => <option key={l.id} value={l.id}>{languageName(l.id, l.label)}</option>)}
            </optgroup>
          )}
        </select>
        {languageMissing && (
          <span role="alert" style={{ maxWidth: 560, color: 'var(--color-warning)' }}>
            {rich(t, 'transcriptionSettings.doesNotKnowItReads', { name: chosen.name, languageLabel: languageShown })}
          </span>
        )}
        <span role="note" style={{ maxWidth: 560, padding: '6px 10px', borderLeft: '3px solid var(--color-accent)', borderRadius: 'var(--radius-sm)', background: 'var(--color-surface-hover)', fontWeight: 600, color: 'var(--color-text)' }}>
          {t('transcriptionSettings.forTheMostAccurateTranscript')}
        </span>
        <span style={hintStyle}>
          {rich(t, 'transcriptionSettings.autoDetectsTheLanguageOf', { value: liveLanguageMissing && t('transcriptionSettings.doesNotHaveThisLanguage', { name: liveModel.name }) })}
        </span>
      </label>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 'var(--text-sm)' }}>
        <span style={{ fontWeight: 600 }}>{t('transcriptionSettings.liveTranscriptWhileRecording')}</span>
        <select aria-label={t('transcriptionSettings.liveTranscriptModel')} value={data.settings.live_model ?? ''} disabled={saving}
          onChange={(e) => void save({ live_model: e.target.value || null })}
          style={{ maxWidth: 420, padding: '6px 8px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--color-border)', background: 'var(--color-surface)', color: 'inherit' }}>
          <option value="">{t('transcriptionSettings.offTranscribeAfterTheMeeting')}</option>
          {data.models.filter((m) => m.installed && (!m.gpu || m.gpu_ready || m.id === data.settings.live_model)).map((m) => (
            <option key={m.id} value={m.id}>{m.name}{m.speed ? t('transcriptionSettings.aboutRealTimeHere', { realtime_x: m.speed.realtime_x }) : ''}</option>
          ))}
        </select>
        <span style={hintStyle}>
          {t('transcriptionSettings.theTextAppearsOnThe')}
        </span>
      </label>
      {(() => {
        const offer = gpuLiveOffer(data.models, data.settings.live_model);
        if (!offer) return null;
        const sameAfter = data.settings.model === offer.id;
        return (
          <div role="note" aria-label={t('transcriptionSettings.liveTranscriptOnTheGraphics')} style={{ maxWidth: 560, display: 'flex', flexDirection: 'column', gap: 6, padding: '8px 12px', borderLeft: '3px solid var(--color-accent)', borderRadius: 'var(--radius-sm)', background: 'var(--color-surface-hover)', fontSize: 'var(--text-sm)' }}>
            <strong>{t('transcriptionSettings.liveTranscriptOnTheGraphics')}</strong>
            <span>
              {rich(t, 'transcriptionSettings.theSpeedTestShowedRuns', { name: offer.name, realtime_x: offer.realtime_x, value: offer.realtime_x >= GPU_LIVE_X
                ? t('transcriptionSettings.youCanTryItFor')
                : t('transcriptionSettings.thatIsTooSlowTo'), value2: sameAfter
                ? t('transcriptionSettings.itIsAlsoTheModel')
                : t('transcriptionSettings.stillTranscribesTheRecordingAfter', { name: chosen?.name ?? t('transcriptionSettings.theModelAbove') }) })}
            </span>
            {offer.realtime_x >= GPU_LIVE_X && <span><Button size="sm" variant="secondary" disabled={saving} onClick={() => void save({ live_model: offer.id })}>{t('transcriptionSettings.useItForTheLive')}</Button></span>}
          </div>
        );
      })()}
      <SpeakerDetection speakers={data.speakers} enabled={data.settings.speakers} saving={saving} downloading={downloading}
        onToggle={(on) => void save({ speakers: on })} onAction={(action) => void act(data.speakers, action)} />
      <RememberedVoices on={data.settings.recognize_voices === true} speakersOn={data.settings.speakers} saving={saving} onToggle={(on) => void save({ recognize_voices: on })} />
      <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 'var(--text-sm)' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600 }}>
          <input type="checkbox" checked={data.settings.keep_recordings} disabled={saving}
            onChange={(e) => void save({ keep_recordings: e.target.checked })} />
          {t('transcriptionSettings.keepRecordingsAfterTranscription')}
        </span>
        <span style={hintStyle}>
          {t('transcriptionSettings.offARecordingIsRemoved')}
        </span>
      </label>
      {notice && <p role="alert" style={{ margin: 0, color: 'var(--color-critical)', fontSize: 'var(--text-sm)' }}>{notice}</p>}
      <p style={hintStyle}>
        {rich(t, 'transcriptionSettings.modelsAreKeptInShared', { code: <code style={{ overflowWrap: 'anywhere' }}>{data.models_dir}</code> })}
      </p>
    </div>
  );
}
