import React from 'react';
import { useLanguage } from '@/i18n/LanguageProvider';
import Button from '@/components/common/Button';
import Card from '@/components/common/Card';
import Modal from '@/components/common/Modal';
import Notice from '@/components/common/Notice';
import Toggle from '@/components/common/Toggle';
import { apiGet, apiPut } from '@/utils/api';
import { autoPrepareView, confirmation, confirmedAccount, type RunnerCheck } from '@/utils/autoPrepare';
import type { MeetingDigest, RunnerStatus } from '@/types';

/**
 * Prepare meetings for review automatically (#484): one switch for the Meeting digest's Right after each meeting and
 * Analyze automatically, saved together in one settings write. It turns on only while the runner is ready, and first
 * says what it does and with which account; turning it off is always possible. It shows
 * mixed, paused and runner problems as they are, with what to fix. It starts nothing itself: the two flags do what
 * they always did.
 */
export function AutoPrepareSwitch({ job, onChanged }: { job: MeetingDigest; onChanged: () => void }) {
  const { t } = useLanguage();
  const [runner, setRunner] = React.useState<RunnerCheck>(undefined);
  // The dialog's own check, made when it opens: Turn on waits for it and needs it ready, so consent is never given for
  // an account or a runner state that changed since the page loaded.
  const [fresh, setFresh] = React.useState<RunnerCheck>(undefined);
  const generation = React.useRef(0);
  // The workspace the user reviewed in the dialog: the write names it, and the server refuses it in any other.
  const reviewed = React.useRef(job.workspace);
  const [asking, setAsking] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const checkRunner = React.useCallback((forDialog: boolean) => {
    const mine = ++generation.current;
    if (forDialog) setFresh(undefined);
    const settle = (s: RunnerCheck) => {
      if (mine !== generation.current) return;
      setRunner(s);
      if (forDialog) setFresh(s);
    };
    apiGet<RunnerStatus>('/api/runner').then(settle, () => settle(null));
  }, []);
  React.useEffect(() => {
    checkRunner(false);
    return () => { generation.current++; };
  }, [checkRunner]);

  const view = autoPrepareView(job.settings, runner);
  const confirm = confirmation(fresh, { enabled: job.settings.enabled, open_digest: job.open_digest, analyze_open_digest: job.analyze_open_digest });

  const open = () => {
    setError(null);
    reviewed.current = job.workspace;
    checkRunner(true);
    setAsking(true);
  };

  const save = async (on: boolean) => {
    const workspace = on ? reviewed.current : job.workspace;
    setSaving(true);
    setError(null);
    try {
      // Turning on names the account the dialog showed: the server checks the runner again and refuses if it is not
      // ready or another account is signed in now, so the user confirms what will really be used.
      await apiPut('/api/routines/meeting-digest', { after_each_meeting: on, auto_analyze: on, workspace, ...(on ? { account: confirmedAccount(fresh) } : {}) }, workspace);
      setAsking(false);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (on && (code === 'runner_not_ready' || code === 'runner_account_changed')) {
        // Checked again, so the dialog shows the runner and account as they are now before another confirmation.
        checkRunner(true);
        setError(code === 'runner_account_changed' ? t('autoPrepare.accountChanged') : t('autoPrepare.notReadyNow'));
      } else {
        setError((err as Error).message);
      }
    } finally {
      setSaving(false);
      // Refused or not, show the settings as they are now.
      onChanged();
    }
  };

  return (
    <div className="gtd-stack" style={{ gap: 'var(--space-3)' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--space-3)' }}>
        <Toggle id="auto-prepare-meetings" label={t('autoPrepare.title')} checked={view.mode === 'on'}
          disabled={saving || (view.mode !== 'on' && !view.canTurnOn)}
          onChange={(on) => { if (on) open(); else void save(false); }} />
        <label htmlFor="auto-prepare-meetings" style={{ fontSize: 'var(--text-sm)', cursor: 'pointer' }}>
          <span style={{ display: 'block', fontWeight: 600 }}>{t('autoPrepare.title')}</span>
          <span style={{ display: 'block', color: 'var(--color-text-secondary)' }}>{view.summary}</span>
        </label>
      </div>
      {view.issues.map((issue) => (
        <Notice key={issue.code} tone={issue.tone} title={issue.text}
          action={issue.code === 'only_digest' || issue.code === 'only_analysis'
            ? <Button size="sm" variant="ghost" disabled={saving} onClick={() => void save(false)}>{t('autoPrepare.turnBothOff')}</Button>
            : undefined}>
          {issue.fix}
        </Notice>
      ))}
      {error && !asking && <Notice tone="critical">{t('autoPrepare.notSaved', { error })}</Notice>}

      <Modal isOpen={asking} onClose={() => { if (!saving) setAsking(false); }} title={t('autoPrepare.confirmTitle')} size="md"
        footer={(
          <>
            <Button variant="ghost" disabled={saving} onClick={() => setAsking(false)}>{t('cancel')}</Button>
            <Button variant="primary" loading={saving} disabled={!confirm.canConfirm} onClick={() => void save(true)}>{t('autoPrepare.turnOn')}</Button>
          </>
        )}>
        <div className="gtd-stack" style={{ gap: 'var(--space-3)', fontSize: 'var(--text-sm)' }}>
          {confirm.checking && <span role="status" style={{ color: 'var(--color-text-muted)' }}>{t('autoPrepare.checking')}</span>}
          <ul style={{ margin: 0, paddingLeft: 'var(--space-5)' }}>
            {confirm.lines.map((line) => <li key={line}>{line}</li>)}
          </ul>
          {confirm.warnings.map((issue) => (
            <Notice key={issue.code} tone={issue.tone} title={issue.text}>{issue.fix}</Notice>
          ))}
          {error && <Notice tone="critical">{t('autoPrepare.notSaved', { error })}</Notice>}
        </div>
      </Modal>
    </div>
  );
}

/** The switch on the Meetings page, in its own card above the meetings. */
export function AutoPrepareCard({ job, onChanged }: { job: MeetingDigest; onChanged: () => void }) {
  return (
    <Card padding="compact">
      <AutoPrepareSwitch job={job} onChanged={onChanged} />
    </Card>
  );
}
