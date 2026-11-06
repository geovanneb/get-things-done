import { useLanguage } from '@/i18n/LanguageProvider';
import { tr } from '@/i18n/current';
import { rich } from '@/i18n/rich';
import { useState } from 'react';
import Button from '@/components/common/Button';
import Modal from '@/components/common/Modal';
import Notice from '@/components/common/Notice';
import { Select } from '@/components/common/Input';
import type { MeetingDetail, MeetingDigest } from '@/types';

/**
 * Transcribe again and the versions of a reviewed meeting's text. A new transcription is added as a version; the
 * reviewed one stays current until the user chooses another, and the record stays the account of the reviewed one.
 */

const when = (iso: string) => new Date(iso).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** The dialog to pick the model a kept recording is transcribed again with. Only downloaded models are offered. */
export function TranscribeAgainDialog({ file, job, onClose, onStart }: {
  file: string | null; job: MeetingDigest | null; onClose: () => void; onStart: (file: string, model: string) => Promise<void>;
}) {
  const { t } = useLanguage();
  const installed = job?.installed_models ?? [];
  const names = job?.model_names ?? {};
  // A GPU model not verified here runs as its CPU counterpart: offer each model once, as it really runs.
  const runnable = [...new Set(installed.map((m) => job?.runnable_models?.[m] ?? m))].filter((m) => installed.includes(m));
  const [model, setModel] = useState(() => (job?.chosen_model && runnable.includes(job.chosen_model) ? job.chosen_model : runnable[0] ?? ''));
  const [saving, setSaving] = useState(false);
  const start = async () => {
    if (!file || !model) return;
    setSaving(true);
    // A failure is reported by the caller; the dialog stays open to try again.
    try { await onStart(file, model); onClose(); } catch { /* reported */ } finally { setSaving(false); }
  };
  return (
    <Modal isOpen={file !== null} onClose={onClose} title={t('meetingVersions.transcribeAgain')}
      description={t('meetingVersions.theNewTranscriptIsAdded')}
      footer={<>
        <Button variant="ghost" onClick={onClose} disabled={saving}>{t('cancel')}</Button>
        <Button variant="primary" onClick={() => void start()} loading={saving} disabled={!model}>{t('meetingVersions.startTranscribing')}</Button>
      </>}>
      {runnable.length ? (
        <Select label={t('meetingVersions.model')} value={model} onChange={setModel}
          options={runnable.map((m) => ({ value: m, label: names[m] ?? m }))}
          hint={t('meetingVersions.usesTheLanguageAndSpeaker')} />
      ) : (
        <Notice tone="warning" title={t('meetingVersions.noTranscriptionModelIsDownloaded')}>{t('meetingVersions.downloadOneInSettingsTranscription')}</Notice>
      )}
    </Modal>
  );
}

/** A Transcribe again that waits, runs or failed. */
export function TranscriptionNotice({ detail, names, busy, onStop }: {
  detail: MeetingDetail; names: Record<string, string>; busy: boolean; onStop: () => void;
}) {
  const t = detail.transcription;
  if (!t) return null;
  const model = names[t.model] ?? t.model;
  const p = detail.transcription_progress;
  if (t.status === 'failed') {
    return (
      <Notice tone="warning" title={tr('meetingVersions.theNewTranscriptionWasNot')} action={<Button size="sm" variant="secondary" disabled={busy} onClick={onStop}>{tr('dismiss')}</Button>}>
        {rich(tr, 'meetingVersions.theReviewedTranscriptIsStill', { error: t.error ?? tr('meetingVersions.itFailed') })}
      </Notice>
    );
  }
  const progress = p && p.total > 0 ? ` ${Math.min(100, Math.round((p.done / p.total) * 100))}%` : '';
  return (
    <Notice tone="info" title={t.status === 'running' ? tr('meetingVersions.transcribingAgainWith', { model, progress }) : tr('meetingVersions.waitingToTranscribeAgainWith', { model })}
      action={<Button size="sm" variant="secondary" disabled={busy} onClick={onStop}>{tr('meetingVersions.stop')}</Button>}>
      {t.status === 'running' ? tr('meetingVersions.whenItIsDoneIt') : tr('meetingVersions.itStartsWhenTheMeetings')}
    </Notice>
  );
}

/** The versions of the meeting's text, for the side panel: which one is used, and choosing another. */
export function VersionsSection({ detail, names, busy, onChoose }: {
  detail: MeetingDetail; names: Record<string, string>; busy: boolean; onChoose: (version: string) => void;
}) {
  const { t } = useLanguage();
  if (detail.versions.length < 2) return null;
  return (
    <section aria-label={t('meetingVersions.versions')} style={{ marginBottom: 'var(--space-5)' }}>
      <h3 style={{ margin: '0 0 var(--space-2)', fontSize: 'var(--text-base)', fontWeight: 600, color: 'var(--color-text)' }}>{t('meetingVersions.versions')}</h3>
      <ul className="gtd-stack" style={{ gap: 'var(--space-2)', margin: 0, padding: 0, listStyle: 'none', fontSize: 'var(--text-sm)' }}>
        {detail.versions.map((v) => (
          <li key={v.id} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-2)' }}>
            <span style={{ flex: '1 1 140px', minWidth: 0 }}>
              <strong>{v.id === 'v1' ? t('taskMeetingSources.reviewed') : t('meetingVersions.version', { slice: v.id.slice(1) })}</strong>
              <span style={{ display: 'block', fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
                {v.made_from === 'transcription' ? `${names[v.model ?? ''] ?? v.model}, ${when(v.at)}`
                  : v.made_from === 'correction' ? t('meetingVersions.correctedIn', { correction: v.correction, when: when(v.at) }) : t('meetingVersions.asReviewed', { when: when(v.at) })}
              </span>
            </span>
            {v.current
              ? <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>{t('meetingVersions.inUse')}</span>
              : <Button size="sm" variant="secondary" disabled={busy} onClick={() => onChoose(v.id)}>{t('meetingVersions.useThisVersion')}</Button>}
          </li>
        ))}
      </ul>
      {detail.versions.find((v) => v.current)?.made_from === 'transcription' && (
        <p style={{ margin: 'var(--space-2) 0 0', fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
          {t('meetingVersions.theRecordStaysTheAccount')}
        </p>
      )}
    </section>
  );
}
