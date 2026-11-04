import React from 'react';
import { useLocation } from 'react-router-dom';
import Button from '@/components/common/Button';
import Badge from '@/components/common/Badge';
import Toggle from '@/components/common/Toggle';
import { apiPost, apiPut } from '@/utils/api';
import { useApi } from '@/hooks/useApi';
import { copyText } from '@/components/context-updates/shared';
import type { AppUpdateStatus } from '@/types';
import { useDesktopUpdate } from '@/hooks/useDesktopUpdate';
import { checkDesktopUpdate, hasDesktopUpdates, restartToUpdate } from '@/utils/desktop';
import { updateStarted } from '@/components/layout/UpdateBanner';

const hint: React.CSSProperties = { margin: 0, fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)' };
const link: React.CSSProperties = { fontSize: 'var(--text-sm)', color: 'var(--color-accent)', textDecoration: 'underline' };
/** While a check runs, the card asks again this often until it is done. */
const CHECKING_POLL_MS = 2000;

/** What the check asks and what goes with it, for the switch's explanation. */
function privacyNote(kind: AppUpdateStatus['kind']): string {
  const asks = kind === 'desktop'
    ? 'GitHub, where the app is released, for the newest version (and the app downloads it quietly): an ordinary web request'
    : 'the npm registry for the newest version number, through your own npm and its settings. npm sends what it sends with any request (its version and your system type, and your registry login if you set one)';
  return `${kind === 'desktop' ? 'A few times a day' : 'Once a day'} it asks ${asks}. Apart from the AI tool runs you start or turn on, it's the only request the app makes on its own, and nothing from your workspace goes with it. Off: it asks only when you press Check now.`;
}

/** The commands to run, with a button to copy them. */
function Commands({ commands, label = 'Commands to update' }: { commands: string[]; label?: string }) {
  const [copied, setCopied] = React.useState(false);
  const text = commands.join('\n');
  return (
    <>
      <pre aria-label={label} style={{ margin: 0, padding: '8px 12px', borderRadius: 'var(--radius-sm)', background: 'var(--color-surface-hover)', fontSize: 'var(--text-xs)', overflowX: 'auto', whiteSpace: 'pre' }}>{text}</pre>
      <span>
        <Button size="sm" variant="secondary" onClick={() => void copyText(text).then((ok) => { setCopied(ok); if (ok) setTimeout(() => setCopied(false), 2000); })}>
          {copied ? 'Copied' : 'Copy the commands'}
        </Button>
      </span>
    </>
  );
}

/**
 * A global npm install (#284): "Update to X and restart" stops the dashboard, installs X with npm, refreshes the app's
 * files in the workspace and starts it again; the page waits and reloads on the new version. Where it can't (started in
 * a terminal, npm installs elsewhere, a folder that needs administrator rights, something important running), it says
 * why and the commands are the way; after a failed update too.
 */
function NpmUpdate({ status, updating, onUpdate }: { status: AppUpdateStatus; updating: boolean; onUpdate: () => void }) {
  const column: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 6 };
  if (updating || status.installing) {
    return (
      <div role="status" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <svg aria-hidden="true" width={18} height={18} viewBox="0 0 24 24" fill="none" className="gtd-spin" style={{ flexShrink: 0 }}>
          <circle cx="12" cy="12" r="10" stroke="var(--color-border-strong)" strokeWidth="3" />
          <path d="M12 2a10 10 0 0 1 10 10" stroke="var(--color-accent)" strokeWidth="3" strokeLinecap="round" />
        </svg>
        <p style={hint}><strong>Updating to {status.latest}…</strong> The dashboard stops, installs it and starts again; this page reconnects by itself. It takes a minute or two.</p>
      </div>
    );
  }
  if (status.installed) {
    return (
      <div style={column}>
        <p style={hint}><strong>{status.installed} is installed.</strong> Restart Get Things Done to finish: run these in a terminal, then reload this page. The upgrade refreshes the app&apos;s own files in your workspace and keeps your edits.</p>
        <Commands commands={status.commands} label="Commands to restart" />
      </div>
    );
  }
  if (status.can_install) {
    return (
      <div style={column}>
        <span><Button variant="primary" size="sm" onClick={onUpdate}>Update to {status.latest} and restart</Button></span>
        <p style={hint}>Stops the dashboard, installs {status.latest} with your npm and its settings, refreshes the app&apos;s files in your workspace (your edits are kept) and starts it again. This page reconnects by itself.</p>
        <details open={Boolean(status.install_error)}>
          <summary style={{ cursor: 'pointer', fontSize: 'var(--text-sm)', color: 'var(--color-accent)' }}>Or run it yourself</summary>
          <div style={{ ...column, marginTop: 6 }}><Commands commands={status.commands} /></div>
        </details>
      </div>
    );
  }
  return (
    <div style={column}>
      <p style={hint}>
        {status.install_blocked ? <>Can&apos;t update from here: {status.install_blocked}. </> : null}
        To update, run these in a terminal, then reload this page. Your workspace stays as it is; the upgrade refreshes the app&apos;s own files in it.
      </p>
      <Commands commands={status.commands} />
    </div>
  );
}

/**
 * The desktop app's own update (#284): how far it is, and Restart to update once it is downloaded. The restart waits
 * while a recording, a transcription or an AI tool run is going, and says so. An app without the bridge (older) says
 * how it updates, as before.
 */
function DesktopUpdatePanel() {
  const update = useDesktopUpdate();
  const [restarting, setRestarting] = React.useState(false);
  const [why, setWhy] = React.useState<string | null>(null);
  if (!update) return <p style={hint}>This app downloads new versions by itself and asks you to restart when one is ready.</p>;
  if (update.phase === 'ready' && update.version) {
    const restart = () => {
      setRestarting(true);
      setWhy(null);
      void restartToUpdate().then((reason) => { if (reason) { setWhy(reason); setRestarting(false); } });
    };
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span><Button variant="primary" size="sm" loading={restarting && !update.error} onClick={restart}>Restart to update to {update.version}</Button></span>
        <p style={hint}>Downloaded. The app restarts on the new version; your workspace stays as it is. It waits while a recording, a transcription or an AI tool run is going. Not now: it is installed the next time you quit.</p>
        {(why ?? update.error) && <p role="alert" style={{ ...hint, color: 'var(--color-warning)' }}>{why ?? update.error}</p>}
      </div>
    );
  }
  return (
    <p role="status" style={hint}>
      {update.phase === 'downloading' ? <>Downloading {update.version}{update.percent !== null ? ` (${update.percent}%)` : ''}… It is ready to restart when done.</>
        : update.phase === 'checking' ? 'Checking for a new version…'
          : update.phase === 'error' ? <>The app&apos;s last check did not work: {update.error}</>
            : update.phase === 'off' ? 'This build of the app does not update itself.'
              : 'This app downloads new versions by itself, then offers to restart.'}
    </p>
  );
}

/** How this install updates, in words, with the commands to copy when there are some. */
function HowToUpdate({ status, updating, onUpdate }: { status: AppUpdateStatus; updating: boolean; onUpdate: () => void }) {
  if (status.how === 'self') return <DesktopUpdatePanel />;
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
  if (status.kind === 'npm') return <NpmUpdate status={status} updating={updating} onUpdate={onUpdate} />;
  const intro = status.kind === 'npx' ? 'Run these with the new version:'
    : 'This copy was installed in a project folder. Run these in that folder, then reload this page:';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <p style={hint}>{intro}</p>
      <Commands commands={status.commands} />
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
  // Set once Update is pressed: the banner, on every page, follows the restart and reloads the page.
  const [waiting, setWaiting] = React.useState(false);
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setNotice(null);
    try { await fn(); refetch(); } catch (err) { setNotice((err as Error).message); } finally { setBusy(false); }
  };
  // While the dashboard restarts for an update, not answering is expected: the last status stays on screen.
  if (error && !waiting) return <p role="alert" style={{ ...hint, color: 'var(--color-critical)' }}>Could not read the update status: {error}</p>;
  if (!data) return <p style={hint}>Loading…</p>;
  const checked = data.checked_at ? new Date(data.checked_at).toLocaleString() : null;
  // The desktop app that updates itself follows the switch too (#284).
  const switchable = data.how !== 'self' || hasDesktopUpdates();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div role="status" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <strong style={{ fontSize: 'var(--text-sm)' }}>Version {data.current}</strong>
        {data.newer && data.latest
          ? <><Badge size="sm" variant="info">{data.latest} is available</Badge>{data.notes_url && <a href={data.notes_url} target="_blank" rel="noreferrer" style={link}>What&apos;s new</a>}</>
          : data.latest ? <Badge size="sm" variant="success">Up to date</Badge> : null}
      </div>
      {data.install_error && (
        <p role="alert" style={{ ...hint, color: 'var(--color-critical)' }}>
          {data.updated ? data.install_error : <>The last update did not finish: {data.install_error}</>}
        </p>
      )}
      {data.updated && !data.install_error && <p role="status" style={hint}>Updated to {data.updated}.</p>}
      {(data.newer || data.installed || data.how !== 'command') && (
        <HowToUpdate status={data} updating={waiting}
          onUpdate={() => { const version = data.latest!; void act(async () => { await apiPost('/api/app/update/install', { version }); setWaiting(true); updateStarted(version); }); }} />
      )}
      {data.error && <p role="alert" style={{ ...hint, color: 'var(--color-warning)' }}>The last check did not work: {data.error}</p>}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <Button size="sm" variant="secondary" loading={busy || checking} disabled={busy || waiting || data.installing} onClick={() => void act(async () => { await apiPost('/api/app/update/check'); if (data.how === 'self') await checkDesktopUpdate(); })}>Check now</Button>
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
