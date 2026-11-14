import { useLanguage } from '@/i18n/LanguageProvider';
import { Link } from 'react-router-dom';
import Badge from '@/components/common/Badge';
import Button from '@/components/common/Button';
import Card from '@/components/common/Card';
import { daysBetween, today } from '@/components/board/TaskWaiting';
import { useApi } from '@/hooks/useApi';
import { useDataVersion } from '@/store';

interface WaitingOnItem { task_id: string; title: string; status: string; for: string; since: string; follow_up: string | null; follow_up_due: boolean }

const metaStyle: React.CSSProperties = { fontSize: 'var(--text-xs)', marginTop: 'var(--space-1)' };

/**
 * What we are waiting on this person for (#108): the open tasks whose waiting record names them. Derived from the
 * tasks each time, never stored; nothing is shown when nothing waits on them.
 */
export default function StakeholderWaitingOn({ id, headingLevel }: { id: string; headingLevel: 2 | 3 }) {
  const { t } = useLanguage();
  const version = useDataVersion('tasks');
  // useApi drops an answer for the person shown before, so switching people never shows the wrong list.
  const { data, loading, error, refetch } = useApi<WaitingOnItem[]>(`/api/stakeholders/${encodeURIComponent(id)}/waiting-on`, [version]);

  if (loading && !data) return null;
  if (error) {
    return (
      <p style={{ margin: '0 0 var(--space-4)', fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)' }} role="status">
        {t('stakeholderWaitingOn.couldNotCheck')}{' '}
        <Button size="sm" variant="ghost" onClick={refetch}>{t('retry')}</Button>
      </p>
    );
  }
  if (!data || data.length === 0) return null;
  const now = today();

  return (
    <Card headingLevel={headingLevel} title={t('stakeholderWaitingOn.title')}
      badge={<Badge variant={data.some((w) => w.follow_up_due) ? 'warning' : 'default'} size="sm">{data.length}</Badge>}>
      <p style={{ margin: '0 0 var(--space-3)', fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>{t('stakeholderWaitingOn.source')}</p>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {data.map((w, i) => (
          <li key={w.task_id} style={{ padding: 'var(--space-2) 0', borderTop: i === 0 ? 'none' : '1px solid var(--color-border)', fontSize: 'var(--text-sm)' }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-2)' }}>
              <Link to={`/board/task/${encodeURIComponent(w.task_id)}`} className="gtd-link" style={{ fontWeight: 600 }}>{w.title || w.task_id}</Link>
              {w.follow_up_due && <Badge variant="warning" size="sm">{t('taskWaiting.followUpBadge')}</Badge>}
            </div>
            <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', marginTop: 'var(--space-1)' }}>{w.for}</div>
            <div style={{ ...metaStyle, color: w.follow_up_due ? 'var(--color-warning)' : 'var(--color-text-muted)' }}>
              {[w.since && t('taskWaiting.since', { since: w.since, count: Math.max(0, daysBetween(w.since, now)) }),
                w.follow_up && (w.follow_up_due ? t('taskWaiting.followUpDue', { date: w.follow_up }) : t('taskWaiting.followUp', { date: w.follow_up }))]
                .filter(Boolean).join(' · ')}
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}
