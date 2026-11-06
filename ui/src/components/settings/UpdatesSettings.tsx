import { useLanguage } from '@/i18n/LanguageProvider';
import { currentLocale, tr } from '@/i18n/current';
import { rich } from '@/i18n/rich';
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
    ? tr('updatesSettings.githubWhereTheAppIs')
    : tr('updatesSettings.theNpmRegistryForThe');
  return tr('updatesSettings.itAsksApartFromThe', { value: kind === 'desktop' ? tr('updatesSettings.aFewTimesADay') : tr('updatesSettings.onceADay'), asks });
}

/** The commands to run, with a button to copy them. */
function Commands({ commands, label = tr('updatesSettings.commandsToUpdate') }: { commands: string[]; label?: string }) {
  const { t } = useLanguage();
  const [copied, setCopied] = React.useState(false);
  const text = commands.join('\n');
  return (
    <>
      <pre aria-label={label} style={{ margin: 0, padding: '8px 12px', borderRadius: 'var(--radius-sm)', background: 'var(--color-surface-hover)', fontSize: 'var(--text-xs)', overflowX: 'auto', whiteSpace: 'pre' }}>{text}</pre>
      <span>
        <Button size="sm" variant="secondary" onClick={() => void copyText(text).then((ok) => { setCopied(ok); if (ok) setTimeout(() => setCopied(false), 2000); })}>
          {copied ? t('shared.copied') : t('updatesSettings.copyTheCommands')}
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
  const { t } = useLanguage();
  const column: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 6 };
  if (updating || status.installing) {
    return (
      <div role="status" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <svg aria-hidden="true" width={18} height={18} viewBox="0 0 24 24" fill="none" className="gtd-spin" style={{ flexShrink: 0 }}>
          <circle cx="12" cy="12" r="10" stroke="var(--color-border-strong)" strokeWidth="3" />
          <path d="M12 2a10 10 0 0 1 10 10" stroke="var(--color-accent)" strokeWidth="3" strokeLinecap="round" />
        </svg>
        <p style={hint}>{rich(t, 'updatesSettings.theDashboardStopsInstallsIt', { strong: <strong>{rich(t, 'updatesSettings.updatingTo', { latest: status.latest })}</strong> })}</p>
      </div>
    );
  }
  if (status.installed) {
    return (
      <div style={column}>
        <p style={hint}>{rich(t, 'updatesSettings.restartGetThingsDoneTo', { strong: <strong>{rich(t, 'updatesSettings.isInstalled', { installed: status.installed })}</strong> })}</p>
        <Commands commands={status.commands} label={t('updatesSettings.commandsToRestart')} />
      </div>
    );
  }
  if (status.can_install) {
    return (
      <div style={column}>
        <span><Button variant="primary" size="sm" onClick={onUpdate}>{rich(t, 'updatesSettings.updateToAndRestart', { latest: status.latest })}</Button></span>
        <p style={hint}>{rich(t, 'updatesSettings.stopsTheDashboardInstallsWith', { latest: status.latest })}</p>
        <details open={Boolean(status.install_error)}>
          <summary style={{ cursor: 'pointer', fontSize: 'var(--text-sm)', color: 'var(--color-accent)' }}>{t('analysisRun.orRunItYourself')}</summary>
          <div style={{ ...column, marginTop: 6 }}><Commands commands={status.commands} /></div>
        </details>
      </div>
    );
  }
  return (
    <div style={column}>
      <p style={hint}>
        {status.install_blocked ? <>{rich(t, 'updatesSettings.canTUpdateFromHere', { install_blocked: status.install_blocked })} </> : null}
        {t('updatesSettings.toUpdateRunTheseIn')}
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
  const { t } = useLanguage();
  const update = useDesktopUpdate();
  const [restarting, setRestarting] = React.useState(false);
  const [why, setWhy] = React.useState<string | null>(null);
  if (!update) return <p style={hint}>{t('updatesSettings.thisAppDownloadsNewVersions')}</p>;
  if (update.phase === 'ready' && update.version) {
    const restart = () => {
      setRestarting(true);
      setWhy(null);
      void restartToUpdate().then((reason) => { if (reason) { setWhy(reason); setRestarting(false); } });
    };
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span><Button variant="primary" size="sm" loading={restarting && !update.error} onClick={restart}>{rich(t, 'updatesSettings.restartToUpdateTo', { version: update.version })}</Button></span>
        <p style={hint}>{t('updatesSettings.downloadedTheAppRestartsOn')}</p>
        {(why ?? update.error) && <p role="alert" style={{ ...hint, color: 'var(--color-warning)' }}>{why ?? update.error}</p>}
      </div>
    );
  }
  return (
    <p role="status" style={hint}>
      {update.phase === 'downloading' ? <>{rich(t, 'updatesSettings.downloadingItIsReadyTo', { version: update.version, value: update.percent !== null ? ` (${update.percent}%)` : '' })}</>
        : update.phase === 'checking' ? t('updatesSettings.checkingForANewVersion')
          : update.phase === 'error' ? <>{rich(t, 'updatesSettings.theAppSLastCheck', { error: update.error })}</>
            : update.phase === 'off' ? t('updatesSettings.thisBuildOfTheApp')
              : t('updatesSettings.thisAppDownloadsNewVersions2')}
    </p>
  );
}

/** How this install updates, in words, with the commands to copy when there are some. */
function HowToUpdate({ status, updating, onUpdate }: { status: AppUpdateStatus; updating: boolean; onUpdate: () => void }) {
  const { t } = useLanguage();
  if (status.how === 'self') return <DesktopUpdatePanel />;
  if (status.how === 'manual') {
    return (
      <p style={hint}>
        {status.kind === 'desktop'
          ? t('updatesSettings.thisBuildOfTheApp2')
          : t('updatesSettings.thisCopyRunsFromThe')}{' '}
        <a href={status.release_url} target="_blank" rel="noreferrer" style={link}>{t('updatesSettings.releasePage')}</a>
      </p>
    );
  }
  if (status.kind === 'npm') return <NpmUpdate status={status} updating={updating} onUpdate={onUpdate} />;
  const intro = status.kind === 'npx' ? t('updatesSettings.runTheseWithTheNew')
    : t('updatesSettings.thisCopyWasInstalledIn');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <p style={hint}>{intro}</p>
      <Commands commands={status.commands} />
    </div>
  );
}

/** Settings > Updates: the version, whether a newer one is out, how to get it, and the automatic check. */
export default function UpdatesSettings() {
  const { t } = useLanguage();
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
  if (error && !waiting) return <p role="alert" style={{ ...hint, color: 'var(--color-critical)' }}>{rich(t, 'updatesSettings.couldNotReadTheUpdate', { error: error })}</p>;
  if (!data) return <p style={hint}>{t('loading')}</p>;
  const checked = data.checked_at ? new Date(data.checked_at).toLocaleString(currentLocale()) : null;
  // The desktop app that updates itself follows the switch too (#284).
  const switchable = data.how !== 'self' || hasDesktopUpdates();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div role="status" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <strong style={{ fontSize: 'var(--text-sm)' }}>{rich(t, 'updatesSettings.version', { current: data.current })}</strong>
        {data.newer && data.latest
          ? <><Badge size="sm" variant="info">{rich(t, 'updatesSettings.isAvailable', { latest: data.latest })}</Badge>{data.notes_url && <a href={data.notes_url} target="_blank" rel="noreferrer" style={link}>{t('updateBanner.whatSNew')}</a>}</>
          : data.latest ? <Badge size="sm" variant="success">{t('updatesSettings.upToDate')}</Badge> : null}
      </div>
      {data.install_error && (
        <p role="alert" style={{ ...hint, color: 'var(--color-critical)' }}>
          {data.updated ? data.install_error : <>{rich(t, 'updatesSettings.theLastUpdateDidNot', { install_error: data.install_error })}</>}
        </p>
      )}
      {data.updated && !data.install_error && <p role="status" style={hint}>{rich(t, 'updatesSettings.updatedTo', { updated: data.updated })}</p>}
      {(data.newer || data.installed || data.how !== 'command') && (
        <HowToUpdate status={data} updating={waiting}
          onUpdate={() => { const version = data.latest!; void act(async () => { await apiPost('/api/app/update/install', { version }); setWaiting(true); updateStarted(version); }); }} />
      )}
      {data.error && <p role="alert" style={{ ...hint, color: 'var(--color-warning)' }}>{rich(t, 'updatesSettings.theLastCheckDidNot', { error: data.error })}</p>}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <Button size="sm" variant="secondary" loading={busy || checking} disabled={busy || waiting || data.installing} onClick={() => void act(async () => { await apiPost('/api/app/update/check'); if (data.how === 'self') await checkDesktopUpdate(); })}>{t('updatesSettings.checkNow')}</Button>
        <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>{checked ? t('updatesSettings.lastChecked', { checked }) : t('updatesSettings.notCheckedYet')}</span>
      </div>
      {switchable
        ? (
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
            <Toggle id="update-auto-check" checked={data.auto_check} disabled={busy} label={t('updatesSettings.checkForUpdatesAutomatically')} onChange={(value) => void act(() => apiPut('/api/app/update/settings', { auto_check: value }))} />
            <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <label htmlFor="update-auto-check" style={{ fontSize: 'var(--text-sm)', cursor: busy ? 'not-allowed' : 'pointer' }}>{t('updatesSettings.checkForUpdatesAutomatically')}</label>
              <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', maxWidth: 560 }}>{privacyNote(data.kind)}</span>
            </span>
          </div>
        )
        : (
          <p style={{ ...hint, fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', maxWidth: 560 }}>
            {t('updatesSettings.theDesktopAppAsksGithub')}
          </p>
        )}
      {notice && <p role="alert" style={{ ...hint, color: 'var(--color-critical)' }}>{notice}</p>}
    </div>
  );
}
