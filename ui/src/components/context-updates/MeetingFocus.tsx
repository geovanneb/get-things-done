import { useLanguage } from '@/i18n/LanguageProvider';
import Button from '@/components/common/Button';
import type { HeldMeetingView } from '@/types';
import type { focusScope, openAcrossUpdate } from '@/utils/meetingFocus';

/**
 * The scope line of a review opened at one meeting: which meeting of how many, the way to the one before and after,
 * and what is still open across every meeting, so nothing is approved without seeing the rest. Navigation only.
 */
export function MeetingScope({ digest, focused, scope, open, onGo, onShowAll }: {
  digest: boolean;
  focused: HeldMeetingView;
  scope: ReturnType<typeof focusScope>;
  open: ReturnType<typeof openAcrossUpdate>;
  onGo: (meeting: HeldMeetingView) => void;
  onShowAll: () => void;
}) {
  const { t, locale } = useLanguage();
  const n = (value: number) => new Intl.NumberFormat(locale).format(value);
  const line = digest
    ? t('meetingFocus.scopeDigest', { position: n(scope.position), count: scope.total })
    : t('meetingFocus.scopeUpdate', { position: n(scope.position), count: scope.total });
  return (
    <section aria-label={t('meetingFocus.region')} style={{
      display: 'flex', flexDirection: 'column', gap: 6, padding: '10px 14px', borderRadius: 'var(--radius-lg)',
      border: '1px solid var(--color-accent)', background: 'var(--color-accent-subtle)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <strong aria-live="polite" style={{ fontSize: 'var(--text-sm)' }}>{line}</strong>
        <span style={{ fontSize: 'var(--text-sm)', minWidth: 0, overflowWrap: 'anywhere' }}>{focused.title}</span>
        {focused.meeting_date && <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>{focused.meeting_date}</span>}
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <Button variant="ghost" size="sm" disabled={!scope.previous} onClick={() => scope.previous && onGo(scope.previous)}
            title={scope.previous?.title}>{t('meetingFocus.previous')}</Button>
          <Button variant="ghost" size="sm" disabled={!scope.next} onClick={() => scope.next && onGo(scope.next)}
            title={scope.next?.title}>{t('meetingFocus.next')}</Button>
          <Button variant="secondary" size="sm" onClick={onShowAll}>{t('meetingFocus.showAll')}</Button>
        </span>
      </div>
      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-secondary)', display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        {open.records > 0 && (
          <span style={{ fontWeight: open.recordsOpen > 0 ? 600 : 400, color: open.recordsOpen > 0 ? 'var(--color-warning)' : undefined }}>
            {open.recordsOpen > 0 ? t('meetingFocus.recordsOpen', { count: open.recordsOpen }) : t('meetingFocus.recordsDone')}
          </span>
        )}
        {open.proposals > 0 && <span>{t('meetingFocus.proposalsSelected', { selected: n(open.selected), count: open.proposals })}</span>}
      </div>
    </section>
  );
}
