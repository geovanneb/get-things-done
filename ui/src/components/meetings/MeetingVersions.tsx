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
    <Modal isOpen={file !== null} onClose={onClose} title="Transcribe again"
      description="The new transcript is added as a version of this meeting. The one you reviewed stays in use until you choose the new one, and the record stays as it was confirmed."
      footer={<>
        <Button variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
        <Button variant="primary" onClick={() => void start()} loading={saving} disabled={!model}>Start transcribing</Button>
      </>}>
      {runnable.length ? (
        <Select label="Model" value={model} onChange={setModel}
          options={runnable.map((m) => ({ value: m, label: names[m] ?? m }))}
          hint="Uses the language and speaker settings of Settings > Transcription. It runs after any meeting in the queue." />
      ) : (
        <Notice tone="warning" title="No transcription model is downloaded.">Download one in Settings &gt; Transcription, then try again.</Notice>
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
      <Notice tone="warning" title="The new transcription was not kept." action={<Button size="sm" variant="secondary" disabled={busy} onClick={onStop}>Dismiss</Button>}>
        {t.error ?? 'It failed.'} The reviewed transcript is still in use. Try again with another model from the Files tab.
      </Notice>
    );
  }
  const progress = p && p.total > 0 ? ` ${Math.min(100, Math.round((p.done / p.total) * 100))}%` : '';
  return (
    <Notice tone="info" title={t.status === 'running' ? `Transcribing again with ${model}${progress}` : `Waiting to transcribe again with ${model}`}
      action={<Button size="sm" variant="secondary" disabled={busy} onClick={onStop}>Stop</Button>}>
      {t.status === 'running' ? 'When it is done, it is added as a new version. The transcript you reviewed stays in use until you choose.' : 'It starts when the meetings in the queue are transcribed.'}
    </Notice>
  );
}

/** The versions of the meeting's text, for the side panel: which one is used, and choosing another. */
export function VersionsSection({ detail, names, busy, onChoose }: {
  detail: MeetingDetail; names: Record<string, string>; busy: boolean; onChoose: (version: string) => void;
}) {
  if (detail.versions.length < 2) return null;
  return (
    <section aria-label="Versions" style={{ marginBottom: 'var(--space-5)' }}>
      <h3 style={{ margin: '0 0 var(--space-2)', fontSize: 'var(--text-base)', fontWeight: 600, color: 'var(--color-text)' }}>Versions</h3>
      <ul className="gtd-stack" style={{ gap: 'var(--space-2)', margin: 0, padding: 0, listStyle: 'none', fontSize: 'var(--text-sm)' }}>
        {detail.versions.map((v) => (
          <li key={v.id} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-2)' }}>
            <span style={{ flex: '1 1 140px', minWidth: 0 }}>
              <strong>{v.id === 'v1' ? 'Reviewed' : `Version ${v.id.slice(1)}`}</strong>
              <span style={{ display: 'block', fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
                {v.made_from === 'transcription' ? `${names[v.model ?? ''] ?? v.model}, ${when(v.at)}` : `As reviewed, ${when(v.at)}`}
              </span>
            </span>
            {v.current
              ? <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>In use</span>
              : <Button size="sm" variant="secondary" disabled={busy} onClick={() => onChoose(v.id)}>Use this version</Button>}
          </li>
        ))}
      </ul>
      {detail.versions.find((v) => v.current)?.id !== 'v1' && (
        <p style={{ margin: 'var(--space-2) 0 0', fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
          The record stays the account of the reviewed version. Tasks made from it keep what they used.
        </p>
      )}
    </section>
  );
}
