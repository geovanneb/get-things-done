import React from 'react';
import Button from '@/components/common/Button';
import Toggle from '@/components/common/Toggle';
import { isDesktopApp } from '@/utils/desktop';
import { runNoticesOn, setRunNoticesOn } from '@/utils/runNotices';

const note: React.CSSProperties = { margin: 0, fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', maxWidth: 560 };

/** Settings: be told when an analysis or apply started from the dashboard finishes while you are elsewhere (#246). */
export default function RunNoticeSettings() {
  const [on, setOn] = React.useState(runNoticesOn);
  const browser = !isDesktopApp() && typeof Notification !== 'undefined';
  const [permission, setPermission] = React.useState<NotificationPermission | null>(browser ? Notification.permission : null);
  const change = (value: boolean) => { setRunNoticesOn(value); setOn(value); };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <Toggle id="run-notices" checked={on} label="Tell me when an analysis or apply finishes" onChange={change} />
        <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <label htmlFor="run-notices" style={{ fontSize: 'var(--text-sm)', cursor: 'pointer' }}>Tell me when an analysis or apply finishes</label>
          <span style={note}>
            For runs started from the dashboard, while you are in another app or tab: what is ready, and a click opens it. Kept in this
            {isDesktopApp() ? ' app' : ' browser'}.
          </span>
        </span>
      </div>
      {on && browser && permission === 'default' && (
        <span>
          <Button size="sm" variant="secondary" onClick={() => void Notification.requestPermission().then(setPermission)}>Allow notifications in this browser</Button>
        </span>
      )}
      {on && browser && permission === 'denied' && (
        <p role="status" style={note}>This browser blocks notifications for the dashboard. Allow them in the browser&apos;s site settings to be told.</p>
      )}
    </div>
  );
}
