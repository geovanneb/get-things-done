import React from 'react';
import Button from '@/components/common/Button';
import Badge from '@/components/common/Badge';
import { apiDelete, apiPost, apiPut } from '@/utils/api';
import { useApi } from '@/hooks/useApi';
import { useAppState } from '@/store';
import type { Transcription, TranscriptionLanguage, TranscriptionModel } from '@/types';

const LANGUAGES: { id: TranscriptionLanguage; label: string }[] = [
  { id: 'auto', label: 'Auto (each part of the meeting in its own language)' },
  { id: 'en', label: 'English' },
  { id: 'ja', label: 'Japanese' },
];

const hintStyle: React.CSSProperties = { fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', margin: '4px 0 0' };

/** Decimal units, as file managers show them and as the pluses and minuses say. */
function size(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`;
}

function ModelCard({ model, chosen, busy, vadMissing, vadSize, onChoose, onAction }: {
  model: TranscriptionModel;
  chosen: boolean;
  busy: boolean;
  /** The model is here but the voice-activity model every transcription needs is not. */
  vadMissing: boolean;
  vadSize: number;
  onChoose: () => void;
  onAction: (action: 'download' | 'cancel' | 'delete') => void;
}) {
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
  const percent = d && d.total ? Math.floor((d.received / d.total) * 100) : 0;
  return (
    <div style={{
      border: `1px solid ${chosen ? 'var(--color-accent)' : 'var(--color-border)'}`, borderRadius: 'var(--radius-md)', padding: 14,
      background: chosen ? 'var(--color-accent-subtle)' : 'transparent', display: 'flex', flexDirection: 'column', gap: 8,
    }}>
      <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer' }}>
        <input type="radio" name="transcription-model" checked={chosen} onChange={onChoose} disabled={busy} style={{ marginTop: 4 }} />
        <span style={{ flex: 1 }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <strong style={{ fontSize: 'var(--text-sm)' }}>{model.name}</strong>
            {model.installed ? <Badge size="sm" variant="success">Downloaded</Badge> : null}
            {chosen ? <Badge size="sm" variant="info">Used for transcription</Badge> : null}
          </span>
          <span style={{ display: 'block', fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)', marginTop: 2 }}>{model.summary}</span>
        </span>
      </label>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 8, fontSize: 'var(--text-xs)' }}>
        <ul aria-label={`${model.name}: pluses`} style={{ margin: 0, paddingLeft: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 2 }}>
          {model.pros.map((p) => <li key={p}><span aria-hidden style={{ color: 'var(--color-success)', fontWeight: 700 }}>+ </span>{p}</li>)}
        </ul>
        <ul aria-label={`${model.name}: minuses`} style={{ margin: 0, paddingLeft: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 2 }}>
          {model.cons.map((c) => <li key={c}><span aria-hidden style={{ color: 'var(--color-warning)', fontWeight: 700 }}>− </span>{c}</li>)}
        </ul>
      </div>
      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>{model.languages}.</div>
      {running && d && (
        <div aria-live="polite">
          <div role="progressbar" aria-label={`Downloading ${model.name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}
            style={{ height: 6, borderRadius: 3, background: 'var(--color-border)', overflow: 'hidden' }}>
            <div style={{ width: `${percent}%`, height: '100%', background: 'var(--color-accent)', transition: 'width 0.3s' }} />
          </div>
          <p style={hintStyle}>
            {d.status === 'verifying' ? 'Checking the files…' : `${percent}%: ${size(d.received)} of ${size(d.total)}`}
          </p>
        </div>
      )}
      {!running && d?.message && (
        <p role="alert" style={{ ...hintStyle, color: d.status === 'failed' ? 'var(--color-critical)' : 'var(--color-text-muted)' }}>{d.message}</p>
      )}
      {check.message && (
        <p role={check.ok ? 'status' : 'alert'} style={{ ...hintStyle, color: check.ok ? 'var(--color-success)' : 'var(--color-critical)' }}>{check.message}</p>
      )}
      <div style={{ display: 'flex', gap: 8 }}>
        {running
          ? <Button size="sm" variant="secondary" onClick={() => onAction('cancel')}>Cancel</Button>
          : model.installed
            ? <>
              {vadMissing && <Button size="sm" variant="secondary" disabled={busy} onClick={() => onAction('download')}>Download the missing voice-activity model ({size(vadSize)})</Button>}
              {!vadMissing && <Button size="sm" variant="secondary" disabled={busy || check.running} loading={check.running} onClick={() => void runCheck()}>Check</Button>}
              <Button size="sm" variant="ghost" disabled={busy || check.running} onClick={() => onAction('delete')}>Delete</Button>
            </>
            : <Button size="sm" variant="secondary" disabled={busy} onClick={() => onAction('download')}>
              {model.partial > 0 ? `Continue download (${size(model.partial)} of ${size(model.size)})` : `Download (${size(model.size)})`}
            </Button>}
      </div>
    </div>
  );
}

/**
 * Settings > Transcription: the offline speech-to-text models, their pluses and minuses, downloads, and the
 * language. Models stay on this computer, outside the workspace.
 */
export default function TranscriptionSettings() {
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

  const downloading = data.downloading_elsewhere || data.models.some((m) => m.download?.status === 'downloading' || m.download?.status === 'verifying');
  const save = async (patch: Partial<Transcription['settings']>) => {
    setSaving(true);
    setNotice(null);
    try { await apiPut('/api/transcription/settings', patch); refetch(); } catch (err) { setNotice((err as Error).message); } finally { setSaving(false); }
  };
  const act = async (model: TranscriptionModel, action: 'download' | 'cancel' | 'delete') => {
    setNotice(null);
    if (action === 'delete' && !window.confirm(`Delete ${model.name} (${size(model.size)}) from this computer? You can download it again later.`)) return;
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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)' }}>
        Meeting recordings will be transcribed on this computer, offline: nothing is sent anywhere. Choose a model and download
        it once. <strong>{data.defaults.model === data.settings.model ? 'The default, ' : ''}{chosen?.name ?? 'The chosen model'}</strong>
        {chosen && chosen.memory_gb > 2 ? ' is the most accurate but takes longer; ' : ' '}you can change it here at any time.
      </p>
      {data.downloading_elsewhere && (
        <p role="status" style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)' }}>
          Another dashboard on this computer is downloading a model; its progress shows there.
        </p>
      )}
      {data.memory_hint && (
        <p role="note" style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--color-warning)' }}>{data.memory_hint}</p>
      )}
      <div role="radiogroup" aria-label="Transcription model" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {data.models.map((m) => (
          <ModelCard key={m.id} model={m} chosen={m.id === data.settings.model} busy={saving || (downloading && m.download === null)}
            vadMissing={!data.vad_installed} vadSize={data.vad_size}
            onChoose={() => void save({ model: m.id })} onAction={(a) => void act(m, a)} />
        ))}
      </div>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 'var(--text-sm)' }}>
        <span style={{ fontWeight: 600 }}>Language</span>
        <select aria-label="Transcription language" value={data.settings.language} disabled={saving}
          onChange={(e) => void save({ language: e.target.value as TranscriptionLanguage })}
          style={{ maxWidth: 420, padding: '6px 8px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--color-border)', background: 'var(--color-surface)', color: 'var(--color-text)' }}>
          {LANGUAGES.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
        </select>
        <span style={hintStyle}>
          Auto detects the language of each part of a meeting, so a meeting that switches between English and Japanese comes
          out right. For the most accurate transcript of a meeting in one language, choose that language.
        </span>
      </label>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 'var(--text-sm)' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600 }}>
          <input type="checkbox" checked={data.settings.keep_recordings} disabled={saving}
            onChange={(e) => void save({ keep_recordings: e.target.checked })} />
          Keep recordings after transcription
        </span>
        <span style={hintStyle}>
          Off: a recording is removed once its complete transcript is safely in a digest. On: it stays with the digest&apos;s
          materials, which are kept after review. A partial transcript always keeps its recording until the digest is done.
        </span>
      </label>
      {notice && <p role="alert" style={{ margin: 0, color: 'var(--color-critical)', fontSize: 'var(--text-sm)' }}>{notice}</p>}
      <p style={hintStyle}>
        Models are kept in <code>{data.models_dir}</code>, shared by every workspace. Speeds were measured on an Apple Silicon
        Mac; other computers may be slower.
      </p>
    </div>
  );
}
