import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import Button from '@/components/common/Button';
import Notice from '@/components/common/Notice';
import { useApi } from '@/hooks/useApi';
import { useDataVersion } from '@/store';
import type { ActionNotice } from '@/types';

const PROPERTY: Record<ActionNotice['changes'][number]['property'], string> = { description: 'Action', owner: 'Owner', due_date: 'Due date' };
const shown = (text: string) => text || '(none)';
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) : '');

const QUIET: Partial<Record<ActionNotice['state'], { tone: 'warning' | 'info'; title: string; text: string }>> = {
  conflict: { tone: 'warning', title: 'The versions of this meeting\'s record disagree.', text: 'Two corrections were made from the same version, so changes since this task was made cannot be shown.' },
  broken: { tone: 'warning', title: 'The versions of this meeting\'s record do not hold.', text: 'One is missing, changed or inconsistent, so changes since this task was made cannot be shown. Review the meeting.' },
  unknown: { tone: 'info', title: 'The version used for this task cannot be verified.', text: 'What the task saved about it cannot be read, or no longer matches a version of the meeting\'s record, so nothing is compared.' },
  ambiguous: { tone: 'info', title: 'This task cannot be matched to one action item.', text: 'It was made before tasks recorded their item, and the meeting has two items that read alike.' },
};

/**
 * What the page shows: the answer, or that the last check failed. `failed` wins over an answer, so an older answer is
 * never shown as if it had just been checked.
 */
export function ActionNoticeView({ data, failed, retrying, onRetry }: { data: ActionNotice | null; failed: boolean; retrying: boolean; onRetry: () => void }) {
  if (failed) {
    return (
      <div style={{ marginBottom: 'var(--space-4)' }}>
        <Notice tone="warning" title="Could not check the meeting this task came from."
          action={<Button size="sm" variant="secondary" loading={retrying} onClick={onRetry}>{retrying ? 'Checking…' : 'Try again'}</Button>}>
          Whether its record changed since this task was made is not known right now.
        </Notice>
      </div>
    );
  }
  if (!data) return null;
  const meeting = data.meeting ? <Link to={`/meetings/${encodeURIComponent(data.meeting)}`} className="gtd-link">Open the meeting</Link> : null;

  if (data.state === 'changed') {
    return (
      <div style={{ marginBottom: 'var(--space-4)' }}>
        <Notice tone="info" title={data.legacy ? 'The current meeting record differs from its original version.' : 'The current meeting record differs from the version used for this task.'}>
          <ul style={{ margin: 'var(--space-1) 0', paddingLeft: 'var(--space-5)' }}>
            {data.changes.map((c) => <li key={c.property}>{PROPERTY[c.property]}: {shown(c.before)} → {shown(c.after)}</li>)}
          </ul>
          <span>
            {data.legacy && 'This task does not record which version it came from, so it is compared with the original. '}
            {data.current?.at && `Current version from ${day(data.current.at)}. `}
            The task itself is unchanged; edit it if it should follow.{' '}
            {data.current && <><Link to={`/context/updates/${data.current.update_id}`} className="gtd-link">See the current version</Link>{meeting && ' · '}</>}{meeting}
          </span>
        </Notice>
      </div>
    );
  }
  const q = QUIET[data.state];
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
