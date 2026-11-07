import { useLanguage } from '@/i18n/LanguageProvider';
import React from 'react';
import Button from '@/components/common/Button';
import Modal from '@/components/common/Modal';
import Notice from '@/components/common/Notice';
import { Checkbox, SearchInput } from '@/components/common/Input';
import { useNotify } from '@/hooks/useNotify';
import { apiPost, errorMessage } from '@/utils/api';
import { shareableNotes, type ContextSharePreview } from '@/utils/contextShare';
import type { ContextNote } from '@/types';

/**
 * Share context notes as one Markdown file (#107): choose shareable notes, see the file's exact text, download it.
 * The server checks every label again and refuses a download that is no longer what was previewed.
 */
export default function ShareNotes({ isOpen, onClose, notes, categoryLabel }: { isOpen: boolean; onClose: () => void; notes: ContextNote[]; categoryLabel: (category: string) => string }) {
  const { t } = useLanguage();
  const notify = useNotify();
  const [chosen, setChosen] = React.useState<string[]>([]);
  const [query, setQuery] = React.useState('');
  const [preview, setPreview] = React.useState<ContextSharePreview | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [stale, setStale] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (isOpen) { setChosen([]); setQuery(''); setPreview(null); setStale(null); }
  }, [isOpen]);

  const { shareable, others } = shareableNotes(notes, query);
  const toggle = (id: string, on: boolean) => {
    setChosen((c) => on ? [...c, id] : c.filter((x) => x !== id));
    setPreview(null);
  };

  const makePreview = async () => {
    setBusy(true);
    setStale(null);
    try {
      setPreview(await apiPost<ContextSharePreview>('/api/context/share/preview', { notes: chosen }));
    } catch (err) {
      notify.error(err, t('shareNotes.couldNotPreview'));
    } finally {
      setBusy(false);
    }
  };

  const download = async () => {
    if (!preview?.token) return;
    setBusy(true);
    try {
      const res = await fetch('/api/context/share/download', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes: chosen, token: preview.token }),
      });
      if (!res.ok) {
        const message = errorMessage(await res.json().catch(() => null), t('shareNotes.couldNotDownload'));
        if (res.status === 409) { setPreview(null); setStale(message); return; }
        throw new Error(message);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = preview.file_name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      notify.error(err, t('shareNotes.couldNotDownload'));
    } finally {
      setBusy(false);
    }
  };

  const problems = preview?.rows.filter((r) => r.problem) ?? [];

  return (
    <Modal isOpen={isOpen} onClose={() => { if (!busy) onClose(); }} title={t('shareNotes.title')} size="lg"
      description={t('shareNotes.description')}
      footer={preview?.text ? (
        <>
          <Button variant="ghost" onClick={() => setPreview(null)} disabled={busy}>{t('shareNotes.back')}</Button>
          <Button variant="primary" loading={busy} onClick={() => void download()}>{t('shareNotes.download')}</Button>
        </>
      ) : (
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>{t('cancel')}</Button>
          <Button variant="primary" loading={busy} disabled={chosen.length === 0} onClick={() => void makePreview()}>
            {t('shareNotes.preview', { count: chosen.length })}
          </Button>
        </>
      )}>
      {preview?.text ? (
        <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
          <p style={{ margin: 0, fontSize: 'var(--text-sm)' }}>{t('shareNotes.exactText', { name: preview.file_name })}</p>
          <pre aria-label={t('shareNotes.previewLabel')} tabIndex={0} style={{
            margin: 0, maxHeight: '50vh', overflow: 'auto', padding: 'var(--space-3)', borderRadius: 'var(--radius-md)',
            background: 'var(--color-surface-hover)', fontSize: 'var(--text-xs)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
          }}>{preview.text}</pre>
          <p style={{ margin: 0, fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>{t('shareNotes.honestLimit')}</p>
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
          {stale && <Notice tone="warning">{stale}</Notice>}
          {problems.length > 0 && (
            <Notice tone="critical">
              {t('shareNotes.cannotShare')}
              <ul style={{ margin: 'var(--space-1) 0 0', paddingLeft: '1.2em' }}>
                {problems.map((r) => <li key={r.id}>{r.title}: {r.problem}</li>)}
              </ul>
            </Notice>
          )}
          <SearchInput value={query} onChange={setQuery} placeholder={t('shareNotes.search')} width={320} />
          {shareable.length === 0 ? (
            <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)' }}>{t('shareNotes.noneShareable')}</p>
          ) : (
            <div style={{ display: 'grid', gap: 'var(--space-1)' }}>
              {shareable.map((n) => (
                <Checkbox key={n.id} checked={chosen.includes(n.id)} onChange={(on) => toggle(n.id, on)} label={n.title}
                  description={categoryLabel(n.category)} />
              ))}
            </div>
          )}
          {others > 0 && (
            <p style={{ margin: 0, fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>{t('shareNotes.othersHidden', { count: others })}</p>
          )}
        </div>
      )}
    </Modal>
  );
}
