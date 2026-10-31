// Electron main process: starts the same server as `gtd start` in a utility process and shows the dashboard in a window.
// The app keeps running in the tray when the window is closed, so routines still run on schedule.
import { app, BrowserWindow, Menu, Tray, dialog, nativeImage, powerSaveBlocker, session, shell, utilityProcess, UtilityProcess } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { registerBridge } from './bridge';
import { stopServer } from './server-lifecycle';
import { holdUpdatesWhile, installNow, startUpdateChecks } from './updates';
import { classifyLink } from './links';
import { RecordingCommands, type RecordingCommand } from './recording-commands';
import type { SpokenLanguageMenu } from './bridge';
import { DEFAULT_PORT, findFreePort } from './port';

const APP_NAME = 'Get Things Done';
// The server, dashboard and templates: the repo itself when run from source, or the copy staged into the app's
// resources (scripts/stage-app.mjs), which has the same layout as `npm install -g @bertonha/getthingsdone`.
const appRoot = app.isPackaged
  ? path.join(process.resourcesPath, 'gtd', 'node_modules', '@bertonha', 'getthingsdone')
  : path.resolve(__dirname, '..', '..');

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let server: UtilityProcess | null = null;
let appUrl = '';
let quitting = false;
/** A recording runs in the window; set by the dashboard through the bridge. */
let recording = false;
/** The spoken languages the page offers for the running recording, for the menu-bar menu. */
let languageMenu: SpokenLanguageMenu | null = null;
/** What the menu-bar menu asked the page to do about recording, until the page takes it. */
const recordingCommands = new RecordingCommands();
/** A downloaded update waiting for a restart, so the menu can be rebuilt when recording starts or stops. */
let pendingUpdate: string | null = null;
let keepAwake: number | null = null;

// ---- Settings kept by the desktop app (not the workspace) ----

interface DesktopSettings {
  port?: number;
}

function settingsFile(): string {
  return path.join(app.getPath('userData'), 'desktop.json');
}

function readSettings(): DesktopSettings {
  try {
    return JSON.parse(fs.readFileSync(settingsFile(), 'utf-8')) as DesktopSettings;
  } catch {
    return {};
  }
}

function writeSettings(settings: DesktopSettings): void {
  try {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
  } catch {
    // Not fatal: the next start just tries the default port again.
  }
}

// ---- Server ----

function startServerProcess(port: number): Promise<string> {
  const logDir = app.getPath('logs');
  fs.mkdirSync(logDir, { recursive: true });
  const log = fs.createWriteStream(path.join(logDir, 'server.log'), { flags: 'a' });

  server = utilityProcess.fork(path.join(__dirname, 'server-host.js'), [], {
    serviceName: `${APP_NAME} server`,
    stdio: 'pipe',
    env: { ...process.env, GTD_PORT: String(port), GTD_APP_ROOT: appRoot, NODE_ENV: 'production' },
  });
  server.stdout?.pipe(log);
  server.stderr?.pipe(log);

  return new Promise((resolve, reject) => {
    server!.on('message', (message: { type?: string; url?: string; message?: string }) => {
      if (message?.type === 'ready' && message.url) resolve(message.url);
      if (message?.type === 'failed') reject(new Error(message.message ?? 'The server did not start.'));
    });
    server!.once('exit', (code) => {
      server = null;
      if (!quitting) {
        reject(new Error(`The server stopped (exit code ${code}).`));
        if (appUrl) {
          dialog.showErrorBox(APP_NAME, `The server stopped unexpectedly. Details are in ${path.join(logDir, 'server.log')}.`);
          app.quit();
        }
      }
    });
  });
}

function stopServerProcess(): Promise<void> {
  return stopServer(server);
}

// ---- Window ----

const secureWebPreferences = {
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  webSecurity: true,
} as const;

function guardContents(window: BrowserWindow): void {
  window.webContents.setWindowOpenHandler(({ url }) => {
    const decision = classifyLink(url, new URL(appUrl).origin);
    if (decision === 'app') {
      // Attachment and document previews open in their own app window.
      return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, webPreferences: secureWebPreferences } };
    }
    if (decision === 'external') void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    const decision = classifyLink(url, new URL(appUrl).origin);
    if (decision === 'app') return;
    event.preventDefault();
    if (decision === 'external') void shell.openExternal(url);
  });
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    title: APP_NAME,
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    // Only the main window gets the bridge; preview windows opened from it do not.
    webPreferences: { ...secureWebPreferences, preload: path.join(__dirname, 'preload.js') },
  });
  guardContents(mainWindow);
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  // A page that is gone records nothing, whatever it last said.
  mainWindow.webContents.on('render-process-gone', () => setRecording(false));
  // Closing the window keeps the app (and its routines) running in the tray. Quit from the tray or the app menu.
  mainWindow.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    mainWindow?.hide();
  });
  mainWindow.on('closed', () => {
    setRecording(false);
    mainWindow = null;
  });
  void mainWindow.loadURL(appUrl);
}

function showWindow(): void {
  if (!appUrl) return;
  if (!mainWindow) createWindow();
  if (mainWindow?.isMinimized()) mainWindow.restore();
  mainWindow?.show();
  mainWindow?.focus();
}

// ---- Recording ----

/** While recording: the computer stays awake, the hidden window keeps working, and the tray says so. */
function setRecording(active: boolean): void {
  recording = active;
  if (!active) {
    languageMenu = null;
    recordingCommands.dropLanguage();
  }
  // Also called from the window's 'closed' event, when its page is already destroyed and cannot be changed.
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.setBackgroundThrottling(!active);
  }
  if (active && keepAwake === null) keepAwake = powerSaveBlocker.start('prevent-app-suspension');
  if (!active && keepAwake !== null) {
    powerSaveBlocker.stop(keepAwake);
    keepAwake = null;
  }
  tray?.setToolTip(active ? `${APP_NAME}: recording` : APP_NAME);
  // macOS shows text next to the menu-bar icon: a recording is visible even with the window closed.
  if (process.platform === 'darwin') tray?.setTitle(active ? 'REC' : '');
  setTrayMenu(pendingUpdate);
}

/**
 * Asks the page to open the record dialog or to stop the recording. Opening needs the window; stopping does not,
 * since the recorder keeps running while the window is hidden.
 */
function sendRecordingCommand(command: RecordingCommand): void {
  recordingCommands.leave(command);
  if (command === 'open') showWindow();
  // A page that is not there yet takes the command once it loads (onRecordingCommand takes it on start).
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) mainWindow.webContents.send('gtd:recording-command');
}

/** The microphone only, for the app's own main window. Preview windows and any other page never get it. */
function mayRecord(contents: Electron.WebContents | null, origin: string | undefined, types: string[] | undefined, isMainFrame: boolean): boolean {
  if (!mainWindow || contents !== mainWindow.webContents || !origin || !isMainFrame) return false;
  if (classifyLink(origin, new URL(appUrl).origin) !== 'app') return false;
  return !types || (types.length > 0 && types.every((t) => t === 'audio'));
}

// ---- Tray ----

function createTray(): void {
  const isMac = process.platform === 'darwin';
  const icon = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', isMac ? 'trayTemplate.png' : 'tray.png'));
  if (isMac) icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip(APP_NAME);
  setTrayMenu(null);
  // Windows and Linux open the window on click; macOS shows the menu.
  if (!isMac) tray.on('click', showWindow);
}

/** `update` is a downloaded version waiting for a restart. */
function setTrayMenu(update: string | null): void {
  pendingUpdate = update;
  tray?.setContextMenu(
    Menu.buildFromTemplate([
      recording
        ? { label: 'Stop recording and save', click: () => sendRecordingCommand('stop') }
        : { label: 'Record a meeting…', click: () => sendRecordingCommand('open') },
      ...(recording && languageMenu ? [{
        label: 'Spoken language',
        submenu: languageMenu.options.map(({ id, label }) => ({
          label, type: 'radio' as const, checked: id === languageMenu?.current, click: () => sendRecordingCommand(`language:${id}`),
        })),
      }] : []),
      { type: 'separator' },
      { label: `Open ${APP_NAME}`, click: showWindow },
      { label: 'Open in browser', click: () => void shell.openExternal(appUrl) },
      ...(update ? [{ type: 'separator' as const }, { label: `Restart to update to ${update}`, click: installNow }] : []),
      { type: 'separator' },
      { label: `Quit ${APP_NAME}`, click: () => app.quit() },
    ]),
  );
}

// ---- App lifecycle ----

if (!app.requestSingleInstanceLock()) {
  // Another copy is already running: it shows its window (see 'second-instance').
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.on('activate', showWindow);
  // Stay alive in the tray when every window is closed.
  app.on('window-all-closed', () => undefined);

  app.on('before-quit', (event) => {
    if (quitting) return;
    if (recording) {
      const choice = dialog.showMessageBoxSync({
        type: 'warning', buttons: ['Keep recording', 'Quit anyway'], defaultId: 0, cancelId: 0,
        message: 'A recording is in progress',
        detail: 'Stop it first to save everything. If you quit, what was already saved stays, and you can finish it on the Routines page.',
      });
      if (choice === 0) { event.preventDefault(); return; }
    }
    quitting = true;
    if (!server) return;
    event.preventDefault();
    void stopServerProcess().then(() => app.quit());
  });

  app.whenReady().then(async () => {
    // The dashboard needs no camera, location or notifications. Copy buttons need clipboard writes; recording a meeting
    // needs the microphone, for the main window only.
    // Downloads (attachments, ZIPs) always ask where to save, starting in the Downloads folder.
    session.defaultSession.on('will-download', (_event, item) => {
      item.setSaveDialogOptions({ defaultPath: path.join(app.getPath('downloads'), item.getFilename()) });
    });
    registerBridge(() => mainWindow, () => appUrl, setRecording, () => recordingCommands.take(), (menu) => {
      languageMenu = menu;
      setTrayMenu(pendingUpdate);
    });
    holdUpdatesWhile(() => recording);

    session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
      if (permission === 'media') {
        const media = details as { securityOrigin?: string; mediaTypes?: string[] };
        callback(mayRecord(contents, media.securityOrigin ?? details.requestingUrl, media.mediaTypes ?? [], details.isMainFrame));
        return;
      }
      // The computer's sound comes through a display capture: the handler below decides what it really gets.
      if (permission === 'display-capture') {
        callback(mayRecord(contents, details.requestingUrl, undefined, details.isMainFrame));
        return;
      }
      callback(permission === 'clipboard-sanitized-write');
    });
    // The computer's sound, for a recording the main window starts: its own page as the picture (no screen access is
    // needed for that, and the page stops it at once) and the system's loopback as the sound. Anything else gets nothing.
    session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
      const frame = request.frame;
      const allowed = Boolean(frame && mainWindow && frame === mainWindow.webContents.mainFrame && request.audioRequested
        && classifyLink(request.securityOrigin, new URL(appUrl).origin) === 'app');
      callback(allowed && frame ? { video: frame, audio: 'loopback' } : {});
    });
    session.defaultSession.setPermissionCheckHandler((contents, permission, origin, details) => {
      if (permission !== 'media') return true;
      return (details as { mediaType?: string }).mediaType === 'audio' && mayRecord(contents, origin, undefined, details.isMainFrame);
    });

    try {
      const settings = readSettings();
      const port = await findFreePort(settings.port ?? DEFAULT_PORT);
      appUrl = await startServerProcess(port);
      // Keep the same port next time: the dashboard stores its preferences per address.
      if (settings.port !== port) writeSettings({ ...settings, port });
    } catch (err) {
      dialog.showErrorBox(APP_NAME, `Could not start: ${err instanceof Error ? err.message : String(err)}`);
      quitting = true;
      app.quit();
      return;
    }

    createTray();
    startUpdateChecks((version) => setTrayMenu(version), async () => {
      // Electron closes windows before before-quit during an update. Allow that only after the server stops.
      quitting = true;
      await stopServerProcess();
    });
    createWindow();
  });
}
