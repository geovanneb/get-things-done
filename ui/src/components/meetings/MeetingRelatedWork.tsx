import { useLanguage } from '@/i18n/LanguageProvider';
import React from 'react';
import { Link } from 'react-router-dom';
import Badge from '@/components/common/Badge';
import Button from '@/components/common/Button';
import Notice from '@/components/common/Notice';
import { useDataVersion } from '@/store';
import { apiGet } from '@/utils/api';

type RelatedState = 'not_compared' | 'changed' | 'pin_failed' | 'unpinned' | 'older_version' | 'no_change' | 'related';

interface RelatedFinding { code: string; properties?: string[]; reason?: string; change?: { code: string; value?: string | null } }

interface RelatedTask {
  id: string; title: string; status: string; archived: boolean;
  via: { latest: boolean; earlier: boolean; mention: boolean; action: boolean };
  selection: string | null; state: RelatedState; findings: RelatedFinding[];
  deliverables: { id: string; name: string }[];
}

interface RelatedWork { meeting: string; meeting_readable: boolean; tasks: RelatedTask[]; scanned: number; skipped: { item: string; reason: string }[] }

const STATE_VARIANT: Record<RelatedState, 'warning' | 'critical' | 'info' | 'success' | 'default'> = {
  not_compared: 'critical', changed: 'warning', pin_failed: 'warning', unpinned: 'info', older_version: 'info', no_change: 'success', related: 'default',
};

/**
 * From a meeting, the tasks that used it and how each stands now: checked on demand, never changed from here. A change
 * is something to look at in the task, not proof that a deliverable is wrong.
 */
export default function MeetingRelatedWork({ meetingId }: { meetingId: string }) {
  const { t } = useLanguage();
  const [result, setResult] = React.useState<RelatedWork | null>(null);
  const [error, setError] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  // Only the latest check may show: one started for another meeting, or before leaving, is dropped.
  const latest = React.useRef(0);
  // A result checked before a task, an update or a transcript changed may no longer hold: it is cleared, not shown as current.
  const tasksVersion = useDataVersion('tasks');
  const updatesVersion = useDataVersion('context-updates');
  const transcriptionVersion = useDataVersion('transcription');

  React.useEffect(() => {
    // A counter, not a node: bumping it on leave drops any answer still on its way.
    const requests = latest;
    requests.current++;
    setResult(null); setError(false); setLoading(false);
    return () => { requests.current++; };
  }, [meetingId, tasksVersion, updatesVersion, transcriptionVersion]);

  const check = async () => {
    const request = ++latest.current;
    setLoading(true); setError(false);
    try {
      const next = await apiGet<RelatedWork>(`/api/meetings/${encodeURIComponent(meetingId)}/related-work`);
      if (request === latest.current) setResult(next);
    } catch {
      if (request === latest.current) setError(true);
    } finally {
      if (request === latest.current) setLoading(false);
    }
  };

  const stateLabel: Record<RelatedState, string> = {
    not_compared: t('meetingRelatedWork.stateNotCompared'), changed: t('meetingRelatedWork.stateChanged'),
    pin_failed: t('meetingRelatedWork.statePinFailed'), unpinned: t('meetingRelatedWork.stateUnpinned'),
    older_version: t('meetingRelatedWork.stateOlderVersion'), no_change: t('meetingRelatedWork.stateNoChange'),
    related: t('meetingRelatedWork.stateRelated'),
  };
  const property = (p: string) => (p === 'owner' ? t('meetingRelatedWork.propertyOwner') : p === 'due_date' ? t('meetingRelatedWork.propertyDueDate') : t('meetingRelatedWork.propertyDescription'));
  const finding = (f: RelatedFinding): string => {
    switch (f.code) {
      case 'meeting_unreadable': return t('meetingRelatedWork.findingUnreadable');
      case 'selection_damaged': return t('meetingRelatedWork.findingSelectionDamaged');
      case 'source_changed': return t('meetingRelatedWork.findingSourceChanged');
      case 'source_missing': return t('meetingRelatedWork.findingSourceMissing');
      case 'record_changed': return change(f.change);
      case 'older_version': return t('meetingRelatedWork.findingOlderVersion');
      case 'pin_failed': return t('meetingRelatedWork.findingPinFailed');
      case 'unavailable_when_pinned': return t('meetingRelatedWork.findingUnavailable');
      case 'unpinned': return t('meetingRelatedWork.findingUnpinned');
      case 'action_changed': return t('meetingRelatedWork.findingActionChanged', { properties: (f.properties ?? []).map(property).join(', ') });
      case 'action_not_compared': return t('meetingRelatedWork.findingActionNotCompared');
      case 'action_legacy': return t('meetingRelatedWork.findingActionLegacy');
      default: return f.code;
    }
  };
  const change = (c: RelatedFinding['change']): string => {
    switch (c?.code) {
      case 'unreadable': return t('meetingRelatedWork.changeUnreadable');
      case 'record_added': return t('meetingRelatedWork.changeRecordAdded');
      case 'record_unlinked': return t('meetingRelatedWork.changeRecordUnlinked');
      case 'confirmation': return c.value === 'confirmed' ? t('meetingRelatedWork.changeConfirmed') : c.value === 'rejected' ? t('meetingRelatedWork.changeRejected') : t('meetingRelatedWork.changeUnconfirmed');
      case 'review': return t('meetingRelatedWork.changeReview');
      default: return t('meetingRelatedWork.findingRecordChanged');
    }
  };
  const skipReason = (reason: string) => ({
    folder_unreadable: t('meetingRelatedWork.skipFolder'), task_unreadable: t('meetingRelatedWork.skipTask'),
    selection_damaged: t('meetingRelatedWork.skipSelection'), update_unreadable: t('meetingRelatedWork.skipUpdate'),
  } as Record<string, string>)[reason] ?? t('meetingRelatedWork.skipCheck');
  const via = (r: RelatedTask) => [
    r.via.latest && t('meetingRelatedWork.viaLatest'), r.via.earlier && t('meetingRelatedWork.viaEarlier'),
    r.via.mention && !r.via.latest && t('meetingRelatedWork.viaMention'), r.via.action && t('meetingRelatedWork.viaAction'),
  ].filter(Boolean).join(' · ');

  return (
    <section aria-labelledby={`related-work-${meetingId}`} style={{ marginTop: 'var(--space-5)' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-2)', marginBottom: 'var(--space-2)' }}>
        <h3 id={`related-work-${meetingId}`} style={{ margin: 0, fontSize: 'var(--text-sm)', fontWeight: 600 }}>{t('meetingRelatedWork.title')}</h3>
        <span style={{ flex: 1 }} />
        <Button size="sm" variant="secondary" loading={loading} onClick={() => void check()}>
          {result ? t('meetingRelatedWork.checkAgain') : t('meetingRelatedWork.check')}
        </Button>
      </div>
      <p style={{ margin: '0 0 var(--space-3)', fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>{t('meetingRelatedWork.intro')}</p>
      {loading && !result && <p role="status" style={{ margin: 0, fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>{t('meetingRelatedWork.checking')}</p>}
      {error && (
        <Notice tone="critical" title={t('meetingRelatedWork.couldNotCheck')}
          action={<Button size="sm" variant="secondary" onClick={() => void check()}>{t('retry')}</Button>}>
          {t('checkConnectionRetry')}
        </Notice>
      )}
      {result && result.tasks.length === 0 && result.skipped.length === 0 && (
        <p role="status" style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)' }}>{t('meetingRelatedWork.none')}</p>
      )}
      {result && result.tasks.length > 0 && (
        <ul aria-label={t('meetingRelatedWork.title')} className="gtd-list" style={{ border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)' }}>
          {result.tasks.map((r) => (
            <li key={r.id} className="gtd-list__row" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-2)', fontSize: 'var(--text-sm)' }}>
              <Link to={`/board/task/${r.id}`} className="gtd-link-strong truncate" style={{ flex: '1 1 220px', minWidth: 0 }}>{r.title || r.id}</Link>
              <span className="mono" style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>{r.id}</span>
              {r.archived && <Badge size="sm">{t('meetingRelatedWork.archived')}</Badge>}
              <Badge size="sm" variant={STATE_VARIANT[r.state]}>{stateLabel[r.state]}</Badge>
              <span style={{ flexBasis: '100%', fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>{via(r)}</span>
              {r.findings.length > 0 && (
                <ul style={{ flexBasis: '100%', margin: 0, paddingLeft: 'var(--space-4)', fontSize: 'var(--text-xs)' }}>
                  {r.findings.map((f, i) => <li key={i}>{finding(f)}</li>)}
                </ul>
              )}
              {r.deliverables.length > 0 && (
                <span style={{ flexBasis: '100%', fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
                  {t('meetingRelatedWork.deliverables')} {r.deliverables.map((d) => (d.name ? `${d.id} (${d.name})` : d.id)).join(', ')}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {result && result.skipped.length > 0 && (
        <Notice tone="warning" title={t('meetingRelatedWork.notChecked')}>
          <ul style={{ margin: 0, paddingLeft: 'var(--space-4)' }}>
            {result.skipped.map((s) => <li key={`${s.item}-${s.reason}`}><span className="mono">{s.item}</span>: {skipReason(s.reason)}</li>)}
          </ul>
        </Notice>
      )}
    </section>
  );
}
