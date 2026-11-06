import { useLanguage } from '@/i18n/LanguageProvider';
import { tr } from '@/i18n/current';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import Button from '@/components/common/Button';
import Notice from '@/components/common/Notice';
import { useApi } from '@/hooks/useApi';
import { useDataVersion } from '@/store';
import type { ActionNotice } from '@/types';

const PROPERTY = (): Record<ActionNotice['changes'][number]['property'], string> => ({ description: tr('taskMeetingAction.action'), owner: tr('taskMeetingAction.owner'), due_date: tr('newTaskModal.dueDate') });
const shown = (text: string) => text || '(none)';
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) : '');

const QUIET = (): Partial<Record<ActionNotice['state'], { tone: 'warning' | 'info'; title: string; text: string }>> => ({
  conflict: { tone: 'warning', title: tr('taskMeetingAction.theVersionsOfThisMeeting'), text: tr('taskMeetingAction.twoCorrectionsWereMadeFrom') },
  broken: { tone: 'warning', title: tr('taskMeetingAction.theVersionsOfThisMeeting2'), text: tr('taskMeetingAction.oneIsMissingChangedOr') },
  unknown: { tone: 'info', title: tr('taskMeetingAction.theVersionUsedForThis'), text: tr('taskMeetingAction.whatTheTaskSavedAbout') },
  ambiguous: { tone: 'info', title: tr('taskMeetingAction.thisTaskCannotBeMatched'), text: tr('taskMeetingAction.itWasMadeBeforeTasks') },
});

/**
 * What the page shows: the answer, or that the last check failed. `failed` wins over an answer, so an older answer is
 * never shown as if it had just been checked.
 */
export function ActionNoticeView({ data, failed, retrying, onRetry }: { data: ActionNotice | null; failed: boolean; retrying: boolean; onRetry: () => void }) {
  const { t } = useLanguage();
  if (failed) {
    return (
      <div style={{ marginBottom: 'var(--space-4)' }}>
        <Notice tone="warning" title={t('taskMeetingAction.couldNotCheckTheMeeting')}
          action={<Button size="sm" variant="secondary" loading={retrying} onClick={onRetry}>{retrying ? t('taskMeetingAction.checking') : t('retry')}</Button>}>
          {t('taskMeetingAction.whetherItsRecordChangedSince')}
        </Notice>
      </div>
    );
  }
  if (!data) return null;
  const meeting = data.meeting ? <Link to={`/meetings/${encodeURIComponent(data.meeting)}`} className="gtd-link">{t('taskMeetingAction.openTheMeeting')}</Link> : null;

  if (data.state === 'changed') {
    return (
      <div style={{ marginBottom: 'var(--space-4)' }}>
        <Notice tone="info" title={data.legacy ? t('taskMeetingAction.theCurrentMeetingRecordDiffers') : t('taskMeetingAction.theCurrentMeetingRecordDiffers2')}>
          <ul style={{ margin: 'var(--space-1) 0', paddingLeft: 'var(--space-5)' }}>
            {data.changes.map((c) => <li key={c.property}>{PROPERTY()[c.property]}: {shown(c.before)} → {shown(c.after)}</li>)}
          </ul>
          <span>
            {data.legacy && t('taskMeetingAction.thisTaskDoesNotRecord')}
            {data.current?.at && t('taskMeetingAction.currentVersionFrom', { day: day(data.current.at) })}
            {t('taskMeetingAction.theTaskItselfIsUnchanged')}{' '}
            {data.current && <><Link to={`/context/updates/${data.current.update_id}`} className="gtd-link">{t('taskMeetingAction.seeTheCurrentVersion')}</Link>{meeting && ' · '}</>}{meeting}
          </span>
        </Notice>
      </div>
    );
  }
  const q = QUIET()[data.state];
  if (!q) return null;
  return (
    <div style={{ marginBottom: 'var(--space-4)' }}>
      <Notice tone={q.tone} title={q.title}>{q.text}{meeting && <> {meeting}</>}</Notice>
    </div>
  );
}

/**
 * For a task made from a meeting's action item: what the meeting record says about that item now, when it differs
 * from the version the task was made from. Only tells: the task's own fields stay as the user left them.
 */
export default function TaskMeetingAction({ taskId, refreshKey }: { taskId: string; refreshKey: number }) {
  // A correction finishing elsewhere changes the answer as much as an edit to the task does.
  const updatesVersion = useDataVersion('context-updates');
  const { data, error, refetch } = useApi<ActionNotice>(`/api/tasks/${encodeURIComponent(taskId)}/meeting-action`, [refreshKey, updatesVersion]);
  // A failed check stays failed until one succeeds: a retry under way does not bring the older answer back.
  const [failed, setFailed] = useState(false);
  const [retrying, setRetrying] = useState(false);
  useEffect(() => { if (error) { setFailed(true); setRetrying(false); } }, [error]);
  useEffect(() => { setFailed(false); setRetrying(false); }, [data]);
  return <ActionNoticeView data={data} failed={failed} retrying={retrying} onRetry={() => { setRetrying(true); refetch(); }} />;
}
