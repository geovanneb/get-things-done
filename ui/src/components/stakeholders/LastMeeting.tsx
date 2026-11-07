import { useLanguage } from '@/i18n/LanguageProvider';
import { currentLocale } from '@/i18n/current';
import { Link } from 'react-router-dom';
import Button from '@/components/common/Button';
import { useApi } from '@/hooks/useApi';
import { useDataVersion } from '@/store';

interface LastMeeting { last: { id: string; title: string; meeting_date: string } | null; undated: boolean }

const lineStyle: React.CSSProperties = { margin: '0 0 var(--space-4)', fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)' };

/**
 * The latest confirmed meeting involving this person (#111): from confirmed meeting records that list them, never
 * from expected participants, a name in a transcript or a planned meeting. Derived each time, never stored.
 */
export default function StakeholderLastMeeting({ id }: { id: string }) {
  const { t } = useLanguage();
  const version = useDataVersion('context-updates');
  // useApi drops an answer for the person shown before, so switching people never shows the wrong meeting.
  const { data, loading, error, refetch } = useApi<LastMeeting>(`/api/stakeholders/${encodeURIComponent(id)}/last-meeting`, [version]);

  if (loading && !data) return null;
  if (error) {
    return (
      <p style={lineStyle} role="status">
        {t('stakeholderLastMeeting.couldNotCheck')}{' '}
        <Button size="sm" variant="ghost" onClick={refetch}>{t('retry')}</Button>
      </p>
    );
  }
  if (!data) return null;
  // In the language the app is shown in, not the computer's.
  const date = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString(currentLocale(), { year: 'numeric', month: 'short', day: 'numeric' });

  return (
    <p style={lineStyle} title={t('stakeholderLastMeeting.source')}>
      <span style={{ fontWeight: 600, color: 'var(--color-text)' }}>{t('stakeholderLastMeeting.label')}</span>{' '}
      {data.last ? (
        <>
          {date(data.last.meeting_date)} · <Link to={`/meetings/${encodeURIComponent(data.last.id)}`} className="gtd-link">{data.last.title || data.last.id}</Link>
        </>
      ) : data.undated ? t('stakeholderLastMeeting.dateUnknown') : t('stakeholderLastMeeting.none')}
      <span style={{ display: 'block', fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>{t('stakeholderLastMeeting.source')}</span>
    </p>
  );
}
