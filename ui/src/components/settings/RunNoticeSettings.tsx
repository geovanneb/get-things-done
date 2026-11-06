import { rich } from '@/i18n/rich';
import { useLanguage } from '@/i18n/LanguageProvider';
import React from 'react';
import Button from '@/components/common/Button';
import Toggle from '@/components/common/Toggle';
import { isDesktopApp } from '@/utils/desktop';
import { runNoticesOn, setRunNoticesOn } from '@/utils/runNotices';

const note: React.CSSProperties = { margin: 0, fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', maxWidth: 560 };

/** Settings: be told when an analysis or apply started from the dashboard finishes while you are elsewhere (#246). */
export default function RunNoticeSettings() {
  const { t } = useLanguage();
  const [on, setOn] = React.useState(runNoticesOn);
  const browser = !isDesktopApp() && typeof Notification !== 'undefined';
  const [permission, setPermission] = React.useState<NotificationPermission | null>(browser ? Notification.permission : null);
  const change = (value: boolean) => { setRunNoticesOn(value); setOn(value); };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <Toggle id="run-notices" checked={on} label={t('runNoticeLabel')} onChange={change} />
        <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <label htmlFor="run-notices" style={{ fontSize: 'var(--text-sm)', cursor: 'pointer' }}>{t('runNoticeLabel')}</label>
          <span style={note}>
            {rich(t, 'runNoticeSettings.forRunsStartedFromThe', { value: isDesktopApp() ? t('runNoticeSettings.keptInApp') : t('runNoticeSettings.keptInBrowser') })}
          </span>
        </span>
      </div>
      {on && browser && permission === 'default' && (
        <span>
          <Button size="sm" variant="secondary" onClick={() => void Notification.requestPermission().then(setPermission)}>{t('allowNotifications')}</Button>
        </span>
      )}
      {on && browser && permission === 'denied' && (
        <p role="status" style={note}>{t('notificationsBlocked')}</p>
      )}
    </div>
  );
}
