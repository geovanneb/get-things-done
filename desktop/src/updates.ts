// Updates from GitHub Releases (electron-updater). Only the installed app checks: running from source, the smoke test
// (GTD_DISABLE_UPDATES=1) and unsigned test builds do not get updates. macOS only installs updates to a signed app.
import { app, dialog } from 'electron';
import { autoUpdater } from 'electron-updater';
import * as fs from 'fs';
import * as path from 'path';
import { checkForUpdate, createUpdateInstaller, updatesEnabled } from './update-controller';

let restart: (() => Promise<void>) | undefined;

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

export interface UpdateState {
  /** The downloaded version waiting for a restart, if any. */
  ready: string | null;
}

/**
 * Starts background update checks. `onReady` runs when an update is downloaded, so the tray can offer the restart.
 * Download happens quietly; installing waits for the user (a restart from the dialog or the tray, or the next quit).
 */
export function startUpdateChecks(onReady: (version: string) => void, prepareForUpdate: () => Promise<void>): UpdateState {
  const state: UpdateState = { ready: null };
  const metadata = JSON.parse(fs.readFileSync(path.join(app.getAppPath(), 'package.json'), 'utf8'));
  if (!updatesEnabled(app.isPackaged, metadata.gtdSignedRelease, process.env['GTD_DISABLE_UPDATES'])) return state;
  autoUpdater.channel = metadata.gtdUpdateChannel ?? 'latest';
  // Setting a channel enables downgrades in electron-updater; releases must only move forward.
  autoUpdater.allowDowngrade = false;
  restart = createUpdateInstaller(prepareForUpdate, () => autoUpdater.quitAndInstall(), (error) => console.warn('[updates] restart failed:', error));

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = console;

  autoUpdater.on('update-downloaded', (info) => {
    state.ready = info.version;
    onReady(info.version);
    void dialog
      .showMessageBox({
        type: 'info',
        buttons: ['Restart now', 'Later'],
        defaultId: 0,
        cancelId: 1,
        message: `Get Things Done ${info.version} is ready`,
        detail: 'Restart to finish the update. Your workspace stays as it is. If you choose Later, the update is installed the next time you quit.',
      })
      .then(({ response }) => {
        if (response === 0) installNow();
      }).catch((error) => console.warn('[updates] dialog failed:', error));
  });

  // No network, an unsigned build or a release without installers: try again later, never bother the user.
  autoUpdater.on('error', (err) => console.warn('[updates] check failed:', err?.message ?? err));

  const check = () => void checkForUpdate(() => autoUpdater.checkForUpdates(), (error) => console.warn('[updates] check failed:', error));
  check();
  setInterval(check, CHECK_EVERY_MS).unref();
  return state;
}

export function installNow(): void {
  void restart?.();
}
