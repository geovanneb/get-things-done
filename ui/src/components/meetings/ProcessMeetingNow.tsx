import { useLanguage } from '@/i18n/LanguageProvider';
import { rich } from '@/i18n/rich';
import React from 'react';
import { Link } from 'react-router-dom';
import Button from '@/components/common/Button';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { useNotify } from '@/hooks/useNotify';
import { apiGet, apiPost } from '@/utils/api';
import { processNowConfirmation, processNowOutcome, processNowRequest, processNowState, type ProcessNowResult } from '@/utils/processNow';
import type { MeetingDigest, QueuedMeeting } from '@/types';

/**
 * "Process this meeting now" (#487): a digest of this meeting alone, after a confirmation that says what happens to its
 * analysis. Disabled, with the reason, when the meeting is not ready or another digest is open (with a link to it).
 * The request names the workspace and the analysis setting the confirmation showed. Once made, the meeting leaves the
 * queue and its dialog shows the new update.
 */
export function ProcessMeetingNow({ meeting: m, job, onChanged }: { meeting: QueuedMeeting; job: MeetingDigest; onChanged: () => void }) {
  const { t } = useLanguage();
  const confirm = useConfirm();
  const notify = useNotify();
  const [busy, setBusy] = React.useState(false);
  const state = processNowState(m, job);

  const run = async () => {
    // What the confirmation showed: if the analysis settings changed before the request arrived, the server refuses it,
    // and the confirmation is shown again from the settings as they are now.
    let view: MeetingDigest = job;
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = processNowState(m, view);
      if (current.kind !== 'ready') { notify.warning(current.reason); break; }
      const c = processNowConfirmation(m, current.analysis);
      const message = <>{c.lines.map((line) => <p key={line} style={{ margin: '0 0 var(--space-2)' }}>{line}</p>)}</>;
      if (!(await confirm({ title: c.title, message, confirmLabel: c.confirmLabel }))) break;
      setBusy(true);
      try {
        const request = processNowRequest(m, view, current.analysis);
        // A run that failed after it started still answers 201, with what went wrong; a refusal answers 4xx.
        const result = await apiPost<ProcessNowResult>(request.path, request.body, request.workspace);
        const outcome = processNowOutcome(result, m.title);
        if (outcome.tone === 'error') notify.error(new Error(outcome.text), t('processNow.failed'));
        else notify[outcome.tone](outcome.text);
        break;
      } catch (err) {
        if ((err as { code?: string }).code !== 'analysis_setting_changed') { notify.error(err, t('processNow.failed')); break; }
        notify.warning(t('processNow.settingChanged'));
        try { view = await apiGet<MeetingDigest>('/api/routines/meeting-digest', view.workspace); } catch (again) { notify.error(again, t('processNow.failed')); break; }
      } finally {
        setBusy(false);
      }
    }
    onChanged();
  };

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
      {state.kind === 'blocked' && state.open_digest && (
        <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
          {rich(t, 'processNow.waitingForLink', { link: <Link to={`/context/updates/${state.open_digest}`} className="gtd-link">{state.open_digest}</Link> })}
        </span>
      )}
      <Button size="sm" variant="secondary" loading={busy} disabled={busy || state.kind !== 'ready'}
        title={state.kind === 'blocked' ? state.reason : undefined}
        onClick={() => void run()}>
        {t('processNow.action')}
      </Button>
    </span>
  );
}
