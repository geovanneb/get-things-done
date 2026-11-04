// Updates from GitHub Releases (electron-updater). Only the installed app checks: running from source, the smoke test
// (GTD_DISABLE_UPDATES=1) and unsigned test builds do not get updates. macOS only installs updates to a signed app.
import { app } from 'electron';
import { autoUpdater } from 'electron-updater';
import * as fs from 'fs';
import * as path from 'path';
import { checkForUpdate, createUpdateInstaller, nextUpdateState, updatesEnabled, type DesktopUpdateState, type UpdateEvent } from './update-controller';

let restart: (() => Promise<void>) | undefined;

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

let state: DesktopUpdateState = { phase: 'off', version: null, percent: null, error: null };
let listener: (state: DesktopUpdateState) => void = () => undefined;
let enabled = false;
/** Set from the hand-over to the installer: an updater error from then on means the restart did not go ahead. */
let restarting = false;
let onRestartFailed: () => void = () => undefined;

/** Restart to update did not go ahead: the page is told why, and the app carries on (`onRestartFailed`). */
function restartFailed(message: string): void {
  restarting = false;
  apply({ type: 'restart-failed', message: `The restart did not work: ${message}` });
  onRestartFailed();
}

/** Where the app's own update is now (#284): the page and the tray show it. */
export function updateState(): DesktopUpdateState {
  return state;
}

function apply(event: UpdateEvent): void {
  const next = nextUpdateState(state, event);
  if (next === state) return;
  state = next;
  listener(state);
}

/** Checks now (Check now in Settings), whatever the automatic setting says. */
export function checkNow(): void {
  if (!enabled) return;
  void checkForUpdate(() => autoUpdater.checkForUpdates(), (error) => apply({ type: 'error', message: String((error as Error)?.message ?? error) }));
}

/**
 * Starts the updater. `onState` hears each change (the page's banner and Settings, the tray), so the downloaded update
 * is said there instead of in a dialog. Downloads happen quietly; installing waits for the user (Restart to update in
 * the page or the tray) or the next quit. `shouldCheck` asks whether automatic checks are on: off, only Check now asks.
 */
export function startUpdateChecks(onState: (state: DesktopUpdateState) => void, prepareForUpdate: () => Promise<void>, shouldCheck: () => Promise<boolean>, failed: () => void): void {
  listener = onState;
  onRestartFailed = failed;
  const metadata = JSON.parse(fs.readFileSync(path.join(app.getAppPath(), 'package.json'), 'utf8'));
  if (!updatesEnabled(app.isPackaged, metadata.gtdSignedRelease, process.env['GTD_DISABLE_UPDATES'])) return;
  enabled = true;
  state = { phase: 'idle', version: null, percent: null, error: null };
  autoUpdater.channel = metadata.gtdUpdateChannel ?? 'latest';
  // Setting a channel enables downgrades in electron-updater; releases must only move forward.
  autoUpdater.allowDowngrade = false;
  restart = createUpdateInstaller(prepareForUpdate, () => { restarting = true; autoUpdater.quitAndInstall(); }, (error) => {
    console.warn('[updates] restart failed:', error);
    restartFailed(String((error as Error)?.message ?? error));
  });

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = console;

  autoUpdater.on('checking-for-update', () => apply({ type: 'checking' }));
  autoUpdater.on('update-not-available', () => apply({ type: 'none' }));
  autoUpdater.on('update-available', (info) => apply({ type: 'available', version: String(info?.version ?? '') }));
  autoUpdater.on('download-progress', (progress) => apply({ type: 'progress', percent: Number(progress?.percent ?? 0) }));
  autoUpdater.on('update-downloaded', (info) => apply({ type: 'downloaded', version: String(info?.version ?? '') }));
  // No network, an unsigned build or a release without installers: said in Settings, never in a dialog.
  autoUpdater.on('error', (err) => {
    console.warn('[updates] failed:', err?.message ?? err);
    if (restarting) restartFailed(String(err?.message ?? err));
    else apply({ type: 'error', message: String(err?.message ?? err) });
  });

  // Only when the switch is known to be on: when it can't be read, the automatic check is skipped (Check now still asks).
  const due = () => void shouldCheck().then((on) => { if (on) checkNow(); }, () => undefined);
  due();
  setInterval(due, CHECK_EVERY_MS).unref();
  listener(state);
}

/**
 * What the dashboard's server is told about updating this app, so Settings can say how it updates: the desktop app,
 * its release channel, and whether this build updates itself at all (unsigned and preview builds do not).
 */
export function updateEnvironment(): Record<string, string> {
  const metadata = JSON.parse(fs.readFileSync(path.join(app.getAppPath(), 'package.json'), 'utf8'));
  const enabled = updatesEnabled(app.isPackaged, metadata.gtdSignedRelease, process.env['GTD_DISABLE_UPDATES']);
  return { GTD_INSTALL: 'desktop', GTD_UPDATE_CHANNEL: metadata.gtdUpdateChannel ?? 'latest', GTD_UPDATES: enabled ? 'on' : 'off' };
}

/**
 * Gets ready for a restart to update, or says why not: what must not be interrupted, or that it could not be checked.
 * Once it says nothing, nothing new starts until the app stops (or `onRestartFailed` opens it again).
 */
let prepare: () => Promise<string | null> = async () => 'Not ready';
export function holdUpdatesWhile(check: () => Promise<string | null>): void {
  prepare = check;
}

/**
 * Restart to update, from the page or the tray: waits while something important runs (a recording, a transcription,
 * an AI tool run), the same check as the npm update. Null when it restarts; otherwise why not.
 */
export async function installNow(): Promise<string | null> {
  if (state.phase !== 'ready' || !restart) return 'No update is ready yet';
  const reason = await prepare();
  if (reason) return reason.includes('restart to update') || reason.includes('try again') ? reason : `${reason}: restart to update when it is done`;
  // A failure from an earlier try is not said again.
  if (state.error) { state = { ...state, error: null }; listener(state); }
  await restart();
  // Still here: the hand-over failed (already said through the state), or the installer is taking over.
  return state.error;
}
