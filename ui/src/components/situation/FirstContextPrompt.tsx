import { useLanguage } from '@/i18n/LanguageProvider';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Notice from '@/components/common/Notice';
import Button from '@/components/common/Button';
import { useAssistant } from '@/hooks/useAssistant';
import { apiGet, apiPost } from '@/utils/api';
import type { FirstContextState } from '@/utils/firstContext';

/**
 * Offers the get-started interview on the Situation page while it is still worth it: a new workspace whose memory is
 * empty, or an interview the executive left half way. "Not now" stops the offer; it never comes back on its own.
 * Says nothing when the check fails: it is an offer, not information the page needs.
 */
export default function FirstContextPrompt() {
  const { t } = useLanguage();
  const assistant = useAssistant();
  const navigate = useNavigate();
  const [state, setState] = useState<FirstContextState | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    apiGet<FirstContextState>('/api/first-context').then((s) => { if (live) setState(s); }).catch(() => {});
    return () => { live = false; };
  }, []);

  if (!state?.suggested) return null;
  const resuming = state.status === 'in_progress';
  const dismiss = async () => {
    setBusy(true);
    try { setState(await apiPost<FirstContextState>('/api/first-context/skip')); } catch { setBusy(false); }
  };

  return (
    <Notice
      tone="info"
      title={t('getStarted.giveAHeadStart', { assistant: assistant.label })}
      style={{ marginBottom: 'var(--space-5)' }}
      action={(
        <span style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Button size="sm" variant="primary" onClick={() => navigate('/get-started')}>
            {resuming ? t('getStarted.continueWhereYouLeftOff') : t('getStarted.getStarted')}
          </Button>
          <Button size="sm" variant="ghost" loading={busy} disabled={busy} onClick={() => void dismiss()}>{t('getStarted.notNow')}</Button>
        </span>
      )}
    >
      {resuming ? t('getStarted.promptResume') : t('getStarted.prompt', { assistant: assistant.label })}
    </Notice>
  );
}
