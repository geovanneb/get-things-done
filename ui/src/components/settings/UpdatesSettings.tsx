import React from 'react';
import { useLocation } from 'react-router-dom';
import Button from '@/components/common/Button';
import Badge from '@/components/common/Badge';
import Toggle from '@/components/common/Toggle';
import { apiPost, apiPut } from '@/utils/api';
import { useApi } from '@/hooks/useApi';
import { copyText } from '@/components/context-updates/shared';
import type { AppUpdateStatus } from '@/types';

const hint: React.CSSProperties = { margin: 0, fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)' };
const link: React.CSSProperties = { fontSize: 'var(--text-sm)', color: 'var(--color-accent)', textDecoration: 'underline' };
/** While a check runs, the card asks again this often until it is done. */
const CHECKING_POLL_MS = 2000;

/** What the check asks and what goes with it, for the switch's explanation. */
function privacyNote(kind: AppUpdateStatus['kind']): string {
  const asks = kind === 'desktop'
    ? 'GitHub, where the app is released, for the newest version number: an ordinary web request'
    : 'the npm registry for the newest version number, through your own npm and its settings. npm sends what it sends with any request (its version and your system type, and your registry login if you set one)';
  return `Once a day it asks ${asks}. Apart from the AI tool runs you start or turn on, it's the only request the app makes on its own, and nothing from your workspace goes with it. Off: it asks only when you press Check now.`;
}

/** How this install updates, in words, with the commands to copy when there are some. */
function HowToUpdate({ status }: { status: AppUpdateStatus }) {
  const [copied, setCopied] = React.useState(false);
  const commands = status.commands.join('\n');
  if (status.how === 'self') return <p style={hint}>This app downloads new versions by itself and asks you to restart when one is ready.</p>;
  if (status.how === 'manual') {
    return (
      <p style={hint}>
        {status.kind === 'desktop'
          ? 'This build of the app can\'t update itself. Download new versions from the release page.'
          : 'This copy runs from the source code: pull the latest changes and build it again.'}{' '}
        <a href={status.release_url} target="_blank" rel="noreferrer" style={link}>Release page</a>
      </p>
    );
  }
  const intro = status.kind === 'npx' ? 'Run these with the new version:'
    : status.kind === 'npm-local' ? 'This copy was installed in a project folder. Run these in that folder, then reload this page:'
      : 'To update, run these in a terminal, then reload this page. Your workspace stays as it is; the upgrade refreshes the app\'s own files in it.';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <p style={hint}>{intro}</p>
      <pre aria-label="Commands to update" style={{ margin: 0, padding: '8px 12px', borderRadius: 'var(--radius-sm)', background: 'var(--color-surface-hover)', fontSize: 'var(--text-xs)', overflowX: 'auto', whiteSpace: 'pre' }}>{commands}</pre>
      <span>
        <Button size="sm" variant="secondary" onClick={() => void copyText(commands).then((ok) => { setCopied(ok); if (ok) setTimeout(() => setCopied(false), 2000); })}>
          {copied ? 'Copied' : 'Copy the commands'}
        </Button>
      </span>
    </div>
  );
}

/** Settings > Updates: the version, whether a newer one is out, how to get it, and the automatic check. */
export default function UpdatesSettings() {
  const { data, error, refetch } = useApi<AppUpdateStatus>('/api/app/update');
  const [busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState<string | null>(null);
  const location = useLocation();
  // Opened from the banner's "How to update" (also while Settings is open): scrolled to once the card is there.
  const shown = Boolean(data);
  React.useEffect(() => {
    if (shown && location.hash === '#updates') document.getElementById('updates')?.scrollIntoView({ block: 'start' });
  }, [shown, location.hash, location.key]);
  // A check running (from another page, or the daily one): asked again until it is done, so the result and the button follow.
  const checking = Boolean(data?.checking);
  React.useEffect(() => {
    if (!checking) return;
    const id = setTimeout(refetch, CHECKING_POLL_MS);
    return () => clearTimeout(id);
  }, [checking, data, refetch]);
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setNotice(null);
    try { await fn(); refetch(); } catch (err) { setNotice((err as Error).message); } finally { setBusy(false); }
  };
  if (error) return <p role="alert" style={{ ...hint, color: 'var(--color-critical)' }}>Could not read the update status: {error}</p>;
  if (!data) return <p style={hint}>Loading…</p>;
  const checked = data.checked_at ? new Date(data.checked_at).toLocaleString() : null;
  // The desktop app that updates itself checks on its own schedule; a switch here would not stop it (yet).
  const switchable = data.how !== 'self';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div role="status" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <strong style={{ fontSize: 'var(--text-sm)' }}>Version {data.current}</strong>
        {data.newer && data.latest
          ? <><Badge size="sm" variant="info">{data.latest} is available</Badge>{data.notes_url && <a href={data.notes_url} target="_blank" rel="noreferrer" style={link}>What&apos;s new</a>}</>
          : data.latest ? <Badge size="sm" variant="success">Up to date</Badge> : null}
      </div>
      {(data.newer || data.how !== 'command') && <HowToUpdate status={data} />}
      {data.error && <p role="alert" style={{ ...hint, color: 'var(--color-warning)' }}>The last check did not work: {data.error}</p>}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <Button size="sm" variant="secondary" loading={busy || checking} disabled={busy} onClick={() => void act(() => apiPost('/api/app/update/check'))}>Check now</Button>
        <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>{checked ? `Last checked ${checked}` : 'Not checked yet'}</span>
      </div>
      {switchable
        ? (
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
            <Toggle id="update-auto-check" checked={data.auto_check} disabled={busy} label="Check for updates automatically" onChange={(value) => void act(() => apiPut('/api/app/update/settings', { auto_check: value }))} />
            <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <label htmlFor="update-auto-check" style={{ fontSize: 'var(--text-sm)', cursor: busy ? 'not-allowed' : 'pointer' }}>Check for updates automatically</label>
              <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', maxWidth: 560 }}>{privacyNote(data.kind)}</span>
            </span>
          </div>
        )
        : (
          <p style={{ ...hint, fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', maxWidth: 560 }}>
            The desktop app asks GitHub for new versions every six hours and downloads them by itself, as an ordinary web
            request that carries nothing from your workspace.
          </p>
        )}
      {notice && <p role="alert" style={{ ...hint, color: 'var(--color-critical)' }}>{notice}</p>}
    </div>
  );
}
